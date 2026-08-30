import type { Enemy, Location, CombatUnit, OwnedHero, OwnedItem, Rarity } from './types';
import { HERO_MAP, RARITY_INDEX } from './heroes';
import { ITEM_MAP, maxChestRarityForLocation } from './items';
import { recommendedTeamPower } from './balance';
import { enchantMultiplier, enchantResonancePercent, MAX_ENCHANT_LEVEL } from './enchant';

export interface HeroFullStats {
  hp: number; atk: number; def: number; speed: number;
  critChance: number; critDamage: number; dodge: number;
  goldBonus: number; xpBonus: number; atkSpeed: number;
}

const BASE_STAT_SCALE = 0.2;

const CLASS_GROWTH: Record<string, { hp: number; atk: number; def: number }> = {
  knight: { hp: .012, atk: .0055, def: .009 }, shepherd: { hp: .007, atk: .0115, def: .0035 },
  assassin: { hp: .0065, atk: .01, def: .003 }, druid: { hp: .0105, atk: .0065, def: .0065 },
  archer: { hp: .008, atk: .009, def: .0045 },
};
const CLASS_CAPS: Record<string, { def: number; dodge: number; crit: number; critDamage: number; atkSpeed: number }> = {
  knight: { def: .6, dodge: .1, crit: .45, critDamage: 2, atkSpeed: .2 }, shepherd: { def: .4, dodge: .15, crit: .5, critDamage: 2.3, atkSpeed: .2 },
  assassin: { def: .4, dodge: .3, crit: .6, critDamage: 2.5, atkSpeed: .25 }, druid: { def: .5, dodge: .15, crit: .45, critDamage: 2.1, atkSpeed: .2 },
  archer: { def: .45, dodge: .2, crit: .55, critDamage: 2.7, atkSpeed: .25 },
};

export const SET_BONUS_PERCENT: Record<Rarity, number> = {
  common: 5, uncommon: 10, rare: 15, epic: 20, legendary: 30, mythic: 40,
  relic: 40, cosmic: 50, divine: 60, celestial: 70, cursed: 80, immortal: 90, god: 100,
};

export function equippedSetBonus(equippedItems: OwnedItem[]): { rarity: Rarity; percent: number } | null {
  if (equippedItems.length !== 8) return null;
  const rarities = equippedItems.map((item) => ITEM_MAP[item.itemId]?.rarity).filter((rarity): rarity is Rarity => Boolean(rarity));
  if (rarities.length !== 8 || !rarities.every((rarity) => rarity === rarities[0])) return null;
  return { rarity: rarities[0], percent: SET_BONUS_PERCENT[rarities[0]] };
}

export function equippedEnchantResonance(equippedItems: OwnedItem[]): { level: number; percent: number } | null {
  if (equippedItems.length !== 8) return null;
  const level = Math.min(...equippedItems.map((item) => Math.max(0, Math.min(MAX_ENCHANT_LEVEL, item.enchantLevel))));
  if (level < 1) return null;
  return { level, percent: enchantResonancePercent(level) };
}

export function heroStarMultiplier(stars: number): number {
  return 1 + Math.max(0, Math.min(20, stars)) * .015;
}

