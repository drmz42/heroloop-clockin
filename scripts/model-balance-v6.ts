// Balance v6 proposal model (not runtime). Builds the hero, Star, item/Enchant, enemy and location
// tables for config/balance/balance-v6-proposal.v1.json and verifies them on the live server combat
// engine. Every v6 formula differs from the current v5 runtime only by the parameters in that config;
// `--check` first proves the v5 re-implementation matches the server hero units exactly.
//
// Run:   npx tsx scripts/model-balance-v6.ts            (writes docs/game/data/balance-v6/*)
//        npx tsx scripts/model-balance-v6.ts --check    (asserts parity, targets and determinism)

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildNormalCombat } from '../managed/functions/player-sync/normal-combat.mjs';
import { resolveCombat } from '../managed/functions/player-sync/combat-step.mjs';
import { COMBAT_EFFECTS_V2_VERSION } from '../managed/functions/player-sync/combat-effects-v2.mjs';
import { itemRollV5StatValue, ITEM_ROLL_V5_CONTRACT } from '../src/game/item-roll-runtime.generated';
import { accountXpForLevel } from '../src/game/state';
import { LOCATION_RANGES, teamPower } from '../src/game/engine';
import { ITEMS } from '../src/game/items';
import { RECOMMENDED_POWER_PER_LANE } from '../src/game/balance';

type HeroClass = 'knight' | 'shepherd' | 'assassin' | 'druid' | 'archer';
type StatKey = 'hp' | 'atk' | 'def' | 'atkSpeed' | 'critChance' | 'critDamage' | 'dodge' | 'goldBonus' | 'xpBonus';
type Line = { key: StatKey; u: number };
type Item = { slot: string; rarity: string; level: number; enchant: number; lines: Line[] };
type Hero = { heroClass: HeroClass; tier: number; level: number; stars: number; items: Item[] };
type Model = 'v5' | 'v6';

const CHECK = process.argv.includes('--check');
const ROOT = new URL('..', import.meta.url);
const CONFIG = JSON.parse(readFileSync(new URL('config/balance/balance-v6-proposal.v1.json', ROOT), 'utf8'));
const OUT = new URL('docs/game/data/balance-v6/', ROOT);

