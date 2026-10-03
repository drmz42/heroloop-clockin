export const SAVE_SCHEMA_VERSION = 4;
export const MAX_STATE_OBJECT_KEYS = 65_536;

const DATA_FIELDS = new Set([
  "gold", "hero", "accountXp", "accountLevel", "heroCapacity", "bagSlots", "ownedHeroes", "team", "inventory", "chests",
  "bossKeys", "bossBattleActive", "battleAnimationMode", "chestsOpenedToday", "lastChestReset",
  "currentLocation", "highestLocation", "lastSeen", "combatXpAt", "activeUntil", "totalGoldEarned",
  "totalTokensEarned", "tokensEarnedToday", "tokenDayKey", "totalKills", "totalBossKills", "summons",
  "summonScrolls", "potions", "autoPot", "tutorial", "trainingCamp", "rotatingShop",
  "rotatingShopRefreshAt", "session", "dailyQuests", "milestoneQuests", "lastQuestReset", "referral",
  "username", "walletAddress", "avatarHeroId", "boost", "balanceTelemetry", "marketListings",
  "marketHistory", "starterBalanceV2", "compatibilityMigrations",
]);
const TOP_LEVEL_FIELDS = new Set([...DATA_FIELDS, "save_schema_version"]);
const AUTHORITATIVE_FIELDS = new Set([
  "gold", "hero", "accountXp", "accountLevel", "heroCapacity", "bagSlots", "bossKeys", "bossBattleActive", "chestsOpenedToday",
  "lastChestReset", "highestLocation", "lastSeen", "combatXpAt", "activeUntil", "totalGoldEarned",
  "totalTokensEarned", "tokensEarnedToday", "tokenDayKey", "totalKills", "totalBossKills", "summons",
  "summonScrolls", "potions", "tutorial", "trainingCamp", "rotatingShop", "rotatingShopRefreshAt",
  "dailyQuests", "milestoneQuests", "lastQuestReset", "referral", "username", "walletAddress", "boost",
  "marketListings", "marketHistory", "starterBalanceV2", "compatibilityMigrations",
]);
const EPHEMERAL_FIELDS = new Set(["session", "balanceTelemetry"]);
const ITEM_SLOTS = new Set(["class_weapon", "offhand", "helmet", "chest", "gloves", "boots", "ring", "amulet", "weapon", "armor", "ring1", "ring2"]);
const ITEM_STATS = new Set(["hp", "atk", "def", "atkSpeed", "critChance", "critDamage", "goldBonus", "xpBonus", "dodge"]);
const RARITIES = new Set(["common", "uncommon", "rare", "epic", "legendary", "mythic", "cosmic", "divine", "celestial", "cursed", "immortal", "god", "relic"]);
const POTION_TIERS = new Set(["xs", "sm", "md", "lg", "xl", "xxl"]);
const TRAINING_BOOSTS = new Set(["2x-1h", "2x-4h", "4x-1h", "4x-4h"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/i;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function keysExact(value, allowed) {
  return record(value) && Object.keys(value).every((key) => allowed.has(key) && !FORBIDDEN_KEYS.has(key));
}

function finite(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value >= min && value <= max;
}

function decimal(value, min = 0, max = 1_000_000_000_000) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && value >= min && value <= max;
}

function text(value, max, pattern) {
  return typeof value === "string" && value.length <= max && (!pattern || pattern.test(value));
}

function validateComplexity(value, validateNumbers = true) {
  let keys = 0;
  const visit = (entry, depth) => {
    if (depth > 12) return false;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
    if (typeof entry === "number") return !validateNumbers || (Number.isFinite(entry) && Math.abs(entry) <= Number.MAX_SAFE_INTEGER);
    if (Array.isArray(entry)) return entry.length <= 1_000 && entry.every((child) => visit(child, depth + 1));
    if (!record(entry)) return false;
    const names = Object.keys(entry);
    keys += names.length;
    return keys <= MAX_STATE_OBJECT_KEYS && names.every((name) => !FORBIDDEN_KEYS.has(name) && visit(entry[name], depth + 1));
  };
  return visit(value, 0);
}

function hero(value) {
  const allowed = new Set(["uid", "heroId", "level", "stars", "equipped", "respawnAt", "xp", "locked", "isNew"]);
  if (!keysExact(value, allowed) || !text(value.uid, 128) || !text(value.heroId, 96, ID_PATTERN) ||
      !finite(value.level, 1, 99) || !finite(value.stars, 0, 20) || !finite(value.xp, 0, 1_000_000_000)) return false;
  if (!keysExact(value.equipped, ITEM_SLOTS)) return false;
  if (!Object.values(value.equipped).every((uid) => text(uid, 128))) return false;
  return (value.respawnAt === undefined || finite(value.respawnAt, 0, 8_640_000_000_000_000)) &&
    (value.locked === undefined || typeof value.locked === "boolean") &&
    (value.isNew === undefined || typeof value.isNew === "boolean");
}

function itemError(value) {
  const allowed = new Set(["uid", "itemId", "level", "stats", "power", "serverOwned", "locked", "isNew", "enchantLevel", "enchantStatsVersion", "itemRollVersion", "rerollCount"]);
  if (!keysExact(value, allowed)) {
    const unknown = record(value) ? Object.keys(value).filter((key) => !allowed.has(key)).sort().join(",") : "not_record";
    return `fields:${unknown}`;
  }
  if (!text(value.uid, 128)) return "uid";
  if (!text(value.itemId, 96, ID_PATTERN)) return "item_id";
  if (!finite(value.level, 1, 99)) return "level";
  if (!Array.isArray(value.stats) || value.stats.length > 12) return "stats_bounds";
  if (!decimal(value.power, 0)) return "power";
  if (!finite(value.enchantLevel, 0, 20)) return "enchant_level";
  if (!finite(value.rerollCount, 0, 1_000_000)) return "reroll_count";
  if (!value.stats.every((stat) => keysExact(stat, new Set(["key", "value", "isPercent"])) && ITEM_STATS.has(stat.key) &&
      decimal(stat.value, -1_000_000_000, 1_000_000_000) && typeof stat.isPercent === "boolean")) return "stat_shape";
  if (value.serverOwned !== undefined && typeof value.serverOwned !== "boolean") return "server_owned";
  if (value.locked !== undefined && typeof value.locked !== "boolean") return "locked";
  if (value.isNew !== undefined && typeof value.isNew !== "boolean") return "is_new";
  if (value.enchantStatsVersion !== undefined && value.enchantStatsVersion !== 2 && value.enchantStatsVersion !== 3 && value.enchantStatsVersion !== 4) return "enchant_stats_version";
  if (value.itemRollVersion !== undefined && value.itemRollVersion !== 2 && value.itemRollVersion !== 3 && value.itemRollVersion !== 4 && value.itemRollVersion !== 5) return "item_roll_version";
  return null;
}

function item(value) {
  return itemError(value) === null;
}

function chest(value) {
  // Chest ids were removed by the server-owned compact-save migration.  Keep
  // accepting legacy ids during load, but do not permit malformed identifiers
  // or any client-controlled fields beyond the immutable chest attributes.
  return keysExact(value, new Set(["id", "stage", "boss", "tutorial"])) &&
    (value.id === undefined || text(value.id, 128)) &&
    finite(value.stage, 1, 100) && (value.boss === undefined || typeof value.boss === "boolean") &&
    (value.tutorial === undefined || typeof value.tutorial === "boolean");
}

function quest(value) {
  if (!keysExact(value, new Set(["id", "label", "kind", "chain", "tier", "target", "progress", "reward", "claimed"])) ||
      !text(value.id, 128, ID_PATTERN) || !text(value.label, 256) || !finite(value.target, 0, 1_000_000_000) ||
      !finite(value.progress, 0, 1_000_000_000) || typeof value.claimed !== "boolean") return false;
  if (value.kind !== undefined && value.kind !== "daily" && value.kind !== "milestone") return false;
  if (value.chain !== undefined && !text(value.chain, 64, ID_PATTERN)) return false;
  if (value.tier !== undefined && !finite(value.tier, 0, 100)) return false;
  if (!keysExact(value.reward, new Set(["gold", "hero", "bossKeys", "summonScrolls"]))) return false;
  return decimal(value.reward.gold, 0) && decimal(value.reward.hero, 0) &&
    (value.reward.bossKeys === undefined || finite(value.reward.bossKeys, 0, 1_000_000)) &&
    (value.reward.summonScrolls === undefined || finite(value.reward.summonScrolls, 0, 1_000_000));
}

function ownedCollectionsError(state, allowMissingTeamReferences = false) {
  if (!Array.isArray(state.bagSlots) || state.bagSlots.length !== 4 ||
      !state.bagSlots.every((slots) => slots === 0 || slots === 48 || slots === 64) ||
      state.bagSlots[0] === 0 ||
      state.bagSlots.some((slots, index) => index > 0 && slots > 0 && state.bagSlots[index - 1] !== 64) ||
      state.bagSlots.some((slots, index) => index > 0 && slots === 0 && state.bagSlots.slice(index + 1).some(Boolean))) return "bag_slots";
  if (!finite(state.heroCapacity, 500, 1000) || state.heroCapacity % 100 !== 0) return "hero_capacity";
  if (!Array.isArray(state.ownedHeroes) || state.ownedHeroes.length < 1 || state.ownedHeroes.length > state.heroCapacity) return "heroes_bounds";
  if (!state.ownedHeroes.every(hero)) return "hero_shape";
  if (!Array.isArray(state.inventory) || state.inventory.length > 1_000) return "inventory_bounds";
  const invalidItem = state.inventory.find((entry) => itemError(entry) !== null);
  if (invalidItem !== undefined) return `item_shape:${itemError(invalidItem)}`;
  if (!Array.isArray(state.chests) || state.chests.length > 500) return "chests_bounds";
  if (!state.chests.every(chest)) return "chest_shape";
  if (!Array.isArray(state.team) || state.team.length > 3 || !state.team.every((uid) => text(uid, 128))) return "team_shape";
  const heroUids = state.ownedHeroes.map((entry) => entry.uid);
  const itemUids = state.inventory.map((entry) => entry.uid);
  if (new Set(heroUids).size !== heroUids.length) return "duplicate_hero_uid";
  if (new Set(itemUids).size !== itemUids.length) return "duplicate_item_uid";
  if (new Set(state.team).size !== state.team.length) return "duplicate_team_uid";
  const ownedHeroes = new Set(heroUids);
  const ownedItems = new Set(itemUids);
  if (!allowMissingTeamReferences && !state.team.every((uid) => ownedHeroes.has(uid))) return "dangling_team_uid";
  if (!state.ownedHeroes.every((entry) => Object.values(entry.equipped).every((uid) => ownedItems.has(uid)))) return "dangling_equipped_uid";
  return null;
}

function validateSettings(state) {
  if (state.battleAnimationMode !== "light" && state.battleAnimationMode !== "spectacular" && state.battleAnimationMode !== "off") return false;
  if (!keysExact(state.autoPot, new Set(["enabled", "autoBuy", "autoBuyTier", "autoSelectTier", "threshold", "goldHealingOptOut", "healingInfoSeen"])) ||
      typeof state.autoPot.enabled !== "boolean" || typeof state.autoPot.autoBuy !== "boolean" ||
      !POTION_TIERS.has(state.autoPot.autoBuyTier) || !decimal(state.autoPot.threshold, 0.05, 1) ||
      (state.autoPot.autoSelectTier !== undefined && typeof state.autoPot.autoSelectTier !== "boolean") ||
      (state.autoPot.goldHealingOptOut !== undefined && typeof state.autoPot.goldHealingOptOut !== "boolean") ||
      (state.autoPot.healingInfoSeen !== undefined && typeof state.autoPot.healingInfoSeen !== "boolean")) return false;
  if (!text(state.avatarHeroId, 96, ID_PATTERN) || !state.ownedHeroes.some((entry) => entry.heroId === state.avatarHeroId)) return false;
  return finite(state.currentLocation, 1, 100);
}

function authoritativeShapeError(state) {
  const ints = ["accountXp", "accountLevel", "heroCapacity", "bossKeys", "chestsOpenedToday", "lastChestReset", "highestLocation", "lastSeen", "combatXpAt", "activeUntil", "totalGoldEarned", "totalKills", "totalBossKills", "summons", "summonScrolls", "rotatingShopRefreshAt", "lastQuestReset"];
  for (const field of ints) if (!finite(state[field], field === "accountLevel" || field === "highestLocation" ? 1 : 0)) return `integer:${field}`;
  for (const field of ["gold", "hero", "totalTokensEarned", "tokensEarnedToday"]) if (!decimal(state[field], 0)) return `decimal:${field}`;
  if (typeof state.bossBattleActive !== "boolean") return "boss_battle_active";
  if (!text(state.tokenDayKey, 10, DAY_PATTERN)) return "token_day_key";
  if (typeof state.starterBalanceV2 !== "boolean") return "starter_balance";
  if (!keysExact(state.potions, POTION_TIERS)) return "potions_fields";
  if (![...POTION_TIERS].every((tier) => finite(state.potions[tier], 0, 1_000_000_000))) return "potions_quantity";
  if (!keysExact(state.tutorial, new Set(["welcomeCompleted", "autoPotCompleted", "chestGranted", "chestCompleted", "questOrdinal", "questCompleted", "openedCount", "chestBalance", "bossKillsAtKeyGrant"])) ||
      !["welcomeCompleted", "autoPotCompleted", "chestGranted", "chestCompleted"].every((field) => typeof state.tutorial[field] === "boolean") ||
      (state.tutorial.questCompleted !== undefined && typeof state.tutorial.questCompleted !== "boolean") ||
      !["questOrdinal", "openedCount", "chestBalance", "bossKillsAtKeyGrant"].every((field) => state.tutorial[field] === undefined || finite(state.tutorial[field], 0, 1_000_000_000))) return "tutorial";
  if (!keysExact(state.trainingCamp, new Set(["heroUids", "unlockedSlots", "boostMultiplier", "boostEndsAt", "activeBoostKey", "boostQueue", "lastTick", "serverAppliedPurchaseIds"]))) return "training_fields";
  const camp = state.trainingCamp;
  if (!Array.isArray(camp.heroUids) || camp.heroUids.length !== 10 || !camp.heroUids.every((uid) => uid === null || text(uid, 128)) ||
      !finite(camp.unlockedSlots, 2, 10) || ![1, 2, 4].includes(camp.boostMultiplier) || !finite(camp.boostEndsAt, 0, 8_640_000_000_000_000) ||
      (camp.activeBoostKey !== null && !TRAINING_BOOSTS.has(camp.activeBoostKey)) || !finite(camp.lastTick, 0, 8_640_000_000_000_000) ||
      !Array.isArray(camp.boostQueue) || camp.boostQueue.length > 100) return "training_shape";
  if (!camp.boostQueue.every((entry) => keysExact(entry, new Set(["key", "multiplier", "durationMs"])) && TRAINING_BOOSTS.has(entry.key) &&
      (entry.multiplier === 2 || entry.multiplier === 4) && finite(entry.durationMs, 1, 14_400_000))) return "training_queue";
  if (camp.serverAppliedPurchaseIds !== undefined && (!Array.isArray(camp.serverAppliedPurchaseIds) || camp.serverAppliedPurchaseIds.length > 200 || !camp.serverAppliedPurchaseIds.every((id) => text(id, 128)))) return "training_purchase_ids";
  const campIds = camp.heroUids.filter(Boolean);
  if (new Set(campIds).size !== campIds.length || !campIds.every((uid) => state.ownedHeroes.some((entry) => entry.uid === uid)) || campIds.some((uid) => state.team.includes(uid))) return "training_references";
  if (!Array.isArray(state.rotatingShop) || state.rotatingShop.length > 200 || !state.rotatingShop.every((entry) =>
    keysExact(entry, new Set(["itemId", "price", "sold", "rarity", "slot"])) && text(entry.itemId, 96, ID_PATTERN) && decimal(entry.price, 0) && typeof entry.sold === "boolean" &&
    (entry.rarity === undefined || RARITIES.has(entry.rarity)) && (entry.slot === undefined || ITEM_SLOTS.has(entry.slot)))) return "rotating_shop";
  if (!Array.isArray(state.dailyQuests) || state.dailyQuests.length > 100 || !state.dailyQuests.every(quest) ||
      !Array.isArray(state.milestoneQuests) || state.milestoneQuests.length > 100 || !state.milestoneQuests.every(quest)) return "quests";
  if (!keysExact(state.referral, new Set(["code", "invitedUsers", "pendingReward", "totalEarned", "alreadyClaimed"])) ||
      !text(state.referral.code, 32, /^[A-Z0-9]*$/) || !Array.isArray(state.referral.invitedUsers) || state.referral.invitedUsers.length > 1_000 ||
      !state.referral.invitedUsers.every((entry) => keysExact(entry, new Set(["username", "level", "active"])) && text(entry.username, 32) && finite(entry.level, 1, 99) && typeof entry.active === "boolean") ||
      !decimal(state.referral.pendingReward, 0) || !decimal(state.referral.totalEarned, 0) || !finite(state.referral.alreadyClaimed, 0, 1_000_000_000)) return "referral";
  if (!text(state.username, 32) || !text(state.walletAddress, 128)) return "identity_display";
  if (!keysExact(state.boost, new Set(["active", "progress", "bonusPct", "chestProgressSeconds", "goldProgressSeconds", "combatProgressSeconds", "conditions"])) ||
      typeof state.boost.active !== "boolean" || !decimal(state.boost.progress, 0, 100) || !decimal(state.boost.bonusPct, 0, 1_000) ||
      !decimal(state.boost.chestProgressSeconds, 0, 604_800) || !decimal(state.boost.goldProgressSeconds, 0, 604_800) || !decimal(state.boost.combatProgressSeconds, 0, 604_800) ||
      !keysExact(state.boost.conditions, new Set(["connectTelegram", "connectTwitter", "connectDiscord", "spentTokens", "holdTokens"])) ||
      typeof state.boost.conditions.connectTelegram !== "boolean" || typeof state.boost.conditions.connectTwitter !== "boolean" || typeof state.boost.conditions.connectDiscord !== "boolean" ||
      !decimal(state.boost.conditions.spentTokens, 0) || !decimal(state.boost.conditions.holdTokens, 0)) return "boost";
  if (!Array.isArray(state.marketListings) || state.marketListings.length > 200 || !Array.isArray(state.marketHistory) || state.marketHistory.length > 1_000) return "market_bounds";
  if (!state.marketListings.every((entry) => keysExact(entry, new Set(["id", "kind", "price", "createdAt", "item", "hero"])) && text(entry.id, 128) &&
    (entry.kind === "item" || entry.kind === "hero") && decimal(entry.price, 0) && finite(entry.createdAt, 0, 8_640_000_000_000_000) &&
    (entry.item === undefined || item(entry.item)) && (entry.hero === undefined || hero(entry.hero)) && ((entry.item === undefined) !== (entry.hero === undefined)))) return "market_listing";
  if (!state.marketHistory.every((entry) => keysExact(entry, new Set(["id", "kind", "sourceId", "name", "price", "createdAt", "action"])) &&
      text(entry.id, 128) && (entry.kind === "item" || entry.kind === "hero") && text(entry.sourceId, 128) && text(entry.name, 128) &&
      decimal(entry.price, 0) && finite(entry.createdAt, 0, 8_640_000_000_000_000) && (entry.action === "bought" || entry.action === "sold"))) return "market_history";
  if (!keysExact(state.compatibilityMigrations, new Set(["legacyMarketRecoveryV1"])) ||
      (state.compatibilityMigrations.legacyMarketRecoveryV1 !== undefined &&
       typeof state.compatibilityMigrations.legacyMarketRecoveryV1 !== "boolean")) return "compatibility_migrations";
  return null;
}

function migrateVersionZero(state) {
  const firstHeroId = Array.isArray(state.ownedHeroes) && typeof state.ownedHeroes[0]?.heroId === "string"
    ? state.ownedHeroes[0].heroId
    : "shepherd-common";
  const timestamp = finite(state.lastSeen, 0, 8_640_000_000_000_000) ? state.lastSeen : 0;
  const defaults = {
    gold: 0, hero: 0, accountXp: 0, accountLevel: 1, heroCapacity: 500, bagSlots: [64, 0, 0, 0], ownedHeroes: [], team: [], inventory: [], chests: [],
    bossKeys: 0, bossBattleActive: false, battleAnimationMode: "spectacular", chestsOpenedToday: 0,
    lastChestReset: timestamp, currentLocation: 1, highestLocation: 1, lastSeen: timestamp,
    combatXpAt: timestamp, activeUntil: timestamp, totalGoldEarned: 0, totalTokensEarned: 0,
    tokensEarnedToday: 0, tokenDayKey: "1970-01-01", totalKills: 0, totalBossKills: 0, summons: 0,
    summonScrolls: 0, potions: { xs: 0, sm: 0, md: 0, lg: 0, xl: 0, xxl: 0 },
    autoPot: { enabled: true, autoBuy: false, autoBuyTier: "sm", autoSelectTier: true, threshold: 0.4 },
    tutorial: { welcomeCompleted: true, autoPotCompleted: true, chestGranted: false, chestCompleted: false, questOrdinal: 11, questCompleted: true, openedCount: 0, chestBalance: 0, bossKillsAtKeyGrant: 0 },
    trainingCamp: { heroUids: Array.from({ length: 10 }, () => null), unlockedSlots: 2, boostMultiplier: 1, boostEndsAt: 0, activeBoostKey: null, boostQueue: [], lastTick: timestamp, serverAppliedPurchaseIds: [] },
    rotatingShop: [], rotatingShopRefreshAt: timestamp, session: {}, dailyQuests: [], milestoneQuests: [],
    lastQuestReset: timestamp, referral: { code: "", invitedUsers: [], pendingReward: 0, totalEarned: 0, alreadyClaimed: 0 },
    username: "", walletAddress: "", avatarHeroId: firstHeroId,
    boost: { active: false, progress: 0, bonusPct: 0, chestProgressSeconds: 0, goldProgressSeconds: 0, combatProgressSeconds: 0, conditions: { connectTelegram: false, connectTwitter: false, connectDiscord: false, spentTokens: 0, holdTokens: 0 } },
    balanceTelemetry: {}, marketListings: [], marketHistory: [], starterBalanceV2: true,
    compatibilityMigrations: {},
  };
  return Object.assign(defaults, state);
}

export function validateAndMigrateGameState(value, options = {}) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return { ok: false, code: "invalid_state" }; }
  const encodedBytes = typeof serialized === "string" ? new TextEncoder().encode(serialized).length : 0;
  if (typeof serialized !== "string" || encodedBytes > 1_000_000 || !record(value)) {
    return { ok: false, code: encodedBytes > 1_000_000 ? "state_too_large" : "invalid_state", reason: "envelope" };
  }
  if (!Object.keys(value).every((key) => TOP_LEVEL_FIELDS.has(key) && !FORBIDDEN_KEYS.has(key))) return { ok: false, code: "invalid_state", reason: "top_level_fields" };
  if (!validateComplexity(value, false)) return { ok: false, code: "invalid_state", reason: "complexity" };
  const version = value.save_schema_version ?? 0;
  if (!finite(version, 0, SAVE_SCHEMA_VERSION) || version > SAVE_SCHEMA_VERSION) return { ok: false, code: "unsupported_save_schema", reason: "version" };
  let state = structuredClone(value);
  if (version === 0) state = migrateVersionZero(state);
  if (version <= 2) state.heroCapacity = 500;
  if (version <= 3) state.bagSlots = [64, 0, 0, 0];
  // This marker did not exist before v2, so an older client cannot forge it.
  if (version <= 1) state.compatibilityMigrations = {};
  if (record(options.canonicalState)) {
    for (const field of AUTHORITATIVE_FIELDS) {
      if (Object.hasOwn(options.canonicalState, field)) state[field] = structuredClone(options.canonicalState[field]);
    }
  }
  for (const field of EPHEMERAL_FIELDS) delete state[field];
  state.save_schema_version = SAVE_SCHEMA_VERSION;
  if (!validateComplexity(state)) return { ok: false, code: "invalid_state", reason: "complexity" };
  if (!Object.keys(state).every((key) => TOP_LEVEL_FIELDS.has(key))) return { ok: false, code: "invalid_state", reason: "migrated_fields" };
  if (![...DATA_FIELDS].filter((field) => !EPHEMERAL_FIELDS.has(field)).every((field) => Object.hasOwn(state, field))) return { ok: false, code: "invalid_state", reason: "required_fields" };
  const ownedError = ownedCollectionsError(state, options.allowMissingTeamReferences === true);
  if (ownedError) return { ok: false, code: "invalid_state", reason: `owned_collections:${ownedError}` };
  if (!validateSettings(state)) return { ok: false, code: "invalid_state", reason: "settings" };
  const authoritativeError = authoritativeShapeError(state);
  if (authoritativeError) return { ok: false, code: "invalid_state", reason: `authoritative_shape:${authoritativeError}` };
  return { ok: true, state, migrated: version !== SAVE_SCHEMA_VERSION };
}

