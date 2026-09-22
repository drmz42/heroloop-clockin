export type CombatStepSide = 'hero' | 'enemy';
export interface CombatStepUnit {
  uid: string; side: CombatStepSide; hp: number; maxHp: number; alive: boolean;
  atk: number; def: number; attackTimer: number; attackInterval: number;
  critChance: number; critDamage: number; dodge?: number; heroClass?: string; regenTimer?: number; regenPerSecond?: number;
  role?: 'tank' | 'striker' | 'skirmisher' | 'support' | 'caster';
  eliteAffix?: 'guard-aura' | 'mending' | 'barrier' | 'enrage' | 'curse' | 'lane-blast' | 'summoner' | null;
  shield?: number; curseRemainingMs?: number; damageMultiplier?: number; assistLowestHp?: boolean;
  enraged?: boolean; summoned?: boolean;
  effectCooldowns?: Record<string, number>; abilityTimer?: number;
  combatEffectsVersion?: string; effectClockMsV2?: number;
  effectSourceStateV2?: { cooldowns?: Record<string, number>; hitCounts?: Record<string, number> };
  activeEffectsV2?: Record<string, { effectId: string; magnitude: Record<string, number>; sourceUids: string[]; appliedAtMs: number; expiresAtMs: number; stacks: 1 }>;
  aegisBarrierV2?: { effectId: string; amount: number; expiresAtMs: number; sourceUids: string[] };
}
export type CombatStepEvent =
  | { kind: 'heal'; targetUid: string; amount: number }
  | { kind: 'miss'; attackerUid: string; targetUid: string }
  | { kind: 'damage'; attackerUid: string; targetUid: string; amount: number; critical: boolean }
  | { kind: 'effect'; effectId: string; sourceUid: string; targetUid: string; amount?: number; durationMs?: number };
export interface CombatResolution {
  deadHeroUids: string[]; wonHeroUids: string[]; clearedLanes: number; allCleared: boolean;
}
export interface ResolvedCombat<T extends CombatStepUnit> {
  units: T[]; resolution: CombatResolution; elapsedMs: number; timedOut: boolean;
  events: Array<CombatStepEvent & { elapsedMs: number }>;
}
export function seededCombatRandom(seed: number): () => number;
export function advanceCombatFrame<T extends CombatStepUnit>(units: readonly T[], elapsedMs: number, random?: () => number): { units: T[]; events: CombatStepEvent[] };
export function combatResolution(units: readonly CombatStepUnit[]): CombatResolution | null;
export function resolveCombat<T extends CombatStepUnit>(initialUnits: readonly T[], seed: number, stepMs?: number, maxElapsedMs?: number, afterStep?: (units: T[], elapsedMs: number) => T[]): ResolvedCombat<T>;
