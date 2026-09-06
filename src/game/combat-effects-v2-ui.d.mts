import type { HeroClass } from './types';

export interface CombatEffectV2Preview {
  core: { id: string; name: string; description: string };
  team: { id: string; name: string; capability: string; description: string };
}
export const COMBAT_EFFECTS_V2_UI_VERSION: string;
export const COMBAT_EFFECTS_V2_UI_ACTIVE: false;
export const COMBAT_EFFECTS_V2_PREVIEW: Readonly<Record<HeroClass, CombatEffectV2Preview>>;
