import type { GameState, HeroClass } from './types';
import { HERO_MAP } from './heroes';
import { getEquippedItems } from './engine';
import { editionStorageKey, isolatedHackathon } from './editionStorage';

// Seeker story (Founder 2026-10-12): comic scenes are separate from the real game, and real game
// events trigger the next scene. The story itself writes no save and grants nothing; every reward
// is the ordinary server-owned Tutorial Quest claim, shown here as a story reward card.
//
//   intro   comic: betrayal, first death, first awakening            → hunt
//   hunt    REAL game: the first 3 kills in the Ashen Crypt            → gate
//   gate    comic: the road back to the gate, "Face Morvane"           → trial
//   trial   REAL battlefield: the geared hero against Morvane, a loss  → fallen
//   fallen  comic: "You came back", second awakening                   → grow
//   grow    REAL game: levels, summons, full squad, the Boss Hunt      → victory (a real Boss win)
//   victory comic: Morvane falls, the trio at the gate, Elyra's trace  → done

export type StoryStage = 'intro' | 'hunt' | 'gate' | 'trial' | 'fallen' | 'grow' | 'victory' | 'done';
/** Stages that take over the screen; the others run inside the ordinary game. */
export type StorySceneStage = 'intro' | 'gate' | 'trial' | 'fallen' | 'victory';

const STAGES: StoryStage[] = ['intro', 'hunt', 'gate', 'trial', 'fallen', 'grow', 'victory', 'done'];
export const STORY_SCENES: StorySceneStage[] = ['intro', 'gate', 'trial', 'fallen', 'victory'];
export const isStoryScene = (stage: StoryStage | null): stage is StorySceneStage => STORY_SCENES.includes(stage as StorySceneStage);

const storageKey = (account: string) => editionStorageKey(`story-box:${account}`);
const bossBaseKey = (account: string) => editionStorageKey(`story-box-boss:${account}`);
const huntBaseKey = (account: string) => editionStorageKey(`story-box-hunt:${account}`);

export function storyAccount(state: GameState): string {
  return state.walletAddress || state.username || 'local';
}

/** The story belongs to one starter hero: a reset account gets a new starter, so its story starts over. */
export function storyEpoch(state: GameState): string {
  return state.ownedHeroes[0]?.uid ?? '';
}

export function readStory(account: string, epoch = ''): StoryStage | null {
  try {
    const raw = window.localStorage.getItem(storageKey(account));
    if (!raw) return null;
    const [value, savedEpoch] = raw.split('@');
    if (epoch && savedEpoch && savedEpoch !== epoch) return null;
    // Accounts that already played the earlier one-piece Story Box keep playing normally.
    return STAGES.includes(value as StoryStage) ? value as StoryStage : 'done';
  } catch { return null; }
}

export function writeStory(account: string, stage: StoryStage, epoch = ''): void {
  try { window.localStorage.setItem(storageKey(account), epoch ? `${stage}@${epoch}` : stage); } catch { /* storage blocked: the story restarts next launch */ }
}

/** Boss kills when the second half began, so only a new real Boss win ends the story. */
export function readStoryBossBase(account: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(bossBaseKey(account)));
    return Number.isSafeInteger(value) && window.localStorage.getItem(bossBaseKey(account)) !== null ? value : null;
  } catch { return null; }
}

export function writeStoryBossBase(account: string, kills: number): void {
  try { window.localStorage.setItem(bossBaseKey(account), String(kills)); } catch { /* storage blocked */ }
}

/** Kills when the crypt stage began: combat keeps running behind the intro, so the crypt counts its own kills. */
export function readStoryHuntBase(account: string): number | null {
  try {
    const raw = window.localStorage.getItem(huntBaseKey(account));
    const value = Number(raw);
    return raw !== null && Number.isSafeInteger(value) ? value : null;
  } catch { return null; }
}

export function writeStoryHuntBase(account: string, kills: number): void {
  try { window.localStorage.setItem(huntBaseKey(account), String(kills)); } catch { /* storage blocked */ }
}

/** Settings "Replay intro story" dispatches this; App replays the opening without moving the story. */
export const STORY_BOX_REPLAY_EVENT = 'hl:story-replay';

/** `?story=replay` replays the opening; `?story=<scene>` shows one scene, for filming. */
export function storyReplayRequest(): StorySceneStage | null {
  try {
    const value = new URLSearchParams(window.location.search).get('story');
    if (value === 'replay' || window.location.hash.includes('story')) return 'intro';
    return STORY_SCENES.includes(value as StorySceneStage) ? value as StorySceneStage : null;
  } catch { return null; }
}

