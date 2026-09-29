import type { HeroClass, ItemBase, ItemSlot, OwnedItem, ItemStatRoll, ItemStatKey, Rarity, PotionDef, PotionTier } from './types';
import { RARITY_COLORS, RARITY_INDEX } from './heroes';
import {
  enchantGoldCost, enchantGuaranteedHeroCost, enchantMultiplier,
} from './enchant';
import { itemRollV5Power, itemRollV5RollItem } from './item-roll-runtime.generated';
import { v6ItemImplicit } from '../../managed/functions/player-sync/balance-v6.mjs';

export { HERO_USD_QUOTE, enchantSuccessChance } from './enchant';

export const SLOT_LABEL: Record<ItemSlot, string> = {
  class_weapon: 'Class Weapon', offhand: 'Off-hand', helmet: 'Helmet', chest: 'Chest Armor',
  gloves: 'Gloves', boots: 'Boots', ring: 'Ring', amulet: 'Amulet',
  weapon: 'Class Weapon', armor: 'Chest Armor', ring1: 'Ring', ring2: 'Off-hand',
};

export const SLOT_ICON: Record<ItemSlot, string> = {
  class_weapon: '⚔️', offhand: '🛡️', helmet: '⛑️', chest: '🛡️', gloves: '🧤',
  boots: '👢', ring: '💍', amulet: '📿', weapon: '⚔️', armor: '🛡️', ring1: '💍', ring2: '🛡️',
};

export const STAT_LABEL: Record<ItemStatKey, string> = {
  hp: 'HP', atk: 'Attack', def: 'Defense', atkSpeed: 'Atk Speed',
  critChance: 'Crit Chance', critDamage: 'Crit Dmg',
  goldBonus: 'Gold Bonus', xpBonus: 'XP Bonus', dodge: 'Dodge',
};

// HEAVILY NERFED — items give small bonuses at low rarity, only significant at late game
const RARITY_MULT: Record<Rarity, number> = {
  common: 1, uncommon: 1.15, rare: 1.35, epic: 1.6,
  legendary: 1.9, mythic: 2.25, relic: 2.25, cosmic: 2.65, divine: 3.1, celestial: 3.6,
  cursed: 4.1, immortal: 4.7, god: 5.4,
};

// Max chest rarity per location tier
export const LOCATION_CHEST_RARITY: Record<number, Rarity> = {
  1: 'common', 2: 'uncommon', 3: 'rare', 4: 'rare',
  5: 'epic', 6: 'epic', 7: 'legendary', 8: 'legendary',
  9: 'mythic', 10: 'mythic', 11: 'cosmic', 12: 'cosmic',
  13: 'divine', 14: 'divine', 15: 'celestial',
};

export function maxChestRarityForLocation(locationId: number): Rarity {
  const tier = Math.min(15, Math.ceil(locationId / 1));
  return LOCATION_CHEST_RARITY[tier] ?? 'divine';
}

// ── Items catalog ──────────────────────────────────────────────────────────

