import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { buildRegisteredState, STARTER_HERO_IDS } from "./registration.js";
import { allowedGoldCredit, applyTrainingPurchases, deriveServerSummary, preserveHeroOwnership, serverLocationCap } from "./authority.mjs";
import { applyResourceSnapshot, validRegistrationShell, validateAndMigrateGameState } from "./save-schema.mjs";

const ALLOWED_ORIGINS = new Set(
  (Deno.env.get("ALLOWED_ORIGINS") ?? "http://heroloop.xyz,http://www.heroloop.xyz,https://heroloop.xyz,https://www.heroloop.xyz")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

const corsHeadersBase = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function corsHeadersFor(origin: string | null): Record<string, string> {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return { ...corsHeadersBase, "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { ...corsHeadersBase, Vary: "Origin" };
}

const testerControlsEnabled = Deno.env.get("HEROLOOP_ENVIRONMENT") === "staging";
const PLAYER_ACTIONS = new Set([
  "account_status", "game_state_load", "game_state_migrate", "game_state_save", "account_register",
    "account_delete", "sync", "claim", "tester_credit_tokens", "tester_credit_gold", "tester_credit_account_xp", "tester_credit_formation_xp", "promo_redeem", "spend_tokens", "hero_summon_quote", "hero_summon", "hero_ascend", "hero_release", "training_assignment_set", "hero_capacity_quote", "hero_capacity_upgrade", "ascension_focus_set",
  "chest_open", "tutorial_quest_claim", "quest_claim", "tutorial_chest_open", "item_mutate", "item_equip", "item_upgrade", "set_boost_max_active", "leaderboard", "status", "summon_boss", "reserve_limited_item", "remove_limited_item",
  "store_snapshot", "store_buy_item",
  "market_snapshot", "market_list_item", "market_cancel_listing", "market_buy_listing",
  "market_seed_test_stock",
  "dungeon_status", "dungeon_start", "dungeon_room_start", "dungeon_room_action", "dungeon_room_complete", "dungeon_room_choose", "dungeon_abandon", "boss_claim",
]);
const ACTION_FIELDS: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  account_status: ["action"],
  game_state_load: ["action"],
  game_state_migrate: ["action", "state"],
  game_state_save: ["action", "state", "revision"],
  account_register: ["action", "username", "starter_hero_id", "state"],
  account_delete: ["action"],
  sync: [
    "action", "player_id", "power", "account_level", "username", "total_kills", "boss_kills", "chests_opened",
    "heroes_owned", "highest_location", "lineup", "avatar_hero_id", "summons", "total_tokens_earned",
    "token_eligible", "training_hero_count",
  ],
  claim: ["action", "player_id"],
  tester_credit_tokens: ["action"],
  tester_credit_gold: ["action"],
  tester_credit_account_xp: ["action"],
  tester_credit_formation_xp: ["action"],
  promo_redeem: ["action", "code", "idempotency_key"],
  spend_tokens: ["action", "amount", "action_kind", "idempotency_key"],
  hero_summon_quote: ["action", "count", "expected_revision"],
  hero_summon: ["action", "count", "expected_revision", "payment_method", "quote_id", "idempotency_key"],
  hero_ascend: ["action", "target_uid", "target_uids", "repeat", "idempotency_key"],
  hero_release: ["action", "hero_uid", "expected_revision", "idempotency_key"],
  training_assignment_set: ["action", "slot_index", "hero_uid", "expected_revision", "idempotency_key"],
  hero_capacity_quote: ["action", "expected_revision"],
  hero_capacity_upgrade: ["action", "expected_revision", "quote_id", "idempotency_key"],
  ascension_focus_set: ["action", "rarity", "target_hero_id", "idempotency_key"],
  chest_open: ["action", "count", "idempotency_key"],
  tutorial_quest_claim: ["action", "quest_id", "expected_revision", "idempotency_key"],
  quest_claim: ["action", "quest_id", "expected_revision", "idempotency_key"],
  tutorial_chest_open: ["action", "count", "idempotency_key"],
  item_mutate: ["action", "operation", "item_uids", "locked", "idempotency_key"],
  item_equip: ["action", "assignments", "idempotency_key"],
  item_upgrade: ["action", "operation", "item_uid", "use_charm", "idempotency_key"],
  store_snapshot: ["action"],
  store_buy_item: ["action", "slot_index", "refresh_at", "idempotency_key"],
  set_boost_max_active: ["action", "active"],
  leaderboard: ["action"],
  status: ["action", "player_id"],
  summon_boss: ["action", "location", "idempotency_key"],
  reserve_limited_item: ["action", "base_item_id", "slot", "rarity", "item_level", "stats"],
  remove_limited_item: ["action", "item_id"],
  market_snapshot: ["action"],
  market_list_item: ["action", "item_id", "price", "idempotency_key"],
  market_cancel_listing: ["action", "listing_id", "idempotency_key"],
  market_buy_listing: ["action", "listing_id", "idempotency_key"],
  market_seed_test_stock: ["action", "idempotency_key"],
  dungeon_status: ["action"],
  dungeon_start: ["action", "depth", "idempotency_key"],
  dungeon_room_start: ["action", "encounter_id", "expected_revision", "idempotency_key"],
  dungeon_room_action: ["action", "encounter_id", "expected_revision", "command", "idempotency_key"],
  dungeon_room_complete: ["action", "encounter_id", "expected_revision", "idempotency_key"],
  dungeon_room_choose: ["action", "encounter_id", "expected_revision", "choice", "idempotency_key"],
  dungeon_abandon: ["action", "encounter_id", "expected_revision", "idempotency_key"],
  boss_claim: ["action", "encounter_id", "expected_revision", "idempotency_key"],
}).map(([action, fields]) => [action, new Set(fields)]));
const ACTION_RATE_LIMITS: Record<string, readonly [number, number]> = {
  account_status: [20, 60], game_state_load: [20, 60], game_state_migrate: [3, 60], game_state_save: [30, 60],
  account_register: [5, 300], account_delete: [3, 300], sync: [30, 60], claim: [2, 60], tester_credit_tokens: [5, 60], tester_credit_gold: [5, 60], tester_credit_account_xp: [5, 60], tester_credit_formation_xp: [5, 60], promo_redeem: [10, 300],
  spend_tokens: [20, 60], hero_summon_quote: [20, 60], hero_summon: [10, 60], hero_ascend: [20, 60], hero_release: [10, 60], training_assignment_set: [20, 60], hero_capacity_quote: [20, 60], hero_capacity_upgrade: [10, 60], ascension_focus_set: [20, 60], chest_open: [10, 60], tutorial_quest_claim: [20, 60], quest_claim: [20, 60], tutorial_chest_open: [10, 60], item_mutate: [30, 60], item_equip: [30, 60], item_upgrade: [20, 60], set_boost_max_active: [10, 60],
  store_snapshot: [20, 60], store_buy_item: [20, 60],
  leaderboard: [10, 60], status: [60, 60], summon_boss: [2, 300], reserve_limited_item: [30, 60], remove_limited_item: [30, 60],
  market_snapshot: [30, 60], market_list_item: [20, 60], market_cancel_listing: [20, 60], market_buy_listing: [20, 60],
  market_seed_test_stock: [2, 300],
  dungeon_status: [20, 60], dungeon_start: [12, 300], dungeon_room_start: [20, 60],
  dungeon_room_action: [10, 60], dungeon_room_complete: [10, 60], dungeon_room_choose: [10, 60], dungeon_abandon: [10, 60], boss_claim: [5, 60],
};
const BLOCKED_USERNAME_PARTS = [
  "fuck", "shit", "cunt", "dick", "pussy", "bitch", "asshole", "whore", "slut",
  "nigg", "fagg", "retard", "huy", "hui", "khuy", "pizd", "blya", "blia",
  "suka", "syka", "mudak", "dolboeb", "dolboyob", "eblan", "eban", "yeban", "zalupa", "zhopa",
];

function hasBlockedUsernameLanguage(value: string): boolean {
  const leet: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };
  const normalized = value.toLowerCase().replace(/[013457@$]/g, (char) => leet[char] ?? char).replace(/[^a-z]/g, "");
  return BLOCKED_USERNAME_PARTS.some((part) => normalized.includes(part));
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).message === "string") {
    return (value as Record<string, unknown>).message as string;
  }
  return String(value ?? "unknown_error");
}

function allowedErrorCode(value: unknown, allowed: string[], fallback: string): string {
  const message = errorMessage(value);
  return allowed.find((code) => message.includes(code)) ?? fallback;
}