export const CLASSES: HeroClass[] = ['knight', 'shepherd', 'assassin', 'druid', 'archer'];
export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
const RARITY_LABEL = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Cosmic', 'Divine', 'Celestial'];
const HERO_RARITY_SCALE = [1, 1.441163, 2.147372, 3.084756, 4.435796, 6.370091, 9.143236, 13.119459, 18.814853];
const SLOTS = ['class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'amulet', 'ring'];
const OFFHAND_CLASS: Record<HeroClass, string> = { knight: 'warrior', shepherd: 'mage', assassin: 'assassin', druid: 'druid', archer: 'crossbowman' };
// Server archetypes (managed/functions/player-sync/normal-combat.mjs) and client display caps (src/game/engine.ts).
const ARCH: Record<HeroClass, { hp: number; atk: number; def: number; speed: number; crit: number; critDamage: number; growth: [number, number, number]; hpMult: number; caps: [number, number, number]; atkSpeedCap: number; defCap: number; dodge: number; critPts: number; critDmgPts: number; atkSpeedPts: number; regen: number }> = {
  shepherd: { hp: 340, atk: 86, def: 12, speed: 104, crit: .12, critDamage: 1.85, growth: [.007, .0115, .0035], hpMult: 1, caps: [.5, 2.3, .15], atkSpeedCap: .2, defCap: .4, dodge: 0, critPts: 0, critDmgPts: 0, atkSpeedPts: 0, regen: 0 },
  assassin: { hp: 310, atk: 78, def: 10, speed: 130, crit: .18, critDamage: 2, growth: [.0065, .01, .003], hpMult: 1, caps: [.6, 2.5, .3], atkSpeedCap: .25, defCap: .4, dodge: .05, critPts: .05, critDmgPts: 0, atkSpeedPts: 0, regen: 0 },
  knight: { hp: 500, atk: 56, def: 28, speed: 92, crit: .08, critDamage: 1.6, growth: [.012, .0055, .009], hpMult: 1.15, caps: [.45, 2, .1], atkSpeedCap: .2, defCap: .6, dodge: 0, critPts: 0, critDmgPts: 0, atkSpeedPts: 0, regen: 0 },
  druid: { hp: 450, atk: 60, def: 20, speed: 100, crit: .1, critDamage: 1.7, growth: [.0105, .0065, .0065], hpMult: 1.1, caps: [.45, 2.1, .15], atkSpeedCap: .2, defCap: .5, dodge: 0, critPts: 0, critDmgPts: 0, atkSpeedPts: 0, regen: .004 },
  archer: { hp: 360, atk: 70, def: 14, speed: 124, crit: .15, critDamage: 1.9, growth: [.008, .009, .0045], hpMult: 1, caps: [.55, 2.7, .2], atkSpeedCap: .25, defCap: .45, dodge: 0, critPts: 0, critDmgPts: .25, atkSpeedPts: .08, regen: 0 },
};
const SET_BONUS: Record<string, number> = { common: 5, uncommon: 10, rare: 15, epic: 20, legendary: 30, mythic: 40, cosmic: 50, divine: 60, celestial: 70 };
const RESONANCE = [0, 1, 2, 4, 7, 11, 16, 22, 30, 39, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const MAIN = new Set<StatKey>(['hp', 'atk', 'def']);

// ── deterministic randomness ───────────────────────────────────────────────
function rng(seed: number) {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── formulas ───────────────────────────────────────────────────────────────
const V6 = CONFIG.hero;
export const starMultiplier = (model: Model, stars: number) => model === 'v5'
  ? 1 + clamp(stars, 0, 20) * .05
  : (1 + V6.starPerStar) ** clamp(stars, 0, 20);
export const levelMastery = (model: Model, level: number) => model === 'v5'
  ? 1 + .75 * (clamp(level, 1, 99) - 1) / 79
  : (1 + V6.masteryPerLevel) ** (clamp(level, 1, 99) - 1);
export function enchantMultiplier(model: Model, level: number): number {
  const safe = clamp(Math.floor(level), 0, 20);
  if (model === 'v6') return 1 + CONFIG.enchant.perLevel * safe;
  return 1 + Math.min(safe, 5) * .10 + Math.max(0, Math.min(safe, 10) - 5) * .15
    + Math.max(0, Math.min(safe, 15) - 10) * .20 + Math.max(0, safe - 15) * .25;
}
// v6 random stat lines keep their v5 values. Every v6 item adds a slot implicit (its base stat) that
// follows the hero curve: implicit = statBase × rarityScale × (1 + levelLinear·(L−1)) × (1 + mastery)^(L−1).
export const itemLevelMultiplierV6 = (level: number) =>
  (1 + CONFIG.items.levelLinear * (level - 1)) * (1 + V6.masteryPerLevel) ** (level - 1);
export const lineValue = (_model: Model, line: Line, rarity: string, level: number): number => itemRollV5StatValue(line.key, rarity, level, line.u);
export function implicitStats(slot: string, rarity: string, level: number): Partial<Record<StatKey, number>> {
  const mix: Record<string, number> = CONFIG.items.implicitBySlot[slot];
  const scale = CONFIG.items.implicitRarityScale[rarity] * itemLevelMultiplierV6(level);
  return Object.fromEntries(Object.entries(mix).map(([key, share]) => [key, share * CONFIG.items.implicitStatBase[key] * scale]));
}

export type Stats = { hp: number; atk: number; def: number; speed: number; atkSpeed: number; critChance: number; critDamage: number; dodge: number; goldBonus: number; xpBonus: number };

// Mirrors normal-combat.mjs heroUnit (combat effects v2). v6 applies Level mastery to base stats only
// because v6 item main stats carry their own hero-matched Item Level curve.
export function heroStats(model: Model, hero: Hero): Stats {
  const arch = ARCH[hero.heroClass];
  const items = hero.items;
  const sameSet = items.length === 8 && items.every((item) => item.rarity === items[0].rarity);
  const setBonus = sameSet ? SET_BONUS[items[0].rarity] / 100 : 0;
  const resonance = items.length === 8 ? RESONANCE[Math.min(...items.map((item) => clamp(item.enchant, 0, 20)))] / 100 : 0;
  const add: Record<StatKey, number> = { hp: 0, atk: 0, def: 0, atkSpeed: 0, critChance: 0, critDamage: 0, dodge: 0, goldBonus: 0, xpBonus: 0 };
  for (const item of items) {
    const multiplier = enchantMultiplier(model, item.enchant) + setBonus + resonance;
    for (const line of item.lines) {
      const value = lineValue(model, line, item.rarity, item.level);
      add[line.key] += MAIN.has(line.key) ? Math.round(value * multiplier) : Math.round(value * multiplier * 1000) / 1000;
    }
    if (model === 'v6') for (const [key, value] of Object.entries(implicitStats(item.slot, item.rarity, item.level))) add[key as StatKey] += Math.round(value! * multiplier);
  }
  const rarityScale = HERO_RARITY_SCALE[hero.tier];
  const star = starMultiplier(model, hero.stars);
  const rarityGrowth = 1 + hero.tier * .02;
  const mastery = levelMastery(model, hero.level);
  const base = (index: 0 | 1 | 2, value: number) => value * rarityScale * .2 * (1 + arch.growth[index] * rarityGrowth * (hero.level - 1)) * star;
  const stat = (index: 0 | 1 | 2, value: number, extra: number) => model === 'v5'
    ? (base(index, value) + extra) * mastery
    : base(index, value) * mastery + extra;
  return {
    hp: Math.round(stat(0, arch.hp, add.hp) * arch.hpMult),
    atk: Math.round(stat(1, arch.atk, add.atk)),
    def: Math.round(stat(2, arch.def, add.def)),
    speed: arch.speed * (1 + hero.tier * .01) + hero.stars * .1,
    atkSpeed: Math.min(arch.atkSpeedPts + add.atkSpeed, arch.atkSpeedCap),
    critChance: Math.min(arch.crit + arch.critPts + add.critChance, arch.caps[0]),
    critDamage: Math.min(arch.critDamage + arch.critDmgPts + add.critDamage, arch.caps[1]),
    dodge: Math.min(add.dodge + arch.dodge, arch.caps[2]),
    goldBonus: add.goldBonus, xpBonus: add.xpBonus,
  };
}

// Displayed Hero Power: the teamPower formula of src/game/engine.ts applied to the stats above.
export function heroPower(model: Model, hero: Hero): number {
  const s = heroStats(model, hero);
  const arch = ARCH[hero.heroClass];
  const interval = Math.max(600, (1540 - Math.min(Math.round(s.speed) * 2.2, 700)) / (1 + s.atkSpeed));
  const dps = s.atk * (1000 / interval) * (1 + s.critChance * (s.critDamage - 1)) * (hero.heroClass === 'shepherd' ? 1.1 : 1);
  const mitigation = Math.min(arch.defCap, s.def / (s.def + 200));
  const effectiveHp = s.hp / (1 - mitigation) / (1 - s.dodge);
  return 4 * dps + .08 * effectiveHp + 1.5 * s.hp * arch.regen;
}

// ── items ──────────────────────────────────────────────────────────────────
const RARITY_LINES: Record<string, number> = Object.fromEntries(ITEM_ROLL_V5_CONTRACT.rarities.map((r) => [r.id, r.lines]));
function poolFor(heroClass: HeroClass, slot: string): StatKey[] {
  return (slot === 'offhand' ? ITEM_ROLL_V5_CONTRACT.classOffhandPools[OFFHAND_CLASS[heroClass]] : ITEM_ROLL_V5_CONTRACT.slotPools[slot]) as StatKey[];
}
export function rollItemLines(heroClass: HeroClass, slot: string, rarity: string, random: () => number): Line[] {
  const remaining = [...poolFor(heroClass, slot)];
  const lines: Line[] = [];
  for (let index = 0; index < Math.min(RARITY_LINES[rarity], remaining.length); index += 1) {
    const key = remaining.splice(Math.floor(random() * remaining.length), 1)[0];
    lines.push({ key, u: random() });
  }
  return lines;
}
export function gearSet(heroClass: HeroClass, rarity: string, level: number, enchant: number, random: () => number, slots = 8): Item[] {
  return SLOTS.slice(0, slots).map((slot) => ({ slot, rarity, level, enchant, lines: rollItemLines(heroClass, slot, rarity, random) }));
}

// ── v5 parity with the server heroUnit ─────────────────────────────────────
function parityCheck(samples: number): number {
  const random = rng(0xa11ce);
  let mismatches = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const heroClass = CLASSES[Math.floor(random() * 5)];
    const tier = Math.floor(random() * 9);
    const level = 1 + Math.floor(random() * 99);
    const stars = Math.floor(random() * 21);
    const slots = Math.floor(random() * 9);
    const itemRarity = RARITIES[Math.floor(random() * 9)];
    const hero: Hero = { heroClass, tier, level, stars, items: gearSet(heroClass, itemRarity, clamp(level - 3, 1, 99), Math.floor(random() * 21), random, slots) };
    const ledger = hero.items.map((item, index) => ({
      id: `i${index}`, rarity: item.rarity, enchant_level: item.enchant, enchant_stats_version: 4,
      stats: item.lines.map((line) => ({ key: line.key, value: lineValue('v5', line, item.rarity, item.level), isPercent: !MAIN.has(line.key) })),
    }));
    const owned = { uid: 'h0', heroId: `${heroClass}-${RARITIES[tier]}`, level, stars, equipped: Object.fromEntries(ledger.map((item, index) => [SLOTS[index], item.id])), xp: 0 };
    const combat = buildNormalCombat({ team: ['h0'], ownedHeroes: [owned], gold: 0 }, ledger, 1, 1, null, 0, COMBAT_EFFECTS_V2_VERSION);
    const unit = combat.initial_units[0];
    const mine = heroStats('v5', hero);
    const clientItems = hero.items.map((item, index) => ({
      uid: `i${index}`, level: item.level, enchantLevel: item.enchant, enchantStatsVersion: 4 as const, itemRollVersion: 5, rerollCount: 0, power: 0,
      itemId: ITEMS.find((base) => base.slot === SLOTS[index] && base.rarity === item.rarity && (!base.heroClass || base.heroClass === heroClass))!.id,
      stats: ledger[index].stats,
    }));
    const clientPower = teamPower([owned as never], clientItems as never);
    const myPower = heroPower('v5', hero);
    if (Math.abs(clientPower - myPower) > Math.max(4, clientPower * .035)) {
      mismatches += 1;
      if (mismatches <= 3) console.error('power mismatch', { heroClass, tier, level, stars, slots, clientPower, myPower });
    }
    const same = unit.maxHp === mine.hp && unit.atk === mine.atk && unit.def === mine.def
      && Math.abs(unit.critChance - mine.critChance) < 1e-9 && Math.abs(unit.critDamage - mine.critDamage) < 1e-9 && Math.abs((unit.dodge ?? 0) - mine.dodge) < 1e-9;
    if (!same) {
      mismatches += 1;
      if (mismatches <= 3) console.error('parity mismatch', { heroClass, tier, level, stars, slots, server: [unit.maxHp, unit.atk, unit.def, unit.critChance, unit.critDamage, unit.dodge], mine });
    }
  }
  return mismatches;
}

export const csv = (rows: (string | number)[][]) => rows.map((row) => row.join(',')).join('\n') + '\n';
export const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const bare = (heroClass: HeroClass, tier: number, level: number, stars: number): Hero => ({ heroClass, tier, level, stars, items: [] });
const classAvgPower = (model: Model, tier: number, level: number, stars: number) => avg(CLASSES.map((c) => heroPower(model, bare(c, tier, level, stars))));

export { avg, bare, classAvgPower, rng, CONFIG };
export type { Hero, Item, Line, Model, HeroClass, StatKey };

// ── hero tables ────────────────────────────────────────────────────────────
const TABLE_LEVELS = [1, 25, 50, 75, 99];
const TABLE_STARS = [0, 10, 20];
function heroTables() {
  const rows: (string | number)[][] = [['rarity', 'stars', 'level', 'v5_power_class_avg', 'v6_power_class_avg', 'v6_to_v5', 'v5_warrior', 'v6_warrior', 'v6_mage', 'v6_assassin', 'v6_druid', 'v6_crossbowman']];
  for (let tier = 0; tier < 9; tier += 1) for (const stars of TABLE_STARS) for (const level of TABLE_LEVELS) {
    const v5 = classAvgPower('v5', tier, level, stars);
    const v6 = classAvgPower('v6', tier, level, stars);
    rows.push([RARITY_LABEL[tier], stars, level, Math.round(v5), Math.round(v6), (v6 / v5).toFixed(2),
      Math.round(heroPower('v5', bare('knight', tier, level, stars))), ...CLASSES.map((c) => Math.round(heroPower('v6', bare(c, tier, level, stars))))]);
  }
  return rows;
}
// Marginal gain of one action on a bare hero, class average, at representative states.
function marginalTables() {
  const rows: (string | number)[][] = [['action', 'from_state', 'v5_gain', 'v6_gain']];
  const gain = (model: Model, a: [number, number, number], b: [number, number, number]) => classAvgPower(model, ...b) / classAvgPower(model, ...a) - 1;
  for (const [from, to] of [[1, 2], [10, 11], [25, 26], [50, 51], [75, 76], [98, 99]]) {
    rows.push([`Hero Level ${from}->${to}`, 'Legendary 0★ bare', pct(gain('v5', [4, from, 0], [4, to, 0])), pct(gain('v6', [4, from, 0], [4, to, 0]))]);
  }
  for (const [from, to] of [[1, 25], [25, 50], [50, 75], [75, 99], [1, 99]]) {
    const span = to - from;
    const g5 = (1 + gain('v5', [4, from, 0], [4, to, 0])) ** (1 / span) - 1;
    const g6 = (1 + gain('v6', [4, from, 0], [4, to, 0])) ** (1 / span) - 1;
    rows.push([`Hero Level ${from}->${to} (average per level)`, 'Legendary 0★ bare', pct(g5), pct(g6)]);
  }
  for (const [from, to] of [[0, 1], [9, 10], [19, 20], [0, 10], [0, 20]]) {
    rows.push([`Star ${from}->${to}`, 'Legendary L75 bare', pct(gain('v5', [4, 75, from], [4, 75, to])), pct(gain('v6', [4, 75, from], [4, 75, to]))]);
  }
  for (let tier = 0; tier < 8; tier += 1) {
    rows.push([`Rarity ${RARITY_LABEL[tier]}->${RARITY_LABEL[tier + 1]}`, 'L75 0★ bare', pct(gain('v5', [tier, 75, 0], [tier + 1, 75, 0])), pct(gain('v6', [tier, 75, 0], [tier + 1, 75, 0]))]);
  }
  return rows;
}

// ── items and Enchant ──────────────────────────────────────────────────────
const ITEM_LEVELS = [10, 25, 50, 75, 99];
// Average and spread of the Power one random +0 item adds to a bare 0★ hero of the same rarity and level.
function singleItemGains(model: Model, rarity: string, samples: number, seed: number) {
  const random = rng(seed);
  const tier = RARITIES.indexOf(rarity);
  const gains: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const heroClass = CLASSES[sample % 5];
    const level = ITEM_LEVELS[Math.floor(sample / 5) % ITEM_LEVELS.length];
    const slot = SLOTS[Math.floor(random() * SLOTS.length)];
    const item: Item = { slot, rarity, level, enchant: 0, lines: rollItemLines(heroClass, slot, rarity, random) };
    const hero = bare(heroClass, tier, level, 0);
    gains.push(heroPower(model, { ...hero, items: [item] }) / heroPower(model, hero) - 1);
  }
  gains.sort((left, right) => left - right);
  return { mean: avg(gains), p10: gains[Math.floor(gains.length * .1)], p50: gains[Math.floor(gains.length * .5)], p90: gains[Math.floor(gains.length * .9)] };
}
// Implicit-only gain of one slot's base stat on a same-rarity bare 0★ hero, averaged over classes and levels.
function implicitGain(slot: string, rarity: string) {
  const tier = RARITIES.indexOf(rarity);
  const gains: number[] = [];
  for (const heroClass of CLASSES) for (const level of ITEM_LEVELS) {
    const hero = bare(heroClass, tier, level, 0);
    gains.push(heroPower('v6', { ...hero, items: [{ slot, rarity, level, enchant: 0, lines: [] }] }) / heroPower('v6', hero) - 1);
  }
  return avg(gains);
}
// 1) Stat bases so an Attack, HP or chest (HP+Defense) implicit is worth the same at Legendary.
// 2) Rarity scales so the average whole item (implicit plus its random v5 lines) meets the rarity target.
function calibrateItemScales() {
  const items = CONFIG.items;
  const target = items.targetGainPerItem;
  for (let round = 0; round < 6; round += 1) {
    items.implicitStatBase.atk *= target.legendary / implicitGain('class_weapon', 'legendary');
    items.implicitStatBase.hp *= target.legendary / implicitGain('helmet', 'legendary');
    items.implicitStatBase.def = Math.max(.01, items.implicitStatBase.def * (target.legendary / implicitGain('chest', 'legendary')) ** 2);
  }
  // Lines are part of the item, so the implicit share is what remains after the average line gain.
  for (let round = 0; round < 6; round += 1) {
    for (const rarity of RARITIES) {
      const { mean } = singleItemGains('v6', rarity, 20000, 0x17e0 + RARITIES.indexOf(rarity));
      items.implicitRarityScale[rarity] *= target[rarity] / mean;
    }
  }
  const round3 = (record: Record<string, number>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, Number(value.toPrecision(3))]));
  return { implicitStatBase: round3(items.implicitStatBase), implicitRarityScale: round3(items.implicitRarityScale) };
}
// Full-set, per-level and Enchant tables; deterministic seeds so repeated runs are identical.
function itemTables() {
  const rows: (string | number)[][] = [['item_rarity', 'v5_one_item_mean', 'v6_one_item_mean', 'v6_one_item_p10', 'v6_one_item_p90', 'v5_full_set_plus0', 'v6_full_set_plus0', 'v5_full_set_plus10', 'v6_full_set_plus10', 'v5_full_set_plus20', 'v6_full_set_plus20']];
  for (const rarity of RARITIES) {
    const one5 = singleItemGains('v5', rarity, 20000, 0x5eed + RARITIES.indexOf(rarity));
    const one6 = singleItemGains('v6', rarity, 20000, 0x5eed + RARITIES.indexOf(rarity));
    const setGain = (model: Model, enchant: number) => {
      const random = rng(0x5e7 + RARITIES.indexOf(rarity) * 31 + enchant);
      const gains: number[] = [];
      for (let sample = 0; sample < 400; sample += 1) {
        const heroClass = CLASSES[sample % 5];
        const level = ITEM_LEVELS[Math.floor(sample / 5) % ITEM_LEVELS.length];
        const hero = bare(heroClass, RARITIES.indexOf(rarity), level, 0);
        gains.push(heroPower(model, { ...hero, items: gearSet(heroClass, rarity, level, enchant, random) }) / heroPower(model, hero) - 1);
      }
      return avg(gains);
    };
    rows.push([RARITY_LABEL[RARITIES.indexOf(rarity)], pct(one5.mean), pct(one6.mean), pct(one6.p10), pct(one6.p90),
      pct(setGain('v5', 0)), pct(setGain('v6', 0)), pct(setGain('v5', 10)), pct(setGain('v6', 10)), pct(setGain('v5', 20)), pct(setGain('v6', 20))]);
  }
  return rows;
}
// One Enchant step on one item of a full same-rarity set, measured against the bare hero and the
// equipped hero. Resonance is excluded here (it needs all eight at the new minimum) and shown separately.
function enchantTables() {
  const rows: (string | number)[][] = [['step', 'v5_gain_vs_bare', 'v6_gain_vs_bare', 'v5_gain_vs_equipped', 'v6_gain_vs_equipped']];
  const measure = (model: Model, from: number) => {
    const random = rng(0xe4c + from);
    const vsBare: number[] = [];
    const vsEquipped: number[] = [];
    for (let sample = 0; sample < 2000; sample += 1) {
      const heroClass = CLASSES[sample % 5];
      const level = ITEM_LEVELS[Math.floor(sample / 5) % ITEM_LEVELS.length];
      const hero = bare(heroClass, 4, level, 0);
      // The stepped slot rotates through all eight; another slot stays at the old level so the
      // eight-slot Resonance minimum does not change during the step.
      const stepped = Math.floor(sample / 25) % 8;
      const anchor = (stepped + 1) % 8;
      const items = gearSet(heroClass, 'legendary', level, from, random).map((item, index) => index === stepped || index === anchor ? item : { ...item, enchant: from + 1 });
      const before = heroPower(model, { ...hero, items });
      const after = heroPower(model, { ...hero, items: items.map((item, index) => index === stepped ? { ...item, enchant: from + 1 } : item) });
      vsBare.push((after - before) / heroPower(model, hero));
      vsEquipped.push(after / before - 1);
    }
    return [avg(vsBare), avg(vsEquipped)];
  };
  for (const from of [0, 4, 9, 14, 18]) {
    const [b5, e5] = measure('v5', from);
    const [b6, e6] = measure('v6', from);
    rows.push([`+${from}->+${from + 1} one Legendary item`, pct(b5), pct(b6), pct(e5), pct(e6)]);
  }
  return rows;
}
// Does the v6 item keep ~the same share at every level? (Item Level curve tracks the hero curve.)
function itemLevelTable() {
  const rows: (string | number)[][] = [['level', ...RARITIES.map((rarity) => `v6_${rarity}`), 'v5_legendary']];
  for (const level of [1, 10, 25, 50, 75, 99]) {
    const row: (string | number)[] = [level];
    for (const model of ['v6', 'v5'] as Model[]) for (const rarity of model === 'v6' ? RARITIES : ['legendary']) {
      const tier = RARITIES.indexOf(rarity);
      const random = rng(0x1e7e1 + level * 13 + tier);
      const gains: number[] = [];
      for (let sample = 0; sample < 1000; sample += 1) {
        const heroClass = CLASSES[sample % 5];
        const hero = bare(heroClass, tier, level, 0);
        const itemSlot = SLOTS[Math.floor(random() * 8)];
        const item: Item = { slot: itemSlot, rarity, level, enchant: 0, lines: rollItemLines(heroClass, itemSlot, rarity, random) };
        gains.push(heroPower(model, { ...hero, items: [item] }) / heroPower(model, hero) - 1);
      }
      row.push(pct(avg(gains)));
    }
    rows.push(row);
  }
  return rows;
}

