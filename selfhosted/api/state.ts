import {
  allowedGoldCredit,
  applyTrainingPurchases,
  deriveServerSummary,
  serverLocationCap,
} from "../shared/authority.mjs";
import {
  buildRegisteredState,
  STARTER_HERO_IDS,
} from "../shared/registration.js";

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

export function validPersistentState(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  return Array.isArray(value.ownedHeroes) && value.ownedHeroes.length > 0 && value.ownedHeroes.length <= 500 &&
    Array.isArray(value.inventory) && value.inventory.length <= 200 &&
    Array.isArray(value.chests) && value.chests.length <= 500 &&
    Array.isArray(value.team) && value.team.length <= 3;
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

function clonePersistentState(value: JsonRecord, username: string, playerId: string): JsonRecord | null {
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
    !STARTER_HERO_IDS.has(starterHeroId) || !validPersistentState(payload.state)
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
  return validPersistentState(state)
    ? { username, starterHeroId, state }
    : { code: "invalid_registration_state", status: 400 };
}

export function prepareLegacyMigration(
  context: JsonRecord,
  requestedValue: unknown,
  playerId: string,
): { state: JsonRecord } | { code: string; status: number } {
  const account = isRecord(context.account) ? context.account : null;
  if (!account) return { code: "account_required", status: 403 };
  if (!validPersistentState(requestedValue)) return { code: "invalid_state", status: 400 };
  const state = clonePersistentState(requestedValue, String(account.username ?? ""), playerId);
  if (!state) return { code: "state_too_large", status: 413 };
  state.hero = Number(account.token_balance);
  state.summons = Number(account.summons);
  return { state };
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
  };
}

export function canonicalizeLoadedState(context: JsonRecord):
  | { state: JsonRecord | null; revision: number | null; migratedItems: number }
  | { code: string; status: number } {
  if (context.state === null && context.revision === null) {
    return { state: null, revision: null, migratedItems: 0 };
  }
  if (!validPersistentState(context.state) || !Number.isSafeInteger(Number(context.revision))) {
    return { code: "state_unavailable", status: 503 };
  }
  const state = structuredClone(context.state) as JsonRecord;
  const ledger = recordArray(context.items);
  const ledgerById = new Map(ledger.map((row) => [String(row.id ?? ""), row]));
  const inventory = recordArray(state.inventory);
  if (inventory.some((item) => item.serverOwned === true && !ledgerById.has(String(item.uid ?? "")))) {
    return { code: "item_registry_incomplete", status: 409 };
  }
  state.inventory = inventory.map((item) => canonicalItem(item, ledgerById));
  return {
    state,
    revision: Number(context.revision),
    migratedItems: Math.max(0, Math.floor(Number(context.migrated_items) || 0)),
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
  if (!validPersistentState(requestedValue)) return { code: "invalid_state", status: 400 };
  const requested = clonePersistentState(requestedValue, String(account.username ?? ""), playerId);
  if (!requested) return { code: "state_too_large", status: 413 };
  requested.hero = Number(account.token_balance);
  requested.summons = Number(account.summons);
  const revision = Number(context.revision);
  if (!validPersistentState(context.state) || !Number.isSafeInteger(revision) || revision < 1) {
    return { code: "state_unavailable", status: 503 };
  }
  const current = applyTrainingPurchases(context.state, recordArray(context.training_purchases), now) as JsonRecord;
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
  const serverHeroes = [...recordArray(current.ownedHeroes), ...escrowHeroes];
  requested.ownedHeroes = recordArray(requested.ownedHeroes).flatMap((candidate) => {
    const authoritative = serverHeroes.find((hero) => String(hero.uid ?? "") === String(candidate.uid ?? ""));
    if (!authoritative) return [];
    const requestedEquipped = isRecord(candidate.equipped) ? candidate.equipped : {};
    const authoritativeEquipped = isRecord(authoritative.equipped) ? authoritative.equipped : {};
    const equipped = Object.fromEntries(Object.entries(requestedEquipped)
      .filter(([, uid]) => savedInventoryIds.has(String(uid ?? "")) && !ledgerIds.has(String(uid ?? ""))));
    for (const [slot, uid] of Object.entries(authoritativeEquipped)) {
      if (ledgerIds.has(String(uid ?? ""))) equipped[slot] = uid;
    }
    return [{
      ...authoritative,
      equipped,
      locked: candidate.locked,
      isNew: candidate.isNew,
      respawnAt: candidate.respawnAt,
    }];
  });
  if (recordArray(requested.ownedHeroes).length === 0) return { code: "invalid_owned_heroes", status: 400 };
  const savedHeroUids = new Set(recordArray(requested.ownedHeroes).map((hero) => String(hero.uid ?? "")));
  const requestedTeam = Array.isArray(requested.team)
    ? requested.team.filter((uid): uid is string => typeof uid === "string")
    : [];
  if (requestedTeam.some((uid) => !savedHeroUids.has(uid))) {
    return { code: "invalid_team_reference", status: 409, result: { revision, state: current, conflict: true } };
  }
  const serverTraining = isRecord(current.trainingCamp) ? current.trainingCamp : {};
  const requestedTraining = isRecord(requested.trainingCamp) ? requested.trainingCamp : {};
  const unlockedSlots = Math.max(2, Math.min(10, Math.floor(Number(serverTraining.unlockedSlots) || 2)));
  const requestedTrainingUids = Array.isArray(requestedTraining.heroUids) ? requestedTraining.heroUids : [];
  const seen = new Set<string>();
  const ownedHeroes = recordArray(requested.ownedHeroes);
  const accountLevel = Number(current.accountLevel);
  requested.trainingCamp = {
    ...serverTraining,
    heroUids: Array.from({ length: 10 }, (_, index) => {
      if (index >= unlockedSlots) return null;
      const uid = typeof requestedTrainingUids[index] === "string" ? requestedTrainingUids[index] : null;
      const hero = uid ? ownedHeroes.find((entry) => entry.uid === uid) : null;
      if (!uid || !hero || seen.has(uid) || requestedTeam.includes(uid) || Number(hero.level) >= accountLevel) return null;
      seen.add(uid);
      return uid;
    }),
  };
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
  const requestedChestIds = new Set(recordArray(requested.chests).map((chest) => String(chest.id ?? "")));
  requested.chests = recordArray(current.chests).filter((chest) => requestedChestIds.has(String(chest.id ?? "")));
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
