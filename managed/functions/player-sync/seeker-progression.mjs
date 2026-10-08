// Seeker progression v1. Legacy waves keep their frozen balance and reward policy.
export const SEEKER_PROGRESSION_VERSION = 'seeker-progression-200-v1';
export const SEEKER_PROGRESSION_BALANCE_VERSION = 'seeker-200-2026.10.08-v1-combat-effects-v2-auto-healing-v1';
export const SEEKER_MAX_LEVEL = 200;
export const SEEKER_LOCATION_RANGES = Array.from({ length: 20 }, (_, index) => [index * 10 + 1, (index + 1) * 10]);
export function seekerAccountXpNeeded(level) {
  if (level < 20) return Math.round(1800 + level * 85);
  if (level < 29) return Math.round(10400 + (level - 20) * 360);
  if (level < 100) return Math.min(36000, Math.round(14000 + (level - 29) * 1100));
  return 36000 + (Math.min(199, level) - 99) * 1100;
}
export function seekerXpReward(grossXp, remainder = 0) {
  if (!Number.isSafeInteger(grossXp) || grossXp < 0 || !Number.isInteger(remainder) || remainder < 0 || remainder >= 20) throw new Error('invalid_xp_reward');
  const value = grossXp * 17 + remainder;
  if (!Number.isSafeInteger(value)) throw new Error('xp_reward_overflow');
  return { xp: Math.floor(value / 20), remainder: value % 20 };
}
// Preserve all existing mastery values; the extension is linear rather than exponential.
export function seekerLevelMastery(level) {
  const value = Math.max(1, Math.min(200, Math.floor(Number(level) || 1)));
  return 1.014 ** (Math.min(99, value) - 1) * (1 + Math.max(0, value - 99) * .007);
}
export function seekerItemLevelMultiplier(level) {
  const value = Math.max(1, Math.min(200, Math.floor(Number(level) || 1)));
  const legacy = Math.min(99, value);
  return (1 + .008 * (legacy - 1)) * 1.014 ** (legacy - 1) * (1 + Math.max(0, value - 99) * .009);
}