// ── combat units (mirrors normal-combat.mjs, combat effects v2) ────────────
const attackIntervalMs = (speed: number, attackSpeed = 0) => Math.max((1540 - Math.min(speed * 2.2, 700)) / (1 + attackSpeed), 600);
export function heroCombatUnit(model: Model, hero: Hero, lane: number) {
  const s = heroStats(model, hero);
  return {
    uid: `h${lane}`, side: 'hero', lane, hp: s.hp, maxHp: s.hp, alive: s.hp > 0, atk: s.atk, def: s.def,
    attackTimer: 0, attackInterval: attackIntervalMs(s.speed, s.atkSpeed),
    critChance: s.critChance, critDamage: s.critDamage, dodge: s.dodge,
    heroClass: hero.heroClass, regenTimer: 0, regenPerSecond: 0, damageMultiplier: 1,
    combatEffectsVersion: COMBAT_EFFECTS_V2_VERSION, effectClockMsV2: 0, effectSourceStateV2: {}, activeEffectsV2: {},
  };
}
const ENEMY_IDS = ['goblin', 'skeleton', 'bat', 'slime', 'wolf', 'ghost', 'spider', 'orc'];
const ENDGAME_ROLES = ['tank', 'striker', 'skirmisher', 'support', 'caster'];
const ELITE_AFFIXES = ['guard-aura', 'mending', 'barrier', 'enrage', 'curse', 'lane-blast', 'summoner'];
const V5_ENDGAME = [[6163, 556, 202, 103], [6185, 558, 202, 103], [7736, 664, 325, 103], [7815, 671, 327, 103], [8301, 711, 355, 103], [9708, 835, 403, 103], [11836, 1017, 494, 103], [13400, 1156, 547, 103], [15765, 1360, 646, 103], [17315, 1498, 698, 103]];
// Per-location lane-0 enemy base [HP, Attack, Defense] before lane/role modifiers.
export type EnemyBase = { hp: number; atk: number; def: number };
export function v5EnemyBase(location: number): EnemyBase {
  const late = location >= 10 ? 1.2 : 1;
  if (location > 10) {
    const [hp, atk, def] = V5_ENDGAME[location - 11];
    return { hp: hp * late, atk: atk * late, def };
  }
  const scale = 1 + (location - 1) * .35;
  const difficulty = location === 1 ? 1 : 1.45 + (location - 2) * .18;
  return { hp: 300 * scale * .33 * difficulty * late, atk: 32 * scale * .32 * difficulty * late, def: 10 * scale * .25 * difficulty };
}
// Same lane/role structure as the server: Locations 1-10 use lane modifiers, 11-20 endgame roles and elites.
export function enemyCombatUnits(location: number, teamSize: number, seed: number, base: EnemyBase) {
  if (location > 10) {
    const elite = Math.abs(seed) % 20 === 0 ? ELITE_AFFIXES[Math.abs(seed >>> 5) % ELITE_AFFIXES.length] : null;
    return Array.from({ length: teamSize }, (_, lane) => {
      const role = ENDGAME_ROLES[Math.abs(seed + lane * 17) % ENDGAME_ROLES.length];
      const roleScale = role === 'tank' ? [1.3, .8, 1.35, .9, 0] : role === 'striker' ? [.85, 1.25, .85, 1, 0]
        : role === 'skirmisher' ? [.8, .9, .8, 1.25, .05] : role === 'support' ? [1, .75, 1, .95, 0] : [.85, 1.05, .8, 1, 0];
      const hp = Math.round(base.hp * roleScale[0]);
      return { uid: `e${lane}-endgame-${location}`, side: 'enemy', lane, hp, maxHp: hp, alive: true, atk: Math.round(base.atk * roleScale[1]),
        def: Math.round(base.def * roleScale[2] * (elite === 'guard-aura' ? 1.1 : 1)), attackTimer: 0, attackInterval: attackIntervalMs(103 * roleScale[3]),
        critChance: .06, critDamage: 1.5, dodge: roleScale[4], role, eliteAffix: elite, effectCooldowns: {}, assistLowestHp: true };
    });
  }
  return Array.from({ length: teamSize }, (_, lane) => {
    const hp = Math.round(base.hp * (.85 + lane * .08));
    const interval = attackIntervalMs(65 + lane * 3 + Math.min(location * 1.5, 50));
    return { uid: `e${lane}-${ENEMY_IDS[(location + lane) % ENEMY_IDS.length]}`, side: 'enemy', lane, hp, maxHp: hp, alive: true,
      atk: Math.round(base.atk * (.8 + lane * .05)), def: Math.round(base.def), attackTimer: interval, attackInterval: interval, critChance: .06, critDamage: 1.5, dodge: 0 };
  });
}
// heroScale multiplies hero HP/Attack/Defense: a team of the same build at a different Power.
function fight(model: Model, heroes: Hero[], location: number, seed: number, base: EnemyBase, heroScale = 1) {
  const scaled = heroes.map((hero, lane) => {
    const unit = heroCombatUnit(model, hero, lane);
    if (heroScale === 1) return unit;
    const hp = Math.round(unit.hp * heroScale);
    return { ...unit, hp, maxHp: hp, atk: Math.round(unit.atk * heroScale), def: Math.round(unit.def * heroScale) };
  });
  const units = [...scaled, ...enemyCombatUnits(location, heroes.length, seed, base)];
  const resolved = resolveCombat(units as never, seed, 20, 120000);
  return { win: resolved.resolution.allCleared, ms: resolved.elapsedMs };
}
// Combat parity: our v5 units + v5 enemy bases must reproduce the server wave exactly.
function combatParity(samples: number): number {
  const random = rng(0xc0b7a7);
  let mismatches = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const location = 1 + Math.floor(random() * 20);
    const size = 1 + Math.floor(random() * 3);
    const heroes: Hero[] = Array.from({ length: size }, () => {
      const heroClass = CLASSES[Math.floor(random() * 5)];
      const level = 1 + Math.floor(random() * 99);
      return { heroClass, tier: Math.floor(random() * 9), level, stars: Math.floor(random() * 21), items: gearSet(heroClass, RARITIES[Math.floor(random() * 9)], level, Math.floor(random() * 21), random, Math.floor(random() * 9)) };
    });
    const ledger = heroes.flatMap((hero, h) => hero.items.map((item, index) => ({ id: `h${h}i${index}`, rarity: item.rarity, enchant_level: item.enchant, enchant_stats_version: 4,
      stats: item.lines.map((line) => ({ key: line.key, value: lineValue('v5', line, item.rarity, item.level), isPercent: !MAIN.has(line.key) })) })));
    const owned = heroes.map((hero, h) => ({ uid: `h${h}`, heroId: `${hero.heroClass}-${RARITIES[hero.tier]}`, level: hero.level, stars: hero.stars, xp: 0,
      equipped: Object.fromEntries(hero.items.map((_, index) => [SLOTS[index], `h${h}i${index}`])) }));
    const seed = 1000 + sample * 7919;
    const server = buildNormalCombat({ team: owned.map((hero) => hero.uid), ownedHeroes: owned, gold: 0 }, ledger, location, seed, null, 0, COMBAT_EFFECTS_V2_VERSION);
    const mine = fight('v5', heroes, location, seed, v5EnemyBase(location));
    if (server.outcome.all_cleared !== mine.win || server.outcome.elapsed_ms !== mine.ms) {
      mismatches += 1;
      if (mismatches <= 3) console.error('combat mismatch', { location, size, server: [server.outcome.all_cleared, server.outcome.elapsed_ms], mine });
    }
  }
  return mismatches;
}