const LEGACY_ITEMS: ItemBase[] = [
  // Weapons
  { id: 'w-rusty',     name: 'Rusty Blade',        slot: 'weapon',  rarity: 'common',    icon: '🗡️', flavor: 'A worn blade that still bites.' },
  { id: 'w-shortbow',  name: 'Short Bow',           slot: 'weapon',  rarity: 'common',    icon: '🏹', flavor: 'Carved from young ash wood.' },
  { id: 'w-oakstaff',  name: 'Oak Staff',           slot: 'weapon',  rarity: 'common',    icon: '🪄', flavor: 'Steady and reliable.' },
  { id: 'w-steel',     name: 'Steel Sword',         slot: 'weapon',  rarity: 'uncommon',  icon: '⚔️', flavor: 'Forged in the city smithy.' },
  { id: 'w-elvenbow',  name: 'Elven Longbow',       slot: 'weapon',  rarity: 'uncommon',  icon: '🏹', flavor: 'Graceful and silent.' },
  { id: 'w-arcane',    name: 'Arcane Wand',         slot: 'weapon',  rarity: 'uncommon',  icon: '🪄', flavor: 'Vibrates with raw energy.' },
  { id: 'w-shadow',    name: 'Shadowsteel Dagger',  slot: 'weapon',  rarity: 'rare',      icon: '🗡️', flavor: 'Drinks light.' },
  { id: 'w-blazing',   name: 'Blazing War Axe',     slot: 'weapon',  rarity: 'rare',      icon: '⚔️', flavor: 'Wreathed in dragonfire.' },
  { id: 'w-starcall',  name: 'Starcall Bow',        slot: 'weapon',  rarity: 'epic',      icon: '🏹', flavor: 'Arrows ignite mid-flight.' },
  { id: 'w-voidstaff', name: 'Void Staff',          slot: 'weapon',  rarity: 'epic',      icon: '🪄', flavor: 'Opens rifts between realms.' },
  { id: 'w-soulblade', name: 'Soulblade',           slot: 'weapon',  rarity: 'legendary', icon: '⚔️', flavor: 'Each kill feeds its hunger.' },
  { id: 'w-worldbreak',name: 'Worldbreaker',        slot: 'weapon',  rarity: 'mythic',    icon: '⚔️', flavor: 'Cracked the sky.' },
  { id: 'w-relicblade',name: 'Relic Edge',          slot: 'weapon',  rarity: 'relic',     icon: '⚔️', flavor: 'From a fallen civilization.' },
  { id: 'w-cursed',    name: 'Bloodcurse Sword',    slot: 'weapon',  rarity: 'cursed',    icon: '🗡️', flavor: 'Whispers of its victims.' },
  { id: 'w-cosmic',    name: 'Starforged Blade',    slot: 'weapon',  rarity: 'cosmic',    icon: '⚔️', flavor: 'Tempered in a dying star.' },
  { id: 'w-divine',    name: 'Godrender',           slot: 'weapon',  rarity: 'divine',    icon: '⚔️', flavor: 'Forged by gods to end wars.' },
  // Helmets
  { id: 'h-leather',   name: 'Leather Cap',         slot: 'helmet',  rarity: 'common',    icon: '⛑️', flavor: 'Barely more than hide.' },
  { id: 'h-iron',      name: 'Iron Helm',           slot: 'helmet',  rarity: 'uncommon',  icon: '⛑️', flavor: 'Protects the head.' },
  { id: 'h-magehood',  name: "Mage's Hood",         slot: 'helmet',  rarity: 'uncommon',  icon: '🎩', flavor: 'Woven with focus runes.' },
  { id: 'h-shadowcowl',name: 'Shadowcowl',          slot: 'helmet',  rarity: 'rare',      icon: '🎭', flavor: 'One with the dark.' },
  { id: 'h-dragonscale',name:'Dragonscale Crown',   slot: 'helmet',  rarity: 'epic',      icon: '👑', flavor: 'Scales of an ancient dragon.' },
  { id: 'h-voidtiara', name: 'Void Tiara',          slot: 'helmet',  rarity: 'legendary', icon: '👑', flavor: 'Whispers void secrets.' },
  { id: 'h-relichelm', name: 'Relic Visage',        slot: 'helmet',  rarity: 'relic',     icon: '⛑️', flavor: 'A helm from the old age.' },
  { id: 'h-divinecrown',name:'Crown of Divinity',   slot: 'helmet',  rarity: 'divine',    icon: '👑', flavor: 'Worn only by gods.' },
  // Armor
  { id: 'a-cloth',     name: 'Cloth Robe',          slot: 'armor',   rarity: 'common',    icon: '👘', flavor: 'Thin but comfortable.' },
  { id: 'a-chain',     name: 'Chain Mail',          slot: 'armor',   rarity: 'uncommon',  icon: '🛡️', flavor: 'Every ring counts.' },
  { id: 'a-ember',     name: 'Ember Plate',         slot: 'armor',   rarity: 'rare',      icon: '🛡️', flavor: 'Lava-tempered steel.' },
  { id: 'a-voidshroud',name: 'Void Shroud',         slot: 'armor',   rarity: 'epic',      icon: '🌑', flavor: 'Absorbs magic attacks.' },
  { id: 'a-celestial', name: 'Celestial Mantle',    slot: 'armor',   rarity: 'legendary', icon: '✨', flavor: 'Woven from starlight.' },
  { id: 'a-relicplate',name: 'Relic Aegis',         slot: 'armor',   rarity: 'relic',     icon: '🛡️', flavor: 'Unbreakable ancient plate.' },
  { id: 'a-divine',    name: 'Aegis of Heaven',     slot: 'armor',   rarity: 'divine',    icon: '✨', flavor: 'The armor of the divine.' },
  // Gloves
  { id: 'g-thin',      name: 'Thin Gloves',         slot: 'gloves',  rarity: 'common',    icon: '🧤', flavor: 'Better than bare hands.' },
  { id: 'g-iron',      name: 'Iron Grips',          slot: 'gloves',  rarity: 'uncommon',  icon: '🧤', flavor: 'Strengthen every swing.' },
  { id: 'g-shadowclaws',name:'Shadow Claws',        slot: 'gloves',  rarity: 'rare',      icon: '🦾', flavor: 'Blades on every finger.' },
  { id: 'g-storm',     name: 'Storm Fists',         slot: 'gloves',  rarity: 'epic',      icon: '⚡', flavor: 'Channel lightning.' },
  { id: 'g-divine',    name: 'Hands of God',        slot: 'gloves',  rarity: 'divine',    icon: '✨', flavor: 'Blessed by the divine.' },
  // Boots
  { id: 'b-worn',      name: 'Worn Boots',          slot: 'boots',   rarity: 'common',    icon: '👢', flavor: 'Many miles of comfort.' },
  { id: 'b-wind',      name: 'Wind Walkers',        slot: 'boots',   rarity: 'uncommon',  icon: '👟', flavor: 'Like running on air.' },
  { id: 'b-shadowstep',name: 'Shadowstep Boots',    slot: 'boots',   rarity: 'rare',      icon: '👢', flavor: 'Leave no trace.' },
  { id: 'b-void',      name: 'Void Striders',       slot: 'boots',   rarity: 'epic',      icon: '🌀', flavor: 'Step through reality.' },
  { id: 'b-divine',    name: 'Sandals of Dawn',     slot: 'boots',   rarity: 'divine',    icon: '✨', flavor: 'Walk on sunlight.' },
  // Rings
  { id: 'r-copper',    name: 'Copper Band',         slot: 'ring1',   rarity: 'common',    icon: '💍', flavor: 'Simple luck.' },
  { id: 'r-gold',      name: 'Gold Ring',           slot: 'ring1',   rarity: 'uncommon',  icon: '💍', flavor: 'Increases fortune.' },
  { id: 'r-emerald',   name: 'Emerald Ring',        slot: 'ring2',   rarity: 'uncommon',  icon: '💍', flavor: 'Channels nature.' },
  { id: 'r-voidseal',  name: 'Void Seal',           slot: 'ring1',   rarity: 'rare',      icon: '🌀', flavor: 'Abyssal power.' },
  { id: 'r-signet',    name: "King's Signet",       slot: 'ring2',   rarity: 'epic',      icon: '👑', flavor: "A long-dead king's ring." },
  { id: 'r-cosmos',    name: 'Cosmos Ring',         slot: 'ring1',   rarity: 'cosmic',    icon: '🌌', flavor: 'Contains a micro-universe.' },
  { id: 'r-divine',    name: 'Ring of Eternity',    slot: 'ring1',   rarity: 'divine',    icon: '💍', flavor: 'Eternal blessings.' },
  // Amulets
  { id: 'am-tooth',    name: 'Monster Tooth',       slot: 'amulet',  rarity: 'common',    icon: '🦷', flavor: 'From a beast you slew.' },
  { id: 'am-jade',     name: 'Jade Pendant',        slot: 'amulet',  rarity: 'uncommon',  icon: '📿', flavor: 'Ancient wisdom.' },
  { id: 'am-eye',      name: 'Arcane Eye',          slot: 'amulet',  rarity: 'rare',      icon: '👁️', flavor: 'Sees through illusions.' },
  { id: 'am-soulstone',name: 'Soulstone',           slot: 'amulet',  rarity: 'epic',      icon: '💎', flavor: 'Resonates with your soul.' },
  { id: 'am-worldheart',name:'World Heart',         slot: 'amulet',  rarity: 'legendary', icon: '❤️‍🔥', flavor: 'Pulse of a dying world.' },
  { id: 'am-divine',   name: 'Heart of God',        slot: 'amulet',  rarity: 'divine',    icon: '❤️‍🔥', flavor: 'A piece of divinity.' },
];

