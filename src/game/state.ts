import type { GameState, OwnedHero, DailyQuest, ItemSlot, TrainingBoostKey, Rarity } from './types';
import { generateRotatingShop, itemPower } from './items';
import { emptyBalanceTelemetry, BALANCE_VERSION } from './balance';
import { MAX_ENCHANT_LEVEL } from './enchant';

const STORAGE_KEY = 'afk-heroes-save-v7';

export const STARTER_HERO_ID = 'shepherd-common';
export const RESPAWN_TIME_MS = 15_000;
export const MAX_TEAM = 3;
export const BASE_HERO_CAPACITY = 500;
export const MAX_HERO_CAPACITY = 1_000;
export const HERO_CAPACITY_STEP = 100;
export const HERO_CAPACITY_UPGRADE_USD_CENTS = [100, 200, 300, 400, 500] as const;
export const MAX_INVENTORY = 64;
export const MAX_CHESTS = 500;
export const ROTATING_REFRESH_MS = 4 * 60 * 60 * 1000;
export const STARTING_HERO_TOKENS = 0;
const LEGACY_MISSING_HERO_TOKENS = 20_000;
export const STARTING_GOLD = 500;
export const ACTIVE_SESSION_MS = 8 * 60 * 60 * 1000;
export const SUMMON_COST_HERO = 30;
export const TRAINING_SLOT_COSTS = [0, 0, 50, 100, 200, 400, 800, 1_600, 3_200, 6_400] as const;
export const TRAINING_BOOST_COSTS = {
  '2x-1h': 25,
  '2x-4h': 80,
  '4x-1h': 60,
  '4x-4h': 200,
} as const;
const TRAINING_BOOST_KEYS = Object.keys(TRAINING_BOOST_COSTS) as TrainingBoostKey[];

