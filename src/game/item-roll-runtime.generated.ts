/**
 * Item-roll v5 runtime contract — GENERATED FILE. Do not edit by hand.
 * Regenerate: node scripts/generate-item-roll-runtime.mjs
 * Runtime stamp: item-roll-v5@sha256:c885bb3ce3920dc9e47bfd9e315ef7b7eb47b6bc44196e0f8047a09e5ec4e363
 * Sources:
 *   config/balance/hero-power-model.v1.json sha256:4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc
 *   config/balance/balance-v4.v1.json sha256:f2e59620f1501eacb5813107d0f1152c873888cc3bf826f77974b064792ba07d
 *   config/economy/enchant-v4.v1.json sha256:4c18f4186df22256327f9377c373335cf63a83517fc38a3d20e393ff9abfc359
 *
 * Option-A base rolls (founder-approved normalized equipment), six approved
 * Gold/XP slots (helmet, chest, gloves, boots, ring, amulet) and the existing
 * Balance-v4 Enchant curve through +20 (max 4.50x). Data + pure helpers for a
 * future client routing step; no active callsite references this module yet and
 * the server remains authoritative for every item roll.
 */
export const ITEM_ROLL_V5_RUNTIME_STAMP =
  'item-roll-v5@sha256:c885bb3ce3920dc9e47bfd9e315ef7b7eb47b6bc44196e0f8047a09e5ec4e363' as const;