const CHEST_ROLL_RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
export const ALL_PRODUCT_RARITIES: Rarity[] = [...CHEST_ROLL_RARITIES, 'cursed', 'immortal', 'god'];
export const MARKET_MIN_EQUIPMENT_RARITY: Rarity = 'legendary';

export function isMarketEligibleEquipment(item: Pick<ItemBase, 'rarity'>): boolean {
  return RARITY_INDEX[item.rarity] >= RARITY_INDEX[MARKET_MIN_EQUIPMENT_RARITY];
}

const RARITY_NAMES = ['Worn', 'Verdant', 'Sapphire', 'Amethyst', 'Legendary', 'Mythic', 'Cosmic', 'Divine', 'Celestial', 'Cursed', 'Immortal', 'God'];
const WEAPON_TYPES: { key: string; label: string; heroClass: HeroClass; icon: string }[] = [
  { key: 'mage', label: 'Arcane Staff', heroClass: 'shepherd', icon: '🪄' },
  { key: 'assassin', label: 'Single Dagger', heroClass: 'assassin', icon: '🗡️' },
  { key: 'warrior', label: 'One-handed Sword', heroClass: 'knight', icon: '⚔️' },
  { key: 'druid', label: 'Nature Staff', heroClass: 'druid', icon: '🌿' },
  { key: 'crossbowman', label: 'Crossbow', heroClass: 'archer', icon: '🏹' },
];
const OFFHAND_TYPES: { key: string; label: string; heroClass: HeroClass; icon: string }[] = [
  { key: 'mage', label: 'Spellbook', heroClass: 'shepherd', icon: '📘' },
  { key: 'assassin', label: 'Throwing Weapon Set', heroClass: 'assassin', icon: '✦' },
  { key: 'warrior', label: 'Shield', heroClass: 'knight', icon: '🛡️' },
  { key: 'druid', label: 'Nature Totem', heroClass: 'druid', icon: '🗿' },
  { key: 'crossbowman', label: 'Quiver', heroClass: 'archer', icon: '➶' },
];
const SHARED_TYPES: { key: string; label: string; slot: ItemSlot; icon: string }[] = [
  { key: 'helmet', label: 'Helmet', slot: 'helmet', icon: '⛑️' },
  { key: 'armor', label: 'Chest Armor', slot: 'chest', icon: '🛡️' },
  { key: 'gloves', label: 'Gloves', slot: 'gloves', icon: '🧤' },
  { key: 'boots', label: 'Boots', slot: 'boots', icon: '👢' },
  { key: 'amulet', label: 'Amulet', slot: 'amulet', icon: '📿' },
  { key: 'ring', label: 'Ring', slot: 'ring', icon: '💍' },
];