// ── location pacing ───────────────────────────────────────────────────────
const ENDGAME_XP = [9, 10, 11, 11, 12, 13, 13, 14, 15, 15];
export const xpPerLane = (location: number) => location > 10 ? ENDGAME_XP[location - 11] : Math.max(1, Math.round((4 + location * 1.2) * .55));
// Formation sampler in the style of scripts/calibrate-recommended-power.ts: one account-wide strength
// with small per-hero variation, centred on the location's level band.
function sampleFormation(location: number, size: number, bands: [number, number][], random: () => number): Hero[] {
  const integer = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const [low, high] = bands[location - 1];
  const endgame = location > 10;
  const teamTier = integer(endgame ? 3 : 0, 8);
  const teamSlots = integer(endgame ? 4 : 0, 8);
  const teamEnchant = integer(0, endgame ? 20 : 15);
  const teamStars = integer(0, Math.min(20, location * 2));
  return Array.from({ length: size }, () => {
    const heroClass = CLASSES[integer(0, 4)];
    const tier = clamp(teamTier + integer(-1, 1), 0, 8);
    const level = clamp(integer(low - 3, high), 1, 99);
    const gearTier = clamp(tier + integer(-2, 1), 0, 8);
    return { heroClass, tier, level, stars: clamp(teamStars + integer(-2, 2), 0, 20),
      items: gearSet(heroClass, RARITIES[gearTier], clamp(level + integer(-6, 0), 1, 99), clamp(teamEnchant + integer(-2, 2), 0, 20), random, clamp(teamSlots + integer(-1, 1), 0, 8)) };
  });
}
const teamPowerOf = (model: Model, heroes: Hero[]) => heroes.reduce((sum, hero) => sum + heroPower(model, hero), 0);
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN; };
// v5 baseline: win rate and winning clear time of formations within 0.9-1.1x of the shown recommendation.
function v5Baseline(samplesPerLocation: number) {
  const rows: (string | number)[][] = [['location', 'levels', 'shown_3hero_per_lane', 'samples_in_band', 'win_rate', 'median_win_clear_s', 'xp_per_lane']];
  const random = rng(0xba5e);
  const clears: number[] = [];
  for (let location = 1; location <= 20; location += 1) {
    const shown = RECOMMENDED_POWER_PER_LANE[location - 1][2];
    let inBand = 0; let wins = 0; const times: number[] = [];
    for (let sample = 0; sample < samplesPerLocation; sample += 1) {
      const heroes = sampleFormation(location, 3, LOCATION_RANGES as [number, number][], random);
      const perLane = teamPowerOf('v5', heroes) / 3;
      if (perLane < .85 * shown || perLane > 1.15 * shown) continue;
      inBand += 1;
      const result = fight('v5', heroes, location, 5000 + sample * 7919 + location, v5EnemyBase(location));
      if (result.win) { wins += 1; times.push(result.ms / 1000); }
    }
    clears.push(median(times));
    rows.push([location, LOCATION_RANGES[location - 1].join('-'), shown, inBand, inBand ? pct(wins / inBand) : '-', median(times).toFixed(1), xpPerLane(location)]);
  }
  return { rows, clears };
}
// Combat hours per location band: Account XP from three lanes per wave at the given clear time
// plus the 1.25 s server/visible handoff. Offline accrual obeys the same rate (8-hour boundary).
export function pacing(bands: [number, number][], clearSeconds: number[]) {
  const rows: (string | number)[][] = [['location', 'levels', 'xp_per_lane', 'wave_seconds', 'account_xp_per_hour', 'account_xp_in_band', 'combat_hours_in_band', 'cumulative_hours']];
  let cumulative = 0;
  for (let location = 1; location <= 20; location += 1) {
    const [low, high] = bands[location - 1];
    const nextStart = location < 20 ? bands[location][0] : 99;
    let xp = 0;
    for (let level = low; level < nextStart; level += 1) xp += accountXpForLevel(level);
    const wave = clearSeconds[location - 1] + 1.25;
    const perHour = 3 * xpPerLane(location) * 3600 / wave;
    const hours = xp / perHour;
    cumulative += hours;
    rows.push([location, `${low}-${high}`, xpPerLane(location), wave.toFixed(1), Math.round(perHour), xp, hours.toFixed(1), cumulative.toFixed(1)]);
  }
  return rows;
}

