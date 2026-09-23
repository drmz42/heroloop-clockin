#!/usr/bin/env node
// Item-roll v5 runtime generator.
//
// Compiles one deterministic checksum-bound item-roll v5 contract from existing
// approved source configs and emits:
//   - src/game/item-roll-runtime.generated.ts            (future client routing)
//   - selfhosted/postgres/migrations/20260908130000_item_roll_v5_primitives.sql (immutable applied migration)
//
// Sources (no new balance values):
//   - config/balance/hero-power-model.v1.json  Option-A base rolls / curves / rarities / pools
//   - config/balance/balance-v4.v1.json        slotPoolAdditions + set-bonus data
//   - config/economy/enchant-v4.v1.json        existing +1..+20 Enchant tiers
//
// CLI:
//   node scripts/generate-item-roll-runtime.mjs            write the current TS artifact
//   node scripts/generate-item-roll-runtime.mjs --check    verify committed bytes, write nothing

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIG_PATHS = {
  model: resolve(REPO_ROOT, 'config/balance/hero-power-model.v1.json'),
  balanceV4: resolve(REPO_ROOT, 'config/balance/balance-v4.v1.json'),
  enchantV4: resolve(REPO_ROOT, 'config/economy/enchant-v4.v1.json'),
};

export const GENERATED_TS_PATH = resolve(REPO_ROOT, 'src/game/item-roll-runtime.generated.ts');
export const GENERATED_SQL_PATH = resolve(
  REPO_ROOT,
  'selfhosted/postgres/migrations/20260908130000_item_roll_v5_primitives.sql',
);
export const IMMUTABLE_SQL_SHA256 = '1ad2ddeafd0f8f644c519365f5e7fc39f9134c6740d9d5475760e45e4c014098';
export const IMMUTABLE_SQL_RUNTIME_STAMP = 'item-roll-v5@sha256:67048e250cf561ae658c8103e08be49285d160e0eb190897088753f5ea4d150c';

const RARITY_IDS = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic',
  'cosmic', 'divine', 'celestial', 'cursed', 'immortal', 'god',
];

const EXPECTED_RARITY_LINES = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6];

const STAT_CURVES = {
  hp: 'main', atk: 'main', def: 'main',
  attackSpeed: 'slow', critChance: 'slow', critDamage: 'slow', dodge: 'slow',
  goldBonus: 'economy', xpBonus: 'economy',
};

function invariant(condition, message) {
  if (!condition) throw new Error(`item-roll v5 contract invalid: ${message}`);
}

export function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

function readJsonConfig(path) {
  invariant(existsSync(path), `missing config ${path}`);
  const source = readFileSync(path, 'utf8');
  return { source, checksum: sha256(source), json: JSON.parse(source) };
}

function withAdditions(pool, additions) {
  const result = [...pool];
  for (const stat of additions || []) {
    if (!result.includes(stat)) result.push(stat);
  }
  return result;
}

function normalizeStatKey(key) {
  return key === 'attackSpeed' ? 'atkSpeed' : key;
}

function normalizePool(pool) {
  return pool.map(normalizeStatKey);
}