export const ITEMS: ItemBase[] = [
  ...WEAPON_TYPES.flatMap((weapon) => ALL_PRODUCT_RARITIES.map((rarity, tier) => ({
    id: `weapon-${weapon.key}-${rarity}`,
    name: `${RARITY_NAMES[tier]} ${weapon.label}`,
    slot: 'class_weapon' as const,
    rarity,
    icon: weapon.icon,
    flavor: `Tier ${tier + 1} ${weapon.label.toLowerCase()}, forged for its class.`,
    heroClass: weapon.heroClass,
  }))),
  ...OFFHAND_TYPES.flatMap((offhand) => ALL_PRODUCT_RARITIES.map((rarity, tier) => ({
    id: `offhand-${offhand.key}-${rarity}`,
    name: `${RARITY_NAMES[tier]} ${offhand.label}`,
    slot: 'offhand' as const,
    rarity,
    icon: offhand.icon,
    flavor: `Tier ${tier + 1} ${offhand.label.toLowerCase()}, fixed to its class identity.`,
    heroClass: offhand.heroClass,
  }))),
  ...SHARED_TYPES.flatMap((gear) => ALL_PRODUCT_RARITIES.map((rarity, tier) => ({
    id: `${gear.key}-${rarity}`,
    name: `${RARITY_NAMES[tier]} ${gear.label}`,
    slot: gear.slot,
    rarity,
    icon: gear.icon,
    flavor: `Tier ${tier + 1} equipment usable by every class.`,
  }))),
];