export function heroStats(owned: OwnedHero, equippedItems?: OwnedItem[]) {
  const base = HERO_MAP[owned.heroId];
  if (!base) return null;
  const lvl = owned.level;
  const tier = Math.min(8, RARITY_INDEX[base.rarity]);
  const growth = CLASS_GROWTH[base.heroClass];
  const starMul = heroStarMultiplier(owned.stars);
  const rarityGrowth = 1 + tier * .02;

  let hp = base.baseHp * BASE_STAT_SCALE * (1 + growth.hp * rarityGrowth * (lvl - 1)) * starMul;
  let atk = base.baseAtk * BASE_STAT_SCALE * (1 + growth.atk * rarityGrowth * (lvl - 1)) * starMul;
  let def = base.baseDef * BASE_STAT_SCALE * (1 + growth.def * rarityGrowth * (lvl - 1)) * starMul;
  const speed = base.baseSpeed + owned.stars * .1;
  let critChance = base.critChance;
  let critDamage = base.critDamage;
  let dodge = 0;
  let goldBonus = 0;
  let xpBonus = 0;
  let atkSpeed = 0;

  if (equippedItems) {
    const setBonus = (equippedSetBonus(equippedItems)?.percent ?? 0) / 100;
    const resonance = (equippedEnchantResonance(equippedItems)?.percent ?? 0) / 100;
    for (const item of equippedItems) {
      const level = Math.max(0, Math.min(MAX_ENCHANT_LEVEL, item.enchantLevel));
      for (const s of item.stats) {
        const enchantRate = item.enchantStatsVersion === 3
          ? (s.key === 'hp' || s.key === 'atk' || s.key === 'def' ? .1 : s.key === 'goldBonus' || s.key === 'xpBonus' ? .025 : .05)
          : .1;
        const baseMultiplier = item.enchantStatsVersion === 4 ? enchantMultiplier(level) : 1 + level * enchantRate;
        const multiplier = baseMultiplier + setBonus + (item.enchantStatsVersion === 3 ? 0 : resonance);
        const value = s.isPercent
          ? Math.round(s.value * multiplier * 1000) / 1000
          : Math.round(s.value * multiplier);
        switch (s.key) {
          case 'hp': hp += value; break;
          case 'atk': atk += value; break;
          case 'def': def += value; break;
          case 'atkSpeed': atkSpeed += value; break;
          case 'critChance': critChance += value; break;
          case 'critDamage': critDamage += value; break;
          case 'dodge': dodge += value; break;
          case 'goldBonus': goldBonus += value; break;
          case 'xpBonus': xpBonus += value; break;
        }
      }
    }
  }

  const passive = classPassiveBonus(base.heroClass);
  dodge += passive.dodge ?? 0;
  hp *= passive.hpMult ?? 1;
  atkSpeed += passive.attackSpeed ?? 0;
  const caps = CLASS_CAPS[base.heroClass];

  return {
    name: base.name, heroClass: base.heroClass, rarity: base.rarity, color: base.color,
    skillName: base.skillName, skillDesc: base.skillDesc,
    passiveName: base.passiveName, passiveDesc: base.passiveDesc,
    hp: Math.round(hp), atk: Math.round(atk), def: Math.round(def),
    speed: Math.round(speed),
    critChance: Math.min(critChance, caps.crit), critDamage: Math.min(critDamage, caps.critDamage),
    dodge: Math.min(dodge, caps.dodge), goldBonus, xpBonus, atkSpeed: Math.min(atkSpeed, caps.atkSpeed),
  };
}

export function classPassiveBonus(heroClass: string): { dodge?: number; hpMult?: number; dpsMult?: number; regenPct?: number; attackSpeed?: number } {
  switch (heroClass) {
    case 'assassin': return { dodge: .05 };
    case 'knight':   return { hpMult: 1.15 };
    case 'shepherd': return { dpsMult: 1.1 };
    case 'druid':    return { hpMult: 1.1, regenPct: .004 };
    case 'archer':   return { attackSpeed: .08 };
    default: return {};
  }
}

export function getEquippedItems(owned: OwnedHero, inventory: OwnedItem[]): OwnedItem[] {
  const uids = Object.values(owned.equipped).filter(Boolean) as string[];
  return inventory.filter((i) => uids.includes(i.uid));
}

export function teamPower(heroes: OwnedHero[], inventory: OwnedItem[]): number {
  return Math.round(heroes.reduce((acc, h) => {
    const s = heroStats(h, getEquippedItems(h, inventory));
    if (!s) return acc;
    const caps = CLASS_CAPS[s.heroClass];
    const interval = Math.max(600, (1540 - Math.min(s.speed * 2.2, 700)) / (1 + s.atkSpeed));
    const dps = s.atk * (1000 / interval) * (1 + s.critChance * (s.critDamage - 1)) * (classPassiveBonus(s.heroClass).dpsMult ?? 1);
    const mitigation = Math.min(caps.def, s.def / (s.def + 200));
    const effectiveHp = s.hp / (1 - mitigation) / (1 - s.dodge);
    const sustain = s.hp * (classPassiveBonus(s.heroClass).regenPct ?? 0);
    return acc + 4 * dps + .08 * effectiveHp + 1.5 * sustain;
  }, 0));
}

// ── Locations ──────────────────────────────────────────────────────────────

