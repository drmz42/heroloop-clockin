export type CombatSessionPhase = 'idle' | 'preparing' | 'playing' | 'settling' | 'recovering';

export interface CombatSessionRequest {
  locationId: number;
  teamUids: string[];
  forceBoss: boolean;
}

export interface CombatSessionSnapshot {
  phase: CombatSessionPhase;
  generation: number;
  activeRequest: CombatSessionRequest | null;
  pendingRequest: CombatSessionRequest | null;
}

export interface CombatSession {
  begin(request: CombatSessionRequest): number | null;
  isCurrent(generation: number): boolean;
  markPlaying(generation: number): boolean;
  markSettling(): number | null;
  markIdle(generation: number): boolean;
  markRecovering(generation: number): boolean;
  reset(): void;
  snapshot(): CombatSessionSnapshot;
}

export function createCombatSession(): CombatSession;
