import { Pool } from "@db/postgres";
import {
  canonicalizeLoadedState,
  mergeSaveState,
  missingFormationUids,
  prepareLegacyMigration,
  prepareProfileSync,
  prepareRegistration,
  recoverMissingFormationHeroes,
} from "./state.ts";

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};
const authInternalUrl = Deno.env.get("AUTH_INTERNAL_URL") ?? "http://auth:9999";
const databasePool = new Pool({
  applicationName: "heroloop-api",
  database: Deno.env.get("PGDATABASE"),
  hostname: Deno.env.get("PGHOST"),
  password: Deno.env.get("PGPASSWORD"),
  port: Number(Deno.env.get("PGPORT") ?? "5432"),
  user: Deno.env.get("PGUSER"),
  connection: { attempts: 1, interval: 250 },
  options: {
    idle_in_transaction_session_timeout: "2000",
    lock_timeout: "1000",
    statement_timeout: "2000",
  },
  tls: { enabled: false, enforce: false },
}, Number(Deno.env.get("PGPOOL_SIZE") ?? "4"), true);
const maxBodyBytes = 256 * 1024;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const commandActions = new Set([
  "account_status",
  "account_register",
  "account_delete",
  "game_state_load",
  "game_state_migrate",
  "game_state_save",
  "sync",
  "status",
  "leaderboard",
  "claim",
  "spend_tokens",
  "set_boost_max_active",
  "promo_redeem",
  "tester_credit_tokens",
  "hero_summon",
  "ascension_focus_set",
  "hero_ascend",
  "chest_open",
  "item_mutate",
  "item_equip",
  "item_upgrade",
  "store_snapshot",
  "store_buy_item",
  "market_snapshot",
  "market_list_item",
  "market_cancel_listing",
  "market_buy_listing",
  "market_seed_test_stock",
  "summon_boss",
  "reserve_limited_item",
  "remove_limited_item",
  "dungeon_status",
  "dungeon_start",
  "dungeon_room_start",
  "dungeon_room_action",
  "dungeon_room_complete",
  "dungeon_room_choose",
  "dungeon_abandon",
]);

