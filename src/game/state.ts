import type { GameState, OwnedHero, DailyQuest } from './types';
import { generateRotatingShop } from './items';

const STORAGE_KEY = 'afk-heroes-save-v5';

export const STARTER_HERO_ID = 'ironfoot';
export const RESPAWN_TIME_MS = 15_000;
export const MAX_TEAM = 3;
export const MAX_INVENTORY = 64;
export const MAX_CHESTS = 500;
export const ROTATING_REFRESH_MS = 4 * 60 * 60 * 1000;
export const STARTING_HERO_TOKENS = 60;
export const SUMMON_COST_HERO = 30;

export function makeReferralCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export interface UserProfile {
  username: string;
  walletAddress: string;
  referralCode: string;
  referredBy?: string;
  createdAt: number;
}

let uidCounter = 0;
export function genUid(): string {
  uidCounter += 1;
  return `h${Date.now().toString(36)}${uidCounter}`;
}

function isSameDay(t1: number, t2: number): boolean {
  const d1 = new Date(t1); const d2 = new Date(t2);
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

export function generateDailyQuests(): DailyQuest[] {
  return [
    { id: 'kill-50', label: 'Defeat 50 enemies', target: 50, progress: 0, reward: { gold: 200, hero: 1 }, claimed: false },
    { id: 'kill-200', label: 'Defeat 200 enemies', target: 200, progress: 0, reward: { gold: 500, hero: 3 }, claimed: false },
    { id: 'boss-1', label: 'Defeat a boss', target: 1, progress: 0, reward: { gold: 300, hero: 2 }, claimed: false },
    { id: 'chest-5', label: 'Open 5 chests', target: 5, progress: 0, reward: { gold: 150, hero: 1 }, claimed: false },
    { id: 'summon-1', label: 'Summon a hero', target: 1, progress: 0, reward: { gold: 100, hero: 1 }, claimed: false },
  ];
}

export function makeInitialState(): GameState {
  const hero: OwnedHero = {
    uid: genUid(),
    heroId: STARTER_HERO_ID,
    level: 1,
    stars: 0,
    equipped: {},
    xp: 0,
  };
  const shop = generateRotatingShop().map((s) => ({ ...s, sold: false }));
  const now = Date.now();
  return {
    gold: 100,
    hero: STARTING_HERO_TOKENS,
    accountXp: 0,
    accountLevel: 1,
    ownedHeroes: [hero],
    team: [hero.uid],
    inventory: [],
    chests: [],
    chestsOpenedToday: 0,
    lastChestReset: now,
    currentLocation: 1,
    highestLocation: 1,
    lastSeen: now,
    totalGoldEarned: 0,
    totalTokensEarned: 0,
    totalKills: 0,
    summons: 0,
    potions: { xs: 10, sm: 0, md: 0, lg: 0, xl: 0, xxl: 0 },
    autoPot: { enabled: true, autoBuy: false, autoBuyTier: 'sm', autoSelectTier: true, threshold: 0.4 },
    rotatingShop: shop,
    rotatingShopRefreshAt: now + ROTATING_REFRESH_MS,
    session: { kills: 0, bossKills: 0, chestsOpened: 0, goldToday: 0, heroToday: 0 },
    dailyQuests: generateDailyQuests(),
    lastQuestReset: now,
    referral: { code: makeReferralCode(), invitedUsers: [], pendingReward: 0, totalEarned: 0, alreadyClaimed: 0 },
    username: '',
    walletAddress: '',
    boost: { active: false, progress: 0, bonusPct: 0, conditions: { connectTelegram: false, connectTwitter: false, connectDiscord: false, spentTokens: 0, holdTokens: 0 } },
    starterBalanceV2: true,
  };
}

// ── XP curves ────────────────────────────────────────────────────────────
export function accountXpForLevel(level: number): number {
  // Progression target at the baseline combat rate:
  // day 1 ≈ level 20, day 2 ≈ +9 levels, then a gradual slowdown
  // toward roughly 3 levels/day. Values remain subject to economy simulation.
  if (level < 20) return Math.round(1800 + level * 85);
  if (level < 29) return Math.round(5200 + (level - 20) * 180);
  return Math.min(18_000, Math.round(7000 + (level - 29) * 550));
}

export function accountLevelFromXp(xp: number): number {
  let lvl = 1;
  let need = accountXpForLevel(1);
  let acc = 0;
  while (xp >= acc + need) {
    acc += need;
    lvl++;
    need = accountXpForLevel(lvl);
  }
  return lvl;
}

// Hero XP — slower, ~level 50 in a month per hero
const HERO_BASE = 60;
const HERO_GROWTH = 1.095;
export function heroXpForLevel(level: number): number {
  return Math.round(HERO_BASE * Math.pow(HERO_GROWTH, level - 1));
}

export function heroLevelFromXp(xp: number): { level: number; remaining: number } {
  let lvl = 1;
  let need = heroXpForLevel(1);
  let acc = 0;
  while (xp >= acc + need) {
    acc += need;
    lvl++;
    need = heroXpForLevel(lvl);
  }
  return { level: lvl, remaining: xp - acc };
}

export const STAR_DUPES = [0, 1, 2, 3, 6, 10];
export function starUpCost(stars: number): { dupes: number; hero: number } {
  const dupes = STAR_DUPES[stars + 1] ?? 999;
  const heroCost = [0, 0, 1, 2, 4, 8][stars + 1] ?? 99;
  return { dupes, hero: heroCost };
}

export function summonCostHero(): number {
  return SUMMON_COST_HERO;
}

export function loadState(): GameState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return makeInitialState();
    const parsed = JSON.parse(raw) as Partial<GameState>;
    if (!parsed.ownedHeroes || parsed.ownedHeroes.length === 0) return makeInitialState();
    const heroes = parsed.ownedHeroes.map((h) => ({
      ...h,
      equipped: h.equipped ?? {},
      xp: h.xp ?? 0,
      locked: h.locked ?? false,
    }));
    const inventory = (parsed.inventory ?? []).map((i) => ({
      ...i,
      locked: i.locked ?? false,
      enchantLevel: i.enchantLevel ?? 0,
      rerollCount: i.rerollCount ?? 0,
    }));
    const base = makeInitialState();
    const now = Date.now();
    // reset daily counters
    const sameDay = parsed.lastChestReset ? isSameDay(parsed.lastChestReset, now) : false;
    const questSameDay = parsed.lastQuestReset ? isSameDay(parsed.lastQuestReset, now) : false;
    return {
      ...base,
      ...parsed,
      ownedHeroes: heroes,
      inventory,
      chests: parsed.chests ?? [],
      chestsOpenedToday: sameDay ? (parsed.chestsOpenedToday ?? 0) : 0,
      lastChestReset: sameDay ? (parsed.lastChestReset ?? now) : now,
      potions: {
        ...base.potions,
        ...(parsed.potions ?? {}),
        xs: parsed.starterBalanceV2 ? (parsed.potions?.xs ?? 0) : (parsed.potions?.xs ?? 3) + 7,
      },
      autoPot: { ...base.autoPot, ...(parsed.autoPot ?? {}), enabled: parsed.starterBalanceV2 ? (parsed.autoPot?.enabled ?? true) : true },
      rotatingShop: parsed.rotatingShop?.length ? parsed.rotatingShop : base.rotatingShop,
      hero: parsed.hero ?? STARTING_HERO_TOKENS,
      accountXp: parsed.accountXp ?? 0,
      accountLevel: parsed.accountLevel ?? 1,
      totalKills: parsed.totalKills ?? 0,
      currentLocation: parsed.currentLocation ?? 1,
      highestLocation: parsed.highestLocation ?? 1,
      session: parsed.session ?? base.session,
      dailyQuests: questSameDay ? (parsed.dailyQuests ?? base.dailyQuests) : generateDailyQuests(),
      lastQuestReset: questSameDay ? (parsed.lastQuestReset ?? now) : now,
      referral: parsed.referral ?? base.referral,
      username: parsed.username ?? '',
      walletAddress: parsed.walletAddress ?? '',
      starterBalanceV2: true,
    };
  } catch {
    return makeInitialState();
  }
}

export function saveState(state: GameState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, lastSeen: Date.now() }));
  } catch { /* ignore */ }
}

export function formatNum(n: number): string {
  if (n < 1000) return Math.floor(n).toString();
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'K';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  return (n / 1_000_000_000).toFixed(2) + 'B';
}

export function heroSellValue(rarity: string, stars: number): number {
  const base: Record<string, number> = {
    common: 15, uncommon: 40, rare: 100, epic: 250, legendary: 700,
    mythic: 1800, relic: 5000, cursed: 15000, cosmic: 40000, divine: 150000,
  };
  return Math.round((base[rarity] ?? 15) * (1 + stars * 0.3));
}