// ── v6 reference builds and enemies ───────────────────────────────────────
const LOC = CONFIG.locations;
export const V6_BANDS: [number, number][] = LOC.rows.map((row: { levels: [number, number] }) => row.levels);
// Reference build at a location's entry level. `upgradedSlots` of the eight carry the next gear rarity,
// so gear improves a few pieces at a time instead of in whole-set jumps.
type Reference = { heroTier: number; stars: number; gearTier: number; gearSlots: number; upgradedSlots?: number; enchant: number };
export function referenceHero(location: number, heroClass: HeroClass, random: () => number, levelOffset = 0): Hero {
  const ref: Reference = LOC.rows[location - 1].reference;
  const level = clamp(V6_BANDS[location - 1][0] + levelOffset, 1, 99);
  const items = SLOTS.slice(0, ref.gearSlots).map((slot, index) => {
    const rarity = RARITIES[Math.min(8, ref.gearTier + (index < (ref.upgradedSlots ?? 0) ? 1 : 0))];
    return { slot, rarity, level, enchant: ref.enchant, lines: rollItemLines(heroClass, slot, rarity, random) };
  });
  return { heroClass, tier: ref.heroTier, level, stars: ref.stars, items };
}
function referenceTeam(location: number, random: () => number, size = 3, levelOffset = 0): Hero[] {
  return Array.from({ length: size }, () => referenceHero(location, CLASSES[Math.floor(random() * 5)], random, levelOffset));
}
// Class-average reference stats and Power over seeded random rolls: the enemy template.
const referenceCache = new Map<number, { hp: number; atk: number; def: number; dps: number; power: number }>();
function expectedDps(hero: Hero) {
  const s = heroStats('v6', hero);
  const interval = Math.max(600, (1540 - Math.min(Math.round(s.speed) * 2.2, 700)) / (1 + s.atkSpeed));
  return s.atk * (1000 / interval) * (1 + s.critChance * (s.critDamage - 1)) * (hero.heroClass === 'shepherd' ? 1.1 : 1);
}
export function referenceStats(location: number) {
  const cached = referenceCache.get(location);
  if (cached) return cached;
  const random = rng(0x7e4 + location);
  const heroes = Array.from({ length: 1000 }, (_, index) => referenceHero(location, CLASSES[index % 5], random));
  const stats = heroes.map((hero) => heroStats('v6', hero));
  const result = { hp: avg(stats.map((s) => s.hp)), atk: avg(stats.map((s) => s.atk)), def: avg(stats.map((s) => s.def)), dps: avg(heroes.map(expectedDps)), power: avg(heroes.map((hero) => heroPower('v6', hero))) };
  referenceCache.set(location, result);
  return result;
}
// Smooth per-lane target Power: Location 1's reference, then a fixed ratio per location.
export const targetPower = (location: number) => referenceStats(1).power
  * LOC.targetCurve.ratioThroughLocation13 ** (Math.min(location, 13) - 1) * LOC.targetCurve.ratioAfterLocation13 ** Math.max(0, location - 13);