type JsonRecord = Record<string, unknown>;
type ParseResult = { value: JsonRecord } | { code: string };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(
  status: number,
  body: JsonRecord,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

function errorResponse(
  status: number,
  code: string,
  requestId: string,
  extraHeaders: HeadersInit = {},
): Response {
  return json(status, { ok: false, code, request_id: requestId }, extraHeaders);
}

async function parseCommandBody(request: Request): Promise<ParseResult> {
  if (
    !(request.headers.get("content-type") ?? "").toLowerCase().startsWith(
      "application/json",
    )
  ) {
    return { code: "invalid_content_type" };
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (
    !Number.isFinite(declaredLength) || declaredLength < 0 ||
    declaredLength > maxBodyBytes
  ) {
    return { code: "body_too_large" };
  }

  const reader = request.body?.getReader();
  if (!reader) return { code: "invalid_json" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBodyBytes) {
      await reader.cancel();
      return { code: "body_too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { code: "invalid_json" };
  }
  return isRecord(value) ? { value } : { code: "invalid_json" };
}

function validateEnvelope(body: JsonRecord): string | null {
  const allowed = new Set([
    "contract_version",
    "action",
    "idempotency_key",
    "payload",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return "invalid_fields";
  }
  if (body.contract_version !== 1) return "unsupported_contract_version";
  if (typeof body.action !== "string" || !commandActions.has(body.action)) {
    return "unknown_action";
  }
  if (!isRecord(body.payload)) return "invalid_payload";
  if (
    body.idempotency_key !== undefined &&
    (typeof body.idempotency_key !== "string" ||
      !uuidPattern.test(body.idempotency_key))
  ) {
    return "invalid_idempotency_key";
  }
  return null;
}

function validateAccountStatusPayload(payload: JsonRecord): string | null {
  return Object.keys(payload).some((key) => key !== "player_id")
    ? "invalid_payload"
    : null;
}

function validatePayloadFields(payload: JsonRecord, allowed: readonly string[]): string | null {
  const fields = new Set(["player_id", ...allowed]);
  return Object.keys(payload).some((key) => !fields.has(key)) ? "invalid_payload" : null;
}

async function withDatabase<T>(operation: (client: Awaited<ReturnType<Pool["connect"]>>) => Promise<T>): Promise<T> {
  const client = await databasePool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

async function accountStatus(playerId: string): Promise<JsonRecord> {
  const query = await withDatabase((client) =>
    client.queryObject<{ result: unknown }>(
      "SELECT heroloop_api.account_status($1::uuid) AS result",
      [playerId],
    )
  );
  const result = query.rows[0]?.result;
  if (
    query.rows.length !== 1 || !isRecord(result) ||
    typeof result.exists !== "boolean" ||
    (result.username !== null && typeof result.username !== "string") ||
    result.account_id !== playerId
  ) {
    throw new Error("invalid account_status database response");
  }
  return result;
}

async function databaseJson(
  queryText: string,
  args: unknown[],
): Promise<JsonRecord> {
  const query = await withDatabase((client) =>
    client.queryObject<{ result: unknown }>(queryText, args)
  );
  const result = query.rows[0]?.result;
  if (query.rows.length !== 1 || !isRecord(result)) {
    throw new Error("invalid database adapter response");
  }
  return result;
}

async function consumeRateLimit(playerId: string, action: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const result = await databaseJson(
    "SELECT heroloop_api.consume_rate_limit($1::uuid, $2::text) AS result",
    [playerId, action],
  );
  if (typeof result.allowed !== "boolean") throw new Error("invalid rate-limit response");
  return {
    allowed: result.allowed,
    retryAfter: Math.max(1, Math.floor(Number(result.retry_after) || 1)),
  };
}

async function authenticate(
  request: Request,
  requestId: string,
): Promise<{ playerId: string } | Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [^\s]+$/.test(authorization)) {
    return errorResponse(401, "authentication_required", requestId);
  }

  let response: Response;
  try {
    response = await fetch(`${authInternalUrl}/user`, {
      headers: { authorization },
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    return errorResponse(503, "authentication_unavailable", requestId);
  }
  if (response.status === 401 || response.status === 403) {
    return errorResponse(401, "invalid_session", requestId);
  }
  if (!response.ok) {
    return errorResponse(503, "authentication_unavailable", requestId);
  }

  const user = await response.json().catch(() => null);
  if (
    !isRecord(user) || typeof user.id !== "string" || !uuidPattern.test(user.id)
  ) {
    return errorResponse(503, "authentication_unavailable", requestId);
  }
  return { playerId: user.id };
}

async function dependenciesHealthy(): Promise<boolean> {
  try {
    const databaseHealthy = await withDatabase(async (client) =>
      (await client.queryObject<{ ok: number }>("SELECT 1 AS ok")).rows[0]?.ok === 1
    );
    const authResponse = await fetch(`${authInternalUrl}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return databaseHealthy && authResponse.ok;
  } catch {
    return false;
  }
}

Deno.serve({ hostname: "0.0.0.0", port: 8080 }, async (request) => {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();

  if (request.method === "GET" && url.pathname === "/internal/health") {
    return json(200, { ok: true });
  }

  if (url.pathname === "/api/v1/health") {
    if (request.method !== "GET") {
      return errorResponse(405, "method_not_allowed", requestId, {
        allow: "GET",
      });
    }
    return await dependenciesHealthy()
      ? json(200, { ok: true })
      : errorResponse(503, "dependency_unavailable", requestId);
  }

  if (url.pathname === "/api/v1/player/commands") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", requestId, {
        allow: "POST",
      });
    }
    const parsed = await parseCommandBody(request);
    if ("code" in parsed) return errorResponse(400, parsed.code, requestId);
    const envelopeError = validateEnvelope(parsed.value);
    if (envelopeError) return errorResponse(400, envelopeError, requestId);

    const identity = await authenticate(request, requestId);
    if (identity instanceof Response) return identity;
    const payload = parsed.value.payload as JsonRecord;
    const payloadPlayerId = payload.player_id;
    if (
      payloadPlayerId !== undefined && payloadPlayerId !== identity.playerId
    ) {
      return errorResponse(403, "player_identity_mismatch", requestId);
    }
    try {
      const rateLimit = await consumeRateLimit(identity.playerId, String(parsed.value.action));
      if (!rateLimit.allowed) {
        return errorResponse(429, "rate_limited", requestId, {
          "retry-after": String(rateLimit.retryAfter),
        });
      }
    } catch {
      console.error("rate-limit database adapter failed", { requestId });
      return errorResponse(503, "database_unavailable", requestId);
    }
    if (parsed.value.action === "account_status") {
      const payloadError = validateAccountStatusPayload(payload);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        return json(200, {
          ok: true,
          contract_version: 1,
          request_id: requestId,
          result: await accountStatus(identity.playerId),
        });
      } catch {
        console.error("account_status database adapter failed", { requestId });
        return errorResponse(503, "database_unavailable", requestId);
      }
    }
    if (parsed.value.action === "account_register") {
      const payloadError = validatePayloadFields(payload, ["username", "starter_hero_id", "state"]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      const prepared = prepareRegistration(payload, identity.playerId, Date.now());
      if ("code" in prepared) return errorResponse(prepared.status, prepared.code, requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.account_register($1::uuid, $2::text, $3::text, $4::jsonb) AS result",
          [identity.playerId, prepared.username, prepared.starterHeroId, JSON.stringify(prepared.state)],
        );
        const revision = Number(result.revision);
        if (!Number.isSafeInteger(revision) || revision < 1 || !isRecord(result.state)) {
          throw new Error("invalid registration database response");
        }
        return json(200, { ok: true, contract_version: 1, request_id: requestId, revision, result });
      } catch {
        console.error("account_register database adapter failed", { requestId });
        return errorResponse(503, "registration_unavailable", requestId);
      }
    }
    if (parsed.value.action === "account_delete") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.account_delete($1::uuid) AS result",
          [identity.playerId],
        );
        if (result.deleted !== true || result.account_id !== identity.playerId) {
          throw new Error("invalid account deletion response");
        }
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        console.error("account_delete database adapter failed", { requestId });
        return errorResponse(503, "account_delete_failed", requestId);
      }
    }
    if (parsed.value.action === "sync") {
      const payloadError = validatePayloadFields(payload, [
        "power", "account_level", "username", "total_kills", "boss_kills", "chests_opened",
        "heroes_owned", "highest_location", "lineup", "avatar_hero_id", "summons",
        "total_tokens_earned", "token_eligible", "training_hero_count",
      ]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const context = await databaseJson(
          "SELECT heroloop_api.sync_context($1::uuid) AS result",
          [identity.playerId],
        );
        const prepared = prepareProfileSync(context, payload);
        if ("code" in prepared) return errorResponse(prepared.status, prepared.code, requestId);
        const result = await databaseJson(
          "SELECT heroloop_api.sync_commit($1::uuid, $2::text, $3::text, $4::jsonb) AS result",
          [identity.playerId, prepared.username, prepared.avatarHeroId, JSON.stringify(prepared.summary)],
        );
        const pendingTokens = Number(result.pending_tokens);
        const totalClaimed = Number(result.total_claimed);
        const profile = isRecord(result.profile) ? result.profile : null;
        if (
          !Number.isFinite(pendingTokens) || !Number.isFinite(totalClaimed) || !profile ||
          profile.username !== prepared.username || profile.avatar_hero_id !== prepared.avatarHeroId ||
          Number(profile.power) !== Number(prepared.summary.power) ||
          Number(profile.combat_power) !== Number(prepared.summary.combat_power) ||
          Number(profile.account_level) !== Number(prepared.summary.account_level) ||
          Number(profile.heroes_owned) !== Number(prepared.summary.heroes_owned) ||
          Number(profile.highest_location) !== Number(prepared.summary.highest_location)
        ) {
          throw new Error("invalid sync database response");
        }
        result.pending_tokens = pendingTokens;
        result.total_claimed = totalClaimed;
        delete result.profile;
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        console.error("sync database adapter failed", { requestId });
        return errorResponse(503, "sync_unavailable", requestId);
      }
    }
    if (parsed.value.action === "game_state_load") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const context = await databaseJson(
          "SELECT heroloop_api.game_state_load_context($1::uuid) AS result",
          [identity.playerId],
        );
        const loaded = canonicalizeLoadedState(context);
        if ("code" in loaded) return errorResponse(loaded.status, loaded.code, requestId);
        let state = loaded.state;
        let revision = loaded.revision;
        let recoveredCount = 0;
        if (state && revision !== null) {
          const missingUids = missingFormationUids(state);
          if (missingUids.length > 0) {
            const recoveryContext = await databaseJson(
              "SELECT heroloop_api.formation_recovery_context($1::uuid, $2::jsonb) AS result",
              [identity.playerId, JSON.stringify(missingUids)],
            );
            const repaired = recoverMissingFormationHeroes(state, recoveryContext);
            if (repaired.recovered > 0) {
              const committed = await databaseJson(
                "SELECT heroloop_api.game_state_save_commit($1::uuid, $2::bigint, $3::jsonb) AS result",
                [identity.playerId, revision, JSON.stringify(repaired.state)],
              );
              const committedRevision = Number(committed.revision);
              if (committed.conflict !== true && Number.isSafeInteger(committedRevision) && committedRevision > revision) {
                state = isRecord(committed.state) ? committed.state : repaired.state;
                revision = committedRevision;
                recoveredCount = repaired.recovered;
              }
            }
          }
        }
        const result: JsonRecord = { state, revision };
        if (loaded.migratedItems > 0) result.migrated_items = loaded.migratedItems;
        if (recoveredCount > 0) result.recovered_formation_heroes = recoveredCount;
        return json(200, {
          ok: true,
          contract_version: 1,
          request_id: requestId,
          ...(revision === null ? {} : { revision }),
          result,
        });
      } catch {
        console.error("game_state_load database adapter failed", { requestId });
        return errorResponse(503, "state_unavailable", requestId);
      }
    }
    if (parsed.value.action === "game_state_migrate") {
      const payloadError = validatePayloadFields(payload, ["state"]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const context = await databaseJson(
          "SELECT heroloop_api.game_state_save_context($1::uuid) AS result",
          [identity.playerId],
        );
        const prepared = prepareLegacyMigration(context, payload.state, identity.playerId);
        if ("code" in prepared) return errorResponse(prepared.status, prepared.code, requestId);
        const result = await databaseJson(
          "SELECT heroloop_api.game_state_migrate($1::uuid, $2::jsonb) AS result",
          [identity.playerId, JSON.stringify(prepared.state)],
        );
        const revision = Number(result.revision);
        if (!Number.isSafeInteger(revision) || revision < 1 || !isRecord(result.state) || typeof result.migrated !== "boolean") {
          throw new Error("invalid migrate database response");
        }
        return json(200, { ok: true, contract_version: 1, request_id: requestId, revision, result });
      } catch {
        console.error("game_state_migrate database adapter failed", { requestId });
        return errorResponse(503, "state_unavailable", requestId);
      }
    }
    if (parsed.value.action === "game_state_save") {
      const payloadError = validatePayloadFields(payload, ["state", "revision"]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      const requestedRevision = Number(payload.revision);
      if (!Number.isSafeInteger(requestedRevision) || requestedRevision < 1) {
        return errorResponse(400, "invalid_revision", requestId);
      }
      try {
        const context = await databaseJson(
          "SELECT heroloop_api.game_state_save_context($1::uuid) AS result",
          [identity.playerId],
        );
        const currentRevision = Number(context.revision);
        if (Number.isSafeInteger(currentRevision) && currentRevision !== requestedRevision) {
          return json(409, {
            ok: false,
            code: "state_conflict",
            request_id: requestId,
            revision: currentRevision,
            result: { state: context.state, revision: currentRevision, conflict: true },
          });
        }
        const merged = mergeSaveState(context, payload.state, identity.playerId, Date.now());
        if ("code" in merged) {
          return merged.result
            ? json(merged.status, { ok: false, code: merged.code, request_id: requestId, result: merged.result })
            : errorResponse(merged.status, merged.code, requestId);
        }
        const committed = await databaseJson(
          "SELECT heroloop_api.game_state_save_commit($1::uuid, $2::bigint, $3::jsonb) AS result",
          [identity.playerId, merged.revision, JSON.stringify(merged.state)],
        );
        const revision = Number(committed.revision);
        if (committed.conflict === true) {
          return json(409, {
            ok: false,
            code: "state_conflict",
            request_id: requestId,
            ...(Number.isSafeInteger(revision) ? { revision } : {}),
            result: { state: committed.state, revision: committed.revision, conflict: true },
          });
        }
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid save commit response");
        const result: JsonRecord = { revision };
        const migratedItems = Math.max(0, Math.floor(Number(committed.migrated_items) || 0));
        if (migratedItems > 0) {
          result.state = committed.state;
          result.migrated_items = migratedItems;
        }
        return json(200, { ok: true, contract_version: 1, request_id: requestId, revision, result });
      } catch {
        console.error("game_state_save database adapter failed", { requestId });
        return errorResponse(503, "state_unavailable", requestId);
      }
    }
    return errorResponse(503, "command_unavailable", requestId);
  }

  return errorResponse(404, "not_found", requestId);
});
