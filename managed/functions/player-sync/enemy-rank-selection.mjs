// Step 3 of the 41-enemy catalogue (docs/game/enemy-catalog-and-ranks.md):
// deterministic server-owned rank/ability selection, without client authority.
// Non-runtime: nothing imports this file into actual combat yet (Step 4).
import { seededCombatRandom } from './combat-step.mjs';

/**
 * Roll one of the rollable ranks (normal/veteran/elite) against a weight
 * table. Deterministic for a given `random`; never Math.random.
 * @param {() => number} random
 * @param {Record<string, number>} rankWeights
 * @returns {string}
 */
export function rollBaseEnemyRank(random, rankWeights) {
  const entries = Object.entries(rankWeights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (!(total > 0)) throw new Error('invalid_rank_weights');
  let roll = random() * total;
  for (const [rankId, weight] of entries) {
    if (roll < weight) return rankId;
    roll -= weight;
  }
  return entries[entries.length - 1][0];
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Resolve one concrete enemy instance: its rank (rolled for a `base` enemy,
 * fixed by kind for epic/field-boss/dungeon-boss), an HP multiplier sampled
 * within the rank's declared band, and an ability list sized within both the
 * catalogue's ability-count budget and the attack registry's presentation
 * budget for that rank (whichever is smaller).
 * @param {string} enemyId
 * @param {{ catalog: object, rankSelectionConfig: object, attackRegistry?: object, random: () => number }} deps
 */
export function resolveEnemySlot(enemyId, { catalog, rankSelectionConfig, attackRegistry, random }) {
  const enemy = catalog.enemies.find((candidate) => candidate.id === enemyId);
  if (!enemy) throw new Error(`unknown_enemy:${enemyId}`);
  const ranksById = new Map(catalog.ranks.map((rank) => [rank.id, rank]));

  const rankId = enemy.kind === 'base'
    ? rollBaseEnemyRank(random, rankSelectionConfig.rankWeights)
    : rankSelectionConfig.authority.fixedRankByKind[enemy.kind];
  const rank = ranksById.get(rankId);
  if (!rank) throw new Error(`unknown_rank:${rankId}`);

  const [hpMin, hpMax] = rank.candidateHpMultiplier;
  const hpMultiplier = round4(hpMin + random() * (hpMax - hpMin));

  const [countMin, countMax] = rank.abilityCount;
  const presentation = attackRegistry?.rankPresentation?.find((entry) => entry.rankId === rankId);
  const ceiling = presentation ? Math.min(countMax, presentation.maxTelegraphedAbilities) : countMax;
  const floor = Math.min(countMin, ceiling);
  const abilityCount = floor + Math.floor(random() * (ceiling - floor + 1));

  // Bounded draw-without-replacement: a pathological random source (for
  // example a short fixed test sequence) must never spin forever here.
  const pool = rankSelectionConfig.abilityPool.ids;
  const abilityIds = [];
  const used = new Set();
  const maxAttempts = pool.length * 8;
  for (let attempt = 0; abilityIds.length < abilityCount && used.size < pool.length && attempt < maxAttempts; attempt += 1) {
    const pick = pool[Math.floor(random() * pool.length)];
    if (used.has(pick)) continue;
    used.add(pick);
    abilityIds.push(pick);
  }

  return {
    enemyId,
    kind: enemy.kind,
    familyId: enemy.familyId,
    rankId,
    sizeScale: rank.sizeScale,
    hpMultiplier,
    abilityIds,
  };
}

/**
 * Deterministic roster for a Location's three base-enemy slots. Same seed,
 * same catalogue and config always produce the same roster.
 * @param {{ locationId: number, seed: number, catalog: object, rankSelectionConfig: object, attackRegistry?: object }} args
 */
export function selectBaseEncounterRoster({ locationId, seed, catalog, rankSelectionConfig, attackRegistry }) {
  const location = catalog.locations.find((candidate) => candidate.id === locationId);
  if (!location) throw new Error(`unknown_location:${locationId}`);
  const random = seededCombatRandom(seed);
  const roster = location.baseEnemyIds.map((enemyId) =>
    resolveEnemySlot(enemyId, { catalog, rankSelectionConfig, attackRegistry, random }));
  return { locationId, seed, roster };
}
