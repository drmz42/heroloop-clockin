// Balance v6 runtime formulas shared by the client, server combat and server Power summary.
// Source of every number: config/balance/balance-v6-proposal.v1.json (docs/game/balance-v6-proposal.md),
// verified by `npx tsx scripts/model-balance-v6.ts --check` against normal-combat.mjs.

export const BALANCE_V6_ID = 'balance-v6-2026.09.29-v1';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export const V6_STAR_PER_STAR = 0.06;
export const V6_MASTERY_PER_LEVEL = 0.014;
export const V6_ENCHANT_PER_LEVEL = 0.11;
export const V6_ITEM_LEVEL_LINEAR = 0.008;

// Every Star multiplies base stats by 1.06; ×3.21 at 20 Stars.
export function v6StarMultiplier(stars) {
  return (1 + V6_STAR_PER_STAR) ** clamp(Math.floor(finite(stars)), 0, 20);
}

// Hero Level mastery applies to base stats only; items carry their own Item Level curve.
export function v6LevelMastery(level) {
  return (1 + V6_MASTERY_PER_LEVEL) ** (clamp(Math.floor(finite(level)), 1, 99) - 1);
}

// Linear Enchant: +11% of the item's stats per level, ×3.2 at +20.
export function v6EnchantMultiplier(level) {
  return 1 + clamp(Math.floor(finite(level)), 0, 20) * V6_ENCHANT_PER_LEVEL;
}

// Legacy non-percent Attack Speed rolls are milliseconds, not fractional bonus points.
// Convert against a one-second reference; modern percent rolls already use fractions.
export function v6AttackSpeedPoints(value, isPercent) {
  return finite(value) / (isPercent === true ? 1 : 1000);
}

// Fixed slot base stat ("implicit") every item carries in addition to its random lines.
const IMPLICIT_BY_SLOT = {
  class_weapon: { atk: 1 }, gloves: { atk: 1 }, ring: { atk: 1 }, amulet: { atk: 1 },
  helmet: { hp: 1 }, boots: { hp: 1 }, offhand: { hp: 1 },
  chest: { hp: .5, def: .5 },
};
const LEGACY_SLOT = { weapon: 'class_weapon', armor: 'chest', ring1: 'ring', ring2: 'ring' };
const IMPLICIT_STAT_BASE = { atk: 1.661, hp: 53.9, def: 9.5 };
// Rarities above Celestial are not generated; they and legacy Relic use the nearest modelled scale.
export const V6_IMPLICIT_RARITY_SCALE = {
  common: 1, uncommon: 1.61, rare: 2.35, epic: 3.54, legendary: 5.15, mythic: 7.68, relic: 7.68,
  cosmic: 11.4, divine: 17.1, celestial: 25.8, cursed: 25.8, immortal: 25.8, god: 25.8,
};

export function v6CanonicalSlot(slot) {
  const key = String(slot ?? '');
  return LEGACY_SLOT[key] ?? key;
}

export function v6ItemLevelMultiplier(itemLevel) {
  const level = clamp(Math.floor(finite(itemLevel)), 1, 99);
  return (1 + V6_ITEM_LEVEL_LINEAR * (level - 1)) * (1 + V6_MASTERY_PER_LEVEL) ** (level - 1);
}

// Unrounded base stats of one item before Enchant, Set Bonus and Resonance.
export function v6ItemImplicit(slot, rarity, itemLevel) {
  const mix = IMPLICIT_BY_SLOT[v6CanonicalSlot(slot)];
  const rarityScale = V6_IMPLICIT_RARITY_SCALE[String(rarity ?? '')];
  const result = { hp: 0, atk: 0, def: 0 };
  if (!mix || !rarityScale) return result;
  const scale = rarityScale * v6ItemLevelMultiplier(itemLevel);
  for (const [key, share] of Object.entries(mix)) result[key] = share * IMPLICIT_STAT_BASE[key] * scale;
  return result;
}

// Location bands (Account Level) and their unlock levels.
export const V6_LOCATION_RANGES = [
  [1, 4], [5, 9], [10, 15], [16, 22], [23, 27], [28, 32], [33, 37], [38, 42], [43, 47], [48, 52],
  [53, 57], [58, 62], [63, 67], [68, 72], [73, 77], [78, 82], [83, 87], [88, 91], [92, 95], [96, 99],
];
export const V6_LOCATION_UNLOCK_LEVELS = V6_LOCATION_RANGES.map(([low]) => low);

// Lane-0 enemy base [HP, Attack, Defense] per Location, calibrated for a 72% reference win rate.
// Location 1 keeps the v5 onboarding enemy so a new player's bare starter hero still wins it;
// Location 2 keeps the v5 Attack (20) so a hero with 0-2 items can clear it.
// Location 3 uses Attack 45 for a smoother four-item Common onboarding build.
export const V6_ENEMY_BASE = [
  [99, 10.24, 2.5], [126, 20, 3.94], [168, 45, 5.24], [240, 95.4, 7.48], [314, 144, 9.78],
  [439, 184, 13.6], [613, 242, 18.8], [869, 294, 26.5], [1130, 426, 34.1], [1600, 524, 47.6],
  [1970, 717, 58.5], [2650, 945, 77.9], [3810, 1140, 111], [4770, 1440, 134], [5870, 1900, 161],
  [7520, 2370, 199], [9530, 2990, 245], [11300, 4200, 291], [15200, 4790, 386], [19900, 5810, 486],
];

export function v6EnemyBase(location) {
  const [hp, atk, def] = V6_ENEMY_BASE[clamp(Math.floor(finite(location)), 1, V6_ENEMY_BASE.length) - 1];
  return { hp, atk, def };
}
