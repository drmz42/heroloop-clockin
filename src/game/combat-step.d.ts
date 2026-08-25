export type CombatStepSide = 'hero' | 'enemy';

export interface CombatStepUnit {
  uid: string;
  side: CombatStepSide;
  hp: number;
  maxHp: number;
  alive: boolean;
  atk: number;
  def: number;
  attackTimer: number;
  attackInterval: number;
  critChance: number;
  critDamage: number;
  dodge?: number;
  heroClass?: string;
  regenTimer?: number;
}

export type CombatStepEvent =
  | { kind: 'heal'; targetUid: string; amount: number }
  | { kind: 'miss'; attackerUid: string; targetUid: string }
  | { kind: 'damage'; attackerUid: string; targetUid: string; amount: number; critical: boolean };

export interface CombatResolution {
  deadHeroUids: string[];
  wonHeroUids: string[];
  clearedLanes: number;
  allCleared: boolean;
}

export function advanceCombatFrame<T extends CombatStepUnit>(
  units: readonly T[],
  elapsedMs: number,
  random?: () => number,
): { units: T[]; events: CombatStepEvent[] };

export function combatResolution(units: readonly CombatStepUnit[]): CombatResolution | null;
