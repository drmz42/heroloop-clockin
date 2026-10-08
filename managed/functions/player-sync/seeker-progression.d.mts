export const SEEKER_PROGRESSION_VERSION: string;
export const SEEKER_PROGRESSION_BALANCE_VERSION: string;
export const SEEKER_MAX_LEVEL: number;
export const SEEKER_LOCATION_RANGES: number[][];
export function seekerAccountXpNeeded(level: number): number;
export function seekerXpReward(grossXp: number, remainder?: number): { xp: number; remainder: number };
export function seekerLevelMastery(level: unknown): number;
export function seekerItemLevelMultiplier(level: unknown): number;