export function buildItemRollV5Contract(inputs = {}) {
  const modelSource = inputs.modelSource ?? readJsonConfig(CONFIG_PATHS.model).source;
  const balanceV4Source = inputs.balanceV4Source ?? readJsonConfig(CONFIG_PATHS.balanceV4).source;
  const enchantV4Source = inputs.enchantV4Source ?? readJsonConfig(CONFIG_PATHS.enchantV4).source;

  const model = JSON.parse(modelSource);
  const balanceV4 = JSON.parse(balanceV4Source);
  const enchantV4 = JSON.parse(enchantV4Source);

  const equipment = model.equipment;
  invariant(model.schemaVersion === 1, 'hero-power-model schemaVersion must be 1');
  invariant(Array.isArray(equipment?.rarities) && equipment.rarities.length === 12, 'equipment must carry 12 rarities');
  invariant(equipment?.rolls && equipment?.slotPools && equipment?.classBuilds && equipment?.levelScaling,
    'equipment model must carry rolls/slotPools/classBuilds/levelScaling');
  invariant(balanceV4?.itemOverrides, 'balance-v4 must carry itemOverrides');
  invariant(enchantV4?.statCurve, 'enchant-v4 must carry statCurve');

  const additions = balanceV4.itemOverrides.slotPoolAdditions || {};
  const economySlots = balanceV4.itemOverrides.economyStatEligibleSlots || [];
  const distinctStatsPerItem = balanceV4.itemOverrides.distinctStatsPerItem === true;
  const setBonusByRarity = balanceV4.itemOverrides.matchingRaritySetBonusPercentByRarity || {};

  // ---- rarity table (Option-A equipment rarities + Balance-v4 set bonus) ----
  const rarities = equipment.rarities.map((rarity, index) => ({
    id: rarity.id,
    multiplier: rarity.multiplier,
    lines: rarity.lines,
    setBonusPercent: setBonusByRarity[rarity.id],
  }));
  invariant(rarities.map((entry) => entry.id).join(',') === RARITY_IDS.join(','), 'rarity ids changed');
  invariant(rarities.every((entry, index) => entry.lines === EXPECTED_RARITY_LINES[index]), 'rarity line counts changed');
  invariant(rarities.every((entry, index, values) => index === 0 || entry.multiplier > values[index - 1].multiplier),
    'rarity multipliers must increase');
  invariant(rarities.every((entry) => Number.isFinite(entry.setBonusPercent) && entry.setBonusPercent > 0),
    'every rarity needs a Balance-v4 set bonus percent');

  // ---- stat rolls (Option-A normalized base ranges, key = atkSpeed) ----
  const statRolls = {};
  for (const [statKey, roll] of Object.entries(equipment.rolls)) {
    const key = normalizeStatKey(statKey);
    invariant(STAT_CURVES[statKey] === roll.curve, `unexpected curve for ${statKey}`);
    invariant(roll.min > 0 && roll.max > roll.min && roll.max / roll.min <= 1.250001,
      `roll spread exceeds 1.25x for ${statKey}`);
    statRolls[key] = { curve: roll.curve, min: roll.min, max: roll.max };
  }
  invariant(Object.keys(statRolls).length === 9, 'expected 9 stat roll ranges');

  // ---- slot pools (Option-A pools + Balance-v4 four-slot Gold/XP additions) ----
  const slotPools = {};
  for (const [slot, pool] of Object.entries(equipment.slotPools)) {
    slotPools[slot] = withAdditions(normalizePool(pool), additions[slot] ? normalizePool(additions[slot]) : []);
  }
  const expectedSlots = ['class_weapon', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet'];
  invariant(Object.keys(slotPools).join(',') === expectedSlots.join(','), 'universal slot pools changed');

  const classOffhandPools = {};
  for (const [className, build] of Object.entries(equipment.classBuilds)) {
    classOffhandPools[className] = normalizePool(build.offhand);
  }
  const expectedClasses = ['assassin', 'crossbowman', 'druid', 'mage', 'warrior'];
  invariant(Object.keys(classOffhandPools).sort().join(',') === expectedClasses.join(','), 'class off-hand pools changed');

  // ---- contract invariants across pools ----
  const allPools = [...Object.values(slotPools), ...Object.values(classOffhandPools)];
  for (const pool of allPools) {
    invariant(pool.length > 0, 'empty slot pool');
    for (const stat of pool) invariant(statRolls[stat], `pool references unknown stat ${stat}`);
  }
  invariant(economySlots.join(',') === ['helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet'].join(','),
    'approved six Gold/XP slots changed');
  for (const slot of economySlots) {
    invariant(slotPools[slot].includes('goldBonus') && slotPools[slot].includes('xpBonus'),
      `${slot} must roll Gold and XP Bonus`);
  }
  for (const pool of [slotPools.class_weapon, ...Object.values(classOffhandPools)]) {
    invariant(!pool.includes('goldBonus') && !pool.includes('xpBonus'),
      'combat slots must not roll Gold/XP Bonus');
  }
  invariant(!slotPools.class_weapon.includes('def') && !slotPools.class_weapon.includes('dodge'),
    'class weapon must not roll DEF/Dodge');

  // ---- level scaling ----
  const levelScaling = {
    maxItemLevel: equipment.levelScaling.maxItemLevel,
    bandSize: equipment.levelScaling.bandSize,
    bandBonus: equipment.levelScaling.bandBonus,
    perLevel: { ...equipment.levelScaling.perLevel },
  };
  invariant(levelScaling.maxItemLevel === 99 && levelScaling.bandSize === 15 && levelScaling.bandBonus === 0.2,
    'level scaling contract changed');
  invariant(levelScaling.perLevel.main === 0.015 && levelScaling.perLevel.slow === 0.005
    && levelScaling.perLevel.economy === 0.005, 'per-level curve rates changed');

  // ---- Enchant (existing Balance-v4 +1..+20 tiers) ----
  const tiers = enchantV4.statCurve.tiers.map((tier) => ({
    from: tier.targets[0],
    to: tier.targets[1],
    bonusPerLevel: tier.bonusPerLevel,
  }));
  invariant(tiers.length === 4 && tiers[0].from === 1 && tiers.at(-1).to === 20, 'enchant tiers must cover 1..20');
  invariant(enchantV4.statCurve.maximumStatMultiplier === 4.5 && enchantV4.statCurve.compounding === false,
    'enchant max/compounding contract changed');
  invariant(enchantV4.maximumLevel === 20, 'enchant maximum level must be 20');
  let cumulativeBonus = 0;
  const derivedCumulative = {};
  for (const tier of tiers) {
    cumulativeBonus += (tier.to - tier.from + 1) * tier.bonusPerLevel;
    derivedCumulative[tier.to] = cumulativeBonus;
  }
  for (const [target, bonus] of Object.entries(enchantV4.statCurve.cumulativeBonusAtTargets)) {
    invariant(Math.abs(derivedCumulative[target] - bonus) < 1e-12,
      `cumulative enchant bonus at +${target} must match config`);
  }
  const enchant = {
    maximumLevel: enchantV4.maximumLevel,
    compounding: enchantV4.statCurve.compounding,
    maximumStatMultiplier: enchantV4.statCurve.maximumStatMultiplier,
    cumulativeBonusAtTargets: { ...enchantV4.statCurve.cumulativeBonusAtTargets },
    tiers,
  };

  const payload = {
    version: 'item-roll-v5',
    sources: {
      heroPowerModel: sha256(modelSource),
      balanceV4: sha256(balanceV4Source),
      enchantV4: sha256(enchantV4Source),
    },
    modelVersion: model.modelVersion,
    rarities,
    statRolls,
    slotPools,
    classOffhandPools,
    slotPoolAdditions: { ...additions },
    economyStatEligibleSlots: [...economySlots],
    distinctStatsPerItem,
    levelScaling,
    enchant,
  };

  const payloadJson = JSON.stringify(payload);
  const contractSha = sha256(payloadJson);
  return {
    ...payload,
    runtimeStamp: `item-roll-v5@sha256:${contractSha}`,
    contractSha,
  };
}

export function renderGeneratedTs(contract) {
  const contractJson = JSON.stringify(contract, null, 2);
  const lines = [
    '/**',
    ' * Item-roll v5 runtime contract — GENERATED FILE. Do not edit by hand.',
    ' * Regenerate: node scripts/generate-item-roll-runtime.mjs',
    ` * Runtime stamp: ${contract.runtimeStamp}`,
    ' * Sources:',
    ` *   config/balance/hero-power-model.v1.json sha256:${contract.sources.heroPowerModel}`,
    ` *   config/balance/balance-v4.v1.json sha256:${contract.sources.balanceV4}`,
    ` *   config/economy/enchant-v4.v1.json sha256:${contract.sources.enchantV4}`,
    ' *',
    ' * Option-A base rolls (founder-approved normalized equipment), six approved',
    ' * Gold/XP slots (helmet, chest, gloves, boots, ring, amulet) and the existing',
    ' * Balance-v4 Enchant curve through +20 (max 4.50x). Data + pure helpers for a',
    ' * future client routing step; no active callsite references this module yet and',
    ' * the server remains authoritative for every item roll.',
    ' */',
    'export const ITEM_ROLL_V5_RUNTIME_STAMP =',
    `  '${contract.runtimeStamp}' as const;`,
    '',
    'export const ITEM_ROLL_V5_CONTRACT_JSON = `',
    contractJson,
    '` as const;',
    '',
    'export type ItemRollV5StatKey =',
    "  'hp' | 'atk' | 'def' | 'atkSpeed' | 'critChance' | 'critDamage' | 'dodge' | 'goldBonus' | 'xpBonus';",
    '',
    'export type ItemRollV5Curve = \'main\' | \'slow\' | \'economy\';',
    '',
    'export interface ItemRollV5Rarity {',
    '  readonly id: string;',
    '  readonly multiplier: number;',
    '  readonly lines: number;',
    '  readonly setBonusPercent: number;',
    '}',
    '',
    'export interface ItemRollV5StatRollRange {',
    '  readonly curve: ItemRollV5Curve;',
    '  readonly min: number;',
    '  readonly max: number;',
    '}',
    '',
    'export interface ItemRollV5EnchantTier {',
    '  readonly from: number;',
    '  readonly to: number;',
    '  readonly bonusPerLevel: number;',
    '}',
    '',
    'export interface ItemRollV5StatRoll {',
    '  readonly key: ItemRollV5StatKey;',
    '  readonly value: number;',
    '  readonly isPercent: boolean;',
    '}',
    '',
    'export interface ItemRollV5Contract {',
    '  readonly version: string;',
    '  readonly runtimeStamp: string;',
    '  readonly sources: { readonly heroPowerModel: string; readonly balanceV4: string; readonly enchantV4: string };',
    '  readonly modelVersion: string;',
    '  readonly rarities: readonly ItemRollV5Rarity[];',
    '  readonly statRolls: Readonly<Record<string, ItemRollV5StatRollRange>>;',
    '  readonly slotPools: Readonly<Record<string, readonly string[]>>;',
    '  readonly classOffhandPools: Readonly<Record<string, readonly string[]>>;',
    '  readonly slotPoolAdditions: Readonly<Record<string, readonly string[]>>;',
    '  readonly economyStatEligibleSlots: readonly string[];',
    '  readonly distinctStatsPerItem: boolean;',
    '  readonly levelScaling: {',
    '    readonly maxItemLevel: number;',
    '    readonly bandSize: number;',
    '    readonly bandBonus: number;',
    '    readonly perLevel: Readonly<Record<ItemRollV5Curve, number>>;',
    '  };',
    '  readonly enchant: {',
    '    readonly maximumLevel: number;',
    '    readonly compounding: boolean;',
    '    readonly maximumStatMultiplier: number;',
    '    readonly cumulativeBonusAtTargets: Readonly<Record<string, number>>;',
    '    readonly tiers: readonly ItemRollV5EnchantTier[];',
    '  };',
    '  readonly contractSha: string;',
    '}',
    '',
    'export const ITEM_ROLL_V5_CONTRACT: ItemRollV5Contract =',
    '  JSON.parse(ITEM_ROLL_V5_CONTRACT_JSON) as ItemRollV5Contract;',
    '',
    '/** Multiplier applied to a stored base roll at a given Enchant level (+1..+20). */',
    'export function itemRollV5EnchantMultiplier(enchantLevel: number): number {',
    '  const level = Math.max(0, Math.min(ITEM_ROLL_V5_CONTRACT.enchant.maximumLevel, Math.floor(enchantLevel)));',
    '  let bonus = 0;',
    '  for (const tier of ITEM_ROLL_V5_CONTRACT.enchant.tiers) {',
    '    if (level >= tier.from) bonus += (Math.min(level, tier.to) - tier.from + 1) * tier.bonusPerLevel;',
    '  }',
    '  return 1 + bonus;',
    '}',
    '',
    '/** Monotonic Item Level band multiplier for one stat curve (Option-A 15-level bands). */',
    'export function itemRollV5ItemLevelMultiplier(itemLevel: number, curve: ItemRollV5Curve): number {',
    '  if (!Number.isInteger(itemLevel) || itemLevel < 1 || itemLevel > ITEM_ROLL_V5_CONTRACT.levelScaling.maxItemLevel) {',
    "    throw new Error('invalid_item_roll_v5');",
    '  }',
    '  const curveRate = ITEM_ROLL_V5_CONTRACT.levelScaling.perLevel[curve];',
    "  if (!Number.isFinite(curveRate)) throw new Error('invalid_item_roll_v5');",
    '  return 1',
    '    + curveRate * (itemLevel - 1)',
    '    + Math.floor((itemLevel - 1) / ITEM_ROLL_V5_CONTRACT.levelScaling.bandSize) * ITEM_ROLL_V5_CONTRACT.levelScaling.bandBonus;',
    '}',
    '',
    '/** Rarity factor: main stats scale linearly, cap-sensitive/economy use sqrt. */',
    'export function itemRollV5RarityFactor(rarityId: string, curve: ItemRollV5Curve): number {',
    '  const rarity = ITEM_ROLL_V5_CONTRACT.rarities.find((entry) => entry.id === rarityId);',
    "  if (!rarity) throw new Error('invalid_item_roll_v5');",
    '  return curve === \'main\' ? rarity.multiplier : Math.sqrt(rarity.multiplier);',
    '}',
    '',
    '/** Deterministic base roll value for one stat line (server model, base +0). */',
    'export function itemRollV5StatValue(',
    '  statKey: ItemRollV5StatKey,',
    '  rarityId: string,',
    '  itemLevel: number,',
    '  random01: number,',
    '): number {',
    '  const roll = ITEM_ROLL_V5_CONTRACT.statRolls[statKey];',
    "  if (!roll || !Number.isFinite(random01) || random01 < 0 || random01 >= 1) throw new Error('invalid_item_roll_v5');",
    '  const value = (roll.min + random01 * (roll.max - roll.min))',
    '    * itemRollV5RarityFactor(rarityId, roll.curve)',
    '    * itemRollV5ItemLevelMultiplier(itemLevel, roll.curve);',
    '  return Math.round(value * 1000000) / 1000000;',
    '}',
    '',
    '/**',
    ' * Roll one item with distinct stat lines (lines = min(rarity.lines, pool size)).',
    ' * random01(index) must return a deterministic value in [0,1) per line index.',
    ' * Display/testing helper mirroring roll_item_stats_v5; server stays authoritative.',
    ' */',
    'export function itemRollV5RollItem(',
    '  slot: string,',
    '  rarityId: string,',
    '  itemLevel: number,',
    '  baseItemId: string,',
    '  random01: (index: number) => number,',
    '): ItemRollV5StatRoll[] {',
    '  const rarity = ITEM_ROLL_V5_CONTRACT.rarities.find((entry) => entry.id === rarityId);',
    "  if (!rarity || !Number.isInteger(itemLevel) || itemLevel < 1 || itemLevel > ITEM_ROLL_V5_CONTRACT.levelScaling.maxItemLevel || !baseItemId) throw new Error('invalid_item_roll_v5');",
    '  const classFromId = baseItemId.split(\'-\')[1];',
    '  const pool = slot === \'offhand\'',
    '    ? (classFromId ? ITEM_ROLL_V5_CONTRACT.classOffhandPools[classFromId] : undefined)',
    '    : ITEM_ROLL_V5_CONTRACT.slotPools[slot];',
    "  if (!pool || pool.length === 0) throw new Error('invalid_item_roll_v5');",
    '  const lines = Math.min(rarity.lines, pool.length);',
    '  const remaining: string[] = [...pool];',
    '  const stats: ItemRollV5StatRoll[] = [];',
    '  for (let index = 0; index < lines; index += 1) {',
    '    const pick = random01(index);',
    "    if (!Number.isFinite(pick) || pick < 0 || pick >= 1) throw new Error('invalid_item_roll_v5');",
    '    const pickIndex = Math.floor(pick * remaining.length);',
    '    const statKey = remaining[pickIndex] as ItemRollV5StatKey;',
    '    remaining.splice(pickIndex, 1);',
    '    const value = itemRollV5StatValue(statKey, rarity.id, itemLevel, random01(index + 1000));',
    '    stats.push({ key: statKey, value, isPercent: statKey !== \'hp\' && statKey !== \'atk\' && statKey !== \'def\' });',
    '  }',
    '  return stats;',
    '}',
    '',
    '/** Mirror of calculate_item_power_v5 using the approved power weights. */',
    'export function itemRollV5Power(stats: readonly ItemRollV5StatRoll[], enchantLevel: number): number {',
    '  const weights: Record<string, number> = {',
    '    atk: 4, critChance: 200, critDamage: 100, atkSpeed: 0.5,',
    '    hp: 0.15, def: 2, goldBonus: 150, xpBonus: 100, dodge: 150,',
    '  };',
    '  const base = stats.reduce((sum, stat) => sum + stat.value * (weights[stat.key] ?? 1), 0);',
    '  return Math.round(base * itemRollV5EnchantMultiplier(enchantLevel));',
    '}',
  ];
  return `${lines.join('\n')}\n`;
}

function sqlNumber(value) {
  return String(Number(value.toFixed(12)));
}

function sqlRarityCase(contract) {
  const linesSql = contract.rarities.map((entry) => `WHEN '${entry.id}' THEN ${entry.lines}`).join(' ');
  const multSql = contract.rarities.map((entry) => `WHEN '${entry.id}' THEN ${sqlNumber(entry.multiplier)}`).join(' ');
  return { linesSql, multSql };
}

function sqlSlotPoolCase(contract) {
  const cases = [];
  for (const [slot, pool] of Object.entries(contract.slotPools)) {
    cases.push(`WHEN '${slot}' THEN ARRAY[${pool.map((stat) => `'${stat}'`).join(',')}]`);
  }
  const offhandClassCases = [];
  for (const [className, pool] of Object.entries(contract.classOffhandPools)) {
    offhandClassCases.push(`WHEN '${className}' THEN ARRAY[${pool.map((stat) => `'${stat}'`).join(',')}]`);
  }
  return { cases, offhandClassCases };
}

function sqlStatRangeValues(contract) {
  return Object.entries(contract.statRolls).map(([stat, roll]) =>
    `      ('${stat}', ${sqlNumber(roll.min)}::numeric, ${sqlNumber(roll.max)}::numeric, '${roll.curve}')`).join(',\n');
}

export function renderMigrationSql(contract) {
  const { linesSql, multSql } = sqlRarityCase(contract);
  const { cases, offhandClassCases } = sqlSlotPoolCase(contract);
  const statValues = sqlStatRangeValues(contract);
  const tiers = contract.enchant.tiers;
  const enchantTerms = tiers.map((tier, index) =>
    `${index === 0 ? '  SELECT 1\n' : ''}    + GREATEST(0, LEAST(${tier.to}, p_enchant) - ${tier.from - 1}) * ${sqlNumber(tier.bonusPerLevel)}`).join('\n');

  return [
    '-- Item-roll v5 primitives — GENERATED FILE. Do not edit by hand.',
    '-- Regenerate: node scripts/generate-item-roll-runtime.mjs',
    `-- Runtime stamp: ${contract.runtimeStamp}`,
    '-- Sources:',
    `--   config/balance/hero-power-model.v1.json sha256:${contract.sources.heroPowerModel}`,
    `--   config/balance/balance-v4.v1.json sha256:${contract.sources.balanceV4}`,
    `--   config/economy/enchant-v4.v1.json sha256:${contract.sources.enchantV4}`,
    '--',
    '-- Option-A base rolls (founder-approved normalized equipment), six approved',
    '-- Gold/XP slots (helmet, chest, gloves, boots, ring, amulet) and the existing',
    '-- Balance-v4 Enchant curve through +20 (max 4.50x).',
    '-- ADDITIVE ONLY: defines primitives and patches/calls no chest, store, reroll or',
    '-- enchant flow. Existing v2/v3/v4 items and their versions remain untouched.',
    '',
    'CREATE OR REPLACE FUNCTION public.item_roll_v5_enchant_multiplier(p_enchant integer)',
    'RETURNS numeric',
    'LANGUAGE sql',
    'IMMUTABLE',
    'STRICT',
    'SET search_path = public',
    'AS $$',
    enchantTerms,
    '$$;',
    '',
    'CREATE OR REPLACE FUNCTION public.roll_item_stats_v5(',
    '  p_slot text,',
    '  p_rarity text,',
    '  p_item_level integer,',
    '  p_base_item_id text',
    ')',
    'RETURNS jsonb',
    'LANGUAGE plpgsql',
    'VOLATILE',
    'SET search_path = public',
    'AS $$',
    'DECLARE',
    '  v_lines integer;',
    '  v_rarity_mult numeric;',
    '  v_pool text[];',
    '  v_class text;',
    '  v_key text;',
    '  v_choice integer;',
    '  v_curve text;',
    '  v_min numeric;',
    '  v_max numeric;',
    '  v_rarity_factor numeric;',
    '  v_level_mult numeric;',
    '  v_value numeric;',
    '  v_percent boolean;',
    '  v_stats jsonb := \'[]\'::jsonb;',
    '  v_remaining integer;',
    '  i integer;',
    'BEGIN',
    `  v_lines := CASE p_rarity ${linesSql} ELSE NULL END;`,
    `  v_rarity_mult := CASE p_rarity ${multSql} ELSE NULL END;`,
    '  IF p_slot IS NULL OR p_rarity IS NULL OR p_item_level IS NULL OR p_base_item_id IS NULL',
    '     OR v_lines IS NULL OR v_rarity_mult IS NULL OR p_item_level NOT BETWEEN 1 AND 99 THEN',
    "    RAISE EXCEPTION 'invalid_item_roll_v5';",
    '  END IF;',
    "  v_class := split_part(p_base_item_id, '-', 2);",
    '  v_pool := CASE p_slot',
    ...cases.map((entry) => `    ${entry}`),
    "    WHEN 'offhand' THEN CASE v_class",
    ...offhandClassCases.map((entry) => `      ${entry}`),
    '      ELSE NULL END',
    '    ELSE NULL END;',
    "  IF v_pool IS NULL THEN RAISE EXCEPTION 'invalid_item_roll_v5'; END IF;",
    '',
    '  v_remaining := LEAST(v_lines, array_length(v_pool, 1));',
    '  FOR i IN 1..v_remaining LOOP',
    '    v_choice := 1 + floor(random() * array_length(v_pool, 1))::integer;',
    '    v_key := v_pool[v_choice];',
    '    v_pool := array_remove(v_pool, v_key);',
    '    SELECT stat_min, stat_max, stat_curve INTO v_min, v_max, v_curve FROM (VALUES',
    statValues,
    '    ) AS ranges(stat_key, stat_min, stat_max, stat_curve) WHERE stat_key = v_key;',
    "    v_percent := v_key NOT IN ('hp', 'atk', 'def');",
    '    v_level_mult := 1 + (p_item_level - 1)',
    "      * CASE WHEN v_curve = 'main' THEN 0.015 ELSE 0.005 END",
    '      + 0.2 * floor((p_item_level - 1) / 15);',
    "    v_rarity_factor := CASE WHEN v_curve = 'main' THEN v_rarity_mult ELSE sqrt(v_rarity_mult) END;",
    '    v_value := (v_min + random() * (v_max - v_min)) * v_rarity_factor * v_level_mult;',
    '    v_value := round(v_value, 6);',
    "    v_stats := v_stats || jsonb_build_array(jsonb_build_object('key', v_key, 'value', v_value, 'isPercent', v_percent));",
    '  END LOOP;',
    '  RETURN v_stats;',
    'END;',
    '$$;',
    '',
    'CREATE OR REPLACE FUNCTION public.calculate_item_power_v5(p_stats jsonb, p_enchant integer)',
    'RETURNS bigint',
    'LANGUAGE sql',
    'IMMUTABLE',
    'STRICT',
    'SET search_path = public',
    'AS $$',
    '  SELECT round(COALESCE(sum(',
    "    (stat->>'value')::numeric * CASE stat->>'key'",
    "      WHEN 'atk' THEN 4 WHEN 'critChance' THEN 200 WHEN 'critDamage' THEN 100 WHEN 'atkSpeed' THEN 0.5",
    "      WHEN 'hp' THEN 0.15 WHEN 'def' THEN 2 WHEN 'goldBonus' THEN 150 WHEN 'xpBonus' THEN 100",
    "      WHEN 'dodge' THEN 150 ELSE 1 END",
    '    * public.item_roll_v5_enchant_multiplier(LEAST(20, GREATEST(0, p_enchant)))',
    '  ), 0))::bigint',
    '  FROM jsonb_array_elements(p_stats) stat',
    '$$;',
    '',
    'REVOKE ALL ON FUNCTION public.item_roll_v5_enchant_multiplier(integer) FROM PUBLIC, anon, authenticated;',
    'REVOKE ALL ON FUNCTION public.roll_item_stats_v5(text, text, integer, text) FROM PUBLIC, anon, authenticated;',
    'REVOKE ALL ON FUNCTION public.calculate_item_power_v5(jsonb, integer) FROM PUBLIC, anon, authenticated;',
    'GRANT EXECUTE ON FUNCTION public.item_roll_v5_enchant_multiplier(integer) TO service_role;',
    'GRANT EXECUTE ON FUNCTION public.roll_item_stats_v5(text, text, integer, text) TO service_role;',
    'GRANT EXECUTE ON FUNCTION public.calculate_item_power_v5(jsonb, integer) TO service_role;',
    '',
  ].join('\n');
}

export function generateItemRollRuntime({ write = true } = {}) {
  const contract = buildItemRollV5Contract();
  const ts = renderGeneratedTs(contract);
  const sql = renderMigrationSql(contract);
  const committedSql = existsSync(GENERATED_SQL_PATH) ? readFileSync(GENERATED_SQL_PATH) : null;
  const sqlMatch = committedSql !== null && sha256(committedSql) === IMMUTABLE_SQL_SHA256;

  if (!write) {
    const tsMatch = existsSync(GENERATED_TS_PATH)
      && Buffer.compare(readFileSync(GENERATED_TS_PATH), Buffer.from(ts, 'utf8')) === 0;
    return { contract, ts, sql, tsMatch, sqlMatch };
  }

  invariant(sqlMatch, 'applied item-roll migration bytes changed');
  writeFileSync(GENERATED_TS_PATH, ts);
  return { contract, ts, sql, tsMatch: true, sqlMatch: true, wrote: true };
}

function main() {
  const args = process.argv.slice(2);
  const isValid = args.length === 0 || (args.length === 1 && args[0] === '--check') || args.includes('--help');
  if (!isValid) {
    process.stderr.write('Usage: node scripts/generate-item-roll-runtime.mjs [--check]\n');
    process.exit(2);
  }
  if (args.includes('--help')) {
    process.stdout.write('Usage: node scripts/generate-item-roll-runtime.mjs [--check]\n');
    return;
  }
  const checkMode = args.includes('--check');
  const { contract, tsMatch, sqlMatch } = generateItemRollRuntime({ write: !checkMode });

  if (checkMode) {
    console.log(`Item-roll v5 runtime generator (--check)`);
    console.log(`runtime stamp: ${contract.runtimeStamp}`);
    console.log(`src/game/item-roll-runtime.generated.ts: ${tsMatch ? 'MATCH' : 'MISMATCH'}`);
    console.log(`selfhosted/postgres/migrations/20260908130000_item_roll_v5_primitives.sql: ${sqlMatch ? 'IMMUTABLE' : 'MISMATCH'}`);
    if (!tsMatch || !sqlMatch) process.exitCode = 1;
    return;
  }

  console.log(`Wrote ${GENERATED_TS_PATH}`);
  console.log(`Preserved immutable ${GENERATED_SQL_PATH}`);
  console.log(`runtime stamp: ${contract.runtimeStamp}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