export const ITEM_ROLL_V5_CONTRACT_JSON = `
{
  "version": "item-roll-v5",
  "sources": {
    "heroPowerModel": "4ce9d1cacaa3b100e8fcf361ab7328b2bec96bba8807cc7cc6f98695b629efdc",
    "balanceV4": "f2e59620f1501eacb5813107d0f1152c873888cc3bf826f77974b064792ba07d",
    "enchantV4": "4c18f4186df22256327f9377c373335cf63a83517fc38a3d20e393ff9abfc359"
  },
  "modelVersion": "hero-power-proposal-2026.08.12-v3",
  "rarities": [
    {
      "id": "common",
      "multiplier": 1,
      "lines": 1,
      "setBonusPercent": 5
    },
    {
      "id": "uncommon",
      "multiplier": 1.15,
      "lines": 1,
      "setBonusPercent": 10
    },
    {
      "id": "rare",
      "multiplier": 1.35,
      "lines": 2,
      "setBonusPercent": 15
    },
    {
      "id": "epic",
      "multiplier": 1.6,
      "lines": 2,
      "setBonusPercent": 20
    },
    {
      "id": "legendary",
      "multiplier": 1.9,
      "lines": 3,
      "setBonusPercent": 30
    },
    {
      "id": "mythic",
      "multiplier": 2.25,
      "lines": 3,
      "setBonusPercent": 40
    },
    {
      "id": "cosmic",
      "multiplier": 2.65,
      "lines": 4,
      "setBonusPercent": 50
    },
    {
      "id": "divine",
      "multiplier": 3.1,
      "lines": 4,
      "setBonusPercent": 60
    },
    {
      "id": "celestial",
      "multiplier": 3.6,
      "lines": 5,
      "setBonusPercent": 70
    },
    {
      "id": "cursed",
      "multiplier": 4.1,
      "lines": 5,
      "setBonusPercent": 80
    },
    {
      "id": "immortal",
      "multiplier": 4.7,
      "lines": 6,
      "setBonusPercent": 90
    },
    {
      "id": "god",
      "multiplier": 5.4,
      "lines": 6,
      "setBonusPercent": 100
    }
  ],
  "statRolls": {
    "hp": {
      "curve": "main",
      "min": 3.658817373,
      "max": 4.573521716
    },
    "atk": {
      "curve": "main",
      "min": 0.914704343,
      "max": 1.143380429
    },
    "def": {
      "curve": "main",
      "min": 0.335391593,
      "max": 0.419239491
    },
    "dodge": {
      "curve": "slow",
      "min": 0.001553236,
      "max": 0.001941545
    },
    "critChance": {
      "curve": "slow",
      "min": 0.003106472,
      "max": 0.00388309
    },
    "critDamage": {
      "curve": "slow",
      "min": 0.004400835,
      "max": 0.005501044
    },
    "atkSpeed": {
      "curve": "slow",
      "min": 0.003235908,
      "max": 0.004044885
    },
    "goldBonus": {
      "curve": "economy",
      "min": 0.005177453,
      "max": 0.006471816
    },
    "xpBonus": {
      "curve": "economy",
      "min": 0.005177453,
      "max": 0.006471816
    }
  },
  "slotPools": {
    "class_weapon": [
      "atk",
      "atkSpeed",
      "critChance",
      "critDamage",
      "hp"
    ],
    "helmet": [
      "hp",
      "def",
      "dodge",
      "critChance",
      "critDamage",
      "goldBonus",
      "xpBonus"
    ],
    "chest": [
      "hp",
      "def",
      "dodge",
      "atk",
      "critDamage",
      "goldBonus",
      "xpBonus"
    ],
    "gloves": [
      "atk",
      "atkSpeed",
      "critChance",
      "critDamage",
      "def",
      "goldBonus",
      "xpBonus"
    ],
    "boots": [
      "hp",
      "def",
      "dodge",
      "atkSpeed",
      "critChance",
      "goldBonus",
      "xpBonus"
    ],
    "ring": [
      "atk",
      "critChance",
      "critDamage",
      "dodge",
      "goldBonus",
      "xpBonus",
      "hp"
    ],
    "amulet": [
      "hp",
      "def",
      "critDamage",
      "dodge",
      "goldBonus",
      "xpBonus",
      "critChance"
    ]
  },
  "classOffhandPools": {
    "warrior": [
      "hp",
      "def",
      "dodge",
      "atk",
      "critChance"
    ],
    "mage": [
      "atk",
      "atkSpeed",
      "critChance",
      "critDamage",
      "hp"
    ],
    "assassin": [
      "atk",
      "atkSpeed",
      "critChance",
      "critDamage",
      "dodge"
    ],
    "druid": [
      "hp",
      "def",
      "atk",
      "critChance",
      "critDamage"
    ],
    "crossbowman": [
      "atk",
      "atkSpeed",
      "critChance",
      "critDamage",
      "hp"
    ]
  },
  "slotPoolAdditions": {
    "helmet": [
      "goldBonus",
      "xpBonus"
    ],
    "chest": [
      "goldBonus",
      "xpBonus"
    ],
    "gloves": [
      "goldBonus",
      "xpBonus"
    ],
    "boots": [
      "goldBonus",
      "xpBonus"
    ]
  },
  "economyStatEligibleSlots": [
    "helmet",
    "chest",
    "gloves",
    "boots",
    "ring",
    "amulet"
  ],
  "distinctStatsPerItem": true,
  "levelScaling": {
    "maxItemLevel": 99,
    "bandSize": 15,
    "bandBonus": 0.2,
    "perLevel": {
      "main": 0.015,
      "slow": 0.005,
      "economy": 0.005
    }
  },
  "enchant": {
    "maximumLevel": 20,
    "compounding": false,
    "maximumStatMultiplier": 4.5,
    "cumulativeBonusAtTargets": {
      "5": 0.5,
      "10": 1.25,
      "15": 2.25,
      "20": 3.5
    },
    "tiers": [
      {
        "from": 1,
        "to": 5,
        "bonusPerLevel": 0.1
      },
      {
        "from": 6,
        "to": 10,
        "bonusPerLevel": 0.15
      },
      {
        "from": 11,
        "to": 15,
        "bonusPerLevel": 0.2
      },
      {
        "from": 16,
        "to": 20,
        "bonusPerLevel": 0.25
      }
    ]
  },
  "runtimeStamp": "item-roll-v5@sha256:c885bb3ce3920dc9e47bfd9e315ef7b7eb47b6bc44196e0f8047a09e5ec4e363",
  "contractSha": "c885bb3ce3920dc9e47bfd9e315ef7b7eb47b6bc44196e0f8047a09e5ec4e363"
}
` as const;

