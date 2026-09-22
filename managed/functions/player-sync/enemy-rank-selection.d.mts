export interface ResolvedEnemySlot {
  enemyId: string;
  kind: 'base' | 'epic' | 'field-boss' | 'dungeon-boss';
  familyId: string;
  rankId: 'normal' | 'veteran' | 'elite' | 'epic' | 'field-boss' | 'dungeon-boss';
  sizeScale: number;
  hpMultiplier: number;
  abilityIds: string[];
}

export interface EncounterRoster {
  locationId: number;
  seed: number;
  roster: ResolvedEnemySlot[];
}

export function rollBaseEnemyRank(random: () => number, rankWeights: Record<string, number>): string;

export function resolveEnemySlot(
  enemyId: string,
  deps: { catalog: object; rankSelectionConfig: object; attackRegistry?: object; random: () => number },
): ResolvedEnemySlot;

export function selectBaseEncounterRoster(args: {
  locationId: number;
  seed: number;
  catalog: object;
  rankSelectionConfig: object;
  attackRegistry?: object;
}): EncounterRoster;