const ENEMY_POOL: Omit<Enemy, 'hp' | 'atk' | 'def' | 'speed'>[] = [
  { id: 'goblin',   name: 'Goblin',        color: '#65a30d', icon: '👺' },
  { id: 'skeleton', name: 'Skeleton',      color: '#e2e8f0', icon: '💀' },
  { id: 'bat',      name: 'Cave Bat',      color: '#7c3aed', icon: '🦇' },
  { id: 'slime',    name: 'Toxic Slime',   color: '#84cc16', icon: '🟢' },
  { id: 'wolf',     name: 'Dire Wolf',     color: '#475569', icon: '🐺' },
  { id: 'ghost',    name: 'Wraith',        color: '#a5b4fc', icon: '👻' },
  { id: 'spider',   name: 'Giant Spider',  color: '#1e292b', icon: '🕷️' },
  { id: 'orc',      name: 'Orc Brute',     color: '#16a34a', icon: '👹' },
];

const BOSS_POOL: Omit<Enemy, 'hp' | 'atk' | 'def' | 'speed'>[] = [
  { id: 'boss-ogre',   name: 'Ogre Warlord',   color: '#15803d', icon: '👹' },
  { id: 'boss-lich',   name: 'Lich King',      color: '#6d28d9', icon: '☠️' },
  { id: 'boss-dragon', name: 'Ancient Dragon', color: '#b91c1c', icon: '🐲' },
  { id: 'boss-titan',  name: 'Frost Titan',    color: '#0e7490', icon: '🧊' },
];

const LOCATION_NAMES = [
  'Dusty Docks',        // 1 — Lv 1-4
  'Greenwood Vale',     // 2 — Lv 5-9
  'Mistwood Hollow',    // 3 — Lv 10-15
  'Shadowmarsh',        // 4 — Lv 16-22
  'Frostpeak Pass',     // 5 — Lv 23-30
  'Emberfall Caverns',  // 6 — Lv 31-39
  'Ruins of Aether',    // 7 — Lv 40-49
  'Dreadmoor Spire',    // 8 — Lv 50-59
  'Abyssal Rift',       // 9 — Lv 60-69
  'The Void Beyond',    // 10 — Lv 70-79
  'Shattered Crown', 'Astral Scar', 'Cinder Throne', 'Thorned Eclipse', 'Graveglass Expanse',
  'Immortal Bastion', 'Cursed Meridian', 'Divine Crucible', 'Celestial Terminus', 'Godfall Nexus',
];

// Unlock levels matching screenshot: 1-4, 5-9, 10-15, 16-22, 23-30, 31-39, 40-49, 50-59, 60-69, 70-79
export const LOCATION_RANGES: [number, number][] = [
  [1,4],[5,9],[10,15],[16,22],[23,30],[31,39],[40,49],[50,59],[60,69],[70,79],
  [80,81],[82,83],[84,85],[86,87],[88,89],[90,91],[92,93],[94,95],[96,97],[98,99],
];

export function locationUnlockLevel(locationId: number): number {
  const idx = Math.min(locationId - 1, LOCATION_RANGES.length - 1);
  return LOCATION_RANGES[idx][0];
}

export function locationLevelRange(locationId: number): [number, number] {
  const idx = Math.min(locationId - 1, LOCATION_RANGES.length - 1);
  return LOCATION_RANGES[idx];
}

export function isLocationUnlocked(locationId: number, accountLevel: number, highestLocation: number): boolean {
  if (locationId > highestLocation) return false;
  return accountLevel >= locationUnlockLevel(locationId);
}

export function latestTokenLocation(accountLevel: number, highestLocation: number): number {
  const discoveredCap = Math.max(1, Math.min(LOCATION_RANGES.length, highestLocation));
  let latest = 1;
  for (let locationId = 1; locationId <= discoveredCap; locationId += 1) {
    if (accountLevel >= locationUnlockLevel(locationId)) latest = locationId;
  }
  return latest;
}

export function canMineTokens(locationId: number, accountLevel: number, highestLocation: number): boolean {
  const latest = latestTokenLocation(accountLevel, highestLocation);
  return locationId <= latest && locationId >= Math.max(1, latest - 1);
}

