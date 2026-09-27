import type { FloatingNumber, GameState } from './types';

export const FLOATER_QUEUE_GAP_MS: number;
export const MAX_FLOATER_QUEUE_MS: number;
export function scheduleFloaters(batch: readonly FloatingNumber[], now: number, nextFree: Map<string, number>): FloatingNumber[];

export function combatPresentationDue(mode: GameState['battleAnimationMode'], elapsedMs: number, hasEvents: boolean): boolean;
