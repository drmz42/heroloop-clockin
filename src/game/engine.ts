import type { Enemy, Location, CombatUnit, OwnedHero, OwnedItem, Rarity } from './types';
import { HERO_MAP } from './heroes';
import { ITEM_MAP, maxChestRarityForLocation } from './items';
import { recommendedTeamPower } from './balance';

export interface HeroFullStats {
  hp: number; atk: number; def: number; speed: number;
  critChance: number; critDamage: number; dodge: number;
  goldBonus: number; xpBonus: number; atkSpeed: number;
}

const HP_PER_LEVEL = 0.06;
const ATK_PER_LEVEL = 0.05;
const BASE_STAT_SCALE = 0.2;

export const SET_BONUS_PERCENT: Record<Rarity, number> = {
  common: 2, uncommon: 4, rare: 6, epic: 8, legendary: 10, mythic: 12,
  relic: 12, cosmic: 14, divine: 16, celestial: 18, cursed: 20, immortal: 22, god: 25,
};

export const ENCHANT_RESONANCE_PERCENT = [0, 1, 2, 4, 7, 11, 16, 22, 30, 39, 50] as const;

export function equippedSetBonus(equippedItems: OwnedItem[]): { rarity: Rarity; percent: number } | null {
  if (equippedItems.length !== 8) return null;
  const rarities = equippedItems.map((item) => ITEM_MAP[item.itemId]?.rarity).filter((rarity): rarity is Rarity => Boolean(rarity));
  if (rarities.length !== 8 || !rarities.every((rarity) => rarity === rarities[0])) return null;
  return { rarity: rarities[0], percent: SET_BONUS_PERCENT[rarities[0]] };
}

export function equippedEnchantResonance(equippedItems: OwnedItem[]): { level: number; percent: number } | null {
  if (equippedItems.length !== 8) return null;
  const level = Math.min(...equippedItems.map((item) => Math.max(0, Math.min(10, item.enchantLevel))));
  if (level < 1) return null;
  return { level, percent: ENCHANT_RESONANCE_PERCENT[level] };
}

export function heroStarMultiplier(stars: number): number {
  const safeStars = Math.max(0, Math.min(20, stars));
  const gold = Math.min(5, safeStars);
  const purple = Math.min(5, Math.max(0, safeStars - 5));
  const red = Math.min(5, Math.max(0, safeStars - 10));
  const pink = Math.min(5, Math.max(0, safeStars - 15));
  return 1 + gold * 0.22 + purple * 0.15 + red * 0.12 + pink * 0.10;
}

export function heroStats(owned: OwnedHero, equippedItems?: OwnedItem[]) {
  const base = HERO_MAP[owned.heroId];
  if (!base) return null;
  const lvl = owned.level;
  const starMul = heroStarMultiplier(owned.stars);
  const hpLvlMul = 1 + (lvl - 1) * HP_PER_LEVEL;
  const atkLvlMul = 1 + (lvl - 1) * ATK_PER_LEVEL;

  let hp = base.baseHp * BASE_STAT_SCALE * hpLvlMul * starMul;
  let atk = base.baseAtk * BASE_STAT_SCALE * atkLvlMul * starMul;
  let def = base.baseDef * BASE_STAT_SCALE * starMul;
  const speed = base.baseSpeed + owned.stars * 4;
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
      const multiplier = 1 + Math.max(0, Math.min(10, item.enchantLevel)) * 0.10 + setBonus + resonance;
      for (const s of item.stats) {
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
  if (passive.defMult) def *= passive.defMult;

  return {
    name: base.name, heroClass: base.heroClass, rarity: base.rarity, color: base.color,
    skillName: base.skillName, skillDesc: base.skillDesc,
    passiveName: base.passiveName, passiveDesc: base.passiveDesc,
    hp: Math.round(hp), atk: Math.round(atk), def: Math.round(def),
    speed: Math.round(speed),
    critChance: Math.min(critChance, 0.85), critDamage,
    dodge: Math.min(dodge, 0.6), goldBonus, xpBonus, atkSpeed,
  };
}

export function classPassiveBonus(heroClass: string): { dodge?: number; defMult?: number; healOnAttack?: number; regenPct?: number; } {
  switch (heroClass) {
    case 'assassin': return { dodge: 0.08 };
    case 'knight':   return { defMult: 1.05 };
    case 'shepherd': return { healOnAttack: 0.05 };
    case 'druid':    return { regenPct: 0.015 };
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
    return acc + s.atk + s.hp * 0.08 + s.def * 1.5 + s.atkSpeed * 2;
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
];

// Unlock levels matching screenshot: 1-4, 5-9, 10-15, 16-22, 23-30, 31-39, 40-49, 50-59, 60-69, 70-79
export const LOCATION_RANGES: [number, number][] = [
  [1,4],[5,9],[10,15],[16,22],[23,30],[31,39],[40,49],[50,59],[60,69],[70,79],
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

  const goldReward = Math.max(1, (5 + id) * (isBoss ? 3 : 1));
  const xpReward = Math.max(1, Math.round((4 + id * 1.2) * 0.55 * (isBoss ? 2 : 1)));
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
): CombatUnit {
  // Attack interval: minimum 900ms at base, scaling down with speed
  // Slower base combat overall (base interval raised 10% = base attack speed -10%)
  const interval = 1540 - Math.min(speed * 2.2, 700);
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
  // atkSpeed adds to speed for attack frequency
  const effectiveSpeed = s.speed + s.atkSpeed * 0.15;
  return makeUnit(
    owned.uid, s.name, 'hero',
    s.hp, s.atk, s.def, effectiveSpeed,
    s.color, icon,
    s.critChance, s.critDamage,
    s.heroClass as import('./types').HeroClass,
    s.dodge,
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
