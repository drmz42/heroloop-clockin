import { Pool } from "@db/postgres";
import {
  canonicalizeLoadedState,
  canonicalResourceState,
  mergeSaveState,
  missingFormationUids,
  prepareLeaderboardResult,
  prepareLegacyMigration,
  prepareProfileSync,
  prepareRegistration,
  prepareStatusResult,
  recoverMissingFormationHeroes,
} from "./state.ts";

const jsonHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};
const authInternalUrl = Deno.env.get("AUTH_INTERNAL_URL") ?? "http://auth:9999";
const testerControlsEnabled = Deno.env.get("TESTER_CONTROLS_ENABLED") === "true";
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
  "tester_credit_gold",
  "hero_summon",
  "ascension_focus_set",
  "hero_ascend",
  "chest_open",
  "tutorial_quest_claim",
  "tutorial_chest_open",
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

function idempotencyKey(envelope: JsonRecord): string | null {
  return typeof envelope.idempotency_key === "string" && uuidPattern.test(envelope.idempotency_key)
    ? envelope.idempotency_key
    : null;
}

function databaseErrorCode(error: unknown, allowed: readonly string[]): string | null {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return allowed.find((code) => message.includes(code)) ?? null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function isStatementTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  return code === "57014" || message.includes("canceling statement due to statement timeout");
}