void LEGACY_ITEMS;

export const ITEM_MAP: Record<string, ItemBase> = Object.fromEntries([...LEGACY_ITEMS, ...ITEMS].map((i) => [i.id, i]));

export function canClassEquipItem(heroClass: HeroClass, item: ItemBase): boolean {
  if (item.slot !== 'class_weapon' && item.slot !== 'offhand' && item.slot !== 'weapon') return true;
  if (item.heroClass) return item.heroClass === heroClass;
  if (/bow/i.test(item.id + item.name)) return heroClass === 'archer';
  if (/staff|wand/i.test(item.id + item.name)) return heroClass === 'druid' || heroClass === 'shepherd';
  if (/dagger|shadow|bloodcurse/i.test(item.id + item.name)) return heroClass === 'assassin';
  return heroClass === 'knight';
}

export function meetsItemLevelRequirement(item: OwnedItem, accountLevel: number): boolean {
  return item.level <= accountLevel;
}

// ── Potions ────────────────────────────────────────────────────────────────

export const POTIONS: PotionDef[] = [
  { tier: 'xs',  name: 'Minor Tonic',     hpRestore: 50,    cost: 15   },
  { tier: 'sm',  name: 'Healing Draught', hpRestore: 200,   cost: 50   },
  { tier: 'md',  name: 'Greater Potion',  hpRestore: 1000,  cost: 150  },
  { tier: 'lg',  name: 'Superior Elixir', hpRestore: 4000,  cost: 450  },
  { tier: 'xl',  name: 'Mythic Flask',    hpRestore: 15000, cost: 1200 },
  { tier: 'xxl', name: 'Divine Nectar',   hpRestore: 40000, cost: 3000 },
];

export const POTION_MAP: Record<PotionTier, PotionDef> = Object.fromEntries(
  POTIONS.map((p) => [p.tier, p])
) as Record<PotionTier, PotionDef>;

// ── Enchanting ────────────────────────────────────────────────────────────

export function enchantCost(item: OwnedItem): { gold: number; hero: number } {
  const rarity = ITEM_MAP[item.itemId]?.rarity ?? 'common';
  return { gold: enchantGoldCost(rarity, item.enchantLevel), hero: 0 };
}

export function enchantCharmCost(currentEnchant: number): number {
  return enchantGuaranteedHeroCost(currentEnchant);
}

// Stats on item boosted by enchant level
export function enchantedStats(stats: ItemStatRoll[], enchantLevel: number): ItemStatRoll[] {
  if (enchantLevel === 0) return stats;
  const mult = enchantMultiplier(enchantLevel);
  return stats.map(s => ({
    ...s,
    value: s.isPercent
      ? Math.round(s.value * mult * 1000) / 1000
      : Math.round(s.value * mult),
  }));
}