function internalError(headers: Record<string, string>, requestId: string, code: string, detail: unknown): Response {
  console.error(JSON.stringify({ request_id: requestId, error: code, detail: errorMessage(detail) }));
  return new Response(JSON.stringify({ error: code, request_id: requestId }), {
    status: 500,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalFiniteNumbers(body: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((field) => body[field] === undefined || isFiniteNumber(body[field]));
}

function validActionPayload(action: string, body: Record<string, unknown>): boolean {
  const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
  const optionalPlayerId = body.player_id === undefined || (typeof body.player_id === "string" && body.player_id.length <= 64);
  if (!optionalPlayerId) return false;

  switch (action) {
    case "game_state_migrate":
      return isRecord(body.state);
    case "game_state_save":
      return isRecord(body.state) && Number.isSafeInteger(body.revision) && Number(body.revision) >= 1;
    case "account_register":
      return typeof body.username === "string" && typeof body.starter_hero_id === "string" && isRecord(body.state);
    case "sync": {
      if (!isFiniteNumber(body.power) || !isFiniteNumber(body.account_level) || typeof body.username !== "string") return false;
      if (!optionalFiniteNumbers(body, ["total_kills", "boss_kills", "chests_opened", "heroes_owned", "highest_location", "summons", "total_tokens_earned", "training_hero_count"])) return false;
      if (body.token_eligible !== undefined && typeof body.token_eligible !== "boolean") return false;
      if (body.avatar_hero_id !== undefined && typeof body.avatar_hero_id !== "string") return false;
      if (body.lineup !== undefined && (!Array.isArray(body.lineup) || body.lineup.length > 3 || body.lineup.some((entry) =>
        !isRecord(entry) || Object.keys(entry).some((field) => !["hero_id", "level", "stars"].includes(field))
        || typeof entry.hero_id !== "string" || !isFiniteNumber(entry.level) || !isFiniteNumber(entry.stars)
      ))) return false;
      return true;
    }
    case "spend_tokens":
      return uuid(body.idempotency_key) && isFiniteNumber(body.amount) && typeof body.action_kind === "string";
    case "promo_redeem":
      return uuid(body.idempotency_key) && typeof body.code === "string" && /^[A-Za-z0-9 -]{4,40}$/.test(body.code);
    case "hero_summon_quote":
      return isFiniteNumber(body.count) && Number.isInteger(body.count) && [1, 10, 100].includes(Number(body.count))
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    case "hero_summon":
      return uuid(body.idempotency_key) && isFiniteNumber(body.count) && Number.isInteger(body.count)
        && [1, 10, 100].includes(Number(body.count))
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1
        && (body.payment_method === "paid" || body.payment_method === "scroll")
        && ((body.payment_method === "paid" && uuid(body.quote_id)) || (body.payment_method === "scroll" && body.quote_id === null));
    case "ascension_focus_set":
      return uuid(body.idempotency_key) && typeof body.rarity === "string"
        && (body.target_hero_id === null || typeof body.target_hero_id === "string");
    case "hero_ascend":
      return uuid(body.idempotency_key) && typeof body.repeat === "boolean"
        && ((typeof body.target_uid === "string" && body.target_uids === undefined) || (body.target_uid === undefined && body.repeat === true
          && Array.isArray(body.target_uids) && body.target_uids.length >= 1 && body.target_uids.length <= 45
          && body.target_uids.every((uid) => typeof uid === "string" && uid.length >= 1 && uid.length <= 100)
          && new Set(body.target_uids).size === body.target_uids.length));
    case "hero_release":
      return uuid(body.idempotency_key) && typeof body.hero_uid === "string"
        && body.hero_uid.length >= 1 && body.hero_uid.length <= 100
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    case "training_assignment_set":
      return uuid(body.idempotency_key) && Number.isSafeInteger(body.slot_index)
        && Number(body.slot_index) >= 0 && Number(body.slot_index) <= 9
        && (body.hero_uid === null || (typeof body.hero_uid === "string" && body.hero_uid.length >= 1 && body.hero_uid.length <= 100))
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    case "hero_capacity_quote":
      return Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    case "hero_capacity_upgrade":
      return uuid(body.idempotency_key) && uuid(body.quote_id)
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    case "chest_open":
      return uuid(body.idempotency_key) && isFiniteNumber(body.count) && Number.isInteger(body.count) && body.count >= 1 && body.count <= 64;
    case "tutorial_quest_claim":
    case "quest_claim":
      return uuid(body.idempotency_key) && typeof body.quest_id === "string" && /^[a-z0-9-]{3,64}$/.test(body.quest_id)
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    case "tutorial_chest_open":
      return uuid(body.idempotency_key) && (body.count === 1 || body.count === 10);
    case "item_mutate":
      return uuid(body.idempotency_key) && ["lock", "sell"].includes(String(body.operation))
        && Array.isArray(body.item_uids) && body.item_uids.length >= 1 && body.item_uids.length <= 256
        && body.item_uids.every(uuid)
        && (body.operation === "sell" || (body.item_uids.length === 1 && typeof body.locked === "boolean"));
    case "item_equip":
      return uuid(body.idempotency_key) && Array.isArray(body.assignments) && body.assignments.length <= 64
        && body.assignments.every((assignment) => isRecord(assignment)
          && Object.keys(assignment).sort().join(",") === "hero_uid,item_uid,slot"
          && uuid(assignment.item_uid)
          && typeof assignment.hero_uid === "string" && assignment.hero_uid.length >= 1 && assignment.hero_uid.length <= 100
          && ["class_weapon", "offhand", "helmet", "chest", "gloves", "boots", "ring", "amulet"].includes(String(assignment.slot)));
    case "item_upgrade":
      return uuid(body.idempotency_key) && uuid(body.item_uid)
        && ["enchant", "reroll"].includes(String(body.operation))
        && typeof body.use_charm === "boolean"
        && (body.operation === "enchant" || body.use_charm === false);
    case "set_boost_max_active":
      return typeof body.active === "boolean";
    case "summon_boss":
      return isFiniteNumber(body.location) && uuid(body.idempotency_key);
    case "reserve_limited_item":
      return typeof body.base_item_id === "string" && typeof body.slot === "string" && typeof body.rarity === "string"
        && isFiniteNumber(body.item_level) && Array.isArray(body.stats) && body.stats.length <= 20
        && body.stats.every((stat) => isRecord(stat)
          && Object.keys(stat).every((field) => ["key", "value", "isPercent"].includes(field))
          && ["hp", "atk", "def", "atkSpeed", "critChance", "critDamage", "goldBonus", "xpBonus", "dodge"].includes(String(stat.key))
          && isFiniteNumber(stat.value) && typeof stat.isPercent === "boolean");
    case "remove_limited_item":
      return typeof body.item_id === "string" && body.item_id.length > 0 && body.item_id.length <= 100;
    case "market_list_item":
      return uuid(body.idempotency_key) && uuid(body.item_id) && Number.isSafeInteger(body.price)
        && Number(body.price) >= 1 && Number(body.price) <= 1_000_000_000;
    case "market_cancel_listing":
    case "market_buy_listing":
      return uuid(body.idempotency_key) && uuid(body.listing_id);
    case "market_seed_test_stock":
      return uuid(body.idempotency_key);
    case "dungeon_start":
      return uuid(body.idempotency_key) && Number.isSafeInteger(body.depth)
        && Number(body.depth) >= 1 && Number(body.depth) <= 3;
    case "dungeon_abandon":
    case "boss_claim":
    case "dungeon_room_start":
    case "dungeon_room_complete":
      return uuid(body.idempotency_key) && uuid(body.encounter_id)
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    case "dungeon_room_action":
      return uuid(body.idempotency_key) && uuid(body.encounter_id) && body.command === "resolve"
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    case "dungeon_room_choose":
      return uuid(body.idempotency_key) && uuid(body.encounter_id)
        && (body.choice === "recovery" || body.choice === "treasure")
        && Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 1;
    default:
      return true;
  }
}

function persistentState(value: Record<string, unknown>, username: string, playerId: string): Record<string, unknown> | null {
  const serialized = JSON.stringify(value);
  if (serialized.length > 1_000_000) return null;
  const state = JSON.parse(serialized) as Record<string, unknown>;
  state.username = username;
  state.walletAddress = `game-${playerId}`;
  state.bossBattleActive = false;
  return state;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

async function recoverMissingFormationHeroes(
  supabase: ReturnType<typeof createClient>,
  playerId: string,
  sourceState: Record<string, unknown>,
): Promise<{ state: Record<string, unknown>; recovered: number }> {
  const ownedHeroes = recordArray(sourceState.ownedHeroes);
  const team = Array.isArray(sourceState.team)
    ? sourceState.team.filter((uid): uid is string => typeof uid === "string" && uid.length > 0).slice(0, 3)
    : [];
  const ownedUids = new Set(ownedHeroes.map((hero) => String(hero.uid ?? "")));
  const missingUids = [...new Set(team.filter((uid) => !ownedUids.has(uid)))];
  if (missingUids.length === 0) return { state: sourceState, recovered: 0 };

  const recovered: Record<string, unknown>[] = [];
  for (const uid of missingUids) {
    const { data: events } = await supabase
      .from("summon_events")
      .select("result")
      .eq("player_id", playerId)
      .contains("result", { heroes: [{ uid }] })
      .order("created_at", { ascending: false })
      .limit(1);
    const exactHero = recordArray((events?.[0]?.result as Record<string, unknown> | undefined)?.heroes)
      .find((hero) => hero.uid === uid);
    if (exactHero) recovered.push(exactHero);
  }

  const unresolvedUids = missingUids.filter((uid) => !recovered.some((hero) => hero.uid === uid));
  if (unresolvedUids.length > 0) {
    const { data: player } = await supabase.from("players").select("lineup").eq("player_id", playerId).maybeSingle();
    const remainingLineup = [...recordArray(player?.lineup)];
    for (const uid of team) {
      const owned = [...ownedHeroes, ...recovered].find((hero) => hero.uid === uid);
      if (!owned) continue;
      const index = remainingLineup.findIndex((entry) =>
        entry.hero_id === owned.heroId
        && Number(entry.level) === Number(owned.level)
        && Number(entry.stars) === Number(owned.stars));
      if (index >= 0) remainingLineup.splice(index, 1);
    }
    const validHeroId = /^(shepherd|assassin|knight|druid|archer)-(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$/;
    if (remainingLineup.length === unresolvedUids.length && remainingLineup.every((entry) => validHeroId.test(String(entry.hero_id ?? "")))) {
      unresolvedUids.forEach((uid, index) => {
        const entry = remainingLineup[index];
        recovered.push({
          uid,
          heroId: entry.hero_id,
          level: Math.max(1, Math.floor(Number(entry.level) || 1)),
          stars: Math.max(0, Math.min(20, Math.floor(Number(entry.stars) || 0))),
          equipped: {},
          xp: 0,
        });
      });
    }
  }

  return recovered.length > 0
    ? { state: { ...sourceState, ownedHeroes: [...ownedHeroes, ...recovered] }, recovered: recovered.length }
    : { state: sourceState, recovered: 0 };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const headers = corsHeadersFor(origin);
  const requestId = crypto.randomUUID();

  if (req.method === "OPTIONS") {
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(null, { status: 403, headers });
    }
    return new Response(null, { status: 200, headers });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { ...headers, Allow: "POST, OPTIONS", "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const accessToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!accessToken) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const authClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
    );
    const { data: authData, error: authError } = await authClient.auth.getUser(accessToken);
    if (authError || !authData.user) {
      return new Response(
        JSON.stringify({ error: "Invalid session" }),
        { status: 401, headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return new Response(JSON.stringify({ error: "invalid_json" }), {
        status: 400, headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    const { action } = body;
    if (typeof action !== "string" || !PLAYER_ACTIONS.has(action)) {
      return new Response(JSON.stringify({ error: "unknown_action" }), {
        status: 400, headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    if (Object.keys(body).some((field) => !ACTION_FIELDS[action].has(field))) {
      return new Response(JSON.stringify({ error: "invalid_fields" }), {
        status: 400, headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    if (!validActionPayload(action, body)) {
      return new Response(JSON.stringify({ error: "invalid_payload" }), {
        status: 400, headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    const player_id = authData.user.id;
    const [rateLimit, rateWindowSeconds] = ACTION_RATE_LIMITS[action];
    const { data: rateAllowed, error: rateError } = await supabase.rpc("consume_edge_rate_limit", {
      p_subject_key: `player:${player_id}`,
      p_action: action,
      p_limit: rateLimit,
      p_window_seconds: rateWindowSeconds,
    });
    if (rateError) return internalError(headers, requestId, "rate_limit_unavailable", rateError);
    if (rateAllowed !== true) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { ...headers, "Content-Type": "application/json", "Retry-After": String(rateWindowSeconds) },
      });
    }

    if (action === "account_status") {
      const { data: storedPlayer, error } = await supabase
        .from("players")
        .select("username")
        .eq("player_id", player_id)
        .maybeSingle();
      let player = storedPlayer;
      if (error) {
        return internalError(headers, requestId, "account_status_failed", error);
      }

      // v21 briefly deleted live `players` rows when an Admin Auth lookup in
      // the leaderboard suffered a transient error. `player_saves` references
      // Auth directly, so it survives that deletion and is the safest recovery
      // source for the authenticated owner.
      if (!player) {
        const { data: save, error: saveError } = await supabase
          .from("player_saves")
          .select("state")
          .eq("player_id", player_id)
          .maybeSingle();
        if (saveError) {
          return new Response(JSON.stringify({ error: "account_recovery_unavailable" }), {
            status: 500, headers: { ...headers, "Content-Type": "application/json" },
          });
        }
        if (save?.state && typeof save.state === "object" && !Array.isArray(save.state)) {
          const savedState = save.state as Record<string, unknown>;
          const username = typeof savedState.username === "string"
            ? savedState.username.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16)
            : "";
          const safeInt = (value: unknown, max: number) => Math.min(max, Math.max(0, Math.floor(Number(value) || 0)));
          const ownedHeroes = recordArray(savedState.ownedHeroes);
          const heroesByUid = new Map(ownedHeroes.map((hero) => [String(hero.uid ?? ""), hero]));
          const lineup = (Array.isArray(savedState.team) ? savedState.team : []).slice(0, 3).flatMap((uid) => {
            const hero = heroesByUid.get(String(uid));
            const heroId = typeof hero?.heroId === "string" ? hero.heroId.replace(/[^a-z0-9_-]/gi, "").slice(0, 64) : "";
            return heroId ? [{ hero_id: heroId, level: Math.max(1, safeInt(hero?.level, 200)), stars: safeInt(hero?.stars, 20) }] : [];
          });
          if (username.length >= 3 && ownedHeroes.length > 0) {
            const { data: recovered, error: recoveryError } = await supabase.from("players").insert({
              player_id,
              username,
              online: true,
              last_heartbeat: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              account_level: Math.max(1, safeInt(savedState.accountLevel, 200)),
              token_balance: safeInt(savedState.hero, 1_000_000_000_000),
              summons: safeInt(savedState.summons, 1_000_000_000),
              total_tokens_earned: safeInt(savedState.totalTokensEarned, 1_000_000_000_000),
              total_kills: safeInt(savedState.totalKills, 1_000_000_000),
              boss_kills: safeInt(savedState.totalBossKills, 1_000_000_000),
              heroes_owned: Math.min(500, ownedHeroes.length),
              highest_location: Math.max(1, safeInt(savedState.highestLocation, 10_000)),
              boss_keys: safeInt(savedState.bossKeys, 1_000_000),
              lineup,
              avatar_hero_id: typeof savedState.avatarHeroId === "string" ? savedState.avatarHeroId.slice(0, 64) : "",
            }).select("username").single();
            if (recoveryError || !recovered) {
              return new Response(JSON.stringify({ error: "account_recovery_failed" }), {
                status: 500, headers: { ...headers, "Content-Type": "application/json" },
              });
            }
            player = recovered;
          }
        }
      }
      return new Response(JSON.stringify({ exists: Boolean(player), username: player?.username ?? null, account_id: player_id }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "game_state_load") {
      const { data: legacyMarketRecovery, error: legacyMarketError } = await supabase.rpc(
        "migrate_legacy_market_listings",
        { p_player_id: player_id },
      );
      if (legacyMarketError || !isRecord(legacyMarketRecovery)) {
        return new Response(JSON.stringify({ error: "state_unavailable" }), {
          status: 500, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data: migratedSave, error } = await supabase.rpc("migrate_legacy_player_items", { p_player_id: player_id });
      const save = isRecord(migratedSave) ? migratedSave : null;
      if (error) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
      if (!save?.state || save.revision === null) {
        return new Response(JSON.stringify({ state: null, revision: null }), { headers: { ...headers, "Content-Type": "application/json" } });
      }
      const { data: ledgerRows, error: ledgerError } = await supabase.from("player_items")
        .select("id, base_item_id, item_level, stats, power, locked, enchant_level, reroll_count, enchant_stats_version, item_roll_version")
        .eq("player_id", player_id).is("removed_at", null);
      if (ledgerError) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
      const ledgerById = new Map((ledgerRows ?? []).map((row) => [String(row.id), row]));
      let loadedState = save.state as Record<string, unknown>;
      const staleServerItemIds = new Set(recordArray(loadedState.inventory)
        .filter((item) => item.serverOwned === true && !ledgerById.has(String(item.uid ?? "")))
        .map((item) => String(item.uid ?? "")));
      if (staleServerItemIds.size > 0) {
        return new Response(JSON.stringify({ error: "item_registry_incomplete" }), { status: 409, headers: { ...headers, "Content-Type": "application/json" } });
      }
      loadedState.inventory = recordArray(loadedState.inventory).map((item) => {
        const row = ledgerById.get(String(item.uid ?? ""));
        return row === undefined ? item : {
          ...item, itemId: row.base_item_id, level: Number(row.item_level), stats: row.stats,
          power: Number(row.power), serverOwned: true, locked: row.locked === true,
          enchantLevel: Number(row.enchant_level), rerollCount: Number(row.reroll_count),
          enchantStatsVersion: Number(row.enchant_stats_version),
          itemRollVersion: Number(row.item_roll_version),
        };
      });
      const { data: loadedResources, error: loadedResourcesError } = await supabase.rpc("resource_snapshot", { p_player_id: player_id });
      const resourceState = applyResourceSnapshot(loadedState, loadedResources);
      if (loadedResourcesError || !resourceState.ok) return new Response(JSON.stringify({ error: "resource_state_unavailable" }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });
      loadedState = resourceState.state;
      const validatedLoaded = validateAndMigrateGameState(loadedState, { allowMissingTeamReferences: true });
      if (!validatedLoaded.ok) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });
      loadedState = validatedLoaded.state;
      const repaired = await recoverMissingFormationHeroes(supabase, player_id, loadedState);
      if (repaired.recovered > 0 || validatedLoaded.migrated) {
        const { data: updated } = await supabase.from("player_saves")
          .update({ state: repaired.state, revision: Number(save.revision) + 1, updated_at: new Date().toISOString() })
          .eq("player_id", player_id)
          .eq("revision", save.revision)
          .select("state, revision")
          .maybeSingle();
        if (updated) {
          return new Response(JSON.stringify({ state: updated.state, revision: updated.revision, recovered_formation_heroes: repaired.recovered, save_schema_migrated: validatedLoaded.migrated, legacy_market_recovery: legacyMarketRecovery }), {
            headers: { ...headers, "Content-Type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ state: loadedState, revision: save.revision, migrated_items: Number(save.migrated_items) || 0, legacy_market_recovery: legacyMarketRecovery }), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "game_state_migrate" || action === "game_state_save") {
      const { data: player } = await supabase.from("players").select("username, token_balance, summons").eq("player_id", player_id).maybeSingle();
      if (!player) return new Response(JSON.stringify({ error: "account_required" }), { status: 403, headers: { ...headers, "Content-Type": "application/json" } });
      const state = persistentState(body.state, player.username, player_id);
      if (!state) return new Response(JSON.stringify({ error: "state_too_large" }), { status: 413, headers: { ...headers, "Content-Type": "application/json" } });
      state.hero = Number(player.token_balance);
      state.summons = Number(player.summons);

      if (action === "game_state_migrate") {
        const validated = validateAndMigrateGameState(state, { allowMissingTeamReferences: true });
        if (!validated.ok) return new Response(JSON.stringify({ error: validated.code ?? "invalid_state" }), { status: validated.code === "state_too_large" ? 413 : 400, headers: { ...headers, "Content-Type": "application/json" } });
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, validated.state);
        const { data: existing, error: existingError } = await supabase.from("player_saves").select("state, revision").eq("player_id", player_id).maybeSingle();
        if (existingError) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
        if (existing) return new Response(JSON.stringify({ state: existing.state, revision: existing.revision, migrated: false }), { headers: { ...headers, "Content-Type": "application/json" } });
        const { data: created, error: createError } = await supabase.from("player_saves").insert({ player_id, state, imported_legacy: true }).select("state, revision").single();
        if (createError || !created) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ state: created.state, revision: created.revision, migrated: true }), { headers: { ...headers, "Content-Type": "application/json" } });
      }

      const revision = Number.isSafeInteger(body.revision) ? Number(body.revision) : 0;
      const { data: current, error: currentError } = await supabase.from("player_saves")
        .select("state, revision")
        .eq("player_id", player_id)
        .maybeSingle();
      if (currentError || !current) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
      const { data: resources, error: resourcesError } = await supabase.rpc("resource_snapshot", { p_player_id: player_id });
      const canonicalCurrent = applyResourceSnapshot(current.state, resources);
      if (resourcesError || !canonicalCurrent.ok) return new Response(JSON.stringify({ error: "resource_state_unavailable" }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });
      if (Number(current.revision) !== revision) {
        return new Response(JSON.stringify({ revision: current.revision, state: canonicalCurrent.state, conflict: true }), {
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data: trainingPurchases, error: trainingPurchasesError } = await supabase
        .from("token_spend_events")
        .select("idempotency_key, action_kind, created_at")
        .eq("player_id", player_id)
        .like("action_kind", "training-%")
        .order("created_at", { ascending: true });
      if (trainingPurchasesError) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
      const currentState = applyTrainingPurchases(canonicalCurrent.state, trainingPurchases, Date.now()) as Record<string, unknown>;
      const serverTraining = currentState.trainingCamp && typeof currentState.trainingCamp === "object"
        ? currentState.trainingCamp as Record<string, unknown>
        : {};
      const unlockedTrainingSlots = Math.max(2, Math.min(10, Math.floor(Number(serverTraining.unlockedSlots) || 2)));
      const serverTrainingUids = Array.isArray(serverTraining.heroUids) ? serverTraining.heroUids : [];
      const trainingHeroUids = Array.from({ length: 10 }, (_, index) =>
        index < unlockedTrainingSlots && typeof serverTrainingUids[index] === "string"
          ? serverTrainingUids[index] as string
          : null
      );
      const requestedTeamBeforeValidation = Array.isArray(state.team)
        ? state.team.filter((uid): uid is string => typeof uid === "string")
        : [];
      if (requestedTeamBeforeValidation.some((uid) => trainingHeroUids.includes(uid))) {
        return new Response(JSON.stringify({ error: "hero_in_training", revision: current.revision, state: currentState, conflict: true }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      state.trainingCamp = { ...serverTraining, heroUids: trainingHeroUids };
      const validated = validateAndMigrateGameState(state, { canonicalState: currentState });
      if (!validated.ok) return new Response(JSON.stringify({ error: validated.code ?? "invalid_state" }), { status: validated.code === "state_too_large" ? 413 : 400, headers: { ...headers, "Content-Type": "application/json" } });
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, validated.state);
      const { data: ledgerRows, error: ledgerError } = await supabase
        .from("player_items")
        .select("id, base_item_id, item_level, stats, power, locked, enchant_level, reroll_count, enchant_stats_version, item_roll_version")
        .eq("player_id", player_id)
        .is("removed_at", null);
      if (ledgerError) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
      const ledgerIds = new Set((ledgerRows ?? []).map((row) => String(row.id)));
      const ledgerById = new Map((ledgerRows ?? []).map((row) => [String(row.id), row]));
      const currentInventory = recordArray(currentState.inventory);
      const requestedInventory = recordArray(state.inventory);
      if (requestedInventory.some((item) => item.serverOwned === true && !ledgerIds.has(String(item.uid ?? "")))) {
        return new Response(JSON.stringify({ error: "item_registry_incomplete" }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const requestedItemUids = new Set(requestedInventory.map((item) => String(item.uid ?? "")));
      const canonicalItem = (item: Record<string, unknown>): Record<string, unknown> => {
        const row = ledgerById.get(String(item.uid ?? ""));
        return row === undefined ? item : {
          ...item, itemId: row.base_item_id, level: Number(row.item_level), stats: row.stats,
          power: Number(row.power), serverOwned: true, locked: row.locked === true,
          enchantLevel: Number(row.enchant_level), rerollCount: Number(row.reroll_count),
          enchantStatsVersion: Number(row.enchant_stats_version),
          itemRollVersion: Number(row.item_roll_version),
        };
      };
      state.inventory = [
        ...requestedInventory.map(canonicalItem),
        ...currentInventory
          .filter((item) => ledgerIds.has(String(item.uid ?? "")) && !requestedItemUids.has(String(item.uid ?? "")))
          .map(canonicalItem),
      ];
      const savedInventoryIds = new Set(recordArray(state.inventory).map((item) => String(item.uid ?? "")));
      if (Array.isArray(state.marketListings)) {
        state.marketListings = state.marketListings.filter((listing) => {
          if (!listing || typeof listing !== "object" || Array.isArray(listing)) return false;
          const item = (listing as Record<string, unknown>).item;
          return !item || typeof item !== "object" || Array.isArray(item) || !ledgerIds.has(String((item as Record<string, unknown>).uid ?? ""));
        });
      }
      const currentListings = Array.isArray(currentState.marketListings) ? currentState.marketListings as Record<string, unknown>[] : [];
      const escrowHeroes = currentListings.flatMap((listing) => listing.hero && typeof listing.hero === "object" ? [listing.hero as Record<string, unknown>] : []);
      const requestedHeroes = state.ownedHeroes as Record<string, unknown>[];
      state.ownedHeroes = preserveHeroOwnership(
        currentState.ownedHeroes,
        escrowHeroes,
        requestedHeroes,
        savedInventoryIds,
        ledgerIds,
      );
      if ((state.ownedHeroes as unknown[]).length === 0) {
        return new Response(JSON.stringify({ error: "invalid_owned_heroes" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const savedHeroUids = new Set((state.ownedHeroes as Record<string, unknown>[]).map((hero) => String(hero.uid ?? "")));
      const requestedTeam = Array.isArray(state.team) ? state.team.filter((uid): uid is string => typeof uid === "string") : [];
      if (requestedTeam.some((uid) => !savedHeroUids.has(uid))) {
        return new Response(JSON.stringify({ error: "invalid_team_reference", revision: current.revision, state: current.state, conflict: true }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const authoritativeExactFields = [
        "accountXp", "accountLevel", "highestLocation", "totalGoldEarned", "totalKills", "totalBossKills",
        "chestsOpenedToday", "lastChestReset", "combatXpAt",
      ];
      for (const field of authoritativeExactFields) state[field] = currentState[field];
      state.currentLocation = Math.min(
        Math.max(1, Math.floor(Number(state.currentLocation) || 1)),
        serverLocationCap(currentState),
      );
      state.gold = Math.min(
        Math.max(0, Math.floor(Number(state.gold) || 0)),
        Math.max(0, Math.floor(Number(currentState.gold) || 0)) + allowedGoldCredit(currentState, state),
      );
      state.rotatingShop = currentState.rotatingShop;
      state.rotatingShopRefreshAt = currentState.rotatingShopRefreshAt;
      const serverChests = Array.isArray(currentState.chests) ? currentState.chests as Record<string, unknown>[] : [];
      const requestedChestIds = new Set(
        (Array.isArray(state.chests) ? state.chests : []).map((chest) => String((chest as Record<string, unknown>)?.id ?? "")),
      );
      state.chests = serverChests.filter((chest) => requestedChestIds.has(String(chest.id ?? "")));
      const requestedBoost = state.boost && typeof state.boost === "object" ? state.boost as Record<string, unknown> : {};
      const serverBoost = currentState.boost && typeof currentState.boost === "object" ? currentState.boost as Record<string, unknown> : {};
      state.boost = {
        ...requestedBoost,
        chestProgressSeconds: serverBoost.chestProgressSeconds ?? 0,
        goldProgressSeconds: serverBoost.goldProgressSeconds ?? 0,
        combatProgressSeconds: serverBoost.combatProgressSeconds ?? 0,
      };
      const { data: saved, error: saveError } = await supabase.from("player_saves")
        .update({ state, revision: revision + 1, updated_at: new Date().toISOString() })
        .eq("player_id", player_id).eq("revision", revision)
        .select("revision").maybeSingle();
      if (saveError) return new Response(JSON.stringify({ error: "state_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
      if (!saved) return new Response(JSON.stringify({ error: "state_conflict" }), { status: 409, headers: { ...headers, "Content-Type": "application/json" } });
      const { data: migrated, error: migrationError } = await supabase.rpc("migrate_legacy_player_items", { p_player_id: player_id });
      if (migrationError || !isRecord(migrated)) return new Response(JSON.stringify({ error: "item_registry_unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
      const migratedCount = Number(migrated.migrated_items) || 0;
      return new Response(JSON.stringify({
        revision: Number(migrated.revision) || saved.revision,
        ...(migratedCount > 0 ? { state: migrated.state, migrated_items: migratedCount } : {}),
      }), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "account_register") {
      const username = typeof body.username === "string"
        ? body.username.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16)
        : "";
      const starterHeroId = typeof body.starter_hero_id === "string" ? body.starter_hero_id : "";
      if (username.length < 3 || hasBlockedUsernameLanguage(username) || !STARTER_HERO_IDS.has(starterHeroId)) {
        return new Response(JSON.stringify({ error: "invalid_username" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const { data: existingSave, error: existingSaveError } = await supabase.from("player_saves")
        .select("state, revision")
        .eq("player_id", player_id)
        .maybeSingle();
      if (existingSaveError) {
        return new Response(JSON.stringify({ error: "registration_state_unavailable" }), {
          status: 500, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      if (!existingSave && !validRegistrationShell(body.state)) {
        return new Response(JSON.stringify({ error: "invalid_registration_state" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const savedState = existingSave?.state && typeof existingSave.state === "object" && !Array.isArray(existingSave.state)
        ? existingSave.state as Record<string, unknown>
        : null;
      const recoveredBalance = savedState ? Math.min(1_000_000_000_000, Math.max(0, Math.floor(Number(savedState.hero) || 0))) : 0;
      const nowIso = new Date().toISOString();
      const { error: createPlayerError } = await supabase.from("players").upsert({
        player_id,
        username,
        online: true,
        last_heartbeat: nowIso,
        updated_at: nowIso,
        token_balance: recoveredBalance,
      }, { onConflict: "player_id", ignoreDuplicates: true });
      if (createPlayerError) {
        return new Response(JSON.stringify({ error: "registration_account_failed" }), {
          status: 500, headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const { data: player, error: playerError } = await supabase.from("players")
        .update({ username, online: true, last_heartbeat: nowIso, updated_at: nowIso })
        .eq("player_id", player_id)
        .select("token_balance, summons")
        .single();
      if (playerError || !player) {
        return new Response(JSON.stringify({ error: "registration_account_failed" }), {
          status: 500, headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      if (existingSave && savedState) {
        const restored = persistentState(savedState, username, player_id);
        if (!restored) return new Response(JSON.stringify({ error: "state_too_large" }), { status: 413, headers: { ...headers, "Content-Type": "application/json" } });
        restored.hero = Number(player.token_balance);
        restored.summons = Number(player.summons);
        const validated = validateAndMigrateGameState(restored);
        if (!validated.ok) return new Response(JSON.stringify({ error: validated.code ?? "invalid_state" }), { status: validated.code === "state_too_large" ? 413 : 400, headers: { ...headers, "Content-Type": "application/json" } });
        const { data: updatedSave, error: updateSaveError } = await supabase.from("player_saves")
          .update({ state: validated.state, revision: Number(existingSave.revision) + 1, updated_at: nowIso })
          .eq("player_id", player_id)
          .eq("revision", existingSave.revision)
          .select("state, revision")
          .maybeSingle();
        if (updateSaveError) return new Response(JSON.stringify({ error: "registration_state_failed" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
        if (updatedSave) return new Response(JSON.stringify({ created: true, username, account_id: player_id, state: updatedSave.state, revision: updatedSave.revision }), { headers: { ...headers, "Content-Type": "application/json" } });
        const { data: concurrentSave } = await supabase.from("player_saves").select("state, revision").eq("player_id", player_id).single();
        if (concurrentSave) return new Response(JSON.stringify({ created: true, username, account_id: player_id, state: concurrentSave.state, revision: concurrentSave.revision }), { headers: { ...headers, "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ error: "registration_state_failed" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
      }

      const registeredState = buildRegisteredState(body.state, username, player_id, starterHeroId, crypto.randomUUID(), Number(player.token_balance), Date.now());
      const validatedRegistration = registeredState ? validateAndMigrateGameState(registeredState) : null;
      if (!validatedRegistration?.ok) {
        return new Response(JSON.stringify({ error: "invalid_registration_state" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data: createdSave, error: createSaveError } = await supabase.from("player_saves")
        .insert({ player_id, state: validatedRegistration.state, imported_legacy: false })
        .select("state, revision")
        .single();
      if (createSaveError || !createdSave) {
        const { data: concurrentSave } = await supabase.from("player_saves").select("state, revision").eq("player_id", player_id).maybeSingle();
        if (concurrentSave) return new Response(JSON.stringify({ created: true, username, account_id: player_id, state: concurrentSave.state, revision: concurrentSave.revision }), { headers: { ...headers, "Content-Type": "application/json" } });
        return new Response(JSON.stringify({ error: "registration_state_failed" }), {
          status: 500, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ created: true, username, account_id: player_id, state: createdSave.state, revision: createdSave.revision }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "account_delete") {
      // Permanently remove the player. Every per-player row (players, player_saves,
      // player_items, boss_encounters) references auth.users(id) ON DELETE CASCADE,
      // so deleting the auth user wipes the account completely.
      const { error } = await supabase.auth.admin.deleteUser(player_id);
      if (error) {
        return internalError(headers, requestId, "account_delete_failed", error);
      }
      const { error: rankCleanupError } = await supabase
        .from("players")
        .delete()
        .eq("player_id", player_id);
      if (rankCleanupError) {
        return new Response(JSON.stringify({ error: "account_rank_cleanup_failed" }), {
          status: 500, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ deleted: true, account_id: player_id }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "sync") {
      const { username } = body;
      const now = new Date().toISOString();
      const safeUsername = typeof username === "string"
        ? username.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16) || "player"
        : "player";
      const safeHeroId = (value: unknown) => typeof value === "string" ? value.replace(/[^a-z0-9_-]/gi, "").slice(0, 64) : "";

      const [
        { data: registeredPlayer, error: registeredError },
        { data: playerSave, error: saveError },
        { data: ledgerItems, error: ledgerError },
      ] = await Promise.all([
        supabase.from("players").select("player_id").eq("player_id", player_id).maybeSingle(),
        supabase.from("player_saves").select("state").eq("player_id", player_id).maybeSingle(),
        supabase.from("player_items").select("id, rarity, item_level, stats, enchant_level, enchant_stats_version")
          .eq("player_id", player_id).is("removed_at", null),
      ]);
      if (registeredError || saveError || ledgerError) {
        return internalError(headers, requestId, "sync_authority_unavailable", registeredError ?? saveError ?? ledgerError);
      }
      if (!registeredPlayer || !playerSave) {
        return new Response(JSON.stringify({ error: "account_required" }), {
          status: 403, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const summary = deriveServerSummary(playerSave.state, ledgerItems ?? []);

      const { error: updateErr } = await supabase
        .from("players")
        .update({
          username: safeUsername,
          power: summary.power,
          combat_power: summary.combat_power,
          collection_power: summary.collection_power,
          account_level: summary.account_level,
          training_hero_count: summary.training_hero_count,
          total_kills: summary.total_kills,
          boss_kills: summary.boss_kills,
          chests_opened: summary.chests_opened,
          heroes_owned: summary.heroes_owned,
          highest_location: summary.highest_location,
          lineup: summary.lineup,
          avatar_hero_id: safeHeroId(body.avatar_hero_id),
          total_tokens_earned: summary.total_tokens_earned,
          token_eligible: summary.token_eligible,
          updated_at: now,
        })
        .eq("player_id", player_id);

      const { error: heartbeatErr } = await supabase.rpc("record_player_heartbeat", {
        p_player_id: player_id,
      });

      if (updateErr) return internalError(headers, requestId, "sync_update_failed", updateErr);
      if (heartbeatErr) return internalError(headers, requestId, "sync_heartbeat_failed", heartbeatErr);

      const { data: player } = await supabase
        .from("players")
        .select("pending_tokens, total_claimed")
        .eq("player_id", player_id)
        .maybeSingle();

      return new Response(
        JSON.stringify({
          pending_tokens: player ? Number(player.pending_tokens) : 0,
          total_claimed: player ? Number(player.total_claimed) : 0,
        }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (action === "claim") {
      const { data, error } = await supabase.rpc("claim_player_tokens", {
        p_player_id: player_id,
      });
      if (error || !data?.[0]) {
        return new Response(
          JSON.stringify({ error: "claim_failed" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }
      const result = data[0];
      return new Response(
        JSON.stringify({
          claimed: Number(result.claimed),
          pending: Number(result.pending),
          total_claimed: Number(result.total_claimed),
          token_balance: Number(result.token_balance),
        }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (action === "tester_credit_tokens") {
      if (!testerControlsEnabled) return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404, headers: { ...headers, "Content-Type": "application/json" },
      });
      const { data: credited, error: creditError } = await supabase.rpc("credit_token_distribution", {
        p_player_id: player_id,
        p_amount: 10_000,
      });
      if (creditError || credited !== true) {
        return new Response(
          JSON.stringify({ error: "tester_credit_failed" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }
      const { data, error } = await supabase.rpc("claim_player_tokens", {
        p_player_id: player_id,
      });
      if (error || !data?.[0]) {
        return new Response(
          JSON.stringify({ error: "tester_claim_failed" }),
          { status: 400, headers: { ...headers, "Content-Type": "application/json" } },
        );
      }
      const result = data[0];
      return new Response(
        JSON.stringify({
          claimed: Number(result.claimed),
          pending: Number(result.pending),
          total_claimed: Number(result.total_claimed),
          token_balance: Number(result.token_balance),
        }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (action === "tester_credit_gold") {
      if (!testerControlsEnabled) return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404, headers: { ...headers, "Content-Type": "application/json" },
      });
      const { data, error } = await supabase.rpc("credit_tester_gold", {
        p_player_id: player_id,
        p_amount: 10_000,
      });
      if (error || !data) {
        return new Response(JSON.stringify({ error: "tester_credit_failed" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "tester_credit_account_xp" || action === "tester_credit_formation_xp") {
      if (!testerControlsEnabled) return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404, headers: { ...headers, "Content-Type": "application/json" },
      });
      const { data, error } = await supabase.rpc("credit_tester_progression", {
        p_player_id: player_id,
        p_kind: action === "tester_credit_account_xp" ? "account_xp" : "formation_xp",
        p_amount: 2000,
      });
      if (error || !data) {
        return new Response(JSON.stringify({ error: "tester_credit_failed" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "promo_redeem") {
      const normalizedCode = String(body.code).trim().toUpperCase().replace(/[ -]+/g, "");
      if (!/^[A-Z0-9]{4,24}$/.test(normalizedCode)) {
        return new Response(JSON.stringify({ error: "invalid_promo_code" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedCode));
      const codeHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const { data, error } = await supabase.rpc("redeem_promo_code", {
        p_player_id: player_id,
        p_code_hash: codeHash,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const code = allowedErrorCode(error, [
          "invalid_promo_code", "promo_code_already_redeemed", "promo_code_exhausted",
        ], "promo_redemption_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code === "promo_redemption_failed" ? 500 : 409,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "spend_tokens") {
      const idempotencyKey = typeof body.idempotency_key === "string" && /^[0-9a-f-]{36}$/i.test(body.idempotency_key)
        ? body.idempotency_key
        : "";
      const amount = Math.min(1_000_000_000, Math.max(0, Number(body.amount) || 0));
      const actionKind = typeof body.action_kind === "string" ? body.action_kind.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64) : "";
      if (!idempotencyKey || !Number.isFinite(amount) || amount <= 0 || !actionKind) {
        return new Response(JSON.stringify({ error: "invalid_spend" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supabase.rpc("settle_token_spend", {
        p_player_id: player_id,
        p_idempotency_key: idempotencyKey,
        p_amount: amount,
        p_action_kind: actionKind,
      });
      if (error || !data?.[0]) {
        const code = allowedErrorCode(error, ["insufficient_tokens"], "spend_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code === "insufficient_tokens" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        spent: Number(data[0].spent),
        token_balance: Number(data[0].token_balance),
        boost_tokens_spent: Number(data[0].boost_tokens_spent),
      }), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "chest_open") {
      const idempotencyKey = typeof body.idempotency_key === "string" && /^[0-9a-f-]{36}$/i.test(body.idempotency_key)
        ? body.idempotency_key
        : "";
      const count = Math.floor(Number(body.count) || 0);
      if (!idempotencyKey || count < 1 || count > 64) {
        return new Response(JSON.stringify({ error: "invalid_chest_open" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supabase.rpc("settle_chest_open", {
        p_player_id: player_id,
        p_idempotency_key: idempotencyKey,
        p_count: count,
      });
      if (error || !data) {
        const expected = ["item_capacity_exceeded", "chest_count_exceeded"];
        const code = allowedErrorCode(error, expected, "chest_open_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code !== "chest_open_failed" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "tutorial_quest_claim") {
      const { data, error } = await supabase.rpc("settle_tutorial_quest_claim", {
        p_player_id: player_id, p_idempotency_key: body.idempotency_key,
        p_quest_id: body.quest_id, p_expected_revision: body.expected_revision,
      });
      if (error || !data) {
        const code = allowedErrorCode(error, ["state_conflict", "idempotency_conflict", "tutorial_completed", "tutorial_quest_locked", "tutorial_quest_incomplete"], "tutorial_claim_failed");
        return new Response(JSON.stringify({ error: code }), { status: code === "tutorial_claim_failed" ? 400 : 409, headers: { ...headers, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "quest_claim") {
      const { data, error } = await supabase.rpc("settle_quest_claim", {
        p_player_id: player_id, p_idempotency_key: body.idempotency_key,
        p_quest_id: body.quest_id, p_expected_revision: body.expected_revision,
      });
      if (error || !data) {
        const code = allowedErrorCode(error, ["state_conflict", "idempotency_conflict", "quest_unknown", "quest_catalogue_mismatch", "quest_already_claimed", "quest_incomplete"], "quest_claim_failed");
        return new Response(JSON.stringify({ error: code }), { status: code === "quest_claim_failed" ? 400 : 409, headers: { ...headers, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "tutorial_chest_open") {
      const { data, error } = await supabase.rpc("settle_tutorial_chest_open", {
        p_player_id: player_id, p_idempotency_key: body.idempotency_key, p_count: body.count,
      });
      if (error || !data) {
        const code = allowedErrorCode(error, ["item_capacity_exceeded", "resource_insufficient_balance", "idempotency_conflict"], "tutorial_chest_open_failed");
        return new Response(JSON.stringify({ error: code }), { status: code === "tutorial_chest_open_failed" ? 400 : 409, headers: { ...headers, "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "item_mutate") {
      const { data, error } = await supabase.rpc("settle_item_mutation", {
        p_player_id: player_id,
        p_idempotency_key: body.idempotency_key,
        p_action_kind: body.operation,
        p_item_ids: body.item_uids,
        p_desired_locked: body.operation === "lock" ? body.locked : null,
      });
      if (error || !data) {
        const expected = ["item_not_found", "item_locked", "item_state_mismatch"];
        const code = allowedErrorCode(error, expected, "item_mutation_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code !== "item_mutation_failed" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "item_equip") {
      const { data, error } = await supabase.rpc("settle_item_equipment", {
        p_player_id: player_id,
        p_idempotency_key: body.idempotency_key,
        p_assignments: body.assignments,
      });
      if (error || !data) {
        const expected = [
          "invalid_equipment_assignment", "duplicate_equipment_assignment", "hero_not_active", "hero_not_found",
          "item_not_found", "item_state_mismatch", "item_level_required", "item_slot_mismatch", "item_class_mismatch",
          "item_capacity_exceeded", "idempotency_conflict",
        ];
        const code = allowedErrorCode(error, expected, "item_equipment_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code !== "item_equipment_failed" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "item_upgrade") {
      const { data, error } = await supabase.rpc("settle_item_upgrade", {
        p_player_id: player_id,
        p_idempotency_key: body.idempotency_key,
        p_action_kind: body.operation,
        p_item_id: body.item_uid,
        p_use_charm: body.use_charm,
      });
      if (error || !data) {
        const expected = [
          "invalid_item_upgrade", "charm_unavailable", "maximum_enchant", "insufficient_gold",
          "insufficient_tokens", "item_not_found", "item_state_mismatch", "idempotency_conflict",
          "save_not_found", "account_not_found",
        ];
        const code = allowedErrorCode(error, expected, "item_upgrade_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code !== "item_upgrade_failed" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "store_snapshot") {
      const { data, error } = await supabase.rpc("store_snapshot", { p_player_id: player_id });
      if (error || !data) return internalError(headers, requestId, "store_snapshot_failed", error);
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "store_buy_item") {
      const { data, error } = await supabase.rpc("settle_store_purchase", {
        p_player_id: player_id,
        p_idempotency_key: body.idempotency_key,
        p_slot_index: body.slot_index,
        p_refresh_at: body.refresh_at,
      });
      if (error || !data) {
        const expected = [
          "invalid_store_slot", "store_offer_expired", "store_offer_sold", "insufficient_gold",
          "item_capacity_exceeded", "idempotency_conflict", "save_not_found",
        ];
        const code = allowedErrorCode(error, expected, "store_purchase_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code !== "store_purchase_failed" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "market_snapshot") {
      const { data, error } = await supabase.rpc("market_snapshot", { p_player_id: player_id });
      if (error || !data) return internalError(headers, requestId, "market_unavailable", error);
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "market_seed_test_stock") {
      if (Deno.env.get("ALLOWED_ORIGINS") !== "https://staging.heroloop.xyz") {
        return new Response(JSON.stringify({ error: "not_found" }), {
          status: 404, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supabase.rpc("seed_market_test_stock", {
        p_player_id: player_id,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const code = allowedErrorCode(error, ["idempotency_conflict", "market_test_seed_forbidden", "market_test_stock_not_empty", "save_not_found"], "market_test_seed_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code !== "market_test_seed_failed" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "market_list_item" || action === "market_cancel_listing" || action === "market_buy_listing") {
      const rpcName = action === "market_list_item"
        ? "settle_market_list"
        : action === "market_cancel_listing" ? "settle_market_cancel" : "settle_market_buy";
      const args = action === "market_list_item"
        ? { p_player_id: player_id, p_idempotency_key: body.idempotency_key, p_item_id: body.item_id, p_price: body.price }
        : { p_player_id: player_id, p_idempotency_key: body.idempotency_key, p_listing_id: body.listing_id };
      const { data, error } = await supabase.rpc(rpcName, args);
      if (error || !data) {
        const expected = [
          "idempotency_conflict", "invalid_market_price", "market_test_limit_reached", "market_test_item_required",
          "market_listing_unavailable", "market_self_purchase", "market_seller_limit_reached", "insufficient_tokens", "item_not_found", "item_locked",
          "item_equipped", "item_state_mismatch", "item_capacity_exceeded", "save_not_found",
        ];
        const code = allowedErrorCode(error, expected, "market_settlement_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code !== "market_settlement_failed" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "dungeon_status") {
      const { data, error } = await supabase.rpc("dungeon_status", { p_player_id: player_id });
      if (error || !data) {
        const code = allowedErrorCode(error, ["save_not_found"], "dungeon_status_failed");
        if (code === "save_not_found") {
          return new Response(JSON.stringify({ error: "account_required" }), {
            status: 403, headers: { ...headers, "Content-Type": "application/json" },
          });
        }
        return internalError(headers, requestId, code, error);
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "dungeon_start") {
      const { data, error } = await supabase.rpc("dungeon_start", {
        p_player_id: player_id,
        p_depth: body.depth,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const expected = [
          "idempotency_conflict", "dungeon_invalid_depth", "dungeon_invalid_progression",
          "dungeon_invalid_formation", "dungeon_equipment_state_mismatch", "dungeon_depth_locked",
          "dungeon_attempts_exhausted", "active_encounter_exists", "save_not_found",
        ];
        const code = allowedErrorCode(error, expected, "dungeon_start_failed");
        if (code === "dungeon_start_failed") return internalError(headers, requestId, code, error);
        const status = code === "save_not_found" ? 403
          : ["dungeon_invalid_depth", "dungeon_invalid_progression", "dungeon_invalid_formation", "dungeon_equipment_state_mismatch"].includes(code) ? 400 : 409;
        return new Response(JSON.stringify({ error: code === "save_not_found" ? "account_required" : code }), {
          status, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "dungeon_room_start") {
      const { data, error } = await supabase.rpc("dungeon_room_start", {
        p_player_id: player_id,
        p_encounter_id: body.encounter_id,
        p_expected_revision: body.expected_revision,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const expected = [
          "idempotency_conflict", "dungeon_invalid_revision", "dungeon_encounter_not_found",
          "dungeon_encounter_not_active", "dungeon_revision_conflict", "dungeon_room_not_available",
          "dungeon_room_already_started", "dungeon_run_state_invalid",
        ];
        const code = allowedErrorCode(error, expected, "dungeon_room_start_failed");
        if (code === "dungeon_room_start_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: code === "dungeon_invalid_revision" ? 400 : 409,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "dungeon_room_action") {
      const { data, error } = await supabase.rpc("dungeon_room_action", {
        p_player_id: player_id,
        p_encounter_id: body.encounter_id,
        p_expected_revision: body.expected_revision,
        p_action_kind: body.command,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const expected = [
          "idempotency_conflict", "dungeon_invalid_revision", "dungeon_invalid_action",
          "dungeon_encounter_not_found", "dungeon_encounter_not_active", "dungeon_revision_conflict",
          "dungeon_room_not_ready", "dungeon_room_already_resolved", "dungeon_room_state_invalid",
          "dungeon_combat_version_mismatch",
        ];
        const code = allowedErrorCode(error, expected, "dungeon_room_action_failed");
        if (code === "dungeon_room_action_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: ["dungeon_invalid_revision", "dungeon_invalid_action"].includes(code) ? 400 : 409,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "dungeon_room_complete") {
      const { data, error } = await supabase.rpc("dungeon_room_complete", {
        p_player_id: player_id,
        p_encounter_id: body.encounter_id,
        p_expected_revision: body.expected_revision,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const expected = [
          "idempotency_conflict", "dungeon_invalid_revision", "dungeon_encounter_not_found",
          "dungeon_encounter_not_active", "dungeon_revision_conflict", "dungeon_room_not_ready",
          "dungeon_room_not_resolved", "dungeon_room_state_invalid", "boss_claim_required",
        ];
        const code = allowedErrorCode(error, expected, "dungeon_room_complete_failed");
        if (code === "dungeon_room_complete_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: code === "dungeon_invalid_revision" ? 400 : 409,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "dungeon_room_choose") {
      const { data, error } = await supabase.rpc("dungeon_room_choose", {
        p_player_id: player_id,
        p_encounter_id: body.encounter_id,
        p_expected_revision: body.expected_revision,
        p_choice: body.choice,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const expected = [
          "idempotency_conflict", "dungeon_invalid_revision", "dungeon_invalid_choice",
          "dungeon_encounter_not_found", "dungeon_encounter_not_active", "dungeon_revision_conflict",
          "dungeon_room_not_ready", "dungeon_run_state_invalid",
        ];
        const code = allowedErrorCode(error, expected, "dungeon_room_choice_failed");
        if (code === "dungeon_room_choice_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: ["dungeon_invalid_revision", "dungeon_invalid_choice"].includes(code) ? 400 : 409,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "dungeon_abandon") {
      const { data, error } = await supabase.rpc("dungeon_abandon", {
        p_player_id: player_id,
        p_encounter_id: body.encounter_id,
        p_expected_revision: body.expected_revision,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const expected = [
          "idempotency_conflict", "dungeon_invalid_revision", "dungeon_encounter_not_found",
          "dungeon_encounter_not_active", "dungeon_revision_conflict",
        ];
        const code = allowedErrorCode(error, expected, "dungeon_abandon_failed");
        if (code === "dungeon_abandon_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: code === "dungeon_invalid_revision" ? 400 : 409,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "boss_claim") {
      const { data, error } = await supabase.rpc("boss_claim", {
        p_player_id: player_id,
        p_encounter_id: body.encounter_id,
        p_expected_revision: body.expected_revision,
        p_idempotency_key: body.idempotency_key,
      });
      if (error || !data) {
        const expected = [
          "idempotency_conflict", "boss_encounter_not_found", "boss_encounter_not_active",
          "dungeon_revision_conflict", "boss_reward_not_ready", "chest_capacity_exceeded", "daily_chest_limit_reached",
        ];
        const code = allowedErrorCode(error, expected, "boss_claim_failed");
        if (code === "boss_claim_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "ascension_focus_set") {
      const idempotencyKey = typeof body.idempotency_key === "string" && /^[0-9a-f-]{36}$/i.test(body.idempotency_key)
        ? body.idempotency_key
        : "";
      const rarity = typeof body.rarity === "string" ? body.rarity : "";
      const targetHeroId = typeof body.target_hero_id === "string" ? body.target_hero_id.slice(0, 100) : null;
      if (!idempotencyKey) {
        return new Response(JSON.stringify({ error: "invalid_ascension_focus" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supabase.rpc("set_ascension_focus", {
        p_player_id: player_id,
        p_idempotency_key: idempotencyKey,
        p_rarity: rarity,
        p_target_hero_id: targetHeroId,
      });
      if (error || !data) {
        const code = allowedErrorCode(error, ["invalid_focus_rarity", "focus_target_not_owned", "focus_target_rarity_mismatch", "idempotency_conflict"], "ascension_focus_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code !== "ascension_focus_failed" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "hero_summon_quote") {
      const count = Math.floor(Number(body.count) || 0);
      const expectedRevision = Number(body.expected_revision);
      const { data, error } = await supabase.rpc("quote_hero_summon", {
        p_player_id: player_id,
        p_expected_revision: expectedRevision,
        p_count: count,
      });
      if (error || !data) {
        const conflicts = ["state_conflict", "hero_capacity_exceeded", "dex_quote_unavailable"];
        const code = allowedErrorCode(error, conflicts, "hero_summon_quote_failed");
        if (code === "hero_summon_quote_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "hero_summon") {
      const idempotencyKey = typeof body.idempotency_key === "string" && /^[0-9a-f-]{36}$/i.test(body.idempotency_key)
        ? body.idempotency_key
        : "";
      const count = Math.floor(Number(body.count) || 0);
      const expectedRevision = Number(body.expected_revision);
      const paymentMethod = body.payment_method === "paid" || body.payment_method === "scroll" ? body.payment_method : "";
      const quoteId = body.quote_id === null ? null : typeof body.quote_id === "string" ? body.quote_id : "";
      if (!idempotencyKey || ![1, 10, 100].includes(count) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
        || !paymentMethod || (paymentMethod === "paid" && !/^[0-9a-f-]{36}$/i.test(quoteId ?? ""))
        || (paymentMethod === "scroll" && quoteId !== null)) {
        return new Response(JSON.stringify({ error: "invalid_summon" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supabase.rpc("settle_hero_summon", {
        p_player_id: player_id,
        p_idempotency_key: idempotencyKey,
        p_count: count,
        p_expected_revision: expectedRevision,
        p_payment_method: paymentMethod,
        p_quote_id: quoteId,
      });
      if (error || !data) {
        const code = allowedErrorCode(error, [
          "state_conflict", "insufficient_tokens", "resource_insufficient_balance", "hero_capacity_exceeded",
          "hero_summon_quote_not_found", "hero_summon_quote_mismatch", "hero_summon_quote_expired",
          "hero_summon_quote_used", "dex_quote_unavailable", "rarity_supply_unavailable",
          "summon_rarity_unavailable", "resource_idempotency_conflict", "idempotency_conflict",
        ], "summon_failed");
        if (code === "summon_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "hero_ascend") {
      const idempotencyKey = typeof body.idempotency_key === "string" && /^[0-9a-f-]{36}$/i.test(body.idempotency_key)
        ? body.idempotency_key
        : "";
      const targetUid = typeof body.target_uid === "string" ? body.target_uid.slice(0, 100) : "";
      const targetUids = Array.isArray(body.target_uids) ? body.target_uids as string[] : [];
      const repeat = body.repeat === true;
      if (!idempotencyKey || (!targetUid && targetUids.length === 0)) {
        return new Response(JSON.stringify({ error: "invalid_ascension" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data, error } = targetUids.length > 0
        ? await supabase.rpc("settle_all_hero_ascensions", {
          p_player_id: player_id,
          p_idempotency_key: idempotencyKey,
          p_target_uids: targetUids,
        })
        : await supabase.rpc("settle_hero_ascension", {
          p_player_id: player_id,
          p_idempotency_key: idempotencyKey,
          p_target_uid: targetUid,
          p_repeat: repeat,
        });
      if (error || !data) {
        const expected = ["insufficient_duplicates", "insufficient_tokens", "maximum_stars", "target_not_found"];
        const code = allowedErrorCode(error, expected, "ascension_failed");
        if (code === "ascension_failed") {
          return internalError(headers, requestId, code, error);
        }
        return new Response(JSON.stringify({ error: code }), {
          status: 409,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "hero_release") {
      const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      const heroUid = typeof body.hero_uid === "string" ? body.hero_uid : "";
      const expectedRevision = Number(body.expected_revision);
      const { data, error } = await supabase.rpc("settle_hero_release", {
        p_player_id: player_id,
        p_idempotency_key: idempotencyKey,
        p_hero_uid: heroUid,
        p_expected_revision: expectedRevision,
      });
      if (error || !data) {
        const conflicts = [
          "state_conflict", "hero_not_found", "last_hero", "hero_locked", "hero_in_team",
          "hero_in_training", "hero_has_equipment", "hero_in_market", "hero_in_active_encounter",
          "idempotency_conflict",
        ];
        const code = allowedErrorCode(error, conflicts, "hero_release_failed");
        if (code === "hero_release_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "training_assignment_set") {
      const { data, error } = await supabase.rpc("settle_training_assignment", {
        p_player_id: player_id,
        p_idempotency_key: body.idempotency_key,
        p_slot_index: body.slot_index,
        p_hero_uid: body.hero_uid,
        p_expected_revision: body.expected_revision,
      });
      if (error || !data) {
        const conflicts = [
          "idempotency_conflict", "state_conflict", "save_not_found", "player_not_found",
          "training_slot_locked", "hero_not_found", "hero_in_team", "hero_already_training", "hero_level_capped",
        ];
        const code = allowedErrorCode(error, conflicts, "training_assignment_failed");
        if (code === "training_assignment_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: code === "save_not_found" || code === "player_not_found" ? 404 : 409,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "hero_capacity_quote") {
      const expectedRevision = Number(body.expected_revision);
      const { data, error } = await supabase.rpc("quote_hero_capacity_upgrade", {
        p_player_id: player_id,
        p_expected_revision: expectedRevision,
      });
      if (error || !data) {
        const conflicts = ["state_conflict", "maximum_capacity", "dex_quote_unavailable"];
        const code = allowedErrorCode(error, conflicts, "hero_capacity_quote_failed");
        if (code === "hero_capacity_quote_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
    if (action === "hero_capacity_upgrade") {
      const idempotencyKey = typeof body.idempotency_key === "string" ? body.idempotency_key : "";
      const expectedRevision = Number(body.expected_revision);
      const quoteId = typeof body.quote_id === "string" ? body.quote_id : "";
      const { data, error } = await supabase.rpc("settle_hero_capacity_upgrade", {
        p_player_id: player_id,
        p_idempotency_key: idempotencyKey,
        p_expected_revision: expectedRevision,
        p_quote_id: quoteId,
      });
      if (error || !data) {
        const conflicts = [
          "state_conflict", "insufficient_tokens", "maximum_capacity", "idempotency_conflict",
          "hero_capacity_quote_not_found", "quote_revision_mismatch", "hero_capacity_quote_expired",
          "hero_capacity_quote_stale", "dex_quote_unavailable",
        ];
        const code = allowedErrorCode(error, conflicts, "hero_capacity_upgrade_failed");
        if (code === "hero_capacity_upgrade_failed") return internalError(headers, requestId, code, error);
        return new Response(JSON.stringify({ error: code }), {
          status: 409, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(data), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "set_boost_max_active") {
      const { data, error } = await supabase.rpc("set_boost_max_active", {
        p_player_id: player_id,
        p_active: body.active === true,
      });
      if (error || !data?.[0]) {
        const code = allowedErrorCode(error, ["requirements_incomplete"], "boost_update_failed");
        return new Response(JSON.stringify({ error: code }), {
          status: code === "requirements_incomplete" ? 409 : 400,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const result = data[0];
      return new Response(JSON.stringify({
        active: result.active === true,
        login_days: Number(result.login_days),
        online_seconds: Number(result.online_seconds),
        tokens_earned: Number(result.tokens_earned),
        tokens_spent: Number(result.tokens_spent),
        token_balance: Number(result.token_balance),
      }), { headers: { ...headers, "Content-Type": "application/json" } });
    }

    if (action === "leaderboard") {
      const { data: leaders, error: leadersError } = await supabase
        .from("players")
        .select("player_id, username, account_level, power, collection_power, total_kills, boss_kills, heroes_owned, highest_location, online, lineup, avatar_hero_id, summons, total_tokens_earned")
        .order("account_level", { ascending: false })
        .order("total_kills", { ascending: false })
        .order("power", { ascending: false })
        .limit(100);

      if (leadersError) {
        return internalError(headers, requestId, "leaderboard_unavailable", leadersError);
      }

      // `players.player_id` already has an ON DELETE CASCADE foreign key to
      // Auth. Never delete rows from a read path: a transient Admin Auth error
      // must not erase a live account and its server-authoritative economy.
      return new Response(JSON.stringify({ players: leaders ?? [], me: player_id }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "status") {
      const { data: pool } = await supabase
        .from("token_pool")
        .select("pool_amount, total_distributed, distribution_rate")
        .eq("id", 1)
        .maybeSingle();

      const { data: player } = await supabase
        .from("players")
        .select("pending_tokens, total_claimed, power, boss_keys, token_eligible, highest_location, training_hero_count, reward_active_until, token_balance, boost_tokens_earned, boost_tokens_spent, boost_login_days, boost_online_seconds, boost_max_active, pity_legendary, pity_mythic, pity_cosmic, pity_divine, pity_celestial, ascension_focus")
        .eq("player_id", player_id)
        .maybeSingle();

      const { data: raritySupply } = await supabase
        .from("rarity_supply")
        .select("rarity, existing_count, max_existing")
        .in("rarity", ["divine", "celestial", "cursed", "immortal", "god"]);
      const { data: resourceSave } = await supabase
        .from("player_saves")
        .select("state, revision")
        .eq("player_id", player_id)
        .maybeSingle();
      const { data: resources, error: resourcesError } = await supabase.rpc("resource_snapshot", { p_player_id: player_id });
      if (resourcesError) return new Response(JSON.stringify({ error: "status_unavailable" }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });
      const { data: income, error: incomeError } = await supabase.rpc("hero_income_snapshot", { p_player_id: player_id });
      if (incomeError || !income || typeof income !== "object") return new Response(JSON.stringify({ error: "status_unavailable" }), { status: 503, headers: { ...headers, "Content-Type": "application/json" } });

      return new Response(
        JSON.stringify({
          total_distributed: pool ? Number(pool.total_distributed) : 0,
          distribution_rate: pool ? Number(pool.distribution_rate) : 0.15,
          pending_tokens: player ? Number(player.pending_tokens) : 0,
          total_claimed: player ? Number(player.total_claimed) : 0,
          token_balance: player ? Number(player.token_balance) : 0,
          boost: player ? {
            active: player.boost_max_active === true,
            login_days: Number(player.boost_login_days),
            online_seconds: Number(player.boost_online_seconds),
            tokens_earned: Number(player.boost_tokens_earned),
            tokens_spent: Number(player.boost_tokens_spent),
            token_balance: Number(player.token_balance),
          } : null,
          pity: player ? {
            legendary: Number(player.pity_legendary),
            mythic: Number(player.pity_mythic),
            cosmic: Number(player.pity_cosmic),
            divine: Number(player.pity_divine),
            celestial: Number(player.pity_celestial),
          } : null,
          ascension_focus: player?.ascension_focus && typeof player.ascension_focus === "object" ? player.ascension_focus : {},
          boss_keys: player ? Number(player.boss_keys) : 0,
          resource_state: resourceSave?.state ?? null,
          resource_revision: resourceSave ? Number(resourceSave.revision) : null,
          resources,
          rarity_capacity: Object.fromEntries((raritySupply ?? []).map((row) => [row.rarity, Number(row.existing_count) < Number(row.max_existing)])),
          rarity_supply: Object.fromEntries((raritySupply ?? []).map((row) => [row.rarity, { existing: Number(row.existing_count), max: Number(row.max_existing) }])),
          ...income,
        }),
        { headers: { ...headers, "Content-Type": "application/json" } },
      );
    }

    if (action === "summon_boss") {
      const location = Math.min(10_000, Math.max(1, Math.floor(Number(body.location) || 1)));
      const { data, error } = await supabase.rpc("summon_boss", {
        p_player_id: player_id,
        p_location: location,
        p_idempotency_key: body.idempotency_key,
      });
      if (error) {
        const code = allowedErrorCode(error, ["resource_insufficient_balance", "resource_idempotency_conflict", "active_encounter_exists"], "boss_summon_failed");
        if (code !== "boss_summon_failed") {
          return new Response(JSON.stringify({ error: code }), { status: 409, headers: { ...headers, "Content-Type": "application/json" } });
        }
        return internalError(headers, requestId, code, error);
      }
      const result = data?.[0];
      return new Response(JSON.stringify(result ?? {}), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "reserve_limited_item") {
      if (!["divine", "celestial"].includes(body.rarity)) {
        return new Response(JSON.stringify({ error: "unsupported_rarity" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const { data, error } = await supabase.rpc("reserve_limited_item", {
        p_player_id: player_id,
        p_base_item_id: String(body.base_item_id ?? "").slice(0, 100),
        p_slot: String(body.slot ?? "").slice(0, 30),
        p_rarity: body.rarity,
        p_item_level: Math.min(10_000, Math.max(1, Math.floor(Number(body.item_level) || 1))),
        p_stats: Array.isArray(body.stats) ? body.stats : [],
      });
      if (error) {
        const code = allowedErrorCode(error, ["rarity_limit_reached"], "item_reservation_failed");
        if (code === "rarity_limit_reached") {
          return new Response(JSON.stringify({ error: code }), { status: 409, headers: { ...headers, "Content-Type": "application/json" } });
        }
        return internalError(headers, requestId, code, error);
      }
      return new Response(JSON.stringify({ item_id: data }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (action === "remove_limited_item") {
      const itemId = String(body.item_id ?? "");
      const { data, error } = await supabase.rpc("remove_player_item", {
        p_player_id: player_id, p_item_id: itemId,
      });
      if (error) {
        return new Response(JSON.stringify({ error: "item_removal_failed" }), {
          status: 400, headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ removed: Boolean(data) }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

  } catch (err) {
    return internalError(headers, requestId, "internal_error", err);
  }
});
