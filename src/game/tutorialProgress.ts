import type { GameState } from './types';
import { getEquippedItems } from './engine';
import contract from '../../config/tutorial-quests.v1.json';
import { isolatedHackathon } from './editionStorage';
import { storyHoldsTutorialBundle } from './storyBox';

export const SEEKER_TUTORIAL_ORDINALS = [1, 2, 3, 4, 5, 10] as const;
export const tutorialDisplayOrdinal = (ordinal: number): number => isolatedHackathon && ordinal >= 6 && ordinal <= 9 ? 10 : ordinal;
export const tutorialStepCount = isolatedHackathon ? SEEKER_TUTORIAL_ORDINALS.length : 10;
export const tutorialStepNumber = (ordinal: number): number => isolatedHackathon ? SEEKER_TUTORIAL_ORDINALS.indexOf(tutorialDisplayOrdinal(ordinal) as typeof SEEKER_TUTORIAL_ORDINALS[number]) + 1 : ordinal;

// Presentation only: claim eligibility and rewards remain server-owned.
export function tutorialProgress(state: GameState, ordinal: number): number {
  const equipped = state.ownedHeroes.some(hero => state.team.includes(hero.uid) && getEquippedItems(hero, state.inventory).length > 0);
  return [state.totalKills, state.tutorial.openedCount, equipped ? 1 : 0, state.summons,
    state.team.length, state.summons, state.totalKills,
    state.autoPot.enabled ? 1 : 0,
    state.totalKills,
    Math.max(0, state.totalBossKills - state.tutorial.bossKillsAtKeyGrant)][ordinal - 1] ?? 0;
}

export function readyQuestCount(state: GameState): number {
  const ordinal = Math.max(1, Math.min(10, state.tutorial.questOrdinal));
  // The legacy welcome modal is gone, so welcomeCompleted no longer gates the quest chain.
  // The step-1 bundle waits for the story's second death, so it is not a ready reward yet.
  const tutorialReady = (!isolatedHackathon || ordinal === 1) && !state.tutorial.questCompleted && !storyHoldsTutorialBundle(state)
    && tutorialProgress(state, ordinal) >= contract.quests[ordinal - 1].target;
  return Number(tutorialReady) + [...state.dailyQuests, ...state.milestoneQuests]
    .filter(quest => !quest.claimed && quest.progress >= quest.target).length;
}

export function tutorialObjectiveAt(state: GameState, requestedOrdinal: number) {
  if (state.tutorial.questCompleted) return null;
  const ordinal = Math.max(1, Math.min(10, requestedOrdinal));
  const quest = contract.quests[ordinal - 1];
  const progress = tutorialProgress(state, ordinal);
  return { id: quest.id, label: quest.id === 'enable-auto-pot' ? 'Automatic healing' : quest.label,
    progress: Math.min(progress, quest.target), target: quest.target, ready: progress >= quest.target };
}

export function currentTutorialObjective(state: GameState) {
  return tutorialObjectiveAt(state, tutorialDisplayOrdinal(state.tutorial.questOrdinal));
}
