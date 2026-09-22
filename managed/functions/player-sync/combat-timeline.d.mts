export interface CombatTimelineEvent {
  sequence: number; elapsedMs: number; kind: 'damage' | 'miss' | 'heal' | 'effect' | 'potion';
  sourceUid: string; targetUid: string; amount?: number; critical: boolean; effectId?: string; durationMs?: number;
}
export const COMBAT_TIMELINE_VERSION: number;
export const MAX_COMBAT_TIMELINE_EVENTS: number;
export function serializeCombatTimeline(events: unknown[], autoPotions?: unknown[]): unknown[];
export function parseCombatTimeline(value: unknown, unitIds: Set<string> | string[], maxElapsedMs: number): CombatTimelineEvent[] | null;