export function trainingTokenPenalty(heroCount: number): number {
  if (heroCount >= 5) return 0.9;
  return [0, 0.1, 0.25, 0.5, 0.75][Math.max(0, Math.floor(heroCount))] ?? 0;
}

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
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  uidCounter += 1;
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${uidCounter}`;
}

function isSameDay(t1: number, t2: number): boolean {
  const d1 = new Date(t1); const d2 = new Date(t2);
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

export function moscowDayKey(timestamp = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function generateDailyQuests(): DailyQuest[] {
  return [
    { id: 'kill-1000', kind: 'daily', label: 'Defeat 1,000 enemies', target: 1_000, progress: 0, reward: { gold: 1_000, hero: 2 }, claimed: false },
    { id: 'kill-10000', kind: 'daily', label: 'Defeat 10,000 enemies', target: 10_000, progress: 0, reward: { gold: 5_000, hero: 8 }, claimed: false },
    { id: 'boss-1', kind: 'daily', label: 'Defeat 1 boss', target: 1, progress: 0, reward: { gold: 500, hero: 2 }, claimed: false },
    { id: 'boss-3', kind: 'daily', label: 'Defeat 3 bosses', target: 3, progress: 0, reward: { gold: 2_000, hero: 5 }, claimed: false },
    { id: 'chest-50', kind: 'daily', label: 'Open 50 chests', target: 50, progress: 0, reward: { gold: 1_000, hero: 2 }, claimed: false },
    { id: 'chest-250', kind: 'daily', label: 'Open 250 chests', target: 250, progress: 0, reward: { gold: 4_000, hero: 6 }, claimed: false },
    { id: 'summon-1', kind: 'daily', label: 'Summon 1 hero', target: 1, progress: 0, reward: { gold: 300, hero: 1 }, claimed: false },
    { id: 'summon-10', kind: 'daily', label: 'Summon 10 heroes', target: 10, progress: 0, reward: { gold: 1_500, hero: 3 }, claimed: false },
    { id: 'summon-50', kind: 'daily', label: 'Summon 50 heroes', target: 50, progress: 0, reward: { gold: 5_000, hero: 10 }, claimed: false },
  ];
}

const MILESTONE_TARGETS: Record<string, { label: string; targets: number[] }> = {
  chest: { label: 'Open {n} chests', targets: [1_000, 5_000, 25_000] },
  kill: { label: 'Defeat {n} enemies', targets: [50_000, 250_000, 1_000_000] },
  boss: { label: 'Defeat {n} bosses', targets: [25, 100, 500] },
  summon: { label: 'Summon {n} heroes', targets: [10, 100, 1_000, 10_000] },
  'token-earned': { label: 'Earn {n} $HERO', targets: [1_000, 10_000, 100_000] },
  'token-spent': { label: 'Spend {n} $HERO', targets: [500, 5_000, 50_000] },
  'gold-earned': { label: 'Earn {n} Gold', targets: [100_000, 1_000_000, 10_000_000] },
  'hero-owned': { label: 'Own {n} heroes', targets: [25, 100, 200] },
};

export function milestoneQuest(chain: string, tier = 0, progress = 0): DailyQuest | null {
  const definition = MILESTONE_TARGETS[chain];
  const target = definition?.targets[tier];
  if (!definition || target === undefined) return null;
  const summonScrollRewards = [1, 5, 10, 50];
  return {
    id: `milestone-${chain}-${target}`, kind: 'milestone', chain, tier,
    label: definition.label.replace('{n}', target.toLocaleString('en-US')),
    target,
    progress,
    reward: chain === 'summon'
      ? { gold: 0, hero: 0, summonScrolls: summonScrollRewards[tier] }
      : { gold: Math.max(2_500, Math.floor(target / 10)), hero: 5 * (tier + 1) },
    claimed: false,
  };
}

export function generateMilestoneQuests(): DailyQuest[] {
  return Object.keys(MILESTONE_TARGETS).map((chain) => milestoneQuest(chain)).filter((quest): quest is DailyQuest => Boolean(quest));
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
    gold: STARTING_GOLD,
    hero: STARTING_HERO_TOKENS,
    accountXp: 0,
    accountLevel: 1,
    heroCapacity: BASE_HERO_CAPACITY,
    ownedHeroes: [hero],
    team: [hero.uid],
    inventory: [],
    chests: [],
    bossKeys: 0,
    bossBattleActive: false,
    battleAnimationMode: 'light',
    chestsOpenedToday: 0,
    lastChestReset: now,
    currentLocation: 1,
    highestLocation: 1,
    lastSeen: now,
    combatXpAt: now,
    activeUntil: now + ACTIVE_SESSION_MS,
    totalGoldEarned: 0,
    totalTokensEarned: 0,
    tokensEarnedToday: 0,
    tokenDayKey: moscowDayKey(now),
    totalKills: 0,
    totalBossKills: 0,
    summons: 0,
    summonScrolls: 0,
    potions: { xs: 10, sm: 0, md: 0, lg: 0, xl: 0, xxl: 0 },
    autoPot: { enabled: true, autoBuy: false, autoBuyTier: 'sm', autoSelectTier: true, threshold: 0.4 },
    tutorial: { welcomeCompleted: false, autoPotCompleted: false, chestGranted: false, chestCompleted: false, questOrdinal: 1, questCompleted: false, openedCount: 0, chestBalance: 0, bossKillsAtKeyGrant: 0 },
    trainingCamp: {
      heroUids: Array.from({ length: 10 }, () => null),
      unlockedSlots: 2,
      boostMultiplier: 1,
      boostEndsAt: 0,
      activeBoostKey: null,
      boostQueue: [],
      lastTick: now,
    },
    rotatingShop: shop,
    rotatingShopRefreshAt: now + ROTATING_REFRESH_MS,
    session: { kills: 0, bossKills: 0, chestsOpened: 0, goldToday: 0, heroToday: 0 },
    dailyQuests: generateDailyQuests(),
    milestoneQuests: generateMilestoneQuests(),
    lastQuestReset: now,
    referral: { code: makeReferralCode(), invitedUsers: [], pendingReward: 0, totalEarned: 0, alreadyClaimed: 0 },
    username: '',
    walletAddress: '',
    avatarHeroId: hero.heroId,
    boost: { active: false, progress: 0, bonusPct: 0, chestProgressSeconds: 0, goldProgressSeconds: 0, combatProgressSeconds: 0, conditions: { connectTelegram: false, connectTwitter: false, connectDiscord: false, spentTokens: 0, holdTokens: 0 } },
    balanceTelemetry: emptyBalanceTelemetry(),
    marketListings: [],
    marketHistory: [],
    starterBalanceV2: true,
  };
}

export function makeRegisteredStarterState(username: string, walletAddress: string, starterHeroId: string): GameState {
  const initial = makeInitialState();
  const starter = { ...initial.ownedHeroes[0], heroId: starterHeroId };
  return {
    ...initial,
    username,
    walletAddress,
    ownedHeroes: [starter],
    team: [starter.uid],
    avatarHeroId: starterHeroId,
    tutorial: { ...initial.tutorial, welcomeCompleted: false },
  };
}

// ── XP curves ────────────────────────────────────────────────────────────
export function accountXpForLevel(level: number): number {
  if (level < 20) return Math.round(1800 + level * 85);
  if (level < 29) return Math.round(10_400 + (level - 20) * 360);
  return Math.min(36_000, Math.round(14_000 + (level - 29) * 1_100));
}

export const MAX_LEVEL = 99;
export const MAX_ACCOUNT_XP = Array.from({ length: MAX_LEVEL - 1 }, (_, index) => accountXpForLevel(index + 1)).reduce((sum, need) => sum + need, 0);

export function accountLevelFromXp(xp: number): number {
  let lvl = 1;
  let need = accountXpForLevel(1);
  let acc = 0;
  while (lvl < MAX_LEVEL && Math.min(MAX_ACCOUNT_XP, Math.max(0, xp)) >= acc + need) {
    acc += need;
    lvl++;
    need = accountXpForLevel(lvl);
  }
  return lvl;
}

export function accountXpProgress(xp: number, level: number): number {
  let levelStartXp = 0;
  for (let current = 1; current < level; current++) {
    levelStartXp += accountXpForLevel(current);
  }
  return Math.max(0, xp - levelStartXp);
}

export function heroXpForLevel(level: number): number {
  return Math.max(1, Math.round(accountXpForLevel(level) / 1.3));
}

export function advanceHeroXp(level: number, currentXp: number, gainedXp: number): { level: number; remaining: number } {
  let nextLevel = Math.max(1, Math.min(MAX_LEVEL, level));
  let remaining = Math.max(0, currentXp) + Math.max(0, gainedXp);
  while (nextLevel < MAX_LEVEL && remaining >= heroXpForLevel(nextLevel)) {
    remaining -= heroXpForLevel(nextLevel);
    nextLevel++;
  }
  return { level: nextLevel, remaining: nextLevel >= MAX_LEVEL ? 0 : remaining };
}

export const MAX_HERO_STARS = 20;
export const STAR_DUPLICATE_BANDS: Partial<Record<Rarity, readonly [number, number, number, number]>> = {
  common: [12, 24, 36, 48],
  uncommon: [11, 23, 35, 47],
  rare: [5, 10, 14, 17],
  epic: [5, 9, 13, 17],
  legendary: [4, 8, 11, 13],
  mythic: [3, 5, 8, 12],
  cosmic: [2, 3, 4, 5],
  divine: [2, 2, 2, 2],
  celestial: [1, 1, 1, 1],
};
export const STAGING_HERO_USD_MICROS = 1_000;
export function heroCapacityUpgradeCost(capacity: number): { nextCapacity: number; usdCents: number } | null {
  const normalized = BASE_HERO_CAPACITY + Math.floor((capacity - BASE_HERO_CAPACITY) / HERO_CAPACITY_STEP) * HERO_CAPACITY_STEP;
  const tier = (normalized - BASE_HERO_CAPACITY) / HERO_CAPACITY_STEP;
  const usdCents = HERO_CAPACITY_UPGRADE_USD_CENTS[tier];
  if (normalized < BASE_HERO_CAPACITY || normalized >= MAX_HERO_CAPACITY || usdCents === undefined) return null;
  return {
    nextCapacity: normalized + HERO_CAPACITY_STEP,
    usdCents,
  };
}
export const STAR_UP_BASE_USD_CENTS: Partial<Record<Rarity, number>> = {
  common: 1,
  uncommon: 2,
  rare: 4,
  epic: 8,
  legendary: 12,
  mythic: 16,
  cosmic: 20,
  divine: 30,
  celestial: 45,
};
export function starUpCost(stars: number, rarity: Rarity): { dupes: number; hero: number; usdCents: number } {
  const nextStar = Math.max(1, Math.min(MAX_HERO_STARS, Math.floor(stars) + 1));
  const bands = STAR_DUPLICATE_BANDS[rarity];
  const dupes = bands?.[Math.min(3, Math.floor((nextStar - 1) / 5))] ?? 999;
  const baseUsdCents = STAR_UP_BASE_USD_CENTS[rarity];
  if (!baseUsdCents) return { dupes, hero: Number.MAX_SAFE_INTEGER, usdCents: 0 };
  const usdCents = baseUsdCents * nextStar;
  const heroCost = Math.ceil((usdCents * 10_000) / STAGING_HERO_USD_MICROS);
  return { dupes, hero: heroCost, usdCents };
}

export function summonCostHero(): number {
  return SUMMON_COST_HERO;
}

export function normalizeState(parsed: Partial<GameState>): GameState {
  try {
    if (!parsed.ownedHeroes || parsed.ownedHeroes.length === 0) return makeInitialState();
    const itemUids = new Set<string>();
    const inventory = (parsed.inventory ?? []).map((i) => {
      const uid = i.uid && !itemUids.has(i.uid) ? i.uid : genUid();
      itemUids.add(uid);
      const enchantLevel = Math.max(0, Math.min(MAX_ENCHANT_LEVEL, i.enchantLevel ?? 0));
      const storedStats = i.stats ?? [];
      const version = 4 as const;
      const powerFromStoredStats = itemPower(storedStats, enchantLevel, version);
      const legacyStatsWereCompounded = enchantLevel > 0
        && i.enchantStatsVersion !== 2 && i.enchantStatsVersion !== 3 && i.enchantStatsVersion !== 4
        && powerFromStoredStats > (i.power ?? 0) * 1.03 + 2;
      const legacyMultiplier = legacyStatsWereCompounded
        ? Array.from({ length: enchantLevel }, (_, index) => 1 + (index + 1) * 0.10).reduce((total, multiplier) => total * multiplier, 1)
        : 1;
      const stats = legacyStatsWereCompounded ? storedStats.map((stat) => ({
        ...stat,
        value: stat.isPercent
          ? Math.round((stat.value / legacyMultiplier) * 1000) / 1000
          : Math.round(stat.value / legacyMultiplier),
      })) : storedStats;
      return ({
      ...i, uid,
      itemId: /^shield-(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial)$/.test(i.itemId)
        ? i.itemId.replace('shield-', 'offhand-warrior-')
        : i.itemId,
      locked: i.locked ?? false,
      stats,
      power: itemPower(stats, enchantLevel, version),
      enchantLevel,
      enchantStatsVersion: version,
      rerollCount: i.rerollCount ?? 0,
    });
    });
    const heroUids = new Set<string>();
    const heroes = parsed.ownedHeroes.map((h) => {
      const uid = h.uid && !heroUids.has(h.uid) ? h.uid : genUid();
      heroUids.add(uid);
      const old = h.equipped ?? {};
      const equipped: Partial<Record<ItemSlot, string>> = { ...old };
      if (old.weapon && !equipped.class_weapon) equipped.class_weapon = old.weapon;
      if (old.armor && !equipped.chest) equipped.chest = old.armor;
      const oldSecondItem = old.ring2 ? inventory.find((item) => item.uid === old.ring2) : undefined;
      if (oldSecondItem?.itemId.startsWith('offhand-warrior-')) equipped.offhand = old.ring2;
      if (!equipped.ring) equipped.ring = old.ring1 ?? (oldSecondItem?.itemId.startsWith('offhand-') ? undefined : old.ring2);
      delete equipped.weapon; delete equipped.armor; delete equipped.ring1; delete equipped.ring2;
      const level = Math.max(1, Math.min(MAX_LEVEL, h.level ?? 1));
      return { ...h, uid, equipped, level, xp: level >= MAX_LEVEL ? 0 : Math.max(0, h.xp ?? 0), locked: h.locked ?? false, stars: Math.max(0, Math.min(MAX_HERO_STARS, h.stars ?? 0)) };
    });
    const accountXp = Math.max(0, Math.min(MAX_ACCOUNT_XP, parsed.accountXp ?? 0));
    const accountLevel = Math.max(1, Math.min(MAX_LEVEL, parsed.accountLevel ?? accountLevelFromXp(accountXp)));
    const sanitizedHeroes = heroes.map((hero) => {
      const equipped = { ...hero.equipped };
      for (const [slot, itemUid] of Object.entries(equipped)) {
        const item = itemUid ? inventory.find((owned) => owned.uid === itemUid) : undefined;
        if (item && item.level > accountLevel) delete equipped[slot as ItemSlot];
      }
      return equipped !== hero.equipped ? { ...hero, equipped } : hero;
    });
    const validHeroUids = new Set(sanitizedHeroes.map((hero) => hero.uid));
    const team = [...new Set(parsed.team ?? [])]
      .filter((uid): uid is string => typeof uid === 'string' && validHeroUids.has(uid))
      .slice(0, MAX_TEAM);
    const base = makeInitialState();
    const now = Date.now();
    // reset daily counters
    const sameDay = parsed.lastChestReset ? isSameDay(parsed.lastChestReset, now) : false;
    const questSameDay = parsed.lastQuestReset ? isSameDay(parsed.lastQuestReset, now) : false;
    return {
      ...base,
      ...parsed,
      ownedHeroes: sanitizedHeroes,
      team,
      inventory,
      chests: parsed.chests ?? [],
      bossKeys: parsed.bossKeys ?? 0,
      bossBattleActive: false,
      battleAnimationMode: parsed.battleAnimationMode === 'spectacular' || parsed.battleAnimationMode === 'off' ? parsed.battleAnimationMode : 'light',
      chestsOpenedToday: sameDay ? (parsed.chestsOpenedToday ?? 0) : 0,
      lastChestReset: sameDay ? (parsed.lastChestReset ?? now) : now,
      potions: {
        ...base.potions,
        ...(parsed.potions ?? {}),
        xs: parsed.starterBalanceV2 ? (parsed.potions?.xs ?? 0) : (parsed.potions?.xs ?? 3) + 7,
      },
      autoPot: { ...base.autoPot, ...(parsed.autoPot ?? {}), enabled: parsed.starterBalanceV2 ? (parsed.autoPot?.enabled ?? true) : true },
      tutorial: {
        ...base.tutorial,
        ...(parsed.tutorial ?? {}),
        // Existing saves have already completed account creation; only a fresh registration starts the welcome guide.
        welcomeCompleted: parsed.tutorial?.welcomeCompleted ?? true,
      },
      trainingCamp: {
        ...base.trainingCamp,
        ...(parsed.trainingCamp ?? {}),
        heroUids: Array.from({ length: 10 }, (_, index) => parsed.trainingCamp?.heroUids?.[index] ?? null),
        unlockedSlots: Math.max(2, Math.min(10, parsed.trainingCamp?.unlockedSlots ?? 2)),
        activeBoostKey: TRAINING_BOOST_KEYS.includes(parsed.trainingCamp?.activeBoostKey as TrainingBoostKey)
          ? parsed.trainingCamp?.activeBoostKey as TrainingBoostKey
          : null,
        boostQueue: (parsed.trainingCamp?.boostQueue ?? []).filter((entry) =>
          TRAINING_BOOST_KEYS.includes(entry.key)
          && (entry.multiplier === 2 || entry.multiplier === 4)
          && Number.isFinite(entry.durationMs)
          && entry.durationMs > 0
          && entry.durationMs <= 4 * 60 * 60 * 1000
        ),
        serverAppliedPurchaseIds: (parsed.trainingCamp?.serverAppliedPurchaseIds ?? [])
          .filter((id): id is string => typeof id === 'string')
          .slice(-200),
      },
      rotatingShop: parsed.rotatingShop?.length ? parsed.rotatingShop : base.rotatingShop,
      hero: parsed.hero ?? LEGACY_MISSING_HERO_TOKENS,
      accountXp,
      accountLevel,
      heroCapacity: Math.min(
        MAX_HERO_CAPACITY,
        BASE_HERO_CAPACITY + Math.floor((Math.max(BASE_HERO_CAPACITY, parsed.heroCapacity ?? BASE_HERO_CAPACITY) - BASE_HERO_CAPACITY) / HERO_CAPACITY_STEP) * HERO_CAPACITY_STEP,
      ),
      totalKills: parsed.totalKills ?? 0,
      totalBossKills: parsed.totalBossKills ?? parsed.session?.bossKills ?? 0,
      summonScrolls: Math.max(0, Math.floor(parsed.summonScrolls ?? 0)),
      tokensEarnedToday: parsed.tokenDayKey === moscowDayKey(now) ? (parsed.tokensEarnedToday ?? 0) : 0,
      tokenDayKey: moscowDayKey(now),
      currentLocation: parsed.currentLocation ?? 1,
      highestLocation: parsed.highestLocation ?? 1,
      combatXpAt: Math.max(0, Number(parsed.combatXpAt ?? parsed.lastSeen ?? now) || now),
      activeUntil: parsed.activeUntil ?? ((parsed.lastSeen ?? now) + ACTIVE_SESSION_MS),
      session: parsed.session ?? base.session,
      dailyQuests: questSameDay && parsed.dailyQuests?.some((quest) => quest.id === 'kill-1000') ? parsed.dailyQuests : generateDailyQuests(),
      milestoneQuests: (parsed.milestoneQuests ?? generateMilestoneQuests()).map((quest) =>
        quest.kind === 'milestone' && quest.chain
          ? milestoneQuest(
              quest.chain,
              quest.chain === 'summon' && MILESTONE_TARGETS.summon.targets[quest.tier ?? 0] !== quest.target ? 0 : (quest.tier ?? 0),
              quest.chain === 'summon' ? (parsed.summons ?? 0) : quest.progress,
            ) ?? quest
          : quest
      ),
      lastQuestReset: questSameDay ? (parsed.lastQuestReset ?? now) : now,
      referral: parsed.referral ?? base.referral,
      boost: {
        ...base.boost,
        ...(parsed.boost ?? {}),
        chestProgressSeconds: Math.max(0, Number(parsed.boost?.chestProgressSeconds) || 0),
        goldProgressSeconds: Math.max(0, Number(parsed.boost?.goldProgressSeconds) || 0),
        combatProgressSeconds: Math.max(0, Number(parsed.boost?.combatProgressSeconds) || 0),
        conditions: { ...base.boost.conditions, ...(parsed.boost?.conditions ?? {}) },
      },
      balanceTelemetry: parsed.balanceTelemetry?.version === BALANCE_VERSION
        ? parsed.balanceTelemetry
        : emptyBalanceTelemetry(),
      marketListings: parsed.marketListings ?? [],
      marketHistory: parsed.marketHistory ?? [],
      username: parsed.username ?? '',
      walletAddress: parsed.walletAddress ?? '',
      avatarHeroId: parsed.avatarHeroId && sanitizedHeroes.some((hero) => hero.heroId === parsed.avatarHeroId)
        ? parsed.avatarHeroId
        : sanitizedHeroes[0].heroId,
      starterBalanceV2: true,
    };
  } catch {
    return makeInitialState();
  }
}

export function loadState(): GameState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw) as Partial<GameState>) : makeInitialState();
  } catch { return makeInitialState(); }
}

export function saveLegacyState(state: GameState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* server migration will report the failure */ }
}

export function clearLegacyState(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

export function formatNum(n: number): string {
  if (n < 1000) return Math.floor(n).toString();
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'K';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  return (n / 1_000_000_000).toFixed(2) + 'B';
}