// Reroll catalogue converted at the Staging quote, capped at 5x.
export function rerollCost(rarity: Rarity, rerollCount: number): number {
  const base: Record<Rarity, number> = {
    common: 5, uncommon: 10, rare: 20, epic: 40, legendary: 80,
    mythic: 150, relic: 150, cosmic: 300, divine: 600, celestial: 1_000,
    cursed: 1_500, immortal: 2_500, god: 4_000,
  };
  const cost = base[rarity] ?? 1;
  return cost * Math.min(5, Math.max(1, Math.floor(rerollCount) + 1));
}

// ── Stat rolling ──────────────────────────────────────────────────────────

function rollStats(slot: ItemSlot, rarity: Rarity, level: number, itemId: string): ItemStatRoll[] {
  const canonicalSlot = slot === 'weapon' ? 'class_weapon'
    : slot === 'armor' ? 'chest'
      : slot === 'ring1' || slot === 'ring2' ? 'ring' : slot;
  return itemRollV5RollItem(canonicalSlot, rarity, level, itemId, () => Math.random()) as ItemStatRoll[];
}

const STORED_POWER_WEIGHTS: Record<ItemStatKey, number> = {
  atk: 4, critChance: 200, critDamage: 100, atkSpeed: 0.5,
  hp: 0.15, def: 2, goldBonus: 150, xpBonus: 100, dodge: 150,
};
const GEAR_POWER_WEIGHTS: Record<ItemStatKey, number> = {
  ...STORED_POWER_WEIGHTS, atkSpeed: 300, goldBonus: 0, xpBonus: 0,
};

function weightedItemPower(stats: ItemStatRoll[], enchantLevel: number, version: 2 | 3 | 4, weights: Record<ItemStatKey, number>): number {
  return Math.round(stats.reduce((acc, s) => {
    const multiplier = version === 4 ? enchantMultiplier(enchantLevel) : 1 + enchantLevel * (
      version === 2 ? .1 : s.key === 'hp' || s.key === 'atk' || s.key === 'def' ? .1
        : s.key === 'goldBonus' || s.key === 'xpBonus' ? .025 : .05
    );
    return acc + s.value * (weights[s.key] ?? (s.isPercent ? 100 : 1)) * multiplier;
  }, 0));
}

// Historical stored Power remains stable for save normalization and server-ledger compatibility.
export function itemPower(stats: ItemStatRoll[], enchantLevel = 0, version: 2 | 3 | 4 = 4): number {
  return weightedItemPower(stats, enchantLevel, version, STORED_POWER_WEIGHTS);
}

// Balance v6 base stat every item carries from its slot, rarity and Item Level (before Enchant).
export function itemBaseStats(item: Pick<OwnedItem, 'itemId' | 'level'>): ItemStatRoll[] {
  const base = ITEM_MAP[item.itemId];
  if (!base) return [];
  const implicit = v6ItemImplicit(base.slot, base.rarity, item.level);
  return (['hp', 'atk', 'def'] as const).filter((key) => implicit[key] > 0)
    .map((key) => ({ key, value: Math.round(implicit[key]), isPercent: false }));
}

// Player-facing gear score excludes economy lines and values Attack Speed in combat units.
// It includes the Balance v6 base stat so higher-rarity and higher-level items rank higher.
export function displayItemPower(item: OwnedItem): number {
  return weightedItemPower([...itemBaseStats(item), ...item.stats], item.enchantLevel, item.enchantStatsVersion ?? 2, GEAR_POWER_WEIGHTS);
}

