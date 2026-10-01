import type { GameState } from './types';
import { getEquippedItems, locationUnlockLevel } from './engine';
import contract from '../../config/tutorial-quests.v1.json';

// Presentation only: claim eligibility and rewards remain server-owned.
export function tutorialProgress(state: GameState, ordinal: number): number {
  const equipped = state.ownedHeroes.some(hero => state.team.includes(hero.uid) && getEquippedItems(hero, state.inventory).length > 0);
  return [state.totalKills, state.tutorial.openedCount, equipped ? 1 : 0, state.summons,
    state.team.length, state.summons, state.trainingCamp.heroUids.some(Boolean) ? 1 : 0,
    state.autoPot.enabled ? 1 : 0,
    state.accountLevel >= locationUnlockLevel(2) ? state.highestLocation : Math.min(1, state.highestLocation),
    Math.max(0, state.totalBossKills - state.tutorial.bossKillsAtKeyGrant)][ordinal - 1] ?? 0;
}

export function readyQuestCount(state: GameState): number {
  const ordinal = Math.max(1, Math.min(10, state.tutorial.questOrdinal));
  const tutorialReady = state.tutorial.welcomeCompleted && !state.tutorial.questCompleted
    && tutorialProgress(state, ordinal) >= contract.quests[ordinal - 1].target;
  return Number(tutorialReady) + [...state.dailyQuests, ...state.milestoneQuests]
    .filter(quest => !quest.claimed && quest.progress >= quest.target).length;
}

export function currentTutorialObjective(state: GameState) {
  if (!state.tutorial.welcomeCompleted || state.tutorial.questCompleted) return null;
  const ordinal = Math.max(1, Math.min(10, state.tutorial.questOrdinal));
  const quest = contract.quests[ordinal - 1];
  const progress = tutorialProgress(state, ordinal);
  return { label: quest.id === 'enable-auto-pot' ? 'Automatic healing' : quest.label,
    progress: Math.min(progress, quest.target), target: quest.target, ready: progress >= quest.target };
}
