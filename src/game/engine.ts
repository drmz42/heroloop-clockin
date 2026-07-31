import type { Enemy, Location, CombatUnit, OwnedHero, OwnedItem } from './types';
import { HERO_MAP } from './heroes';
import { ITEM_MAP, enchantedStats, maxChestRarityForLocation } from './items';

export interface HeroFullStats {
  hp: number; atk: number; def: number; speed: number;
  critChance: number; critDamage: number; dodge: number;
  goldBonus: number; xpBonus: number; atkSpeed: number;
}

const HP_PER_LEVEL = 0.06;
const ATK_PER_LEVEL = 0.05;
const BASE_STAT_SCALE = 0.2;

export function heroStats(owned: OwnedHero, equippedItems?: OwnedItem[]) {
  const base = HERO_MAP[owned.heroId];
  if (!base) return null;
  const lvl = owned.level;
  const starMul = 1 + owned.stars * 0.22;
  const hpLvlMul = 1 + (lvl - 1) * HP_PER_LEVEL;
  const atkLvlMul = 1 + (lvl - 1) * ATK_PER_LEVEL;

  let hp = base.baseHp * BASE_STAT_SCALE * hpLvlMul * starMul;
  let atk = base.baseAtk * BASE_STAT_SCALE * atkLvlMul * starMul;
  let def = base.baseDef * BASE_STAT_SCALE * starMul;
  let speed = base.baseSpeed + owned.stars * 4;
  let critChance = base.critChance;
  let critDamage = base.critDamage;
  let dodge = 0;
  let goldBonus = 0;
  let xpBonus = 0;
  let atkSpeed = 0;

  if (equippedItems) {
    for (const item of equippedItems) {
      const effectiveStats = enchantedStats(item.stats, item.enchantLevel);
      for (const s of effectiveStats) {
        switch (s.key) {
          case 'hp': hp += s.value; break;
          case 'atk': atk += s.value; break;
          case 'def': def += s.value; break;
          case 'atkSpeed': atkSpeed += s.value; break;
          case 'critChance': critChance += s.value; break;
          case 'critDamage': critDamage += s.value; break;
          case 'dodge': dodge += s.value; break;
          case 'goldBonus': goldBonus += s.value; break;
          case 'xpBonus': xpBonus += s.value; break;
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

// Tokens mined only when NOT overpowered for the location
export function canMineTokens(locationId: number, accountLevel: number): boolean {
  return accountLevel >= locationUnlockLevel(locationId);
}

export function buildLocation(id: number, teamSize: number = 1): Location {
  const isBoss = id % 5 === 0;  // boss every 5 locations
  const enemyCount = Math.max(1, Math.min(teamSize, 3));
  const scale = 1 + (id - 1) * 0.35;
  // Required power scales with location tier ranges
  const tierPower = [20, 100, 220, 450, 800, 1400, 2400, 4000, 6500, 10000];
  const requiredPower = tierPower[Math.min(id - 1, tierPower.length - 1)] * (1 + (id > 10 ? (id - 10) * 0.4 : 0));

  let enemies: Enemy[];
  if (isBoss) {
    const bossBase = BOSS_POOL[Math.floor(id / 5 - 1) % BOSS_POOL.length];
    enemies = Array.from({ length: enemyCount }).map((_, i) => i === 0 ? {
        ...bossBase,
        hp: Math.round(700 * scale * 2.0 * 0.2),
        atk: Math.round(42 * scale * 1.3 * 0.24),
        def: Math.round(22 * scale * 1.1 * 0.2),
        speed: 80,
      } : {
        ...ENEMY_POOL[(id + i) % ENEMY_POOL.length],
        id: `${bossBase.id}-guard-${i}`,
        name: `${bossBase.name} Guard`,
        hp: Math.round(300 * scale * (0.9 + i * 0.08) * 0.2),
        atk: Math.round(30 * scale * 0.24),
        def: Math.round(12 * scale * 0.2),
        speed: 72 + i * 3,
      });
  } else {
    enemies = Array.from({ length: enemyCount }).map((_, i) => {
      const e = ENEMY_POOL[(id + i) % ENEMY_POOL.length];
      return {
        ...e,
        hp: Math.round(300 * scale * (0.85 + i * 0.08) * 0.2),
        atk: Math.round(32 * scale * (0.8 + i * 0.05) * 0.24),
        def: Math.round(10 * scale * 0.2),
        speed: 65 + i * 3 + Math.min(id * 1.5, 50),
      };
    });
  }

  // Gold matches screenshot: 17g, 22g, 27g, 32g, 37g, 52g, 210g, 727g...
  const goldBase = [17, 22, 27, 32, 37, 52, 120, 210, 500, 1250];
  const goldReward = Math.max(1, Math.round((goldBase[Math.min(id - 1, goldBase.length - 1)] ?? (id * 8)) * 0.28 * (isBoss ? 3 : 1)));
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
  // Slower base combat overall
  const interval = 1400 - Math.min(speed * 2.2, 700);
  return {
    uid, name, side, hp, maxHp: hp, atk, def, speed,
    combatSpeed: speed,
    critChance, critDamage, color, icon,
    attackTimer: (1400 - speed * 1.5) * 0.4,
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
