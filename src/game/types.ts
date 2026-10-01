export type HeroClass = 'knight' | 'archer' | 'assassin' | 'shepherd' | 'druid';

export type Rarity =
  | 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
  | 'mythic' | 'cosmic' | 'divine' | 'celestial' | 'cursed' | 'immortal' | 'god'
  | 'relic'; // legacy save compatibility; never generated

export type Faction = 'light' | 'dark' | 'nature' | 'fire' | 'water' | 'void' | 'cosmic';

export type ItemSlot =
  | 'class_weapon' | 'offhand' | 'helmet' | 'chest' | 'gloves' | 'boots' | 'ring' | 'amulet'
  | 'weapon' | 'armor' | 'ring1' | 'ring2'; // legacy save compatibility

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
  isNew?: boolean;
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
  /** Only weapons use this. Non-weapons are shared by every class. */
  heroClass?: HeroClass;
}

export interface OwnedItem {
  uid: string;
  itemId: string;
  level: number;
  stats: ItemStatRoll[];
  power: number;
  serverOwned?: boolean;
  locked?: boolean;
  isNew?: boolean;
  enchantLevel: number;   // 0–20; Balance v4 uses four non-compounding stat bands
  enchantStatsVersion?: 2 | 3 | 4; // v4 is checksum-bound tiered Enchant plus eight-slot Resonance
  itemRollVersion?: 2 | 3 | 4 | 5; // base-stat roll model; v5 is the Option-A generated contract
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
  id?: string;
  stage: number;
  boss?: boolean;
  tutorial?: boolean;
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
  role?: 'tank' | 'striker' | 'skirmisher' | 'support' | 'caster';
  eliteAffix?: 'guard-aura' | 'mending' | 'barrier' | 'enrage' | 'curse' | 'lane-blast' | 'summoner' | null;
  shield?: number;
  curseRemainingMs?: number;
  enraged?: boolean;
  summoned?: boolean;
  effectCooldowns?: Record<string, number>;
  /** @deprecated Legacy pending-wave snapshots migrate this value into effectCooldowns. */
  abilityTimer?: number;
  assistLowestHp?: boolean;
}

export interface FloatingNumber {
  id: number;
  targetUid: string;
  value: number;
  crit: boolean;
  heal: boolean;
  miss?: boolean;
  born: number;
  sourceUid?: string;
  label?: string;
  effect?: boolean;
  delayMs?: number;
}

// ── Daily Quests ──────────────────────────────────────────────────────────

export interface DailyQuest {
  id: string;
  label: string;
  kind?: 'daily' | 'milestone';
  chain?: string;
  tier?: number;
  target: number;
  progress: number;
  reward: { gold: number; hero: number; bossKeys?: number; summonScrolls?: number };
  claimed: boolean;
}

// ── Game State ─────────────────────────────────────────────────────────────

export interface PotionInventory {
  xs: number; sm: number; md: number;
  lg: number; xl: number; xxl: number;
}

export interface AutoPotConfig {
  goldHealingOptOut?: boolean;
  healingInfoSeen?: boolean;
  enabled: boolean;
  autoBuy: boolean;
  autoBuyTier: PotionTier;
  autoSelectTier?: boolean;
  threshold: number;
}

export interface TutorialState {
  welcomeCompleted: boolean;
  autoPotCompleted: boolean;
  chestGranted: boolean;
  chestCompleted: boolean;
  questOrdinal: number;
  questCompleted: boolean;
  openedCount: number;
  chestBalance: number;
  bossKillsAtKeyGrant: number;
}

export type TrainingBoostKey = '2x-1h' | '2x-4h' | '4x-1h' | '4x-4h';

export interface TrainingBoostQueueEntry {
  key: TrainingBoostKey;
  multiplier: 2 | 4;
  durationMs: number;
}

