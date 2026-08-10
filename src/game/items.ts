import type { HeroClass, ItemBase, ItemSlot, OwnedItem, ItemStatRoll, ItemStatKey, Rarity, PotionDef, PotionTier } from './types';
import { RARITY_COLORS, RARITY_INDEX } from './heroes';

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

// How many stats per rarity
const RARITY_STAT_COUNT: Record<Rarity, [number, number]> = {
  common: [1, 1], uncommon: [1, 1], rare: [2, 2], epic: [2, 2],
  legendary: [3, 3], mythic: [3, 3], cosmic: [4, 4], divine: [4, 4], celestial: [5, 5],
  cursed: [5, 5], immortal: [6, 6], god: [6, 6], relic: [3, 3],
};

// HEAVILY NERFED — items give small bonuses at low rarity, only significant at late game
const RARITY_MULT: Record<Rarity, number> = {
  common: 0.3, uncommon: 0.7, rare: 1.4, epic: 2.8,
  legendary: 4.6, mythic: 6.5, cosmic: 9, divine: 13, celestial: 18,
  cursed: 0, immortal: 0, god: 0, relic: 6.5,
};

// Base stat ranges at level 1 (NERFED)
const STAT_BASES: Record<ItemStatKey, [number, number]> = {
  hp:         [8,  20],
  atk:        [2,  5],
  def:        [1,  4],
  atkSpeed:   [3,  8],     // ms reduction
  critChance: [0.005, 0.015],
  critDamage: [0.02, 0.06],
  goldBonus:  [0.01, 0.03],
  xpBonus:    [0.01, 0.03],
  dodge:      [0.005, 0.015],
};

