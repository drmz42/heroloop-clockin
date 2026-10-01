import { mergeSaveState, prepareLegacyMigration, prepareRegistration, type JsonRecord } from "./state.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const playerId = "00000000-0000-4000-8000-000000000001";
const now = Date.UTC(2026, 8, 30);
const registration = prepareRegistration({
  username: "saveguard",
  starter_hero_id: "knight-common",
  state: { ownedHeroes: [{}], inventory: [], chests: [], team: [] },
}, playerId, now);
if ("code" in registration) throw new Error(`registration fixture failed: ${registration.code}`);
const registered = registration;

// Forged items omit serverOwned: that flag alone was always refused.
function item(uid: string, itemId: string, level: number, power: number, value: number): JsonRecord {
  return {
    uid, itemId, level, power, enchantLevel: 0, rerollCount: 0,
    stats: [{ key: "atk", value, isPercent: false }],
  };
}

const owned: JsonRecord = { ...item("owned-ledger-item", "helmet-common", 3, 12, 5), serverOwned: true };
const legacy = item("stored-legacy-item", "helmet-common", 2, 8, 3);
const ledgerRow = {
  id: owned.uid, base_item_id: "helmet-common", item_level: 3, power: 12, locked: false,
  enchant_level: 0, reroll_count: 0, enchant_stats_version: 3, stats: owned.stats,
};
const resources = {
  balances: {
    boss_key: "0", summon_scroll: "0", potion_xs: "0", potion_sm: "0", potion_md: "0", potion_lg: "0", potion_xl: "0", potion_xxl: "0",
  },
};

function context(): JsonRecord {
  return {
    account: { username: "saveguard", token_balance: "0", summons: "0" },
    state: { ...structuredClone(registered.state), inventory: [structuredClone(owned), structuredClone(legacy)] },
    revision: 4,
    training_purchases: [],
    items: [ledgerRow],
    resources,
  };
}

function saved(requestedInventory: JsonRecord[]): JsonRecord[] {
  const requested = structuredClone(registered.state) as JsonRecord;
  requested.inventory = requestedInventory;
  const merged = mergeSaveState(context(), requested, playerId, now);
  if ("code" in merged) throw new Error(`save refused: ${merged.code}`);
  return merged.state.inventory as JsonRecord[];
}

Deno.test("a client save cannot mint an item outside the ledger", () => {
  const forged = item("forged-god-item", "helmet-common", 99, 999_999, 1_000_000_000);
  const inventory = saved([structuredClone(owned), structuredClone(legacy), forged]);
  const uids = inventory.map((entry) => entry.uid).sort();
  assert(JSON.stringify(uids) === JSON.stringify([legacy.uid, owned.uid].sort()), `forged item dropped, got ${uids}`);
});

Deno.test("a client save cannot re-roll a stored legacy item", () => {
  const tampered = { ...structuredClone(legacy), level: 99, power: 999_999 };
  const inventory = saved([structuredClone(owned), tampered]);
  const kept = inventory.find((entry) => entry.uid === legacy.uid);
  assert(kept && kept.level === 2 && kept.power === 8, "stored legacy values win");
});

Deno.test("a ledger item keeps ledger values and a forged item cannot be equipped", () => {
  const tampered = { ...structuredClone(owned), level: 99, power: 999_999 };
  const forged = item("forged-weapon", "helmet-common", 99, 999_999, 1_000_000_000);
  const requested = structuredClone(registered.state) as JsonRecord;
  requested.inventory = [tampered, forged];
  requested.ownedHeroes = (requested.ownedHeroes as JsonRecord[]).map((hero) => ({ ...hero, equipped: { helmet: forged.uid } }));
  const merged = mergeSaveState(context(), requested, playerId, now);
  if ("code" in merged) throw new Error(`save refused: ${merged.code}`);
  const inventory = merged.state.inventory as JsonRecord[];
  const ledgerItem = inventory.find((entry) => entry.uid === owned.uid);
  assert(ledgerItem && ledgerItem.level === 3 && ledgerItem.power === 12, "ledger values win");
  assert(!inventory.some((entry) => entry.uid === forged.uid), "forged item dropped");
  const equipped = JSON.stringify((merged.state.ownedHeroes as JsonRecord[]).map((hero) => hero.equipped));
  assert(!equipped.includes(String(forged.uid)), `forged item not equipped, got ${equipped}`);
});


Deno.test("a client legacy import cannot create a save with forged assets or progress", () => {
  const forged = structuredClone(registered.state) as JsonRecord;
  forged.inventory = [item("forged-import-item", "helmet-common", 99, 999_999, 1_000_000_000)];
  forged.accountLevel = 99;
  forged.gold = 999_999;
  const result = prepareLegacyMigration({ account: context().account, state: null, revision: null }, forged, playerId);
  assert("code" in result && result.code === "legacy_import_disabled" && result.status === 409, "client import is refused");
});

Deno.test("legacy migration replay returns only the stored server save", () => {
  const canonical = context();
  const forged = { ...structuredClone(registered.state), gold: 999_999, inventory: [] };
  const result = prepareLegacyMigration(canonical, forged, playerId);
  assert("state" in result && result.state === canonical.state, "existing canonical save wins");
});
