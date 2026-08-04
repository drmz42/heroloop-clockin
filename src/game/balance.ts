import type { BalanceTelemetry } from './types';

export const BALANCE_VERSION = '2026.08.02-v2';
export const BASE_POWER_PER_LANE = [50, 150, 350, 700, 1200, 2000, 3200, 5000, 7500, 11000] as const;
const MIN_SAMPLE = 20;
const TARGET_WIN_RATE = 0.72;

export function emptyBalanceTelemetry(): BalanceTelemetry {
  return { version: BALANCE_VERSION, cohorts: {} };
}

function powerBand(power: number): number {
  if (power <= 0) return 0;
  return 2 ** Math.floor(Math.log2(power));
}

function cohortKey(locationId: number, teamSize: number, power: number, boss: boolean): string {
  return `${locationId}:${teamSize}:${powerBand(power)}:${boss ? 'boss' : 'wave'}`;
}

export function recordBattleTelemetry(
  telemetry: BalanceTelemetry,
  input: { locationId: number; teamSize: number; power: number; boss: boolean; win: boolean; clearSeconds: number; heroDeaths: number; equippedStatLines: number },
): BalanceTelemetry {
  const current = telemetry.version === BALANCE_VERSION ? telemetry : emptyBalanceTelemetry();
  const key = cohortKey(input.locationId, input.teamSize, input.power, input.boss);
  const old = current.cohorts[key] ?? {
    locationId: input.locationId, teamSize: input.teamSize, powerBand: powerBand(input.power), boss: input.boss,
    attempts: 0, wins: 0, totalClearSeconds: 0, totalPower: 0, heroDeaths: 0, totalEquippedStatLines: 0,
  };
  return {
    ...current,
    cohorts: {
      ...current.cohorts,
      [key]: {
        ...old,
        attempts: old.attempts + 1,
        wins: old.wins + (input.win ? 1 : 0),
        totalClearSeconds: old.totalClearSeconds + Math.max(0, input.clearSeconds),
        totalPower: old.totalPower + Math.max(0, input.power),
        heroDeaths: old.heroDeaths + Math.max(0, input.heroDeaths),
        totalEquippedStatLines: old.totalEquippedStatLines + Math.max(0, input.equippedStatLines),
      },
    },
  };
}

export function recommendedTeamPower(locationId: number, teamSize: number, telemetry?: BalanceTelemetry): number {
  const lanes = Math.max(1, Math.min(teamSize, 3));
  const basePerLane = BASE_POWER_PER_LANE[Math.min(locationId - 1, BASE_POWER_PER_LANE.length - 1)]
    * (1 + (locationId > 10 ? (locationId - 10) * 0.4 : 0));
  const baseline = basePerLane * lanes;
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
