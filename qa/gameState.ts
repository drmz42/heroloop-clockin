import { HEROES } from '../src/game/heroes';
import { ITEMS } from '../src/game/items';
import { accountXpForLevel, makeInitialState } from '../src/game/state';
import type { GameState, OwnedHero, OwnedItem } from '../src/game/types';

const QA_ACCOUNT_LEVEL = 80;
const QA_HERO_LEVEL = 80;
const QA_LOCATION_COUNT = 10;

export function makeQaGameState(now = Date.now()): GameState {
  const base = makeInitialState();
  const accountXp = Array.from({ length: QA_ACCOUNT_LEVEL - 1 }, (_, index) => accountXpForLevel(index + 1))
    .reduce((total, required) => total + required, 0);
  const ownedHeroes: OwnedHero[] = HEROES.map((hero, index) => ({
    uid: `qa-hero-${index + 1}`,
    heroId: hero.id,
    level: QA_HERO_LEVEL,
    stars: 5,
    equipped: {},
    xp: 0,
  }));
  const inventory: OwnedItem[] = ITEMS.slice(0, 48).map((item, index) => ({
    uid: `qa-item-${index + 1}`,
    itemId: item.id,
    level: QA_ACCOUNT_LEVEL,
    stats: [],
    power: 1000 + index * 25,
    enchantLevel: 5,
    rerollCount: 0,
    locked: false,
  }));

  return {
    ...base,
    gold: 1_000_000,
    hero: 100_000,
    accountXp,
    accountLevel: QA_ACCOUNT_LEVEL,
    ownedHeroes,
    team: ownedHeroes.slice(0, 3).map((hero) => hero.uid),
    inventory,
    chests: [
      { id: 'qa-standard-chest', stage: 10 },
      { id: 'qa-boss-chest', stage: 10, boss: true },
    ],
    bossKeys: 100,
    currentLocation: 1,
    highestLocation: QA_LOCATION_COUNT,
    lastSeen: now,
    lastChestReset: now,
    lastQuestReset: now,
    username: 'PlaywrightQA',
    walletAddress: 'qa-local-playwright',
    potions: { xs: 99, sm: 99, md: 99, lg: 99, xl: 99, xxl: 99 },
    rotatingShop: ITEMS.slice(0, 6).map((item, index) => ({
      itemId: item.id,
      price: 1000 + index * 500,
      sold: false,
    })),
    rotatingShopRefreshAt: now + 4 * 60 * 60 * 1000,
    referral: {
      code: 'QA2026',
      invitedUsers: [],
      pendingReward: 0,
      totalEarned: 0,
      alreadyClaimed: 0,
    },
    boost: {
      active: true,
      chestProgressSeconds: 0,
      goldProgressSeconds: 0,
      combatProgressSeconds: 0,
      progress: 100,
      bonusPct: 100,
      conditions: {
        connectTelegram: true,
        connectTwitter: true,
        connectDiscord: true,
        spentTokens: 500,
        holdTokens: 1000,
      },
    },
  };
}