let itemUid = 0;
export function rollItem(itemId: string, level: number): OwnedItem {
  const base = ITEM_MAP[itemId];
  if (!base) throw new Error(`Unknown item base: ${itemId}`);
  if (base.rarity === 'cursed' || base.rarity === 'immortal' || base.rarity === 'god') {
    throw new Error(`Craft-only rarity cannot be rolled: ${base.rarity}`);
  }
  const stats = rollStats(base.slot, base.rarity, level, itemId);
  return {
    uid: globalThis.crypto?.randomUUID?.() ?? `it-${Date.now().toString(36)}-${itemUid++}-${Math.random().toString(36).slice(2)}`,
    itemId, level, stats, power: itemRollV5Power(stats, 0),
    enchantLevel: 0, enchantStatsVersion: 4, itemRollVersion: 5, rerollCount: 0,
  };
}

export function rerollItemStats(item: OwnedItem): OwnedItem {
  const base = ITEM_MAP[item.itemId];
  const newStats = rollStats(base.slot, base.rarity, item.level, item.itemId);
  return {
    ...item,
    stats: newStats,
    power: itemRollV5Power(newStats, item.enchantLevel),
    enchantStatsVersion: 4,
    itemRollVersion: 5,
    rerollCount: item.rerollCount + 1,
  };
}

// ── Chest rarity weights ──────────────────────────────────────────────────

// Daily timed-reward cap: max 1000 chests per Moscow day per player.
export const MAX_CHESTS_PER_DAY = 1000;

type LimitedAvailability = Partial<Record<'divine' | 'celestial', boolean>>;

const CHEST_BASE_WEIGHTS: { min: number; max: number; weights: Partial<Record<Rarity, number>> }[] = [
  { min: 1, max: 9, weights: { common: 75, uncommon: 20, rare: 5 } },
  { min: 10, max: 19, weights: { common: 53, uncommon: 29, rare: 14, epic: 4 } },
  { min: 20, max: 29, weights: { common: 39, uncommon: 29, rare: 20, epic: 9, legendary: 3 } },
  { min: 30, max: 39, weights: { common: 29, uncommon: 25, rare: 22, epic: 14, legendary: 7, mythic: 3 } },
  { min: 40, max: 54, weights: { common: 23, uncommon: 21, rare: 22, epic: 17, legendary: 10, mythic: 5, cosmic: 2 } },
  { min: 55, max: 79, weights: { common: 17, uncommon: 19, rare: 20, epic: 18, legendary: 13, mythic: 7, cosmic: 3.5, divine: 2.5 } },
  { min: 80, max: Number.POSITIVE_INFINITY, weights: { common: 12, uncommon: 15, rare: 19, epic: 19, legendary: 15, mythic: 10, cosmic: 5, divine: 3, celestial: 2 } },
];

const CHEST_PRESTIGE_MULTIPLIER: Partial<Record<Rarity, number>> = {
  legendary: 0.60,
  mythic: 0.35,
  cosmic: 0.20,
  divine: 0.10,
  celestial: 0.05,
};

function dampenChestPrestige(weights: Record<Rarity, number>, floor: Rarity): Record<Rarity, number> {
  let transferred = 0;
  for (const [rarity, multiplier] of Object.entries(CHEST_PRESTIGE_MULTIPLIER) as [Rarity, number][]) {
    const original = weights[rarity];
    weights[rarity] = original * multiplier;
    transferred += original - weights[rarity];
  }
  weights[floor] += transferred;
  return weights;
}

function chestBaseWeights(playerLevel: number, availability: LimitedAvailability = {}): Record<Rarity, number> {
  const row = CHEST_BASE_WEIGHTS.find((entry) => playerLevel >= entry.min && playerLevel <= entry.max) ?? CHEST_BASE_WEIGHTS[0];
  const weights = Object.fromEntries(Object.keys(RARITY_INDEX).map((rarity) => [rarity, row.weights[rarity as Rarity] ?? 0])) as Record<Rarity, number>;
  weights.relic = 0;
  weights.cursed = 0;
  weights.immortal = 0;
  weights.god = 0;
  if (!availability.divine) weights.divine = 0;
  if (!availability.celestial) weights.celestial = 0;
  return weights;
}

