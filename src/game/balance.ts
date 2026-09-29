import type { BalanceTelemetry, BalanceTelemetrySummary } from './types';

export const BALANCE_VERSION = 'balance-v5-progression-2026.09.28-v1:telemetry-ratio-v2';
// Approved per-location base table (Account Level bands); the displayed value is RECOMMENDED_POWER_PER_LANE.
export const BASE_POWER_PER_LANE = [49, 98, 138, 186, 242, 292, 353, 427, 520, 603, 3947, 3998, 5055, 5117, 5479, 6421, 8169, 9208, 11029, 12166] as const;
// Displayed Recommended Power per lane for 1/2/3-hero formations, calibrated against the server combat
// engine (`scripts/calibrate-recommended-power.ts`, data/recommended-power-server-calibration.csv): the
// per-lane Power at which a formation wins 72% of normal waves. Locations 1-10 are the 2026-09-26 measured
// values (the v5 re-run stays within sampling noise). Locations 11-19 take the 2026-09-29 v5 measurement
// where at least 50 samples fall within 0.85-1.15x of the previous value, raised to stay non-decreasing
// by location; 18/3-hero, 19/2-3-hero and Location 20 keep the previous values: too few v5 samples reach them.
export const RECOMMENDED_POWER_PER_LANE: readonly (readonly [number, number, number])[] = [
  [44, 46, 77], [91, 133, 133], [145, 173, 196], [189, 242, 255], [244, 307, 368],
  [320, 400, 428], [396, 504, 557], [466, 561, 695], [573, 686, 795], [823, 948, 1049],
  [4646, 5518, 6095], [4856, 5703, 6154], [5719, 7041, 7764], [5796, 7041, 7764], [6231, 7589, 8151],
  [7232, 8829, 9786], [9550, 11293, 11719], [10767, 14405, 14388], [13833, 16544, 17232], [16880, 18249, 19010],
];
export const WINNING_CLEAR_SECONDS_BUCKETS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360] as const;
const MAX_CLEAR_SECONDS = WINNING_CLEAR_SECONDS_BUCKETS[WINNING_CLEAR_SECONDS_BUCKETS.length - 1];
const MIN_SAMPLE = 20;
const TARGET_WIN_RATE = 0.72;

export function emptyBalanceTelemetry(): BalanceTelemetry {
  return { version: BALANCE_VERSION, cohorts: {} };
}

function powerBand(power: number): number {
  if (power <= 0) return 0;
  return 2 ** Math.floor(Math.log2(power));
}

function ratioBand(powerRatio: number): number {
  const bounded = Math.max(0, Math.min(4, powerRatio));
  return Math.floor(bounded * 4) / 4;
}

function clearSecondsBucket(seconds: number): number {
  const bounded = Math.max(0, Math.min(MAX_CLEAR_SECONDS, seconds));
  const index = WINNING_CLEAR_SECONDS_BUCKETS.findIndex((upperBound) => bounded <= upperBound);
  return index < 0 ? WINNING_CLEAR_SECONDS_BUCKETS.length - 1 : index;
}

function normalizedBuckets(value: number[] | undefined): number[] {
  return WINNING_CLEAR_SECONDS_BUCKETS.map((_, index) => Math.max(0, Math.floor(Number(value?.[index]) || 0)));
}

function cohortKey(locationId: number, teamSize: number, power: number, recommendedPower: number, boss: boolean): string {
  const ratio = power / recommendedPower;
  return `${locationId}:${teamSize}:${powerBand(power)}:${ratioBand(ratio)}:${boss ? 'boss' : 'wave'}`;
}

