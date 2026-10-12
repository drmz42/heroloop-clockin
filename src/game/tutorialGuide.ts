import { useEffect } from 'react';
import type { GameState } from './types';
import { isolatedHackathon } from './editionStorage';
import { currentTutorialObjective } from './tutorialProgress';
import { storyHoldsTutorialBundle } from './storyBox';

// Tutorial guidance (Founder 2026-10-08): the control a new player must press next pulses.
// Presentation only: progress, claims and rewards stay server-owned. Elements opt in with
// `data-guide="<guide> ..."`; android.css/index.css style `html[data-hl-guide=X] [data-guide~=X]`.
export type TutorialGuide = 'claim' | 'battle' | 'open-chests' | 'equip' | 'summon' | 'formation' | 'boss';

const GUIDE_BY_QUEST: Record<string, TutorialGuide> = {
  'defeat-10-enemies': 'battle',
  'open-10-tutorial-chests': 'open-chests',
  'equip-active-hero': 'equip',
  'summon-two-heroes': 'summon',
  'fill-active-formation': 'formation',
  'summon-reserve-hero': 'summon',
  'defeat-25-enemies': 'battle',
  'defeat-50-enemies': 'battle',
  'defeat-tutorial-boss': 'boss',
};

export function tutorialGuide(state: GameState): TutorialGuide | null {
  const objective = currentTutorialObjective(state);
  if (!objective) return null;
  // The step-1 bundle waits for the story's second death; keep the player fighting meanwhile.
  if (objective.ready) return storyHoldsTutorialBundle(state) ? 'battle' : isolatedHackathon && state.tutorial.questOrdinal > 1 ? null : 'claim';
  return GUIDE_BY_QUEST[objective.id] ?? null;
}

// The 'battle' guide no longer pulses the Battle tab (Founder 2026-10-12: it glowed through every
// kill-count step); the Next-step card still sends the player to Battle.
// Where the Next-step card sends the player for each guide.
export const TUTORIAL_GO_EVENT = 'hl:tutorial-go';
export type TutorialDestination = { section: 'battle' | 'quests' | 'bag' } | { tab: 'summon' | 'heroes' };
export function tutorialDestination(guide: TutorialGuide): TutorialDestination {
  switch (guide) {
    case 'claim': case 'open-chests': return { section: 'quests' };
    case 'equip': return { section: 'bag' };
    case 'summon': return { tab: 'summon' };
    case 'formation': return { tab: 'heroes' };
    default: return { section: 'battle' };
  }
}

export function useTutorialGuide(guide: TutorialGuide | null) {
  useEffect(() => {
    const root = document.documentElement;
    if (guide) root.dataset.hlGuide = guide;
    else delete root.dataset.hlGuide;
    return () => { delete root.dataset.hlGuide; };
  }, [guide]);
}