/** Combat starts the moment the game loads, so "new" means the first Tutorial step is not done yet
 * (fewer than 10 kills, nothing equipped, only the starter hero), not literally zero kills. */
export function isFreshStoryAccount(state: GameState): boolean {
  return state.totalKills < 10 && state.totalBossKills === 0 && !state.tutorial.questCompleted
    && state.tutorial.questOrdinal <= 1 && state.ownedHeroes.length === 1 && !heroGeared(state);
}

/** A brand-new account (first Tutorial step unfinished, only the starter hero) starts the story. */
export function storyStartStage(state: GameState): StoryStage | null {
  if (!isolatedHackathon) return null;
  const saved = readStory(storyAccount(state), storyEpoch(state));
  // A save from another starter hero means the account was reset: still on the first Tutorial step, it starts over.
  // Saves from before the hero binding carry no hero: on that same early state they are treated alike once.
  const early = state.tutorial.questOrdinal <= 1 && !state.tutorial.questCompleted && state.ownedHeroes.length === 1 && state.totalBossKills === 0;
  const unbound = (() => { try { return !(window.localStorage.getItem(storageKey(storyAccount(state))) ?? '').includes('@'); } catch { return false; } })();
  const reset = early && (!saved ? readStory(storyAccount(state)) !== null : unbound && saved !== 'intro' && saved !== 'hunt' && saved !== 'done');
  const fresh = isFreshStoryAccount(state) || reset || (early && !heroGeared(state) && !saved);
  // A reset account is fresh again while this device still remembers a later stage: start over.
  if (reset) return 'intro';
  if (saved) return saved === 'done' ? null : saved;
  return fresh ? 'intro' : null;
}

export function heroGeared(state: GameState): boolean {
  return state.ownedHeroes.some((hero) => state.team.includes(hero.uid) && getEquippedItems(hero, state.inventory).length > 0);
}

/** The next stage a real game event unlocks, or null while the player keeps playing. */
export function storyTrigger(stage: StoryStage, state: GameState, bossBase: number | null, huntBase: number | null = null): StoryStage | null {
  // The hero leaves the crypt after 3 kills made in the crypt itself (Founder 2026-10-12: keep the first fight short).
  if (stage === 'hunt' && (state.totalKills - (huntBase ?? 0) >= 3 || state.tutorial.questOrdinal >= 2 || state.tutorial.questCompleted)) return 'gate';
  if (stage === 'grow' && (state.tutorial.questCompleted || (bossBase !== null && state.totalBossKills > bossBase))) return 'victory';
  return null;
}

export const STORY_NEXT: Record<StorySceneStage, StoryStage> = {
  intro: 'hunt', gate: 'trial', trial: 'fallen', fallen: 'grow', victory: 'done',
};

export function protagonistClass(state: GameState): HeroClass {
  return (HERO_MAP[state.ownedHeroes[0]?.heroId ?? '']?.heroClass as HeroClass | undefined) ?? 'knight';
}

/** The active squad's classes, protagonist first; filming without a squad shows two companions. */
export function squadClasses(state: GameState): HeroClass[] {
  const hero = protagonistClass(state);
  const team = state.team
    .map((uid) => state.ownedHeroes.find((owned) => owned.uid === uid))
    .map((owned) => HERO_MAP[owned?.heroId ?? '']?.heroClass as HeroClass | undefined)
    .filter((heroClass): heroClass is HeroClass => Boolean(heroClass));
  const rest = team.filter((heroClass, index) => !(heroClass === hero && index === team.indexOf(hero)));
  const fallback = (['druid', 'archer', 'assassin', 'knight', 'shepherd'] as HeroClass[]).filter((heroClass) => heroClass !== hero);
  return [hero, ...(rest.length >= 2 ? rest : fallback).slice(0, 2)];
}

/** The step-1 tutorial bundle waits until the story's second death (Founder 2026-10-12). */
export function storyHoldsTutorialBundle(state: GameState): boolean {
  if (!isolatedHackathon || state.tutorial.questCompleted || state.tutorial.questOrdinal !== 1) return false;
  const stage = readStory(storyAccount(state), storyEpoch(state));
  return stage === 'intro' || stage === 'hunt' || stage === 'gate' || stage === 'trial' || stage === 'fallen';
}