// Enemy HP sets the fight length (seconds of reference DPS), Defense is a share of reference Attack,
// and Attack (k × reference HP) is solved per location for the target win rate.
export const enemyFromK = (location: number, k: number): EnemyBase => {
  const ref = referenceStats(location);
  return { hp: LOC.enemyShape.hpSecondsOfReferenceDps * ref.dps, atk: k * ref.hp, def: LOC.enemyShape.defPerReferenceAttack * ref.atk };
};
// Combat is scale-invariant, so enemies solved against the discrete reference build are rescaled by
// target/reference Power to follow the smooth curve instead of the build's rarity steps.
const smoothEnemy = (location: number, k: number): EnemyBase => {
  const scale = targetPower(location) / referenceStats(location).power;
  const base = enemyFromK(location, k);
  return { hp: base.hp * scale, atk: base.atk * scale, def: base.def * scale };
};
export function winRate(location: number, base: EnemyBase, samples: number, seed: number, size = 3, levelOffset = 0, heroScale = 1) {
  const random = rng(seed);
  let wins = 0; const times: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const result = fight('v6', referenceTeam(location, random, size, levelOffset), location, seed + sample * 7919, base, heroScale);
    if (result.win) { wins += 1; times.push(result.ms / 1000); }
  }
  return { rate: wins / samples, clear: median(times) };
}
// Largest enemy scale k at which the reference team still wins the target share of waves.
export function solveK(location: number, samples: number, seed = 0x10c) {
  let low = .002; let high = 2;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const mid = Math.sqrt(low * high);
    if (winRate(location, enemyFromK(location, mid), samples, seed + location * 101).rate >= LOC.targetWinRate) low = mid; else high = mid;
  }
  return Math.sqrt(low * high);
}
const sig3 = (value: number) => Number(value.toPrecision(3));
const LOC_FROM = Number(process.env.LOC_FROM ?? 1);
const LOC_TO = Number(process.env.LOC_TO ?? 20);
// A refinement pass solves again on a second seed and pools it with the stored first pass,
// weighted by sample count, so one unlucky seed cannot set a location's difficulty.
function calibrateEnemies(samples: number, refine = false) {
  return Array.from({ length: LOC_TO - LOC_FROM + 1 }, (_, index) => {
    const location = LOC_FROM + index;
    const row = LOC.rows[location - 1];
    const k = refine
      ? Math.exp((row.calibrationSamples * Math.log(row.calibratedAttackPerReferenceHp) + samples * Math.log(solveK(location, samples, 0x2f00d))) / (row.calibrationSamples + samples))
      : solveK(location, samples);
    const base = smoothEnemy(location, k);
    const enemy = { hp: sig3(base.hp), atk: sig3(base.atk), def: sig3(base.def) };
    console.error(`L${location} k=${k.toFixed(3)} enemy=${JSON.stringify(enemy)}`);
    return { location, k: Number(k.toFixed(4)), samples: refine ? row.calibrationSamples + samples : samples, enemy };
  });
}