export function recordBattleTelemetry(
  telemetry: BalanceTelemetry,
  input: { locationId: number; teamSize: number; power: number; recommendedPower: number; boss: boolean; win: boolean; clearSeconds: number; heroDeaths: number; equippedStatLines: number },
): BalanceTelemetry {
  const current = telemetry.version === BALANCE_VERSION ? telemetry : emptyBalanceTelemetry();
  const safeLocationId = Math.max(1, Math.min(BASE_POWER_PER_LANE.length, Math.floor(Number(input.locationId) || 1)));
  const safeTeamSize = Math.max(1, Math.min(3, Math.floor(Number(input.teamSize) || 1)));
  const safePower = Math.max(0, Number(input.power) || 0);
  const safeRecommendedPower = Math.max(1, Number(input.recommendedPower) || 1);
  const safeClearSeconds = Math.max(0, Number(input.clearSeconds) || 0);
  const powerRatio = safePower / safeRecommendedPower;
  const key = cohortKey(safeLocationId, safeTeamSize, safePower, safeRecommendedPower, input.boss);
  const old = current.cohorts[key] ?? {
    locationId: safeLocationId, teamSize: safeTeamSize, powerBand: powerBand(safePower),
    recommendedPowerBand: powerBand(safeRecommendedPower), powerRatioBand: ratioBand(powerRatio), boss: input.boss,
    attempts: 0, wins: 0, totalClearSeconds: 0, totalPower: 0, totalRecommendedPower: 0, totalPowerRatio: 0,
    winningClearSecondsBuckets: WINNING_CLEAR_SECONDS_BUCKETS.map(() => 0), heroDeaths: 0, totalEquippedStatLines: 0,
  };
  const winningClearSecondsBuckets = normalizedBuckets(old.winningClearSecondsBuckets);
  if (input.win) winningClearSecondsBuckets[clearSecondsBucket(safeClearSeconds)] += 1;
  return {
    ...current,
    cohorts: {
      ...current.cohorts,
      [key]: {
        ...old,
        attempts: old.attempts + 1,
        wins: old.wins + (input.win ? 1 : 0),
        totalClearSeconds: old.totalClearSeconds + safeClearSeconds,
        totalPower: old.totalPower + safePower,
        totalRecommendedPower: old.totalRecommendedPower + safeRecommendedPower,
        totalPowerRatio: old.totalPowerRatio + powerRatio,
        winningClearSecondsBuckets,
        heroDeaths: old.heroDeaths + Math.max(0, input.heroDeaths),
        totalEquippedStatLines: old.totalEquippedStatLines + Math.max(0, input.equippedStatLines),
      },
    },
  };
}

function medianWinningClearSecondsUpperBound(buckets: number[], wins: number): number | null {
  if (wins <= 0) return null;
  const rank = Math.ceil(wins / 2);
  let cumulative = 0;
  for (let index = 0; index < WINNING_CLEAR_SECONDS_BUCKETS.length; index += 1) {
    cumulative += buckets[index] ?? 0;
    if (cumulative >= rank) return WINNING_CLEAR_SECONDS_BUCKETS[index];
  }
  return MAX_CLEAR_SECONDS;
}

export function summarizeBalanceTelemetry(telemetry: BalanceTelemetry): BalanceTelemetrySummary[] {
  if (telemetry.version !== BALANCE_VERSION) return [];
  const groups = new Map<string, { teamSize: number; boss: boolean; powerRatioBand: number; attempts: number; wins: number; totalPowerRatio: number; buckets: number[] }>();
  for (const cohort of Object.values(telemetry.cohorts)) {
    const key = `${cohort.teamSize}:${cohort.powerRatioBand}:${cohort.boss ? 'boss' : 'wave'}`;
    const group = groups.get(key) ?? {
      teamSize: cohort.teamSize, boss: cohort.boss, powerRatioBand: cohort.powerRatioBand,
      attempts: 0, wins: 0, totalPowerRatio: 0, buckets: WINNING_CLEAR_SECONDS_BUCKETS.map(() => 0),
    };
    group.attempts += cohort.attempts;
    group.wins += cohort.wins;
    group.totalPowerRatio += cohort.totalPowerRatio;
    normalizedBuckets(cohort.winningClearSecondsBuckets).forEach((count, index) => { group.buckets[index] += count; });
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      teamSize: group.teamSize,
      boss: group.boss,
      powerRatioBand: group.powerRatioBand,
      attempts: group.attempts,
      wins: group.wins,
      winRate: group.attempts > 0 ? group.wins / group.attempts : 0,
      averagePowerRatio: group.attempts > 0 ? group.totalPowerRatio / group.attempts : 0,
      medianWinningClearSecondsUpperBound: medianWinningClearSecondsUpperBound(group.buckets, group.wins),
    }))
    .sort((left, right) => left.teamSize - right.teamSize || Number(left.boss) - Number(right.boss) || left.powerRatioBand - right.powerRatioBand);
}

export function recommendedTeamPower(locationId: number, teamSize: number, telemetry?: BalanceTelemetry): number {
  const lanes = Math.max(1, Math.min(teamSize, 3));
  const row = RECOMMENDED_POWER_PER_LANE[Math.max(0, Math.min(locationId - 1, RECOMMENDED_POWER_PER_LANE.length - 1))];
  const baseline = row[lanes - 1] * lanes;
  if (!telemetry || telemetry.version !== BALANCE_VERSION) return Math.round(baseline);
  const samples = Object.values(telemetry.cohorts).filter((row) =>
    row.locationId === locationId && row.teamSize === lanes && !row.boss,
  );
  const attempts = samples.reduce((sum, row) => sum + row.attempts, 0);
  if (attempts < MIN_SAMPLE) return Math.round(baseline);
  const wins = samples.reduce((sum, row) => sum + row.wins, 0);
  const observedPower = samples.reduce((sum, row) => sum + row.totalPower, 0) / attempts;
  const winRate = wins / attempts;
  const winFactor = Math.max(0.8, Math.min(1.25, 1 + (winRate - TARGET_WIN_RATE) * 0.7));
  return Math.round(baseline * 0.6 + observedPower * winFactor * 0.4);
}