export type ItemRollV5StatKey =
  'hp' | 'atk' | 'def' | 'atkSpeed' | 'critChance' | 'critDamage' | 'dodge' | 'goldBonus' | 'xpBonus';

export type ItemRollV5Curve = 'main' | 'slow' | 'economy';

export interface ItemRollV5Rarity {
  readonly id: string;
  readonly multiplier: number;
  readonly lines: number;
  readonly setBonusPercent: number;
}

export interface ItemRollV5StatRollRange {
  readonly curve: ItemRollV5Curve;
  readonly min: number;
  readonly max: number;
}

export interface ItemRollV5EnchantTier {
  readonly from: number;
  readonly to: number;
  readonly bonusPerLevel: number;
}

export interface ItemRollV5StatRoll {
  readonly key: ItemRollV5StatKey;
  readonly value: number;
  readonly isPercent: boolean;
}

export interface ItemRollV5Contract {
  readonly version: string;
  readonly runtimeStamp: string;
  readonly sources: { readonly heroPowerModel: string; readonly balanceV4: string; readonly enchantV4: string };
  readonly modelVersion: string;
  readonly rarities: readonly ItemRollV5Rarity[];
  readonly statRolls: Readonly<Record<string, ItemRollV5StatRollRange>>;
  readonly slotPools: Readonly<Record<string, readonly string[]>>;
  readonly classOffhandPools: Readonly<Record<string, readonly string[]>>;
  readonly slotPoolAdditions: Readonly<Record<string, readonly string[]>>;
  readonly economyStatEligibleSlots: readonly string[];
  readonly distinctStatsPerItem: boolean;
  readonly levelScaling: {
    readonly maxItemLevel: number;
    readonly bandSize: number;
    readonly bandBonus: number;
    readonly perLevel: Readonly<Record<ItemRollV5Curve, number>>;
  };
  readonly enchant: {
    readonly maximumLevel: number;
    readonly compounding: boolean;
    readonly maximumStatMultiplier: number;
    readonly cumulativeBonusAtTargets: Readonly<Record<string, number>>;
    readonly tiers: readonly ItemRollV5EnchantTier[];
  };
  readonly contractSha: string;
}

export const ITEM_ROLL_V5_CONTRACT: ItemRollV5Contract =
  JSON.parse(ITEM_ROLL_V5_CONTRACT_JSON) as ItemRollV5Contract;

/** Multiplier applied to a stored base roll at a given Enchant level (+1..+20). */
export function itemRollV5EnchantMultiplier(enchantLevel: number): number {
  const level = Math.max(0, Math.min(ITEM_ROLL_V5_CONTRACT.enchant.maximumLevel, Math.floor(enchantLevel)));
  let bonus = 0;
  for (const tier of ITEM_ROLL_V5_CONTRACT.enchant.tiers) {
    if (level >= tier.from) bonus += (Math.min(level, tier.to) - tier.from + 1) * tier.bonusPerLevel;
  }
  return 1 + bonus;
}

/** Monotonic Item Level band multiplier for one stat curve (Option-A 15-level bands). */
export function itemRollV5ItemLevelMultiplier(itemLevel: number, curve: ItemRollV5Curve): number {
  if (!Number.isInteger(itemLevel) || itemLevel < 1 || itemLevel > ITEM_ROLL_V5_CONTRACT.levelScaling.maxItemLevel) {
    throw new Error('invalid_item_roll_v5');
  }
  const curveRate = ITEM_ROLL_V5_CONTRACT.levelScaling.perLevel[curve];
  if (!Number.isFinite(curveRate)) throw new Error('invalid_item_roll_v5');
  return 1
    + curveRate * (itemLevel - 1)
    + Math.floor((itemLevel - 1) / ITEM_ROLL_V5_CONTRACT.levelScaling.bandSize) * ITEM_ROLL_V5_CONTRACT.levelScaling.bandBonus;
}

