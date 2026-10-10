import type { GameState, HeroClass } from './types';
import { HERO_MAP } from './heroes';
import { editionStorageKey, isolatedHackathon } from './editionStorage';

// Story Box (Founder 2026-10-10): a self-contained, client-only intro mode shown once to new Seeker
// accounts before the ordinary Tutorial. It never writes the save, grants nothing and spends nothing;
// every number below is presentation tuning for the story, not game balance.

export type StoryBoxStage =
  | 'betrayal' | 'awaken' | 'waves' | 'chest' | 'trial' | 'awaken-again'
  | 'growth' | 'final' | 'victory' | 'clue';

export const STORY_BOX_STAGES: StoryBoxStage[] = [
  'betrayal', 'awaken', 'waves', 'chest', 'trial', 'awaken-again', 'growth', 'final', 'victory', 'clue',
];

export interface BoxFighter {
  id: string;
  name: string;
  side: 'hero' | 'enemy';
  hp: number;
  atk: number;
  def: number;
  /** Milliseconds between attacks. */
  interval: number;
  heroClass?: HeroClass;
  boss?: boolean;
}

/** All Story Box tuning in one place. */
export const STORY_BOX = {
  boss: { name: 'The Wretched Giant', hp: 9000, atk: 160, def: 30, interval: 1600, slamEvery: 3, slamMultiplier: 1.6 },
  skeleton: { name: 'Skeleton', hp: 140, atk: 18, def: 4, interval: 1300 },
  waves: 3,
  hero: {
    start: { hp: 420, atk: 46, def: 12, interval: 900 },
    geared: { hp: 520, atk: 54, def: 16, interval: 900 },
    final: { hp: 2400, atk: 210, def: 60, interval: 850 },
  },
  ally: { hp: 2000, atk: 180, def: 50, interval: 900 },
  levels: { start: 1, afterWaves: 3, final: 30 },
  zones: ['Ashen Crypt', 'Grave Road', 'Broken Gate'],
} as const;

export function boxPower(stats: { hp: number; atk: number; def: number }): number {
  return Math.round(stats.hp / 4 + stats.atk * 2 + stats.def * 2);
}

// ── Eligibility and local progress ─────────────────────────────────────────

const storageKey = (account: string) => editionStorageKey(`story-box:${account}`);

export function storyBoxAccount(state: GameState): string {
  return state.walletAddress || state.username || 'local';
}

export function readStoryBox(account: string): StoryBoxStage | 'done' | null {
  try {
    const value = window.localStorage.getItem(storageKey(account));
    if (value === 'done') return 'done';
    return STORY_BOX_STAGES.includes(value as StoryBoxStage) ? value as StoryBoxStage : null;
  } catch { return null; }
}

export function writeStoryBox(account: string, value: StoryBoxStage | 'done'): void {
  try { window.localStorage.setItem(storageKey(account), value); } catch { /* storage blocked: the box restarts next launch */ }
}

/** `?story=replay` (or `#story`) replays the box for filming on any account. */
export function storyBoxReplayRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('story') === 'replay' || window.location.hash.includes('story');
  } catch { return false; }
}

/**
 * Only a brand-new account (no kill, first Tutorial step, only the starter hero) starts the box;
 * an interrupted box resumes at its saved stage. Existing players never see it.
 */
export function storyBoxStartStage(state: GameState): StoryBoxStage | null {
  if (!isolatedHackathon) return null;
  if (storyBoxReplayRequested()) return 'betrayal';
  const saved = readStoryBox(storyBoxAccount(state));
  if (saved === 'done') return null;
  if (saved) return saved;
  const fresh = state.totalKills === 0 && state.totalBossKills === 0 && !state.tutorial.questCompleted
    && state.tutorial.questOrdinal <= 1 && state.ownedHeroes.length === 1;
  return fresh ? 'betrayal' : null;
}

export function protagonistClass(state: GameState): HeroClass {
  return (HERO_MAP[state.ownedHeroes[0]?.heroId ?? '']?.heroClass as HeroClass | undefined) ?? 'knight';
}

/** Two recruits of other classes; never the protagonist's class. */
export function recruitClasses(protagonist: HeroClass): [HeroClass, HeroClass] {
  const order: HeroClass[] = ['druid', 'archer', 'assassin', 'knight', 'shepherd'];
  const [first, second] = order.filter((heroClass) => heroClass !== protagonist);
  return [first, second];
}

export const CLASS_LABEL: Record<HeroClass, string> = {
  knight: 'Warrior', shepherd: 'Mage', assassin: 'Assassin', druid: 'Druid', archer: 'Ranger',
};

// ── Deterministic box combat ───────────────────────────────────────────────

export interface BoxHit {
  at: number;
  from: string;
  to: string;
  amount: number;
  crit: boolean;
  slam: boolean;
}

export interface BoxFight {
  hits: BoxHit[];
  deaths: { at: number; id: string }[];
  duration: number;
  won: boolean;
}

function seeded(seed: number) {
  let state = (seed | 0) || 0x6d2b79f5;
  return () => {
    state = state + 0x6d2b79f5 | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Pre-resolves a whole fight so the outcome follows from the numbers; the UI then replays it.
 * Heroes strike the first living enemy; a boss strikes a random living hero and every
 * `slamEvery`-th attack slams all heroes.
 */
export function resolveBoxFight(fighters: BoxFighter[], seed: number, maxMs = 60_000): BoxFight {
  const random = seeded(seed);
  const units = fighters.map((fighter, index) => ({ ...fighter, current: fighter.hp, timer: fighter.interval * (fighter.side === 'enemy' ? 0.35 : 0.55 + index * 0.12), attacks: 0 }));
  const hits: BoxHit[] = [];
  const deaths: { at: number; id: string }[] = [];
  const alive = (side: 'hero' | 'enemy') => units.filter((unit) => unit.side === side && unit.current > 0);
  const strike = (from: typeof units[number], to: typeof units[number], at: number, multiplier: number, slam: boolean) => {
    const crit = random() < 0.12;
    const roll = 0.9 + random() * 0.2;
    const amount = Math.max(1, Math.round((from.atk * roll * multiplier - to.def * 0.5) * (crit ? 1.6 : 1)));
    to.current = Math.max(0, to.current - amount);
    hits.push({ at, from: from.id, to: to.id, amount, crit, slam });
    if (to.current === 0) deaths.push({ at, id: to.id });
  };
  let at = 0;
  const step = 50;
  while (at < maxMs && alive('hero').length && alive('enemy').length) {
    at += step;
    for (const unit of units) {
      if (unit.current <= 0) continue;
      unit.timer -= step;
      if (unit.timer > 0) continue;
      unit.timer += unit.interval;
      unit.attacks += 1;
      if (unit.side === 'hero') {
        const target = alive('enemy')[0];
        if (target) strike(unit, target, at, 1, false);
      } else if (unit.boss && unit.attacks % STORY_BOX.boss.slamEvery === 0) {
        for (const target of alive('hero')) strike(unit, target, at, STORY_BOX.boss.slamMultiplier, true);
      } else {
        const targets = alive('hero');
        const target = targets[Math.floor(random() * targets.length)];
        if (target) strike(unit, target, at, 1, false);
      }
      if (!alive('hero').length || !alive('enemy').length) break;
    }
  }
  return { hits, deaths, duration: at, won: alive('enemy').length === 0 && alive('hero').length > 0 };
}
