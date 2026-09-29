import {
  allowedGoldCredit,
  applyTrainingPurchases,
  deriveServerSummary,
  preserveHeroOwnership,
  serverLocationCap,
} from "../shared/authority.mjs";
import {
  buildRegisteredState,
  STARTER_HERO_IDS,
} from "../shared/registration.js";
import { applyResourceSnapshot, validRegistrationShell, validateAndMigrateGameState } from "../shared/save-schema.mjs";

export type JsonRecord = Record<string, unknown>;

const blockedUsernameParts = [
  "fuck", "shit", "cunt", "dick", "pussy", "bitch", "asshole", "whore", "slut",
  "nigg", "fagg", "retard", "huy", "hui", "khuy", "pizd", "blya", "blia",
  "suka", "syka", "mudak", "dolboeb", "dolboyob", "eblan", "eban", "yeban", "zalupa", "zhopa",
];

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function recordArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function canonicalResourceState(value: unknown, resources: unknown): JsonRecord | null {
  const result = applyResourceSnapshot(value, resources);
  return result.ok ? result.state : null;
}

export function validPersistentState(value: unknown): value is JsonRecord {
  return validateAndMigrateGameState(value).ok;
}

function hasBlockedUsernameLanguage(value: string): boolean {
  const leet: Record<string, string> = {
    "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s",
  };
  const normalized = value.toLowerCase()
    .replace(/[013457@$]/g, (char) => leet[char] ?? char)
    .replace(/[^a-z]/g, "");
  return blockedUsernameParts.some((part) => normalized.includes(part));
}

function clonePersistentState(value: unknown, username: string, playerId: string): JsonRecord | null {
  if (!isRecord(value)) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length > 1_000_000) return null;
  const state = JSON.parse(serialized) as JsonRecord;
  state.username = username;
  state.walletAddress = `game-${playerId}`;
  state.bossBattleActive = false;
  return state;
}

export function prepareRegistration(
  payload: JsonRecord,
  playerId: string,
  now: number,
): { username: string; starterHeroId: string; state: JsonRecord } | { code: string; status: number } {
  const username = typeof payload.username === "string"
    ? payload.username.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16)
    : "";
  const starterHeroId = typeof payload.starter_hero_id === "string" ? payload.starter_hero_id : "";
  if (
    username.length < 3 || hasBlockedUsernameLanguage(username) ||
    !STARTER_HERO_IDS.has(starterHeroId) || !validRegistrationShell(payload.state)
  ) {
    return { code: "invalid_registration", status: 400 };
  }
  const state = buildRegisteredState(
    payload.state,
    username,
    playerId,
    starterHeroId,
    crypto.randomUUID(),
    0,
    now,
  );
  const validated = validateAndMigrateGameState(state);
  return validated.ok
    ? { username, starterHeroId, state: validated.state }
    : { code: "invalid_registration_state", status: 400 };
}

export function prepareLegacyMigration(
  context: JsonRecord,
  requestedValue: unknown,
  playerId: string,
): { state: JsonRecord } | { code: string; status: number } {
  const account = isRecord(context.account) ? context.account : null;
  if (!account) return { code: "account_required", status: 403 };
  if (!isRecord(requestedValue)) return { code: "invalid_state", status: 400 };
  if (isRecord(context.state) && Number.isSafeInteger(Number(context.revision))) return { state: context.state };
  const state = clonePersistentState(requestedValue, String(account.username ?? ""), playerId);
  if (!state) return { code: "state_too_large", status: 413 };
  state.hero = Number(account.token_balance);
  state.summons = Number(account.summons);
  const validated = validateAndMigrateGameState(state, { allowMissingTeamReferences: true });
  return validated.ok ? { state: validated.state } : { code: validated.code ?? "invalid_state", status: validated.code === "state_too_large" ? 413 : 400 };
}

export function missingFormationUids(state: JsonRecord): string[] {
  const ownedUids = new Set(recordArray(state.ownedHeroes).map((hero) => String(hero.uid ?? "")));
  const team = Array.isArray(state.team)
    ? state.team.filter((uid): uid is string => typeof uid === "string" && uid.length > 0).slice(0, 3)
    : [];
  return [...new Set(team.filter((uid) => !ownedUids.has(uid)))];
}

