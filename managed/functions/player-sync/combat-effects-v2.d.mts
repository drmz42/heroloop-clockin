export interface CombatEffectSourceStateV2 {
  cooldowns?: Record<string, number>;
  hitCounts?: Record<string, number>;
}
export interface ActiveTargetEffectV2 {
  effectId: string;
  magnitude: Record<string, unknown>;
  sourceUids: string[];
  appliedAtMs: number;
  expiresAtMs: number;
  stacks: 1;
}
export const COMBAT_EFFECTS_V2_VERSION: string;
export function serverEffectForClass(classId: string, layer: 'coreTrait' | 'teamContribution'): Record<string, any>;
export function canonicalEffectForClass(registry: Record<string, any>, classId: string, layer: 'coreTrait' | 'teamContribution'): Record<string, any>;
export function tickSourceCooldown(state: CombatEffectSourceStateV2, effectId: string, cooldownMs: number, elapsedMs: number): { state: CombatEffectSourceStateV2; due: boolean };
export function advanceTriggeredCooldown(state: CombatEffectSourceStateV2, effectId: string, cooldownMs: number, elapsedMs: number): CombatEffectSourceStateV2;
export function consumeTriggeredCooldown(state: CombatEffectSourceStateV2, effectId: string, cooldownMs: number): { state: CombatEffectSourceStateV2; consumed: boolean };
export function recordLandedHit(state: CombatEffectSourceStateV2, effectId: string, every: number): { state: CombatEffectSourceStateV2; due: boolean };
export function resolveEchoDamage(effect: Record<string, any>, triggerFinalDamage: number, inheritedCritical: boolean): { amount: number; inheritedCritical: boolean; recursiveTriggers: 0 };
export function selectLowestHpPercentAlly<T extends { uid: string; hp: number; maxHp: number; alive: boolean }>(units: readonly T[]): T | undefined;
export function applyCappedTargetEffect(activeEffects: Record<string, ActiveTargetEffectV2>, effect: Record<string, any>, sourceUid: string, appliedAtMs: number): { activeEffects: Record<string, ActiveTargetEffectV2>; event: Record<string, unknown> };
export function pruneExpiredTargetEffects(activeEffects: Record<string, ActiveTargetEffectV2>, elapsedMs: number): Record<string, ActiveTargetEffectV2>;