// ── v6 location verification (uses the published enemy table in the config) ──
const v6Enemy = (location: number): EnemyBase => LOC.rows[location - 1].enemy;
function isotonicCrossing(points: { x: number; y: number }[], target: number): number {
  const sorted = [...points].sort((left, right) => left.x - right.x);
  const blocks: { sum: number; count: number; xSum: number }[] = [];
  for (const point of sorted) {
    blocks.push({ sum: point.y, count: 1, xSum: point.x });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]; const previous = blocks[blocks.length - 2];
      if (previous.sum / previous.count <= last.sum / last.count) break;
      blocks.splice(blocks.length - 2, 2, { sum: previous.sum + last.sum, count: previous.count + last.count, xSum: previous.xSum + last.xSum });
    }
  }
  const fitted = blocks.map((block) => ({ x: block.xSum / block.count, p: block.sum / block.count }));
  const index = fitted.findIndex((block) => block.p >= target);
  if (index < 0) return Number.NaN;
  if (index === 0) return fitted[0].x;
  const low = fitted[index - 1]; const high = fitted[index];
  return low.x + (high.x - low.x) * (target - low.p) / (high.p - low.p);
}
// Independent seeds from the calibration: reference win rate at band entry for 1/2/3 heroes,
// at band exit (+4 levels, same build) and a formation-sampled 72% Recommended Power per lane.
function verifyLocations(samples: number, recommendedSamples: number) {
  const rows: (string | number)[][] = [['location', 'levels', 'reference_build', 'target_power_per_lane', 'reference_power_per_lane', 'enemy_hp', 'enemy_atk', 'enemy_def',
    'win_ref_1hero', 'win_ref_2hero', 'win_ref_3hero', 'win_3hero_at_target_power', 'win_ref_3hero_band_exit', 'median_clear_s', 'recommended_1', 'recommended_2', 'recommended_3', 'v5_recommended_3']];
  const clears: number[] = [];
  for (let location = LOC_FROM; location <= LOC_TO; location += 1) {
    const base = v6Enemy(location);
    const ref: Reference = LOC.rows[location - 1].reference;
    const results = [1, 2, 3].map((size) => winRate(location, base, samples, 0xfeed + location * 13 + size, size));
    const exit = winRate(location, base, samples, 0xe417 + location, 3, V6_BANDS[location - 1][1] - V6_BANDS[location - 1][0]);
    const atTarget = winRate(location, base, samples, 0xfeed + location * 13 + 3, 3, 0, targetPower(location) / referenceStats(location).power);
    clears.push(results[2].clear);
    const random = rng(0x4ec0 + location);
    const recommended = [1, 2, 3].map((size) => {
      const points: { x: number; y: number }[] = [];
      for (let sample = 0; sample < recommendedSamples; sample += 1) {
        const heroes = sampleFormation(location, size, V6_BANDS, random);
        points.push({ x: teamPowerOf('v6', heroes) / size, y: fight('v6', heroes, location, 0x77 + sample * 7919 + location, base).win ? 1 : 0 });
      }
      return Math.round(isotonicCrossing(points, LOC.targetWinRate));
    });
    const build = `L${V6_BANDS[location - 1][0]} ${RARITY_LABEL[ref.heroTier]} ${ref.stars}★ / ${RARITY_LABEL[ref.gearTier]} gear${ref.upgradedSlots ? ` (${ref.upgradedSlots} ${RARITY_LABEL[Math.min(8, ref.gearTier + 1)]})` : ''} x${ref.gearSlots} +${ref.enchant}`;
    rows.push([location, V6_BANDS[location - 1].join('-'), build, Math.round(targetPower(location)), Math.round(referenceStats(location).power), base.hp, base.atk, base.def,
      pct(results[0].rate), pct(results[1].rate), pct(results[2].rate), pct(atTarget.rate), pct(exit.rate), results[2].clear.toFixed(1), ...recommended, RECOMMENDED_POWER_PER_LANE[location - 1][2]]);
    console.error(`verified L${location}`);
  }
  return { rows, clears };
}

// v6 item base stat (+0) by rarity and Item Level, next to a midpoint v5 random Attack/HP line.
function itemLineTable() {
  const rows: (string | number)[][] = [['rarity', 'item_level', 'v6_base_attack_weapon', 'v6_base_hp_helmet', 'v6_base_chest_hp', 'v6_base_chest_def', 'v5_midpoint_atk_line', 'v5_midpoint_hp_line']];
  for (const rarity of RARITIES) for (const level of [1, 25, 50, 80, 99]) {
    const chest = implicitStats('chest', rarity, level);
    rows.push([RARITY_LABEL[RARITIES.indexOf(rarity)], level, Math.round(implicitStats('class_weapon', rarity, level).atk!), Math.round(implicitStats('helmet', rarity, level).hp!),
      Math.round(chest.hp!), Math.round(chest.def!), lineValue('v5', { key: 'atk', u: .5 }, rarity, level).toFixed(1), lineValue('v5', { key: 'hp', u: .5 }, rarity, level).toFixed(0)]);
  }
  return rows;
}

// Where typical accounts land on the v6 target curve (highest Location whose per-lane target they meet).
function buildEvaluation() {
  const builds: [string, number, number, number, number, number][] = [
    ['L30 Rare 2★ / Uncommon gear +3', 2, 30, 2, 1, 3],
    ['L60 Epic 3★ / Rare gear +5', 3, 60, 3, 2, 5],
    ['L96 Epic 3★ / Epic gear +5 (free-to-play)', 3, 96, 3, 3, 5],
    ['L96 Legendary 5★ / Legendary gear +7', 4, 96, 5, 4, 7],
    ['L96 Mythic 12★ / Mythic gear +11 (reference)', 5, 96, 12, 5, 11],
    ['L99 Mythic 20★ / Mythic gear +20', 5, 99, 20, 5, 20],
    ['L99 Celestial 20★ / Celestial gear +20 (maximum)', 8, 99, 20, 8, 20],
  ];
  const rows: (string | number)[][] = [['build', 'power_per_hero', 'highest_location_at_target', 'power_vs_that_target', 'power_vs_location_20']];
  for (const [label, tier, level, stars, gear, enchant] of builds) {
    const random = rng(0xe7a1 + tier * 97 + level);
    const power = avg(Array.from({ length: 1000 }, (_, index) => {
      const heroClass = CLASSES[index % 5];
      return heroPower('v6', { heroClass, tier, level, stars, items: gearSet(heroClass, RARITIES[gear], level, enchant, random) });
    }));
    let location = 0;
    for (let candidate = 1; candidate <= 20; candidate += 1) if (targetPower(candidate) <= power) location = candidate;
    rows.push([label, Math.round(power), location || '-', location ? (power / targetPower(location)).toFixed(2) : '-', (power / targetPower(20)).toFixed(2)]);
  }
  return rows;
}

