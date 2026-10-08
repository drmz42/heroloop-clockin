import { SEEKER_RECOMMENDED_POWER } from '../../managed/functions/player-sync/seeker-enemies.generated.mjs';
import type { BalanceTelemetry, BalanceTelemetrySummary } from './types';

export const BALANCE_VERSION = 'seeker-200-2026.10.08-v1:telemetry-ratio-v2';
// Balance v6 smooth per-lane target Power by Location (docs/game/data/balance-v6/recommended-power.csv).
export const BASE_POWER_PER_LANE = [49, 99, 136, 188, 259, 358, 494, 682, 941, 1298, 1792, 2473, 3412, 4333, 5503, 6989, 8876, 11273, 14317, 18182] as const;
// Displayed Recommended Power per lane for 1/2/3-hero formations: the v6 target curve times one formation
// factor per team size (x0.98 / x1.36 / x1.57), measured as the 72% win-rate Power on the server combat
// engine by `npx tsx scripts/model-balance-v6.ts` (recommended-power.csv), rounded to whole Power.
// Locations 1-2 keep their v5 onboarding enemy strength and therefore their v5 values.
// Location 3 uses its measured onboarding values after the Attack 45 override.
export const RECOMMENDED_POWER_PER_LANE: readonly (readonly [number, number, number])[] = [
  [44, 46, 77], [91, 133, 133], [128, 146, 152], [185, 256, 296], [255, 353, 408],
  [352, 488, 563], [486, 673, 778], [671, 929, 1070], [926, 1280, 1480], [1280, 1770, 2040],
  [1760, 2440, 2820], [2430, 3370, 3890], [3360, 4650, 5370], [4270, 5900, 6820], [5420, 7490, 8660],
  [6880, 9520, 11000], [8740, 12100, 14000], [11100, 15400, 17700], [14100, 19500, 22500], [17900, 24800, 28600],
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

export function recommendedTeamPower(locationId: number, teamSize: number, telemetry?: BalanceTelemetry, accountLevel?: number): number {
  const lanes = Math.max(1, Math.min(teamSize, 3));
  const recommendations = accountLevel !== undefined && accountLevel < (locationId - 1) * 10 + 1 ? RECOMMENDED_POWER_PER_LANE : SEEKER_RECOMMENDED_POWER;
  const row = recommendations[Math.max(0, Math.min(locationId - 1, recommendations.length - 1))];
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