export interface TrainingCampState {
  heroUids: Array<string | null>;
  unlockedSlots: number;
  boostMultiplier: 1 | 2 | 4;
  boostEndsAt: number;
  activeBoostKey: TrainingBoostKey | null;
  boostQueue: TrainingBoostQueueEntry[];
  lastTick: number;
  serverAppliedPurchaseIds?: string[];
}

export interface RotatingShopItem {
  itemId: string;
  price: number;
  sold: boolean;
  rarity?: Rarity;
  slot?: ItemSlot;
}

export interface SessionStats {
  kills: number;
  bossKills: number;
  chestsOpened: number;
  goldToday: number;
  heroToday: number;
}

export interface BalanceCohort {
  locationId: number;
  teamSize: number;
  powerBand: number;
  recommendedPowerBand: number;
  powerRatioBand: number;
  boss: boolean;
  attempts: number;
  wins: number;
  totalClearSeconds: number;
  totalPower: number;
  totalRecommendedPower: number;
  totalPowerRatio: number;
  winningClearSecondsBuckets: number[];
  heroDeaths: number;
  totalEquippedStatLines: number;
}

export interface BalanceTelemetry {
  version: string;
  cohorts: Record<string, BalanceCohort>;
}

export interface BalanceTelemetrySummary {
  teamSize: number;
  boss: boolean;
  powerRatioBand: number;
  attempts: number;
  wins: number;
  winRate: number;
  averagePowerRatio: number;
  medianWinningClearSecondsUpperBound: number | null;
}

export interface MarketOwnedListing {
  id: string;
  kind: 'item' | 'hero';
  price: number;
  createdAt: number;
  item?: OwnedItem;
  hero?: OwnedHero;
}

export interface MarketHistoryRecord {
  id: string;
  kind: 'item' | 'hero';
  sourceId: string;
  name: string;
  price: number;
  createdAt: number;
  action: 'bought' | 'sold';
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
  heroCapacity: number;
  bagSlots: number[];
  ownedHeroes: OwnedHero[];
  team: string[];
  inventory: OwnedItem[];
  chests: Chest[];
  bossKeys: number;
  bossBattleActive: boolean;
  battleAnimationMode: 'light' | 'spectacular' | 'off';
  chestsOpenedToday: number;
  lastChestReset: number;       // date timestamp for daily chest cap reset
  currentLocation: number;
  highestLocation: number;
  lastSeen: number;
  combatXpAt: number;            // Account/Hero XP rewarded-through cutoff
  activeUntil: number;           // ordinary Active reward window; Boost Max bypasses this cap
  totalGoldEarned: number;
  totalTokensEarned: number;
  tokensEarnedToday: number;
  tokenDayKey: string;
  totalKills: number;
  totalBossKills: number;
  summons: number;
  summonScrolls: number;
  potions: PotionInventory;
  autoPot: AutoPotConfig;
  tutorial: TutorialState;
  trainingCamp: TrainingCampState;
  rotatingShop: RotatingShopItem[];
  rotatingShopRefreshAt: number;
  session: SessionStats;
  dailyQuests: DailyQuest[];
  milestoneQuests: DailyQuest[];
  lastQuestReset: number;
  referral: ReferralData;
  username: string;
  walletAddress: string;
  avatarHeroId: string;
  boost: BoostState;
  balanceTelemetry: BalanceTelemetry;
  marketListings: MarketOwnedListing[];
  marketHistory: MarketHistoryRecord[];
  starterBalanceV2: boolean;
}

export interface BoostState {
  active: boolean;          // true when progress reaches 100%
  progress: number;         // 0–100
  bonusPct: number;         // 100 when active
  chestProgressSeconds: number; // active reward time carried toward the next timed chest
  goldProgressSeconds: number; // server reward time carried toward the next periodic Gold credit
  combatProgressSeconds: number; // server reward time carried toward the next combat settlement
  conditions: {
    connectTelegram: boolean;
    connectTwitter: boolean;
    connectDiscord: boolean;
    spentTokens: number;    // cumulative $HERO spent in-game
    holdTokens: number;     // current $HERO held
  };
}