export function recoverMissingFormationHeroes(
  sourceState: JsonRecord,
  context: JsonRecord,
): { state: JsonRecord; recovered: number } {
  const ownedHeroes = recordArray(sourceState.ownedHeroes);
  const team = Array.isArray(sourceState.team)
    ? sourceState.team.filter((uid): uid is string => typeof uid === "string" && uid.length > 0).slice(0, 3)
    : [];
  const missingUids = missingFormationUids(sourceState);
  if (missingUids.length === 0) return { state: sourceState, recovered: 0 };

  const candidates = recordArray(context.heroes);
  const recovered = missingUids.flatMap((uid) => {
    const exact = candidates.find((hero) => hero.uid === uid);
    return exact ? [structuredClone(exact) as JsonRecord] : [];
  });
  const unresolvedUids = missingUids.filter((uid) => !recovered.some((hero) => hero.uid === uid));
  if (unresolvedUids.length > 0) {
    const remainingLineup = [...recordArray(context.lineup)];
    for (const uid of team) {
      const owned = [...ownedHeroes, ...recovered].find((hero) => hero.uid === uid);
      if (!owned) continue;
      const index = remainingLineup.findIndex((entry) =>
        entry.hero_id === owned.heroId && Number(entry.level) === Number(owned.level) &&
        Number(entry.stars) === Number(owned.stars)
      );
      if (index >= 0) remainingLineup.splice(index, 1);
    }
    const validHeroId = /^(shepherd|assassin|knight|druid|archer)-(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$/;
    if (
      remainingLineup.length === unresolvedUids.length &&
      remainingLineup.every((entry) => validHeroId.test(String(entry.hero_id ?? "")))
    ) {
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

export function prepareProfileSync(
  context: JsonRecord,
  payload: JsonRecord,
): { username: string; avatarHeroId: string; summary: JsonRecord } | { code: string; status: number } {
  if (context.account_exists !== true || !isRecord(context.state)) {
    return { code: "account_required", status: 403 };
  }
  const username = typeof payload.username === "string"
    ? payload.username.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16) || "player"
    : "player";
  const avatarHeroId = typeof payload.avatar_hero_id === "string"
    ? payload.avatar_hero_id.replace(/[^a-z0-9_-]/gi, "").slice(0, 64)
    : "";
  const summary = deriveServerSummary(context.state, recordArray(context.items)) as JsonRecord;
  return { username, avatarHeroId, summary };
}

export function prepareLeaderboardResult(
  context: JsonRecord,
  playerId: string,
): { players: JsonRecord[]; me: string } | { code: string; status: number } {
  const players = recordArray(context.players);
  if (context.me !== playerId || !Array.isArray(context.players) || players.length > 100) {
    return { code: "leaderboard_unavailable", status: 503 };
  }
  return { players, me: playerId };
}

export function prepareStatusResult(context: JsonRecord, now: number): JsonRecord {
  const pool = isRecord(context.pool) ? context.pool : null;
  const player = isRecord(context.player) ? context.player : null;
  const eligiblePlayers = recordArray(context.eligible_players);
  const scoreOf = (entry: JsonRecord): number => {
    const power = Math.max(0, Number(entry.power) || 0);
    const location = Math.max(1, Number(entry.highest_location) || 1);
    return power * (1 + 0.10 * (location - 1)) * (entry.boost_max_active === true ? 2 : 1);
  };
  const totalScore = eligiblePlayers.reduce((sum, entry) => sum + scoreOf(entry), 0);
  const rewardActive = Boolean(player && (
    player.boost_max_active === true ||
    (typeof player.reward_active_until === "string" && Date.parse(player.reward_active_until) > now)
  ));
  const myScore = player?.token_eligible === true && rewardActive ? scoreOf(player) : 0;
  const myDailyShare = totalScore > 0 ? (myScore / totalScore) * 20_000 : 0;
  const trainingHeroCount = Math.max(0, Math.min(10, Number(player?.training_hero_count) || 0));
  const trainingPenalty = trainingHeroCount >= 5 ? 0.9 : [0, 0.1, 0.25, 0.5, 0.75][trainingHeroCount] ?? 0;
  const highestLocation = Math.max(1, Number(player?.highest_location) || 1);
  const locationMultiplier = 1 + 0.10 * (highestLocation - 1);
  const boostMultiplier = player?.boost_max_active === true ? 2 : 1;
  const rarityCapacity: JsonRecord = {};
  const raritySupply: JsonRecord = {};
  for (const row of recordArray(context.rarity_supply)) {
    const rarity = String(row.rarity ?? "");
    if (!new Set(["divine", "celestial", "cursed", "immortal", "god"]).has(rarity)) continue;
    const existing = Number(row.existing_count) || 0;
    const max = Number(row.max_existing) || 0;
    rarityCapacity[rarity] = existing < max;
    raritySupply[rarity] = { existing, max };
  }
  const resource = isRecord(context.resource) ? context.resource : null;
  const income = isRecord(context.income) ? context.income : null;
  return {
    score_version: 2,
    player_power: player ? Number(player.power) || 0 : 0,
    training_hero_count: trainingHeroCount,
    training_penalty: trainingPenalty,
    highest_location: highestLocation,
    location_multiplier: locationMultiplier,
    boost_multiplier: boostMultiplier,
    my_score: myScore,
    total_score: totalScore,
    denominator_as_of: new Date(now).toISOString(),
    daily_pool: 20_000,
    pool_share_percent: myDailyShare / 20_000 * 100,
    save_revision: resource ? Number(resource.revision) || 0 : 0,
    pool_amount: 20_000,
    total_distributed: pool ? Number(pool.total_distributed) || 0 : 0,
    distribution_rate: pool ? Number(pool.distribution_rate) || 0.15 : 0.15,
    total_power: totalScore,
    my_power: myScore,
    my_daily_share: myDailyShare,
    my_hourly_share: myDailyShare / 24,
    pending_tokens: player ? Number(player.pending_tokens) || 0 : 0,
    total_claimed: player ? Number(player.total_claimed) || 0 : 0,
    token_balance: player ? Number(player.token_balance) || 0 : 0,
    boost: player ? {
      active: player.boost_max_active === true,
      login_days: Number(player.boost_login_days) || 0,
      online_seconds: Number(player.boost_online_seconds) || 0,
      tokens_earned: Number(player.boost_tokens_earned) || 0,
      tokens_spent: Number(player.boost_tokens_spent) || 0,
      token_balance: Number(player.token_balance) || 0,
    } : null,
    pity: player ? {
      legendary: Number(player.pity_legendary) || 0,
      mythic: Number(player.pity_mythic) || 0,
      cosmic: Number(player.pity_cosmic) || 0,
      divine: Number(player.pity_divine) || 0,
      celestial: Number(player.pity_celestial) || 0,
    } : null,
    ascension_focus: player && isRecord(player.ascension_focus) ? player.ascension_focus : {},
    boss_keys: player ? Number(player.boss_keys) || 0 : 0,
    resource_state: resource?.state ?? null,
    resource_revision: resource ? Number(resource.revision) : null,
    resources: isRecord(context.resources) ? context.resources : null,
    rarity_capacity: rarityCapacity,
    rarity_supply: raritySupply,
    ...(income ?? {}),
  };
}

function canonicalItem(item: JsonRecord, ledgerById: Map<string, JsonRecord>): JsonRecord {
  const row = ledgerById.get(String(item.uid ?? ""));
  return row === undefined ? item : {
    ...item,
    itemId: row.base_item_id,
    level: Number(row.item_level),
    stats: row.stats,
    power: Number(row.power),
    serverOwned: true,
    locked: row.locked === true,
    enchantLevel: Number(row.enchant_level),
    rerollCount: Number(row.reroll_count),
    enchantStatsVersion: Number(row.enchant_stats_version),
    itemRollVersion: Number(row.item_roll_version),
  };
}

export function canonicalizeLoadedState(context: JsonRecord):
  | { state: JsonRecord | null; revision: number | null; migratedItems: number; schemaMigrated: boolean; legacyMarketRecovery: JsonRecord }
  | { code: string; status: number } {
  const legacyMarketRecovery = isRecord(context.legacy_market_recovery)
    ? structuredClone(context.legacy_market_recovery) as JsonRecord
    : null;
  if (!legacyMarketRecovery || typeof legacyMarketRecovery.status !== "string" || typeof legacyMarketRecovery.blocked !== "boolean") {
    return { code: "state_unavailable", status: 503 };
  }
  if (context.state === null && context.revision === null) {
    return { state: null, revision: null, migratedItems: 0, schemaMigrated: false, legacyMarketRecovery };
  }
  if (!isRecord(context.state) || !Number.isSafeInteger(Number(context.revision))) {
    return { code: "state_unavailable", status: 503 };
  }
  let state = structuredClone(context.state) as JsonRecord;
  const resourceState = applyResourceSnapshot(state, context.resources);
  if (!resourceState.ok) return { code: "resource_state_unavailable", status: 503 };
  state = resourceState.state;
  const ledger = recordArray(context.items);
  const ledgerById = new Map(ledger.map((row) => [String(row.id ?? ""), row]));
  const inventory = recordArray(state.inventory);
  if (inventory.some((item) => item.serverOwned === true && !ledgerById.has(String(item.uid ?? "")))) {
    return { code: "item_registry_incomplete", status: 409 };
  }
  state.inventory = inventory.map((item) => canonicalItem(item, ledgerById));
  const validated = validateAndMigrateGameState(state, { allowMissingTeamReferences: true });
  if (!validated.ok) {
    console.error("stored state schema validation failed", { reason: validated.reason ?? "unknown" });
    return { code: "state_unavailable", status: 503 };
  }
  state = validated.state;
  return {
    state,
    revision: Number(context.revision),
    migratedItems: Math.max(0, Math.floor(Number(context.migrated_items) || 0)),
    schemaMigrated: validated.migrated === true,
    legacyMarketRecovery,
  };
}

export function mergeSaveState(
  context: JsonRecord,
  requestedValue: unknown,
  playerId: string,
  now: number,
): { state: JsonRecord; revision: number } | { code: string; status: number; result?: JsonRecord } {
  const account = isRecord(context.account) ? context.account : null;
  if (!account) return { code: "account_required", status: 403 };
  if (!isRecord(requestedValue)) return { code: "invalid_state", status: 400 };
  const requested = clonePersistentState(requestedValue, String(account.username ?? ""), playerId);
  if (!requested) return { code: "state_too_large", status: 413 };
  requested.hero = Number(account.token_balance);
  requested.summons = Number(account.summons);
  const revision = Number(context.revision);
  if (!validPersistentState(context.state) || !Number.isSafeInteger(revision) || revision < 1) {
    return { code: "state_unavailable", status: 503 };
  }
  let current = applyTrainingPurchases(context.state, recordArray(context.training_purchases), now) as JsonRecord;
  const resourceState = applyResourceSnapshot(current, context.resources);
  if (!resourceState.ok) return { code: "resource_state_unavailable", status: 503 };
  current = resourceState.state;
  const serverTraining = isRecord(current.trainingCamp) ? current.trainingCamp : {};
  const unlockedSlots = Math.max(2, Math.min(10, Math.floor(Number(serverTraining.unlockedSlots) || 2)));
  const serverTrainingUids = Array.isArray(serverTraining.heroUids) ? serverTraining.heroUids : [];
  const canonicalTrainingUids = Array.from({ length: 10 }, (_, index) =>
    index < unlockedSlots && typeof serverTrainingUids[index] === "string" ? serverTrainingUids[index] : null
  );
  const requestedTeamBeforeValidation = Array.isArray(requested.team)
    ? requested.team.filter((uid): uid is string => typeof uid === "string")
    : [];
  if (requestedTeamBeforeValidation.some((uid) => canonicalTrainingUids.includes(uid))) {
    return { code: "hero_in_training", status: 409, result: { revision, state: current, conflict: true } };
  }
  requested.trainingCamp = { ...serverTraining, heroUids: canonicalTrainingUids };
  const validated = validateAndMigrateGameState(requested, { canonicalState: current });
  if (!validated.ok) return { code: validated.code ?? "invalid_state", status: validated.code === "state_too_large" ? 413 : 400 };
  for (const key of Object.keys(requested)) delete requested[key];
  Object.assign(requested, validated.state);
  const ledger = recordArray(context.items);
  const ledgerIds = new Set(ledger.map((row) => String(row.id ?? "")));
  const ledgerById = new Map(ledger.map((row) => [String(row.id ?? ""), row]));
  const currentInventory = recordArray(current.inventory);
  const requestedInventory = recordArray(requested.inventory);
  if (requestedInventory.some((item) => item.serverOwned === true && !ledgerIds.has(String(item.uid ?? "")))) {
    return { code: "item_registry_incomplete", status: 409 };
  }
  const requestedItemUids = new Set(requestedInventory.map((item) => String(item.uid ?? "")));
  requested.inventory = [
    ...requestedInventory.map((item) => canonicalItem(item, ledgerById)),
    ...currentInventory
      .filter((item) => ledgerIds.has(String(item.uid ?? "")) && !requestedItemUids.has(String(item.uid ?? "")))
      .map((item) => canonicalItem(item, ledgerById)),
  ];
  const savedInventoryIds = new Set(recordArray(requested.inventory).map((item) => String(item.uid ?? "")));
  if (Array.isArray(requested.marketListings)) {
    requested.marketListings = requested.marketListings.filter((listing) => {
      if (!isRecord(listing)) return false;
      const item = listing.item;
      return !isRecord(item) || !ledgerIds.has(String(item.uid ?? ""));
    });
  }
  const currentListings = recordArray(current.marketListings);
  const escrowHeroes = currentListings.flatMap((listing) => isRecord(listing.hero) ? [listing.hero] : []);
  requested.ownedHeroes = preserveHeroOwnership(
    current.ownedHeroes,
    escrowHeroes,
    requested.ownedHeroes,
    savedInventoryIds,
    ledgerIds,
  );
  if (recordArray(requested.ownedHeroes).length === 0) return { code: "invalid_owned_heroes", status: 400 };
  const unequippedCount = (state: JsonRecord): number => {
    const equipped = new Set(recordArray(state.ownedHeroes).flatMap((hero) =>
      isRecord(hero.equipped) ? Object.values(hero.equipped).filter((uid): uid is string => typeof uid === "string") : []));
    return recordArray(state.inventory).filter((item) => !equipped.has(String(item.uid ?? ""))).length;
  };
  const currentBagCount = unequippedCount(current);
  const requestedBagCount = unequippedCount(requested);
  const capacity = Array.isArray(requested.bagSlots)
    ? requested.bagSlots.reduce<number>((sum, slots) => sum + Number(slots), 0) : 64;
  if (requestedBagCount > capacity && requestedBagCount > currentBagCount) {
    return { code: "item_capacity_exceeded", status: 409, result: { revision, state: current, conflict: true } };
  }
  const savedHeroUids = new Set(recordArray(requested.ownedHeroes).map((hero) => String(hero.uid ?? "")));
  const requestedTeam = Array.isArray(requested.team)
    ? requested.team.filter((uid): uid is string => typeof uid === "string")
    : [];
  if (requestedTeam.some((uid) => !savedHeroUids.has(uid))) {
    return { code: "invalid_team_reference", status: 409, result: { revision, state: current, conflict: true } };
  }
  for (const field of [
    "accountXp", "accountLevel", "highestLocation", "totalGoldEarned", "totalKills", "totalBossKills",
    "chestsOpenedToday", "lastChestReset", "combatXpAt",
  ]) requested[field] = current[field];
  requested.currentLocation = Math.min(
    Math.max(1, Math.floor(Number(requested.currentLocation) || 1)),
    serverLocationCap(current),
  );
  requested.gold = Math.min(
    Math.max(0, Math.floor(Number(requested.gold) || 0)),
    Math.max(0, Math.floor(Number(current.gold) || 0)) + allowedGoldCredit(current, requested),
  );
  requested.rotatingShop = current.rotatingShop;
  requested.rotatingShopRefreshAt = current.rotatingShopRefreshAt;
  requested.chests = recordArray(current.chests);
  const requestedBoost = isRecord(requested.boost) ? requested.boost : {};
  const serverBoost = isRecord(current.boost) ? current.boost : {};
  requested.boost = {
    ...requestedBoost,
    chestProgressSeconds: serverBoost.chestProgressSeconds ?? 0,
    goldProgressSeconds: serverBoost.goldProgressSeconds ?? 0,
    combatProgressSeconds: serverBoost.combatProgressSeconds ?? 0,
  };
  return { state: requested, revision };
}
