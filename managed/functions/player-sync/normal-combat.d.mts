import type { CombatStepUnit } from './combat-step.mjs';
export interface NormalCombatBuild {
  seed: number;
  initial_units: CombatStepUnit[];
  reward_bonuses: { gold: number; xp: number };
  outcome: {
    status: 'cleared' | 'failed'; elapsed_ms: number; timed_out: boolean;
    final_units: CombatStepUnit[]; dead_hero_uids: string[]; won_hero_uids: string[];
    cleared_lanes: number; all_cleared: boolean;
    timeline_version: number; timeline: unknown[];
    healing_policy?: string;
    auto_pot_gold_cost: number;
    auto_potions: { elapsed_ms: number; hero_uid: string; tier: string; hp_restore: number; from_stock: boolean; gold_cost: number }[];
  };
}
export const NORMAL_COMBAT_SERVER_PAUSE_MS: number;
export const BALANCE_VERSION: string;
export const COMBAT_EFFECTS_V2_BALANCE_VERSION: string;
export function buildNormalCombat(state: unknown, ledgerItems: unknown, location: number, seed: number, resourceSnapshot?: unknown, startedAtMs?: number, combatEffectsVersion?: string | null, healingPolicy?: string | null): NormalCombatBuild;