export function buildLocation(id: number, teamSize: number = 1, forceBoss = false): Location {
  const isBoss = forceBoss;
  const enemyCount = Math.max(1, Math.min(teamSize, 3));
  const scale = 1 + (id - 1) * 0.35;
  const difficultyRamp = id === 1 ? 1 : 1.45 + (id - 2) * 0.18;
  // Power is guidance, not an unlock gate. Each active hero creates one enemy lane,
  // so compare the formation against a per-lane recommendation.
  const requiredPower = recommendedTeamPower(id, enemyCount);

  let enemies: Enemy[];
  if (isBoss) {
    const bossBase = BOSS_POOL[(id - 1) % BOSS_POOL.length];
    enemies = Array.from({ length: enemyCount }).map((_, i) => i === 0 ? {
        ...bossBase,
        hp: Math.round(700 * scale * 2.0 * 0.33 * difficultyRamp),
        atk: Math.round(42 * scale * 1.3 * 0.32 * difficultyRamp),
        def: Math.round(22 * scale * 1.1 * 0.25 * difficultyRamp),
        speed: 80,
      } : {
        ...ENEMY_POOL[(id + i) % ENEMY_POOL.length],
        id: `${bossBase.id}-guard-${i}`,
        name: `${bossBase.name} Guard`,
        hp: Math.round(300 * scale * (0.9 + i * 0.08) * 0.33 * difficultyRamp),
        atk: Math.round(30 * scale * 0.32 * difficultyRamp),
        def: Math.round(12 * scale * 0.25 * difficultyRamp),
        speed: 72 + i * 3,
      });
  } else {
    enemies = Array.from({ length: enemyCount }).map((_, i) => {
      const e = ENEMY_POOL[(id + i) % ENEMY_POOL.length];
      return {
        ...e,
        hp: Math.round(300 * scale * (0.85 + i * 0.08) * 0.33 * difficultyRamp),
        atk: Math.round(32 * scale * (0.8 + i * 0.05) * 0.32 * difficultyRamp),
        def: Math.round(10 * scale * 0.25 * difficultyRamp),
        speed: 65 + i * 3 + Math.min(id * 1.5, 50),
      };
    });
  }

  const endgameGold = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
  const endgameXp = [9, 10, 11, 11, 12, 13, 13, 14, 15, 15];
  const goldReward = Math.max(1, (id > 10 ? endgameGold[id - 11] : 5 + id) * (isBoss ? 3 : 1));
  const xpReward = Math.max(1, (id > 10 ? endgameXp[id - 11] : Math.round((4 + id * 1.2) * .55)) * (isBoss ? 2 : 1));
  const tokenReward = 0;

  return {
    id,
    name: LOCATION_NAMES[(id - 1) % LOCATION_NAMES.length],
    enemies, goldReward, xpReward, tokenReward, boss: isBoss,
    requiredPower: Math.round(requiredPower), unlocked: false,
    maxChestRarity: maxChestRarityForLocation(id),
  };
}

export function isOverpowered(location: Location, power: number): boolean {
  if (location.id === 1) return false;
  return power > location.requiredPower * 2.5;
}

// ── Combat units ───────────────────────────────────────────────────────────

export function makeUnit(
  uid: string, name: string, side: 'hero' | 'enemy',
  hp: number, atk: number, def: number, speed: number,
  color: string, icon: string,
  critChance: number, critDamage: number,
  heroClass?: import('./types').HeroClass,
  dodge?: number,
  atkSpeed = 0,
): CombatUnit {
  // Attack interval: minimum 900ms at base, scaling down with speed
  // Slower base combat overall (base interval raised 10% = base attack speed -10%)
  const interval = (1540 - Math.min(speed * 2.2, 700)) / (1 + Math.max(0, atkSpeed));
  return {
    uid, name, side, hp, maxHp: hp, atk, def, speed,
    combatSpeed: speed,
    critChance, critDamage, color, icon,
    attackTimer: ((1540 - speed * 1.5) * 0.4),
    attackInterval: Math.max(interval, 600),
    heroClass, alive: true, dodge: dodge ?? 0, regenTimer: 0,
  };
}

export function ownedToUnit(owned: OwnedHero, inventory: OwnedItem[] = []): CombatUnit | null {
  const items = getEquippedItems(owned, inventory);
  const s = heroStats(owned, items);
  if (!s) return null;
  const icon = s.heroClass === 'knight' ? '⚔️'
    : s.heroClass === 'archer' ? '🏹'
    : s.heroClass === 'assassin' ? '🗡️'
    : s.heroClass === 'shepherd' ? '✨'
    : '🌿';
  return makeUnit(
    owned.uid, s.name, 'hero',
    s.hp, s.atk, s.def, s.speed,
    s.color, icon,
    s.critChance, s.critDamage,
    s.heroClass as import('./types').HeroClass,
    s.dodge, s.atkSpeed,
  );
}

export function enemyToUnit(e: Enemy, idx: number): CombatUnit {
  return makeUnit(
    `e${idx}-${e.id}`, e.name, 'enemy',
    e.hp, e.atk, e.def, e.speed,
    e.color, e.icon, 0.06, 1.5,
  );
}

void ITEM_MAP;