// Founder-approved v6 targets (TODO HL-TASK-20260929004344-AD72C4) with explicit tolerances.
const num = (value: string | number) => Number(String(value).replace('%', '')) / (String(value).endsWith('%') ? 100 : 1);
function checkTargets(tables: Record<string, (string | number)[][]>): string[] {
  const failures: string[] = [];
  const within = (label: string, value: number, low: number, high: number) => { if (!(value >= low && value <= high)) failures.push(`${label}: ${value.toFixed(4)} outside ${low}-${high}`); };
  for (const row of tables['hero-marginal-gains'].slice(1)) {
    const [action, , , v6] = row as string[];
    if (action.startsWith('Hero Level') && action.includes('average')) within(action, num(v6), .018, .026);
    else if (action.startsWith('Hero Level')) within(action, num(v6), .018, .03);
    else if (/^Star \d+->\d+$/.test(action) && !action.startsWith('Star 0->1') && !action.includes('->10') && !action.includes('->20')) within(action, num(v6), .06, .08);
    else if (action === 'Star 0->1' || action === 'Star 9->10' || action === 'Star 19->20') within(action, num(v6), .06, .08);
    else if (action.startsWith('Rarity')) within(action, num(v6), .30, .52);
  }
  for (const row of tables['item-gains'].slice(1)) within(`one ${row[0]} item`, num(row[2]), .09, .16);
  for (const row of tables['enchant-step-gains'].slice(1)) within(`Enchant ${row[0]} vs bare`, num(row[2]), .013, .022);
  // Hero Power must rise with every level, Star and rarity in the published table.
  const bareRows = tables['hero-power-bare'].slice(1);
  for (let index = 1; index < bareRows.length; index += 1) {
    const [rarity, stars, level, , v6] = bareRows[index];
    const [prevRarity, prevStars, , , prevV6] = bareRows[index - 1];
    if (rarity === prevRarity && stars === prevStars && !(Number(v6) > Number(prevV6))) failures.push(`hero power not rising at ${rarity} ${stars}★ L${level}`);
  }
  return failures;
}

// Measured per-lane recommendations are noisy location to location, so the displayed value is the smooth
// target curve times one formation factor per team size: the geometric mean of measured/target.
function smoothedRecommended(rows: (string | number)[][]) {
  const header = rows[0] as string[];
  const column = (name: string) => header.indexOf(name);
  const body = rows.slice(1);
  const factors = [1, 2, 3].map((size) => Math.exp(avg(body.map((row) => Math.log(Number(row[column(`recommended_${size}`)]) / Number(row[column('target_power_per_lane')]))))));
  const out: (string | number)[][] = [['location', 'target_per_lane', ...[1, 2, 3].map((size) => `displayed_per_lane_${size}hero (x${factors[size - 1].toFixed(2)})`), 'displayed_team_3hero', ...[1, 2, 3].map((size) => `measured_per_lane_${size}hero`), 'v5_displayed_per_lane_3hero']];
  for (const row of body) {
    const target = Number(row[column('target_power_per_lane')]);
    const shown = factors.map((factor) => sig3(target * factor));
    out.push([row[0], Math.round(target), ...shown, sig3(shown[2] * 3), ...[1, 2, 3].map((size) => row[column(`recommended_${size}`)]), row[column('v5_recommended_3')]]);
  }
  return out;
}

function printTable(title: string, rows: (string | number)[][]) {
  console.log(`\n## ${title}`);
  for (const row of rows) console.log(row.join(' | '));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mismatches = parityCheck(CHECK ? 3000 : 600);
  console.log(`v5 parity with server heroUnit: ${mismatches} mismatches`);
  const combatMismatches = combatParity(CHECK ? 600 : 150);
  console.log(`v5 parity with server normal combat: ${combatMismatches} mismatches`);
  if (mismatches || combatMismatches) process.exit(1);
  if (process.argv.includes('--v5-baseline')) {
    const base = v5Baseline(Number(process.argv[process.argv.indexOf('--v5-baseline') + 1]) || 400);
    printTable('v5 baseline', base.rows);
    printTable('v5 pacing', pacing(LOCATION_RANGES as [number, number][], base.clears));
    process.exit(0);
  }
  if (process.argv.includes('--calibrate-enemies')) {
    console.log(JSON.stringify(calibrateEnemies(Number(process.argv[process.argv.indexOf('--calibrate-enemies') + 1]) || 200, process.argv.includes('--refine'))));
    process.exit(0);
  }
  if (process.argv.includes('--calibrate-items')) {
    console.log(JSON.stringify(calibrateItemScales()));
    process.exit(0);
  }
  mkdirSync(OUT, { recursive: true });
  // Location verification is slow, so it can run as LOC_FROM/LOC_TO parts that --merge-locations joins.
  if (process.argv.includes('--locations')) {
    const verified = verifyLocations(CHECK ? 400 : 300, CHECK ? 800 : 500);
    writeFileSync(new URL(`locations-part-${String(LOC_FROM).padStart(2, '0')}.json`, OUT), JSON.stringify(verified));
    process.exit(0);
  }
  if (process.argv.includes('--merge-locations')) {
    const parts = readdirSync(OUT).filter((name) => /^locations-part-\d+\.json$/.test(name)).sort()
      .map((name) => JSON.parse(readFileSync(new URL(name, OUT), 'utf8')) as { rows: (string | number)[][]; clears: number[] });
    // Without parts, rebuild the derived tables from the stored locations.csv (median clear is a column).
    const stored = parts.length ? null : readFileSync(new URL('locations.csv', OUT), 'utf8').trim().split('\n').map((line) => line.split(','));
    const rows = stored ?? [parts[0].rows[0], ...parts.flatMap((part) => part.rows.slice(1))];
    const clears = stored ? stored.slice(1).map((row) => Number(row[stored[0].indexOf('median_clear_s')])) : parts.flatMap((part) => part.clears);
    if (rows.length !== 21 || clears.length !== 20) throw new Error(`incomplete location parts: ${rows.length - 1} rows`);
    writeFileSync(new URL('locations.csv', OUT), csv(rows));
    writeFileSync(new URL('location-pacing.csv', OUT), csv(pacing(V6_BANDS, clears)));
    writeFileSync(new URL('recommended-power.csv', OUT), csv(smoothedRecommended(rows)));
    for (const name of readdirSync(OUT).filter((name) => name.startsWith('locations-part-'))) rmSync(new URL(name, OUT));
    printTable('locations', rows);
    printTable('location pacing', pacing(V6_BANDS, clears));
    printTable('recommended power', smoothedRecommended(rows));
    process.exit(0);
  }
  const tables: Record<string, (string | number)[][]> = {
    'hero-power-bare': heroTables(),
    'hero-marginal-gains': marginalTables(),
    'item-gains': itemTables(),
    'item-level-share': itemLevelTable(),
    'enchant-step-gains': enchantTables(),
    'item-line-values': itemLineTable(),
    'build-evaluation': buildEvaluation(),
  };
  const digest = createHash('sha256');
  for (const [name, rows] of Object.entries(tables)) {
    writeFileSync(new URL(`${name}.csv`, OUT), csv(rows));
    digest.update(csv(rows));
    if (name !== 'hero-power-bare' && !CHECK) printTable(name, rows);
  }
  console.log(`tables sha256 ${digest.digest('hex')}`);
  if (CHECK) {
    const failures = checkTargets(tables);
    for (const failure of failures) console.error(`FAIL ${failure}`);
    console.log(failures.length ? `balance v6 targets: ${failures.length} failures` : 'balance v6 targets: PASS');
    if (failures.length) process.exit(1);
  }
}