const SLOT_STATS: Record<ItemSlot, ItemStatKey[]> = {
  class_weapon: ['atk', 'critChance', 'critDamage', 'atkSpeed', 'hp', 'goldBonus'],
  offhand: ['def', 'hp', 'critChance', 'critDamage', 'dodge', 'xpBonus'],
  chest: ['hp', 'def', 'atk', 'goldBonus', 'dodge', 'critDamage'],
  ring: ['goldBonus', 'xpBonus', 'critChance', 'hp', 'atk', 'dodge'],
  weapon:  ['atk', 'critChance', 'critDamage', 'atkSpeed', 'hp', 'goldBonus'],
  helmet:  ['hp', 'def', 'critChance', 'xpBonus', 'atk', 'dodge'],
  armor:   ['hp', 'def', 'atk', 'goldBonus', 'dodge', 'critDamage'],
  gloves:  ['atk', 'critChance', 'critDamage', 'def', 'atkSpeed', 'hp'],
  boots:   ['atkSpeed', 'dodge', 'def', 'hp', 'goldBonus', 'critChance'],
  ring1:   ['goldBonus', 'xpBonus', 'critChance', 'hp', 'atk', 'dodge'],
  ring2:   ['critDamage', 'atk', 'goldBonus', 'critChance', 'def', 'xpBonus'],
  amulet:  ['xpBonus', 'goldBonus', 'hp', 'critDamage', 'dodge', 'def'],
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

export const RANDOM_DROP_RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
export const ALL_PRODUCT_RARITIES: Rarity[] = [...RANDOM_DROP_RARITIES, 'cursed', 'immortal', 'god'];
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

// Success chance per enchant level (+1 to +10)
export const ENCHANT_CHANCE = [1.0, 1.0, 1.0, 0.85, 0.70, 0.55, 0.40, 0.25, 0.15, 0.10];
// Gold cost per level
export const ENCHANT_GOLD_COST = [50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600];
// $HERO protection charm cost (only for +4 and above, index 0 = +4)
export const ENCHANT_CHARM_COST = [1, 2, 5, 10, 20, 35, 50];   // for +4 through +10

export function enchantSuccessChance(currentEnchant: number): number {
  return ENCHANT_CHANCE[currentEnchant] ?? 0.10;
}

export function enchantGoldCost(currentEnchant: number): number {
  return ENCHANT_GOLD_COST[currentEnchant] ?? 25600;
}

export function enchantCharmCost(currentEnchant: number): number {
  if (currentEnchant < 3) return 0;
  return ENCHANT_CHARM_COST[currentEnchant - 3] ?? 50;
}

// Stats on item boosted by enchant level
export function enchantedStats(stats: ItemStatRoll[], enchantLevel: number): ItemStatRoll[] {
  if (enchantLevel === 0) return stats;
  const mult = 1 + enchantLevel * 0.10;
  return stats.map(s => ({
    ...s,
    value: s.isPercent
      ? Math.round(s.value * mult * 1000) / 1000
      : Math.round(s.value * mult),
  }));
}

// Reroll costs (base $HERO × 1 + rerollCount × 1.5)
export function rerollCost(rarity: Rarity, rerollCount: number): number {
  const base: Record<Rarity, number> = {
    common: 1, uncommon: 2, rare: 4, epic: 8, legendary: 15,
    mythic: 25, relic: 40, cursed: 60, cosmic: 90, divine: 150, celestial: 300,
    immortal: 600, god: 1200,
  };
  const cost = base[rarity] ?? 1;
  return Math.round(cost * (1 + rerollCount * 1.5));
}

// ── Stat rolling ──────────────────────────────────────────────────────────

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function rollStats(slot: ItemSlot, rarity: Rarity, level: number): ItemStatRoll[] {
  const [minC, maxC] = RARITY_STAT_COUNT[rarity];
  const count = minC + Math.floor(Math.random() * (maxC - minC + 1));
  const pool = [...SLOT_STATS[slot]];
  const mult = RARITY_MULT[rarity];
  // Level scaling is slow — level 20 item is ~60% stronger than level 1
  const lvlScale = 1 + (level - 1) * 0.03;
  const chosen: ItemStatKey[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    chosen.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return chosen.map((key) => {
    const [b1, b2] = STAT_BASES[key];
    const raw = rand(b1, b2) * mult * lvlScale;
    const isPct = key === 'critChance' || key === 'critDamage'
      || key === 'goldBonus' || key === 'xpBonus' || key === 'dodge'
      || key === 'atkSpeed';
    // atkSpeed is flat ms value (not percent) but treated as atkSpeed bonus
    const isPctActual = key !== 'atkSpeed' && isPct;
    return {
      key,
      value: isPctActual ? Math.round(raw * 1000) / 1000 : Math.round(raw),
      isPercent: isPctActual,
    };
  });
}

export function itemPower(stats: ItemStatRoll[], enchantLevel = 0): number {
  const mult = 1 + enchantLevel * 0.10;
  return Math.round(stats.reduce((acc, s) => {
    const w: Record<ItemStatKey, number> = {
      atk: 4, critChance: 200, critDamage: 100, atkSpeed: 0.5,
      hp: 0.15, def: 2, goldBonus: 150, xpBonus: 100, dodge: 150,
    };
    return acc + (s.isPercent ? s.value * (w[s.key] ?? 100) : s.value * (w[s.key] ?? 1));
  }, 0) * mult);
}

let itemUid = 0;
export function rollItem(itemId: string, level: number): OwnedItem {
  const base = ITEM_MAP[itemId];
  if (!base) throw new Error(`Unknown item base: ${itemId}`);
  if (base.rarity === 'cursed' || base.rarity === 'immortal' || base.rarity === 'god') {
    throw new Error(`Craft-only rarity cannot be rolled: ${base.rarity}`);
  }
  const stats = rollStats(base.slot, base.rarity, level);
  return {
    uid: globalThis.crypto?.randomUUID?.() ?? `it-${Date.now().toString(36)}-${itemUid++}-${Math.random().toString(36).slice(2)}`,
    itemId, level, stats, power: itemPower(stats),
    enchantLevel: 0, enchantStatsVersion: 2, rerollCount: 0,
  };
}

export function rerollItemStats(item: OwnedItem): OwnedItem {
  const base = ITEM_MAP[item.itemId];
  const newStats = rollStats(base.slot, base.rarity, item.level);
  return {
    ...item,
    stats: newStats,
    power: itemPower(newStats, item.enchantLevel),
    enchantStatsVersion: 2,
    rerollCount: item.rerollCount + 1,
  };
}

// ── Drop rates ────────────────────────────────────────────────────────────

// Daily timed-reward cap: max 1000 chests per Moscow day per player.
export const MAX_CHESTS_PER_DAY = 1000;

// Drop chance: 12% per battle win (reduced from 35%)
const BASE_DROP_CHANCE = 0.12;

type LimitedAvailability = Partial<Record<'divine' | 'celestial', boolean>>;

const STANDARD_LOOT_TABLE: { min: number; max: number; weights: Partial<Record<Rarity, number>> }[] = [
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

export function standardLootWeights(playerLevel: number, availability: LimitedAvailability = {}): Record<Rarity, number> {
  const row = STANDARD_LOOT_TABLE.find((entry) => playerLevel >= entry.min && playerLevel <= entry.max) ?? STANDARD_LOOT_TABLE[0];
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
  const weights = standardLootWeights(playerLevel, availability);
  const transferable = 10;
  const higherTotal = RANDOM_DROP_RARITIES.slice(1).reduce((sum, rarity) => sum + weights[rarity], 0);
  weights.common = Math.max(0, weights.common - transferable);
  if (higherTotal > 0) {
    for (const rarity of RANDOM_DROP_RARITIES.slice(1)) weights[rarity] += transferable * (weights[rarity] / higherTotal);
  }
  return dampenChestPrestige(weights, 'common');
}

function rollItemLevel(playerLevel: number): number {
  return Math.max(1, playerLevel + Math.floor(Math.random() * 5) - 2);
}

function rollFromWeights(weights: Record<Rarity, number>, playerLevel: number): OwnedItem | null {
  const chosen = weightedRarity(weights);
  const pool = ITEMS.filter((item) => item.rarity === chosen && RANDOM_DROP_RARITIES.includes(item.rarity));
  if (!pool.length) return null;
  return rollItem(pool[Math.floor(Math.random() * pool.length)].id, rollItemLevel(playerLevel));
}

export function rollStandardMonsterDrop(playerLevel: number, availability: LimitedAvailability = {}): OwnedItem | null {
  if (Math.random() > BASE_DROP_CHANCE) return null;
  return rollFromWeights(standardLootWeights(playerLevel, availability), playerLevel);
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
  const weights = standardLootWeights(playerLevel, availability);
  const floorIndex = playerLevel >= 10 ? RARITY_INDEX.epic : RARITY_INDEX.rare;
  for (const rarity of RANDOM_DROP_RARITIES) if (RARITY_INDEX[rarity] < floorIndex) weights[rarity] = 0;
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

export function itemTotalPower(items: OwnedItem[]): number {
  return items.reduce((acc, i) => acc + i.power, 0);
}

void RARITY_INDEX;
