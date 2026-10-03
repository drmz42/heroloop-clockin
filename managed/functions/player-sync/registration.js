export const STARTER_HERO_IDS = new Set([
  'shepherd-common',
  'assassin-common',
  'knight-common',
  'druid-common',
  'archer-common',
]);

export function buildRegisteredState(source, username, playerId, starterHeroId, heroUid, tokenBalance, now) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  if (!STARTER_HERO_IDS.has(starterHeroId)) return null;
  if (typeof heroUid !== 'string' || heroUid.length < 16) return null;

  const state = JSON.parse(JSON.stringify(source));
  const safeBalance = Math.min(1_000_000_000_000, Math.max(0, Math.floor(Number(tokenBalance) || 0)));
  state.gold = 500;
  state.hero = safeBalance;
  state.accountXp = 0;
  state.accountLevel = 1;
  state.heroCapacity = 500;
  state.ownedHeroes = [{ uid: heroUid, heroId: starterHeroId, level: 1, stars: 0, equipped: {}, xp: 0 }];
  state.team = [heroUid];
  state.inventory = [];
  state.bagSlots = [48, 0, 0, 0];
  state.chests = [];
  state.bossKeys = 0;
  state.bossBattleActive = false;
  state.battleAnimationMode = 'spectacular';
  state.chestsOpenedToday = 0;
  state.lastChestReset = now;
  state.currentLocation = 1;
  state.highestLocation = 1;
  state.lastSeen = now;
  state.combatXpAt = now;
  state.activeUntil = now + 8 * 60 * 60 * 1000;
  state.totalGoldEarned = 0;
  state.totalTokensEarned = 0;
  state.tokensEarnedToday = 0;
  state.tokenDayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
  state.totalKills = 0;
  state.totalBossKills = 0;
  state.summons = 0;
  state.summonScrolls = 0;
  state.potions = { xs: 10, sm: 0, md: 0, lg: 0, xl: 0, xxl: 0 };
  state.autoPot = { enabled: true, autoBuy: false, autoBuyTier: 'sm', autoSelectTier: true, threshold: 0.4 };
  state.tutorial = { welcomeCompleted: false, autoPotCompleted: false, chestGranted: false, chestCompleted: false, questOrdinal: 1, questCompleted: false, openedCount: 0, chestBalance: 0, bossKillsAtKeyGrant: 0 };
  state.trainingCamp = {
    heroUids: Array.from({ length: 10 }, () => null),
    unlockedSlots: 2,
    boostMultiplier: 1,
    boostEndsAt: 0,
    activeBoostKey: null,
    boostQueue: [],
    lastTick: now,
    serverAppliedPurchaseIds: [],
  };
  state.rotatingShop = Array.isArray(state.rotatingShop) ? state.rotatingShop : [];
  state.rotatingShopRefreshAt = Number.isSafeInteger(state.rotatingShopRefreshAt) ? state.rotatingShopRefreshAt : now;
  state.session = { kills: 0, bossKills: 0, chestsOpened: 0, goldToday: 0, heroToday: 0 };
  state.dailyQuests = Array.isArray(state.dailyQuests) ? state.dailyQuests : [];
  state.milestoneQuests = Array.isArray(state.milestoneQuests) ? state.milestoneQuests : [];
  state.lastQuestReset = Number.isSafeInteger(state.lastQuestReset) ? state.lastQuestReset : now;
  state.referral = { code: typeof state.referral?.code === 'string' ? state.referral.code : '', invitedUsers: [], pendingReward: 0, totalEarned: 0, alreadyClaimed: 0 };
  state.username = username;
  state.walletAddress = `game-${playerId}`;
  state.avatarHeroId = starterHeroId;
  state.boost = { active: false, progress: 0, bonusPct: 0, chestProgressSeconds: 0, goldProgressSeconds: 0, combatProgressSeconds: 0, conditions: { connectTelegram: false, connectTwitter: false, connectDiscord: false, spentTokens: 0, holdTokens: 0 } };
  state.marketListings = [];
  state.marketHistory = [];
  state.starterBalanceV2 = true;
  // Fresh accounts never held client-side Market escrow, so they start beyond
  // the legacy recovery boundary without spending an extra revision on load.
  state.compatibilityMigrations = { legacyMarketRecoveryV1: true };
  state.save_schema_version = 4;
  return state;
}
