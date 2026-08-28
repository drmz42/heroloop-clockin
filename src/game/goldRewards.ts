export const GOLD_REWARD_RULES_VERSION = 'balance-v4-gold-parity-v1';
export const PROPOSED_ENDGAME_ELITE_CHANCE = 0.05;
export const PROPOSED_ENDGAME_ELITE_REWARD_MULTIPLIER = 1.5;

export function goldRewardForLanes(
  baseGoldPerLane: number,
  clearedLanes: number,
  additiveGoldBonus = 0,
  rewardMultiplier = 1,
): number {
  const base = Math.max(0, Number.isFinite(baseGoldPerLane) ? baseGoldPerLane : 0);
  const lanes = Math.max(0, Math.floor(Number.isFinite(clearedLanes) ? clearedLanes : 0));
  const bonus = Math.max(0, Number.isFinite(additiveGoldBonus) ? additiveGoldBonus : 0);
  const multiplier = Math.max(0, Number.isFinite(rewardMultiplier) ? rewardMultiplier : 0);
  return Math.round(base * (1 + bonus) * multiplier) * lanes;
}

export function expectedEliteRewardMultiplier(
  chance = PROPOSED_ENDGAME_ELITE_CHANCE,
  eliteMultiplier = PROPOSED_ENDGAME_ELITE_REWARD_MULTIPLIER,
): number {
  return 1 + Math.max(0, chance) * (Math.max(0, eliteMultiplier) - 1);
}