/** Rarity factor: main stats scale linearly, cap-sensitive/economy use sqrt. */
export function itemRollV5RarityFactor(rarityId: string, curve: ItemRollV5Curve): number {
  const rarity = ITEM_ROLL_V5_CONTRACT.rarities.find((entry) => entry.id === rarityId);
  if (!rarity) throw new Error('invalid_item_roll_v5');
  return curve === 'main' ? rarity.multiplier : Math.sqrt(rarity.multiplier);
}

/** Deterministic base roll value for one stat line (server model, base +0). */
export function itemRollV5StatValue(
  statKey: ItemRollV5StatKey,
  rarityId: string,
  itemLevel: number,
  random01: number,
): number {
  const roll = ITEM_ROLL_V5_CONTRACT.statRolls[statKey];
  if (!roll || !Number.isFinite(random01) || random01 < 0 || random01 >= 1) throw new Error('invalid_item_roll_v5');
  const value = (roll.min + random01 * (roll.max - roll.min))
    * itemRollV5RarityFactor(rarityId, roll.curve)
    * itemRollV5ItemLevelMultiplier(itemLevel, roll.curve);
  return Math.round(value * 1000000) / 1000000;
}

/**
 * Roll one item with distinct stat lines (lines = min(rarity.lines, pool size)).
 * random01(index) must return a deterministic value in [0,1) per line index.
 * Display/testing helper mirroring roll_item_stats_v5; server stays authoritative.
 */
export function itemRollV5RollItem(
  slot: string,
  rarityId: string,
  itemLevel: number,
  baseItemId: string,
  random01: (index: number) => number,
): ItemRollV5StatRoll[] {
  const rarity = ITEM_ROLL_V5_CONTRACT.rarities.find((entry) => entry.id === rarityId);
  if (!rarity || !Number.isInteger(itemLevel) || itemLevel < 1 || itemLevel > ITEM_ROLL_V5_CONTRACT.levelScaling.maxItemLevel || !baseItemId) throw new Error('invalid_item_roll_v5');
  const classFromId = baseItemId.split('-')[1];
  const pool = slot === 'offhand'
    ? (classFromId ? ITEM_ROLL_V5_CONTRACT.classOffhandPools[classFromId] : undefined)
    : ITEM_ROLL_V5_CONTRACT.slotPools[slot];
  if (!pool || pool.length === 0) throw new Error('invalid_item_roll_v5');
  const lines = Math.min(rarity.lines, pool.length);
  const remaining: string[] = [...pool];
  const stats: ItemRollV5StatRoll[] = [];
  for (let index = 0; index < lines; index += 1) {
    const pick = random01(index);
    if (!Number.isFinite(pick) || pick < 0 || pick >= 1) throw new Error('invalid_item_roll_v5');
    const pickIndex = Math.floor(pick * remaining.length);
    const statKey = remaining[pickIndex] as ItemRollV5StatKey;
    remaining.splice(pickIndex, 1);
    const value = itemRollV5StatValue(statKey, rarity.id, itemLevel, random01(index + 1000));
    stats.push({ key: statKey, value, isPercent: statKey !== 'hp' && statKey !== 'atk' && statKey !== 'def' });
  }
  return stats;
}

/** Mirror of calculate_item_power_v5 using the approved power weights. */
export function itemRollV5Power(stats: readonly ItemRollV5StatRoll[], enchantLevel: number): number {
  const weights: Record<string, number> = {
    atk: 4, critChance: 200, critDamage: 100, atkSpeed: 0.5,
    hp: 0.15, def: 2, goldBonus: 150, xpBonus: 100, dodge: 150,
  };
  const base = stats.reduce((sum, stat) => sum + stat.value * (weights[stat.key] ?? 1), 0);
  return Math.round(base * itemRollV5EnchantMultiplier(enchantLevel));
}