export function standardChestWeights(playerLevel: number, availability: LimitedAvailability = {}): Record<Rarity, number> {
  const weights = chestBaseWeights(playerLevel, availability);
  const transferable = 10;
  const higherTotal = CHEST_ROLL_RARITIES.slice(1).reduce((sum, rarity) => sum + weights[rarity], 0);
  weights.common = Math.max(0, weights.common - transferable);
  if (higherTotal > 0) {
    for (const rarity of CHEST_ROLL_RARITIES.slice(1)) weights[rarity] += transferable * (weights[rarity] / higherTotal);
  }
  return dampenChestPrestige(weights, 'common');
}

function rollItemLevel(playerLevel: number): number {
  return Math.min(99, Math.max(1, playerLevel + Math.floor(Math.random() * 5) - 2));
}

function rollFromWeights(weights: Record<Rarity, number>, playerLevel: number): OwnedItem | null {
  const chosen = weightedRarity(weights);
  const pool = ITEMS.filter((item) => item.rarity === chosen && CHEST_ROLL_RARITIES.includes(item.rarity));
  if (!pool.length) return null;
  return rollItem(pool[Math.floor(Math.random() * pool.length)].id, rollItemLevel(playerLevel));
}

export function weightedRarity(weights: Record<Rarity, number>): Rarity {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total <= 0) return 'common';
  const roll = Math.random() * total;
  let acc = 0;
  for (const [r, w] of Object.entries(weights)) {
    acc += w;
    if (roll <= acc) return r as Rarity;
  }
  return 'common';
}

// Open a chest — capped by location's max rarity
export function openStandardChest(playerLevel: number, availability: LimitedAvailability = {}): OwnedItem {
  const weights = standardChestWeights(playerLevel, availability);
  return rollFromWeights(weights, playerLevel) ?? rollItem('helmet-common', rollItemLevel(playerLevel));
}

export function openBossChest(playerLevel: number, availability: LimitedAvailability = {}): OwnedItem {
  const weights = chestBaseWeights(playerLevel, availability);
  const floorIndex = playerLevel >= 10 ? RARITY_INDEX.epic : RARITY_INDEX.rare;
  for (const rarity of CHEST_ROLL_RARITIES) if (RARITY_INDEX[rarity] < floorIndex) weights[rarity] = 0;
  return rollFromWeights(dampenChestPrestige(weights, playerLevel >= 10 ? 'epic' : 'rare'), playerLevel) ?? rollItem('helmet-rare', rollItemLevel(playerLevel));
}

// ── Rotating shop ─────────────────────────────────────────────────────────

const ROTATING_TIERS: Rarity[] = ['common', 'uncommon', 'uncommon', 'rare'];

export function generateRotatingShop(): { itemId: string; price: number }[] {
  return ROTATING_TIERS.map((rarity) => {
    const pool = ITEMS.filter((i) => i.rarity === rarity);
    const base = pool[Math.floor(Math.random() * pool.length)];
    const priceBase: Record<Rarity, number> = {
      common: 80, uncommon: 250, rare: 800, epic: 2500, legendary: 8000,
      mythic: 25000, relic: 80000, cursed: 250000, cosmic: 700000, divine: 3000000, celestial: 9000000,
      immortal: 18000000, god: 36000000,
    };
    return { itemId: base.id, price: priceBase[rarity] + Math.floor(Math.random() * priceBase[rarity] * 0.4) };
  });
}

export function formatStatValue(stat: ItemStatRoll): string {
  if (stat.isPercent) return `+${(stat.value * 100).toFixed(1)}%`;
  return `+${stat.value}`;
}

export function rarityColor(r: Rarity): string {
  return RARITY_COLORS[r];
}

export function sellValue(item: OwnedItem): number {
  const base = ITEM_MAP[item.itemId];
  if (!base) return 5;
  const mult = RARITY_MULT[base.rarity];
  return Math.max(5, Math.round(mult * 5 * (1 + (item.level - 1) * 0.05) * (1 + item.enchantLevel * 0.2)));
}

void RARITY_INDEX;
