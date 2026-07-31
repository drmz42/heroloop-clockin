export type HeroClass = 'knight' | 'archer' | 'assassin' | 'shepherd' | 'druid';

export type Rarity =
  | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
  | 'mythic' | 'relic' | 'cursed' | 'cosmic' | 'divine';

export type Faction = 'light' | 'dark' | 'nature' | 'fire' | 'water' | 'void' | 'cosmic';

export type ItemSlot = 'weapon' | 'helmet' | 'armor' | 'gloves' | 'boots' | 'ring1' | 'ring2' | 'amulet';

export interface HeroBase {
  id: string;
  name: string;
  heroClass: HeroClass;
  rarity: Rarity;
  faction: Faction;
  baseHp: number;
  baseAtk: number;
  baseDef: number;
  baseSpeed: number;
  critChance: number;
  critDamage: number;
  skillName: string;
  skillDesc: string;
  passiveName: string;
  passiveDesc: string;
  color: string;
}

export interface OwnedHero {
  uid: string;
  heroId: string;
  level: number;
  stars: number;
  equipped: Partial<Record<ItemSlot, string>>;
  respawnAt?: number;
  xp: number;
  locked?: boolean;
}

// ── Items ──────────────────────────────────────────────────────────────────

export type ItemStatKey =
  | 'hp' | 'atk' | 'def' | 'atkSpeed'
  | 'critChance' | 'critDamage'
  | 'goldBonus' | 'xpBonus' | 'dodge';

export interface ItemStatRoll {
  key: ItemStatKey;
  value: number;
  isPercent: boolean;
}

export interface ItemBase {
  id: string;
  name: string;
  slot: ItemSlot;
  rarity: Rarity;
  icon: string;
  flavor: string;
}

export interface OwnedItem {
  uid: string;
  itemId: string;
  level: number;
  stats: ItemStatRoll[];
  power: number;
  locked?: boolean;
  enchantLevel: number;   // 0–10, each +1 boosts all stats by +10%
  rerollCount: number;    // how many times rerolled (affects cost)
}

// ── Potions ────────────────────────────────────────────────────────────────

export type PotionTier = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

export interface PotionDef {
  tier: PotionTier;
  name: string;
  hpRestore: number;
  cost: number;
}

// ── Chests ────────────────────────────────────────────────────────────────

export interface Chest {
  id: string;
  stage: number;
}

// ── Enemy / Location ───────────────────────────────────────────────────────

export interface Enemy {
  id: string;
  name: string;
  hp: number;
  atk: number;
  def: number;
  speed: number;
  color: string;
  icon: string;
}

export interface Location {
  id: number;
  name: string;
  enemies: Enemy[];
  goldReward: number;
  xpReward: number;
  tokenReward: number;
  boss?: boolean;
  requiredPower: number;
  unlocked: boolean;
  maxChestRarity: Rarity;   // highest rarity possible from chests at this location
}

// ── Combat ────────────────────────────────────────────────────────────────

export interface CombatUnit {
  uid: string;
  name: string;
  side: 'hero' | 'enemy';
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  speed: number;
  combatSpeed: number;
  critChance: number;
  critDamage: number;
  color: string;
  icon: string;
  attackTimer: number;
  attackInterval: number;
  heroClass?: HeroClass;
  alive: boolean;
  dodge?: number;
  regenTimer?: number;
}

export interface FloatingNumber {
  id: number;
  targetUid: string;
  value: number;
  crit: boolean;
  heal: boolean;
  miss?: boolean;
  born: number;
}

// ── Daily Quests ──────────────────────────────────────────────────────────

export interface DailyQuest {
  id: string;
  label: string;
  target: number;
  progress: number;
  reward: { gold: number; hero: number };
  claimed: boolean;
}

// ── Game State ─────────────────────────────────────────────────────────────

export interface PotionInventory {
  xs: number; sm: number; md: number;
  lg: number; xl: number; xxl: number;
}

export interface AutoPotConfig {
  enabled: boolean;
  autoBuy: boolean;
  autoBuyTier: PotionTier;
  autoSelectTier?: boolean;
  threshold: number;
}

export interface RotatingShopItem {
  itemId: string;
  price: number;
  sold: boolean;
}

export interface SessionStats {
  kills: number;
  bossKills: number;
  chestsOpened: number;
  goldToday: number;
  heroToday: number;
}

// ── User Profile ─────────────────────────────────────────────────────────

export interface UserProfile {
  username: string;
  walletAddress: string; // fake for now
  referralCode: string;
  referredBy?: string;
  createdAt: number;
}

export interface ReferralData {
  code: string;
  invitedUsers: { username: string; level: number; active: boolean }[];
  pendingReward: number;
  totalEarned: number;
  alreadyClaimed: number;
}

export interface GameState {
  gold: number;
  hero: number;
  accountXp: number;
  accountLevel: number;
  ownedHeroes: OwnedHero[];
  team: string[];
  inventory: OwnedItem[];
  chests: Chest[];
  chestsOpenedToday: number;
  lastChestReset: number;       // date timestamp for daily chest cap reset
  currentLocation: number;
  highestLocation: number;
  lastSeen: number;
  totalGoldEarned: number;
  totalTokensEarned: number;
  totalKills: number;
  summons: number;
  potions: PotionInventory;
  autoPot: AutoPotConfig;
  rotatingShop: RotatingShopItem[];
  rotatingShopRefreshAt: number;
  session: SessionStats;
  dailyQuests: DailyQuest[];
  lastQuestReset: number;
  referral: ReferralData;
  username: string;
  walletAddress: string;
  boost: BoostState;
  starterBalanceV2: boolean;
}

export interface BoostState {
  active: boolean;          // true when progress reaches 100%
  progress: number;         // 0–100
  bonusPct: number;         // 100 when active
  conditions: {
    connectTelegram: boolean;
    connectTwitter: boolean;
    connectDiscord: boolean;
    spentTokens: number;    // cumulative $HERO spent in-game
    holdTokens: number;     // current $HERO held
  };
}
