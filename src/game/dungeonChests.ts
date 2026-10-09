import type { DungeonChestStatus } from '@/game/types';

export type DungeonChestDepth = 1 | 2 | 3;
export const DUNGEON_CHEST_NUMERAL: Record<DungeonChestDepth, string> = { 1: 'I', 2: 'II', 3: 'III' };

export const dungeonChestTitle = (depth: number) => `Dungeon Chest · Depth ${DUNGEON_CHEST_NUMERAL[depth as DungeonChestDepth] ?? depth}`;

/** Depths the player owns at least one chest of; empty stacks never take a cell. */
export function ownedDungeonChestDepths(status: DungeonChestStatus | null): DungeonChestDepth[] {
  return status ? ([1, 2, 3] as const).filter((depth) => status.balances[depth] > 0) : [];
}