async function databaseJsonReadRetryOnce(queryText: string, args: unknown[]): Promise<JsonRecord> {
  try {
    return await databaseJson(queryText, args);
  } catch (error) {
    if (!isStatementTimeout(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return await databaseJson(queryText, args);
  }
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
      const requestedAction = String(parsed.value.action);
      const rateLimit = await consumeRateLimit(identity.playerId,
        requestedAction === "tester_credit_gold" ? "tester_credit_tokens" : requestedAction);
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
    if (parsed.value.action === "claim") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.claim_tokens($1::uuid) AS result",
          [identity.playerId],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        return errorResponse(400, "claim_failed", requestId);
      }
    }
    if (parsed.value.action === "tester_credit_tokens") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      if (!testerControlsEnabled) return errorResponse(404, "not_found", requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.tester_credit_tokens($1::uuid) AS result",
          [identity.playerId],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        return errorResponse(400, "tester_credit_failed", requestId);
      }
    }
    if (parsed.value.action === "tester_credit_gold") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      if (!testerControlsEnabled) return errorResponse(404, "not_found", requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.tester_credit_gold($1::uuid) AS result",
          [identity.playerId],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        return errorResponse(400, "tester_credit_failed", requestId);
      }
    }
    if (parsed.value.action === "spend_tokens") {
      const payloadError = validatePayloadFields(payload, ["amount", "action_kind"]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      const requestKey = idempotencyKey(parsed.value);
      const amount = Math.min(1_000_000_000, Math.max(0, Number(payload.amount) || 0));
      const actionKind = typeof payload.action_kind === "string"
        ? payload.action_kind.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64)
        : "";
      if (!requestKey || !Number.isFinite(amount) || amount <= 0 || !actionKind) {
        return errorResponse(400, "invalid_spend", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.spend_tokens($1::uuid, $2::uuid, $3::numeric, $4::text) AS result",
          [identity.playerId, requestKey, amount, actionKind],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, ["insufficient_tokens"]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "spend_failed", requestId);
      }
    }
    if (parsed.value.action === "promo_redeem") {
      const payloadError = validatePayloadFields(payload, ["code"]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      const requestKey = idempotencyKey(parsed.value);
      if (!requestKey || typeof payload.code !== "string" || !/^[A-Za-z0-9 -]{4,40}$/.test(payload.code)) {
        return errorResponse(400, "invalid_promo_code", requestId);
      }
      const normalizedCode = payload.code.trim().toUpperCase().replace(/[ -]+/g, "");
      if (!/^[A-Z0-9]{4,24}$/.test(normalizedCode)) {
        return errorResponse(400, "invalid_promo_code", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.promo_redeem($1::uuid, $2::text, $3::uuid) AS result",
          [identity.playerId, await sha256Hex(normalizedCode), requestKey],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "invalid_promo_code", "promo_code_already_redeemed", "promo_code_exhausted",
        ]);
        if (code) return errorResponse(409, code, requestId);
        console.error("promo_redeem database adapter failed", { requestId });
        return errorResponse(503, "promo_redemption_failed", requestId);
      }
    }
    if (parsed.value.action === "ascension_focus_set") {
      const payloadError = validatePayloadFields(payload, ["rarity", "target_hero_id"]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      const requestKey = idempotencyKey(parsed.value);
      const rarity = typeof payload.rarity === "string" ? payload.rarity : "";
      const targetHeroId = payload.target_hero_id === null
        ? null
        : typeof payload.target_hero_id === "string" ? payload.target_hero_id.slice(0, 100) : undefined;
      if (!requestKey || targetHeroId === undefined) {
        return errorResponse(400, "invalid_ascension_focus", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.ascension_focus_set($1::uuid, $2::uuid, $3::text, $4::text) AS result",
          [identity.playerId, requestKey, rarity, targetHeroId],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "invalid_focus_rarity", "focus_target_not_owned", "focus_target_rarity_mismatch", "idempotency_conflict",
        ]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "ascension_focus_failed", requestId);
      }
    }
    if (parsed.value.action === "hero_summon") {
      const payloadError = validatePayloadFields(payload, ["count"]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      const requestKey = idempotencyKey(parsed.value);
      const count = Math.floor(Number(payload.count) || 0);
      if (!requestKey || ![1, 10, 100].includes(count)) {
        return errorResponse(400, "invalid_summon", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.hero_summon($1::uuid, $2::uuid, $3::integer) AS result",
          [identity.playerId, requestKey, count],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, ["insufficient_tokens", "hero_capacity_exceeded", "idempotency_conflict"]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "summon_failed", requestId);
      }
    }
    if (parsed.value.action === "hero_ascend") {
      const payloadError = validatePayloadFields(payload, ["target_uid", "target_uids", "repeat"]);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      const requestKey = idempotencyKey(parsed.value);
      const repeat = payload.repeat === true;
      const targetUid = typeof payload.target_uid === "string" ? payload.target_uid : null;
      const targetUids = Array.isArray(payload.target_uids) ? payload.target_uids : null;
      const validSingle = targetUid !== null && targetUid.length >= 1 && targetUid.length <= 100 && targetUids === null;
      const validAll = targetUid === null && repeat && targetUids !== null && targetUids.length >= 1 && targetUids.length <= 45 &&
        targetUids.every((uid) => typeof uid === "string" && uid.length >= 1 && uid.length <= 100) &&
        new Set(targetUids).size === targetUids.length;
      if (!requestKey || typeof payload.repeat !== "boolean" || (!validSingle && !validAll)) {
        return errorResponse(400, "invalid_ascension", requestId);
      }
      try {
        const result = validAll
          ? await databaseJson(
            "SELECT heroloop_api.hero_promote_all($1::uuid, $2::uuid, $3::jsonb) AS result",
            [identity.playerId, requestKey, JSON.stringify(targetUids)],
          )
          : await databaseJson(
            "SELECT heroloop_api.hero_ascend($1::uuid, $2::uuid, $3::text, $4::boolean) AS result",
            [identity.playerId, requestKey, targetUid, repeat],
          );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "insufficient_duplicates", "insufficient_tokens", "maximum_stars", "target_not_found", "idempotency_conflict",
        ]);
        if (code) return errorResponse(409, code, requestId);
        console.error("hero_ascend database adapter failed", { requestId });
        return errorResponse(503, "ascension_failed", requestId);
      }
    }
    if (parsed.value.action === "chest_open") {
      const payloadError = validatePayloadFields(payload, ["count"]);
      const requestKey = idempotencyKey(parsed.value);
      const count = Number(payload.count);
      if (payloadError || !requestKey || !Number.isSafeInteger(count) || count < 1 || count > 64) {
        return errorResponse(400, payloadError ?? "invalid_chest_open", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.chest_open($1::uuid, $2::uuid, $3::integer) AS result",
          [identity.playerId, requestKey, count],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, ["item_capacity_exceeded", "chest_count_exceeded", "idempotency_conflict"]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "chest_open_failed", requestId);
      }
    }
    if (parsed.value.action === "tutorial_quest_claim") {
      const payloadError = validatePayloadFields(payload, ["quest_id", "expected_revision"]);
      const requestKey = idempotencyKey(parsed.value);
      const questId = payload.quest_id;
      const revision = Number(payload.expected_revision);
      if (payloadError || !requestKey || typeof questId !== "string" || !/^[a-z0-9-]{3,64}$/.test(questId) || !Number.isSafeInteger(revision) || revision < 1) {
        return errorResponse(400, payloadError ?? "invalid_tutorial_claim", requestId);
      }
      try {
        const result = await databaseJson("SELECT heroloop_api.tutorial_quest_claim($1::uuid,$2::uuid,$3::text,$4::bigint) AS result", [identity.playerId, requestKey, questId, revision]);
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, ["state_conflict", "idempotency_conflict", "tutorial_completed", "tutorial_quest_locked", "tutorial_quest_incomplete"]);
        return code ? errorResponse(409, code, requestId) : errorResponse(400, "tutorial_claim_failed", requestId);
      }
    }
    if (parsed.value.action === "tutorial_chest_open") {
      const payloadError = validatePayloadFields(payload, ["count"]);
      const requestKey = idempotencyKey(parsed.value);
      const count = Number(payload.count);
      if (payloadError || !requestKey || ![1, 10].includes(count)) return errorResponse(400, payloadError ?? "invalid_tutorial_chest_open", requestId);
      try {
        const result = await databaseJson("SELECT heroloop_api.tutorial_chest_open($1::uuid,$2::uuid,$3::integer) AS result", [identity.playerId, requestKey, count]);
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, ["item_capacity_exceeded", "resource_insufficient_balance", "idempotency_conflict"]);
        return code ? errorResponse(409, code, requestId) : errorResponse(400, "tutorial_chest_open_failed", requestId);
      }
    }
    if (parsed.value.action === "item_mutate") {
      const payloadError = validatePayloadFields(payload, ["operation", "item_uids", "locked"]);
      const requestKey = idempotencyKey(parsed.value);
      const operation = payload.operation;
      const itemUids = payload.item_uids;
      const locked = operation === "lock" ? payload.locked : null;
      const valid = !payloadError && requestKey && ["lock", "sell"].includes(String(operation)) &&
        Array.isArray(itemUids) && itemUids.length >= 1 && itemUids.length <= 64 &&
        itemUids.every((uid) => typeof uid === "string" && uuidPattern.test(uid)) &&
        new Set(itemUids).size === itemUids.length &&
        (operation === "sell" || (itemUids.length === 1 && typeof locked === "boolean"));
      if (!valid) return errorResponse(400, payloadError ?? "invalid_item_mutation", requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.item_mutate($1::uuid, $2::uuid, $3::text, $4::jsonb, $5::boolean) AS result",
          [identity.playerId, requestKey, operation, JSON.stringify(itemUids), locked],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, ["item_not_found", "item_locked", "item_state_mismatch", "idempotency_conflict"]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "item_mutation_failed", requestId);
      }
    }
    if (parsed.value.action === "item_equip") {
      const payloadError = validatePayloadFields(payload, ["assignments"]);
      const requestKey = idempotencyKey(parsed.value);
      const assignments = payload.assignments;
      const slots = new Set(["class_weapon", "offhand", "helmet", "chest", "gloves", "boots", "ring", "amulet"]);
      const valid = !payloadError && requestKey && Array.isArray(assignments) && assignments.length <= 64 &&
        assignments.every((assignment) => isRecord(assignment) &&
          Object.keys(assignment).sort().join(",") === "hero_uid,item_uid,slot" &&
          typeof assignment.item_uid === "string" && uuidPattern.test(assignment.item_uid) &&
          typeof assignment.hero_uid === "string" && assignment.hero_uid.length >= 1 && assignment.hero_uid.length <= 100 &&
          typeof assignment.slot === "string" && slots.has(assignment.slot));
      if (!valid) return errorResponse(400, payloadError ?? "invalid_equipment_assignment", requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.item_equip($1::uuid, $2::uuid, $3::jsonb) AS result",
          [identity.playerId, requestKey, JSON.stringify(assignments)],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "invalid_equipment_assignment", "duplicate_equipment_assignment", "hero_not_active", "hero_not_found",
          "item_not_found", "item_state_mismatch", "item_level_required", "item_slot_mismatch", "item_class_mismatch",
          "item_capacity_exceeded", "idempotency_conflict",
        ]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "item_equipment_failed", requestId);
      }
    }
    if (parsed.value.action === "item_upgrade") {
      const payloadError = validatePayloadFields(payload, ["operation", "item_uid", "use_charm"]);
      const requestKey = idempotencyKey(parsed.value);
      const operation = payload.operation;
      const itemUid = payload.item_uid;
      const useCharm = payload.use_charm;
      const valid = !payloadError && requestKey && ["enchant", "reroll"].includes(String(operation)) &&
        typeof itemUid === "string" && uuidPattern.test(itemUid) && typeof useCharm === "boolean" &&
        (operation === "enchant" || useCharm === false);
      if (!valid) return errorResponse(400, payloadError ?? "invalid_item_upgrade", requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.item_upgrade($1::uuid, $2::uuid, $3::text, $4::uuid, $5::boolean) AS result",
          [identity.playerId, requestKey, operation, itemUid, useCharm],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "invalid_item_upgrade", "charm_unavailable", "maximum_enchant", "insufficient_gold", "insufficient_tokens",
          "item_not_found", "item_state_mismatch", "idempotency_conflict", "save_not_found", "account_not_found",
        ]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "item_upgrade_failed", requestId);
      }
    }
    if (parsed.value.action === "store_snapshot") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const result = await databaseJson("SELECT heroloop_api.store_snapshot($1::uuid) AS result", [identity.playerId]);
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        return errorResponse(503, "store_snapshot_failed", requestId);
      }
    }
    if (parsed.value.action === "store_buy_item") {
      const payloadError = validatePayloadFields(payload, ["slot_index", "refresh_at"]);
      const requestKey = idempotencyKey(parsed.value);
      const slotIndex = Number(payload.slot_index);
      const refreshAt = Number(payload.refresh_at);
      if (payloadError || !requestKey || !Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex > 3 ||
        !Number.isSafeInteger(refreshAt) || refreshAt < 1) {
        return errorResponse(400, payloadError ?? "invalid_store_purchase", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.store_buy_item($1::uuid, $2::uuid, $3::integer, $4::bigint) AS result",
          [identity.playerId, requestKey, slotIndex, refreshAt],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "invalid_store_slot", "store_offer_expired", "store_offer_sold", "insufficient_gold",
          "item_capacity_exceeded", "idempotency_conflict", "save_not_found",
        ]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "store_purchase_failed", requestId);
      }
    }
    if (parsed.value.action === "market_snapshot") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const result = await databaseJson("SELECT heroloop_api.market_snapshot($1::uuid) AS result", [identity.playerId]);
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        return errorResponse(503, "market_unavailable", requestId);
      }
    }
    if (parsed.value.action === "market_seed_test_stock") {
      const payloadError = validatePayloadFields(payload, []);
      const requestKey = idempotencyKey(parsed.value);
      if (payloadError || !requestKey) return errorResponse(400, payloadError ?? "invalid_market_seed", requestId);
      if (!testerControlsEnabled) return errorResponse(404, "not_found", requestId);
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.market_seed_test_stock($1::uuid, $2::uuid) AS result",
          [identity.playerId, requestKey],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "idempotency_conflict", "market_test_seed_forbidden", "market_test_stock_not_empty", "save_not_found",
        ]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "market_test_seed_failed", requestId);
      }
    }
    if (["market_list_item", "market_cancel_listing", "market_buy_listing"].includes(String(parsed.value.action))) {
      const action = String(parsed.value.action);
      const allowedFields = action === "market_list_item" ? ["item_id", "price"] : ["listing_id"];
      const payloadError = validatePayloadFields(payload, allowedFields);
      const requestKey = idempotencyKey(parsed.value);
      const itemId = payload.item_id;
      const listingId = payload.listing_id;
      const price = Number(payload.price);
      const valid = !payloadError && requestKey && (action === "market_list_item"
        ? typeof itemId === "string" && uuidPattern.test(itemId) && Number.isSafeInteger(price) && price >= 1 && price <= 1_000_000_000
        : typeof listingId === "string" && uuidPattern.test(listingId));
      if (!valid) return errorResponse(400, payloadError ?? "invalid_market_request", requestId);
      try {
        const result = action === "market_list_item"
          ? await databaseJson(
            "SELECT heroloop_api.market_list_item($1::uuid, $2::uuid, $3::uuid, $4::bigint) AS result",
            [identity.playerId, requestKey, itemId, price],
          )
          : await databaseJson(
            `SELECT heroloop_api.${action === "market_cancel_listing" ? "market_cancel_listing" : "market_buy_listing"}($1::uuid, $2::uuid, $3::uuid) AS result`,
            [identity.playerId, requestKey, listingId],
          );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "idempotency_conflict", "invalid_market_price", "market_test_limit_reached", "market_test_item_required",
          "market_listing_unavailable", "market_self_purchase", "market_seller_limit_reached", "insufficient_tokens",
          "item_not_found", "item_locked", "item_equipped", "item_state_mismatch", "item_capacity_exceeded", "save_not_found",
        ]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "market_settlement_failed", requestId);
      }
    }
    if (parsed.value.action === "set_boost_max_active") {
      const payloadError = validatePayloadFields(payload, ["active"]);
      if (payloadError || typeof payload.active !== "boolean") {
        return errorResponse(400, payloadError ?? "invalid_boost_state", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.set_boost_max_active($1::uuid, $2::boolean) AS result",
          [identity.playerId, payload.active],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, ["boost_max_requirements_not_met", "insufficient_tokens"]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(400, "boost_max_update_failed", requestId);
      }
    }
    if (parsed.value.action === "summon_boss") {
      const payloadError = validatePayloadFields(payload, ["location"]);
      const location = Number(payload.location);
      const key = idempotencyKey(parsed.value);
      if (payloadError || !key || !Number.isSafeInteger(location) || location < 1 || location > 10_000) {
        return errorResponse(400, payloadError ?? "invalid_boss_location", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.summon_boss($1::uuid, $2::integer, $3::uuid) AS result",
          [identity.playerId, location, key],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, ["resource_insufficient_balance", "resource_idempotency_conflict", "active_encounter_exists"]);
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(503, "boss_summon_failed", requestId);
      }
    }
    if (parsed.value.action === "remove_limited_item") {
      const payloadError = validatePayloadFields(payload, ["item_id"]);
      if (payloadError || typeof payload.item_id !== "string" || !uuidPattern.test(payload.item_id)) {
        return errorResponse(400, payloadError ?? "invalid_item_id", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.remove_limited_item($1::uuid, $2::uuid) AS result",
          [identity.playerId, payload.item_id],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        return errorResponse(400, "item_removal_failed", requestId);
      }
    }
    if (parsed.value.action === "dungeon_status") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const result = await databaseJsonReadRetryOnce(
          "SELECT heroloop_api.dungeon_status($1::uuid) AS result",
          [identity.playerId],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        if (databaseErrorCode(error, ["save_not_found"])) return errorResponse(403, "account_required", requestId);
        return errorResponse(503, "dungeon_status_failed", requestId);
      }
    }
    if (parsed.value.action === "dungeon_start") {
      const payloadError = validatePayloadFields(payload, ["depth"]);
      const requestKey = idempotencyKey(parsed.value);
      const depth = Number(payload.depth);
      if (payloadError || !requestKey || !Number.isSafeInteger(depth) || depth < 1 || depth > 3) {
        return errorResponse(400, payloadError ?? "dungeon_invalid_depth", requestId);
      }
      try {
        const result = await databaseJson(
          "SELECT heroloop_api.dungeon_start($1::uuid, $2::integer, $3::uuid) AS result",
          [identity.playerId, depth, requestKey],
        );
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "idempotency_conflict", "dungeon_invalid_depth", "dungeon_invalid_progression", "dungeon_invalid_formation",
          "dungeon_equipment_state_mismatch", "dungeon_depth_locked", "dungeon_attempts_exhausted", "active_encounter_exists", "save_not_found",
        ]);
        if (code === "save_not_found") return errorResponse(403, "account_required", requestId);
        if (["dungeon_invalid_depth", "dungeon_invalid_progression", "dungeon_invalid_formation", "dungeon_equipment_state_mismatch"].includes(String(code))) {
          return errorResponse(400, String(code), requestId);
        }
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(503, "dungeon_start_failed", requestId);
      }
    }
    if (["dungeon_room_start", "dungeon_room_action", "dungeon_room_complete", "dungeon_room_choose", "dungeon_abandon"].includes(String(parsed.value.action))) {
      const action = String(parsed.value.action);
      const extraField = action === "dungeon_room_action" ? "command" : action === "dungeon_room_choose" ? "choice" : null;
      const payloadError = validatePayloadFields(payload, ["encounter_id", "expected_revision", ...(extraField ? [extraField] : [])]);
      const requestKey = idempotencyKey(parsed.value);
      const encounterId = payload.encounter_id;
      const expectedRevision = Number(payload.expected_revision);
      const validExtra = action === "dungeon_room_action" ? payload.command === "resolve"
        : action === "dungeon_room_choose" ? ["recovery", "treasure"].includes(String(payload.choice)) : true;
      if (payloadError || !requestKey || typeof encounterId !== "string" || !uuidPattern.test(encounterId) ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !validExtra) {
        return errorResponse(400, payloadError ?? "invalid_dungeon_request", requestId);
      }
      try {
        const functionName = action;
        const query = action === "dungeon_room_action"
          ? `SELECT heroloop_api.${functionName}($1::uuid, $2::uuid, $3::bigint, $4::text, $5::uuid) AS result`
          : action === "dungeon_room_choose"
          ? `SELECT heroloop_api.${functionName}($1::uuid, $2::uuid, $3::bigint, $4::text, $5::uuid) AS result`
          : `SELECT heroloop_api.${functionName}($1::uuid, $2::uuid, $3::bigint, $4::uuid) AS result`;
        const args = action === "dungeon_room_action"
          ? [identity.playerId, encounterId, expectedRevision, payload.command, requestKey]
          : action === "dungeon_room_choose"
          ? [identity.playerId, encounterId, expectedRevision, payload.choice, requestKey]
          : [identity.playerId, encounterId, expectedRevision, requestKey];
        const result = await databaseJson(query, args);
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch (error) {
        const code = databaseErrorCode(error, [
          "idempotency_conflict", "dungeon_invalid_revision", "dungeon_invalid_action", "dungeon_invalid_choice",
          "dungeon_encounter_not_found", "dungeon_encounter_not_active", "dungeon_revision_conflict",
          "dungeon_room_not_available", "dungeon_room_already_started", "dungeon_room_not_ready",
          "dungeon_room_already_resolved", "dungeon_room_not_resolved", "dungeon_room_state_invalid",
          "dungeon_run_state_invalid", "dungeon_combat_version_mismatch",
        ]);
        if (["dungeon_invalid_revision", "dungeon_invalid_action", "dungeon_invalid_choice"].includes(String(code))) {
          return errorResponse(400, String(code), requestId);
        }
        if (code) return errorResponse(409, code, requestId);
        return errorResponse(503, `${action}_failed`, requestId);
      }
    }
    if (parsed.value.action === "leaderboard") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const context = await databaseJson(
          "SELECT heroloop_api.leaderboard($1::uuid) AS result",
          [identity.playerId],
        );
        const result = prepareLeaderboardResult(context, identity.playerId);
        if ("code" in result) return errorResponse(result.status, result.code, requestId);
        return json(200, { ok: true, contract_version: 1, request_id: requestId, result });
      } catch {
        console.error("leaderboard database adapter failed", { requestId });
        return errorResponse(503, "leaderboard_unavailable", requestId);
      }
    }
    if (parsed.value.action === "status") {
      const payloadError = validatePayloadFields(payload, []);
      if (payloadError) return errorResponse(400, payloadError, requestId);
      try {
        const context = await databaseJson(
          "SELECT heroloop_api.status_context($1::uuid) AS result",
          [identity.playerId],
        );
        context.resources = await databaseJson(
          "SELECT heroloop_api.resource_snapshot($1::uuid) AS result",
          [identity.playerId],
        );
        return json(200, {
          ok: true,
          contract_version: 1,
          request_id: requestId,
          result: prepareStatusResult(context, Date.now()),
        });
      } catch {
        console.error("status database adapter failed", { requestId });
        return errorResponse(503, "status_unavailable", requestId);
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
        if (isRecord(context.state)) {
          context.resources = await databaseJson(
            "SELECT heroloop_api.resource_snapshot($1::uuid) AS result",
            [identity.playerId],
          );
        }
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
          if (loaded.schemaMigrated && recoveredCount === 0) {
            const committed = await databaseJson(
              "SELECT heroloop_api.game_state_save_commit($1::uuid, $2::bigint, $3::jsonb) AS result",
              [identity.playerId, revision, JSON.stringify(state)],
            );
            const committedRevision = Number(committed.revision);
            if (committed.conflict !== true && Number.isSafeInteger(committedRevision) && committedRevision > revision) {
              state = isRecord(committed.state) ? committed.state : state;
              revision = committedRevision;
            }
          }
        }
        const result: JsonRecord = { state, revision };
        if (loaded.migratedItems > 0) result.migrated_items = loaded.migratedItems;
        if (loaded.schemaMigrated) result.save_schema_migrated = true;
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
        if (isRecord(context.state)) {
          context.resources = await databaseJson(
            "SELECT heroloop_api.resource_snapshot($1::uuid) AS result",
            [identity.playerId],
          );
        }
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
        if (isRecord(context.state)) {
          context.resources = await databaseJson(
            "SELECT heroloop_api.resource_snapshot($1::uuid) AS result",
            [identity.playerId],
          );
        }
        const currentRevision = Number(context.revision);
        if (Number.isSafeInteger(currentRevision) && currentRevision !== requestedRevision) {
          const conflictState = canonicalResourceState(context.state, context.resources);
          if (!conflictState) return errorResponse(503, "resource_state_unavailable", requestId);
          return json(409, {
            ok: false,
            code: "state_conflict",
            request_id: requestId,
            revision: currentRevision,
            result: { state: conflictState, revision: currentRevision, conflict: true },
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