export function validRegistrationShell(value) {
  if (!record(value) || !validateComplexity(value)) return false;
  return Array.isArray(value.ownedHeroes) && value.ownedHeroes.length > 0 && value.ownedHeroes.length <= 500 &&
    Array.isArray(value.inventory) && value.inventory.length <= 1_000 && Array.isArray(value.chests) && value.chests.length <= 500 &&
    Array.isArray(value.team) && value.team.length <= 3;
}

export function applyResourceSnapshot(value, snapshot) {
  if (!record(value) || !record(snapshot) || !record(snapshot.balances)) return { ok: false };
  const read = (id, maximum) => {
    const amount = snapshot.balances[id];
    if (typeof amount !== "string" || !/^[0-9]+$/.test(amount)) return null;
    const numeric = Number(amount);
    return Number.isSafeInteger(numeric) && numeric <= maximum ? numeric : null;
  };
  const bossKeys = read("boss_key", 1_000_000);
  const summonScrolls = read("summon_scroll", 1_000_000_000);
  const potions = Object.fromEntries([...POTION_TIERS].map((tier) => [tier, read(`potion_${tier}`, 1_000_000_000)]));
  if (bossKeys === null || summonScrolls === null || Object.values(potions).some((amount) => amount === null)) return { ok: false };
  const state = structuredClone(value);
  state.bossKeys = bossKeys;
  state.summonScrolls = summonScrolls;
  state.potions = potions;
  return { ok: true, state };
}
