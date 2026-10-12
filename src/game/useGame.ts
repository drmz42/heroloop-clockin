import { seekerXpReward } from '../../managed/functions/player-sync/seeker-progression.mjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isolatedHackathon } from './editionStorage';
import { commitSkrPurchase } from './seekerWallet';
import { skrError } from './skrPurchase';
import { automaticHealingConfig } from '../../managed/functions/player-sync/automatic-healing.mjs';
import { flushSync } from 'react-dom';
import type { DungeonChestStatus, GameState, OwnedHero, CombatUnit, FloatingNumber, ItemSlot, OwnedItem, PotionTier, DailyQuest, TrainingBoostKey, Chest } from '@/game/types';
import {
  loadState, normalizeState, makeInitialState, starUpCost,
  MAX_TEAM, BASE_HERO_CAPACITY, MAX_HERO_CAPACITY, HERO_CAPACITY_STEP, MAX_HERO_STARS, inventoryCapacity, MAX_CHESTS, RESPAWN_TIME_MS, ROTATING_REFRESH_MS,
  awardSeekerXp, gameDayKey,
  TRAINING_SLOT_COSTS, TRAINING_BOOST_COSTS,
  trainingTokenPenalty,
} from '@/game/state';
import { buildLocation, ownedToUnit, enemyToUnit, heroStats, getEquippedItems, teamPower, isOverpowered, canMineTokens, locationUnlockLevel, latestTokenLocation } from '@/game/engine';
import { HERO_MAP, RARITY_INDEX, canonicalHeroId } from '@/game/heroes';
import {
  openStandardChest, openBossChest, generateRotatingShop,
  ITEM_MAP, POTION_MAP, sellValue, rollItem, rerollItemStats,
  enchantSuccessChance, enchantCost, enchantCharmCost, itemPower, displayItemPower,
  MAX_CHESTS_PER_DAY, rerollCost,
  canClassEquipItem,
  meetsItemLevelRequirement,
} from '@/game/items';
import type { Rarity } from '@/game/types';
import { recommendedTeamPower, recordBattleTelemetry } from '@/game/balance';
import { MAX_ENCHANT_LEVEL } from '@/game/enchant';
import { goldRewardForLanes } from '@/game/goldRewards';
import { advanceCombatFrame, combatResolution, seededCombatRandom } from '../../managed/functions/player-sync/combat-step.mjs';
import { playerSync, tokenomicsEnabled } from '@/game/backend';
import type { SeekerPromotionPlan, SeekerPromotionStep } from '@/game/seekerPromotion';
import { combatPresentationDue, scheduleFloaters } from '@/game/floater-queue.mjs';
import { combatRecoveryDelay, createCombatSession, stalledCombatGeneration } from '@/game/combat-session.mjs';
import { COMBAT_TIMELINE_VERSION, parseCombatTimeline } from '../../managed/functions/player-sync/combat-timeline.mjs';
import type { CombatTimelineEvent } from '../../managed/functions/player-sync/combat-timeline.mjs';

const COMBAT_SPEED = 1;
const COMBAT_LOOP_INTERVAL_MS = 50;
const FLOATER_LIFETIME_MS = 1_500;
const MAX_LIVE_FLOATERS = 36;
const NORMAL_COMBAT_START_INTERVAL_MS = 3_100;
const SELL_BATCH_SIZE = 256; // server item_mutate accepts 1-256 item ids per call: all four bags at once
const CHEST_OPEN_BATCH_SIZE = 64; // server chest_open accepts 1-64 chests per call
const ACTIVE_CHEST_SECONDS = 86.4;
const MAX_TRAINING_OFFLINE_MS = 7 * 24 * 60 * 60 * 1000;

function advanceTrainingCamp(state: GameState, now: number): GameState {
  const camp = state.trainingCamp;
  const from = Math.min(now, Math.max(0, camp.lastTick));
  if (now - from < 1_000) return state;

  let cursor = from;
  let activeBoostKey = camp.activeBoostKey;
  let boostMultiplier = camp.boostMultiplier;
  let boostEndsAt = camp.boostEndsAt;
  const boostQueue = [...camp.boostQueue];
  const rewardWindowStart = Math.max(from, now - MAX_TRAINING_OFFLINE_MS);
  let effectiveSeconds = 0;

  const addRewardTime = (start: number, end: number, multiplier: number) => {
    const rewardedStart = Math.max(start, rewardWindowStart);
    const rewardedEnd = Math.min(end, now);
    if (rewardedEnd > rewardedStart) effectiveSeconds += ((rewardedEnd - rewardedStart) / 1000) * multiplier;
  };

  while (cursor < now) {
    if (boostMultiplier > 1 && boostEndsAt > cursor) {
      const segmentEnd = Math.min(now, boostEndsAt);
      addRewardTime(cursor, segmentEnd, boostMultiplier);
      cursor = segmentEnd;
      if (cursor < now && cursor >= boostEndsAt) {
        activeBoostKey = null;
        boostMultiplier = 1;
        boostEndsAt = 0;
      }
      continue;
    }

    const next = boostQueue.shift();
    if (next) {
      activeBoostKey = next.key;
      boostMultiplier = next.multiplier;
      boostEndsAt = cursor + next.durationMs;
      continue;
    }

    addRewardTime(cursor, now, 1);
    cursor = now;
  }

  if (boostMultiplier > 1 && boostEndsAt <= now) {
    activeBoostKey = null;
    boostMultiplier = 1;
    boostEndsAt = 0;
  }

  const locationId = latestTokenLocation(state.accountLevel, state.highestLocation, state.seekerProgression?.legacyLocationAccess);
  const xpGain = Math.floor((buildLocation(locationId, 1, false, state.accountLevel).xpReward * 1.6 / 12) * effectiveSeconds);
  const eligibleTrainees = camp.heroUids.map((uid) => {
    const hero = uid ? state.ownedHeroes.find((owned) => owned.uid === uid) : null;
    return hero && !state.team.includes(hero.uid) && hero.level < state.accountLevel ? hero.uid : null;
  });
  const trainees = new Set(eligibleTrainees.filter((uid): uid is string => Boolean(uid)));
  const awarded = awardSeekerXp(state, 0, Object.fromEntries([...trainees].map((uid) => [uid, xpGain])), true);

  return {
    ...awarded,
    trainingCamp: {
      ...camp,
      heroUids: eligibleTrainees,
      activeBoostKey,
      boostMultiplier,
      boostEndsAt,
      boostQueue,
      lastTick: now,
    },
  };
}

function createIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((byte, index) => `${index === 4 || index === 6 || index === 8 || index === 10 ? '-' : ''}${byte.toString(16).padStart(2, '0')}`).join('');
}

function shouldAutoLockItem(item: OwnedItem): boolean {
  const itemBase = ITEM_MAP[item.itemId];
  if (!itemBase) return false;
  return ['divine', 'celestial', 'cursed', 'immortal', 'god'].includes(itemBase.rarity);
}

export function bagItemCount(state: GameState): number {
  const equipped = new Set<string>();
  state.ownedHeroes.forEach((hero) => Object.values(hero.equipped).forEach((uid) => {
    if (uid) equipped.add(uid);
  }));
  return state.inventory.reduce((count, item) => count + (equipped.has(item.uid) ? 0 : 1), 0);
}

interface ServerItemAssignment {
  item_uid: string;
  hero_uid: string;
  slot: 'class_weapon' | 'offhand' | 'helmet' | 'chest' | 'gloves' | 'boots' | 'ring' | 'amulet';
}

const SERVER_ITEM_SLOTS = new Set<ServerItemAssignment['slot']>([
  'class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet',
]);

function serverEquipmentAssignments(state: GameState): ServerItemAssignment[] {
  const serverItemUids = new Set(state.inventory.filter((item) => item.serverOwned).map((item) => item.uid));
  const activeHeroUids = new Set(state.team);
  return state.ownedHeroes.flatMap((hero) => {
    if (!activeHeroUids.has(hero.uid)) return [];
    return Object.entries(hero.equipped).flatMap(([slot, itemUid]) => {
      if (!itemUid || !serverItemUids.has(itemUid) || !SERVER_ITEM_SLOTS.has(slot as ServerItemAssignment['slot'])) return [];
      return [{ item_uid: itemUid, hero_uid: hero.uid, slot: slot as ServerItemAssignment['slot'] }];
    });
  }).sort((left, right) => left.item_uid.localeCompare(right.item_uid));
}

function sameServerEquipmentAssignments(expected: ServerItemAssignment[], actual: ServerItemAssignment[]): boolean {
  if (expected.length !== actual.length) return false;
  const key = (assignment: ServerItemAssignment) => `${assignment.item_uid}\u0000${assignment.hero_uid}\u0000${assignment.slot}`;
  const expectedKeys = expected.map(key).sort();
  const actualKeys = actual.map(key).sort();
  return expectedKeys.every((value, index) => value === actualKeys[index]);
}

export interface BattleResult {
  win: boolean;
  gold: number;
  xp: number;
  tokens: number;
  drop?: OwnedItem;
  chest?: boolean;
  overpowered: boolean;
}

export interface PromotionSummary {
  heroName: string;
  starsAdded: number;
}

export interface ServerMarketListing {
  id: string;
  price: number;
  seller_id: string;
  seller: string;
  is_own: boolean;
  created_at: string;
  item: OwnedItem;
}

export interface ServerMarketHeroListing {
  id: string;
  price: number;
  seller_id: string;
  seller: string;
  is_own: boolean;
  created_at: string;
  hero: { heroId: string; level: number; stars: number };
}

// Boss and Dungeon Chests are fungible; a listing sells `quantity` of one kind as one lot (Founder 2026-10-09).
export interface ServerMarketChestListing {
  id: string;
  price: number;
  seller_id: string;
  seller: string;
  is_own: boolean;
  created_at: string;
  chest: { kind: 'boss' | 'dungeon_d1' | 'dungeon_d2' | 'dungeon_d3'; quantity: number };
}

export interface ServerMarketSnapshot {
  listings: ServerMarketListing[];
  hero_listings?: ServerMarketHeroListing[];
  chest_listings?: ServerMarketChestListing[];
  history: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold' }[];
  activity?: ServerMarketSnapshot['history'];
  active_limit: number;
  fee_percent: number;
  pool_day: string;
  pool_fee_total: number;
  pool_trade_count: number;
}

export interface MarketActionResult { ok: boolean; error?: string; mailed?: boolean }
export interface MailItemEntry { kind: 'item'; id: string; source: 'market_purchase' | 'market_return' | 'store_overflow' | 'chest_reward'; created_at: string; item: OwnedItem }
// Founder 2026-10-08: rewards arrive in the Mailbox as letters (sender, title, text, attachments); a chest
// attachment moves into the 500-chest queue only when there is room, Gold always lands.
export type MailAttachment = { id: string; claimed: boolean } & ({ kind: 'item'; item: OwnedItem } | { kind: 'chest'; chest: Chest } | { kind: 'gold'; amount: number } | { kind: 'resource'; resourceId: string; title: string; amount: number }
  | { kind: 'hero'; heroId: string; title: string; level: number; stars: number; bound: boolean });
export interface MailLetterEntry {
  kind: 'letter'; id: string; source: 'boss_reward' | 'compensation' | 'admin' | 'system'; sender: string; title: string; body: string;
  created_at: string; read: boolean; claimed: boolean; attachments: MailAttachment[];
}
export type MailEntry = MailItemEntry | MailLetterEntry;
type RawMailLetter = Omit<MailLetterEntry, 'kind' | 'attachments'> & { attachments?: { id: string; kind: string; claimed: boolean; payload: Record<string, unknown> }[] };

function parseMailLetters(raw: RawMailLetter[] | undefined): MailLetterEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((letter) => typeof letter?.id === 'string' && typeof letter.title === 'string').map((letter) => ({
    ...letter, kind: 'letter', body: String(letter.body ?? ''), sender: String(letter.sender ?? 'HeroLoop'), read: letter.read === true, claimed: letter.claimed === true,
    attachments: (Array.isArray(letter.attachments) ? letter.attachments : []).flatMap((attachment): MailAttachment[] => {
      if (attachment?.kind === 'item' && attachment.payload?.item && typeof attachment.payload.item === 'object') {
        const item = attachment.payload.item as OwnedItem;
        if (typeof item.uid === 'string' && item.serverOwned === true && ITEM_MAP[item.itemId]) {
          return [{ id: attachment.id, claimed: attachment.claimed === true, kind: 'item', item }];
        }
      }
      if (attachment?.kind === 'chest' && Number.isSafeInteger(Number(attachment.payload?.stage))) {
        return [{ id: attachment.id, claimed: attachment.claimed === true, kind: 'chest', chest: { stage: Number(attachment.payload.stage), boss: attachment.payload.boss === true } }];
      }
      if (attachment?.kind === 'resource' && typeof attachment.payload?.resource_id === 'string' && Number.isSafeInteger(Number(attachment.payload?.amount))) {
        return [{ id: attachment.id, claimed: attachment.claimed === true, kind: 'resource', resourceId: attachment.payload.resource_id, title: String(attachment.payload.title ?? attachment.payload.resource_id), amount: Number(attachment.payload.amount) }];
      }
      if (attachment?.kind === 'hero' && typeof attachment.payload?.hero_id === 'string') {
        return [{ id: attachment.id, claimed: attachment.claimed === true, kind: 'hero', heroId: attachment.payload.hero_id, title: String(attachment.payload.title ?? ''),
          level: Number(attachment.payload.level) || 1, stars: Number(attachment.payload.stars) || 0, bound: attachment.payload.bound === true }];
      }
      if (attachment?.kind === 'gold' && Number.isSafeInteger(Number(attachment.payload?.amount))) {
        return [{ id: attachment.id, claimed: attachment.claimed === true, kind: 'gold', amount: Number(attachment.payload.amount) }];
      }
      return [];
    }),
  }));
}

export interface MailClaimResult { ok: boolean; error?: string; claimed?: number; remaining?: number; itemsFull?: boolean; chestsFull?: boolean; resourcesFull?: boolean; heroesFull?: boolean; heroesLimited?: boolean }

interface NormalCombatWave {
  startKey: string;
  completionKey: string;
  location: number;
  availableAt: number;
  elapsedMs: number;
  nextAutoPotion: number;
  autoPotions: NormalCombatAutoPotion[];
  timeline: CombatTimelineEvent[] | null;
  nextTimeline: number;
  potionTicks: CombatTimelineEvent[] | null;
  nextPotionTick: number;
}

interface NormalCombatAutoPotion {
  elapsed_ms: number;
  hero_uid: string;
  tier: PotionTier;
  hp_restore: number;
}

export interface CombatRecoveryState {
  status: 'healthy' | 'retrying' | 'failed';
  attempt: number;
  retryAt: number | null;
  reason: string;
}

const MAX_COMBAT_RECOVERY_ATTEMPTS = 5;
const HEALTHY_COMBAT: CombatRecoveryState = { status: 'healthy', attempt: 0, retryAt: null, reason: '' };

interface NormalCombatStartResult {
  start_key: string;
  location: number;
  seed: number;
  available_at: string;
  initial_units: Array<Partial<CombatUnit> & Pick<CombatUnit, 'uid' | 'side'> & { lane: number }>;
  outcome?: { healing_policy?: string; auto_potions?: NormalCombatAutoPotion[]; elapsed_ms?: number; timeline_version?: number; timeline?: unknown };
}

function combatFloater(event: {
  kind: CombatTimelineEvent['kind']; sourceUid: string; targetUid: string;
  amount?: number; critical?: boolean; effectId?: string;
}, id: number, born: number): FloatingNumber {
  const amount = Math.max(0, Math.floor(event.amount ?? 0));
  if (event.kind === 'miss') return { id, sourceUid: event.sourceUid, targetUid: event.targetUid, value: 0, crit: false, heal: false, miss: true, born };
  if (event.kind === 'damage') return { id, sourceUid: event.sourceUid, targetUid: event.targetUid, value: amount, crit: Boolean(event.critical), heal: false, born };
  if (event.kind === 'heal' || event.kind === 'potion') return {
    id, targetUid: event.targetUid, value: amount, crit: false, heal: true,
    label: event.kind === 'potion' ? `POTION +${amount}` : undefined, effect: event.kind === 'potion', born,
  };
  const effect = {
    'role.support-heal': [`MEND +${amount}`, true],
    'affix.mending-heal': [`MEND +${amount}`, true],
    'role.caster-blast': [`BLAST -${amount}`, false],
    'affix.lane-blast': [`BLAST -${amount}`, false],
    'affix.barrier': [`BARRIER +${amount}`, false],
    'affix.curse': ['CURSE', false],
  }[event.effectId ?? ''] as [string, boolean] | undefined;
  // Unlisted team/core effects (e.g. team.druid.wild-growth-heal) read their own name
  // instead of a generic placeholder.
  const name = (event.effectId ?? '').split('.').pop()?.replace(/-heal$/, '').replace(/-/g, ' ').toUpperCase() || 'SKILL';
  const heal = effect?.[1] ?? /heal/.test(event.effectId ?? '');
  const fallback = amount > 0 ? `${name} ${heal ? '+' : '-'}${amount}` : name;
  return { id, sourceUid: event.sourceUid, targetUid: event.targetUid, value: amount, crit: false, heal, label: effect?.[0] ?? fallback, effect: true, born };
}

interface NormalCombatCompleteResult {
  revision: number;
  state: unknown;
  rewards: { gold: number; account_xp: number };
  outcome: { all_cleared: boolean };
}

function updateQuestProgress(quests: DailyQuest[], type: string, amount: number): DailyQuest[] {
  const chain = type.replace(/-$/, '');
  return quests.map(q => {
    if ((q.id.startsWith(type) || q.chain === chain) && !q.claimed) {
      return { ...q, progress: q.kind === 'milestone' ? q.progress + amount : Math.min(q.target, q.progress + amount) };
    }
    return q;
  });
}

export type RewardBoostPlan = '24h' | '7d' | '30d';
export const REWARD_BOOST_PLANS: readonly RewardBoostPlan[] = ['24h', '7d', '30d'];
export interface AccountBonusSnapshot {
  gold: number;
  xp: number;
  /** Local-clock end of the paid Gold/XP boost, or null when none is active. */
  boostEndsAt: number | null;
  plans: { plan: RewardBoostPlan; usdCents: number; days: number; tokenCost: number | null }[];
  /** Shop resource bundles: USD catalogue price and the $HERO cost at the current server quote. */
  bundles: ShopBundleOffer[];
}
export type ShopBundleResource = 'summon_scroll' | 'boss_key' | 'potion_md';
export interface ShopBundleOffer { bundle: string; resourceId: ShopBundleResource; quantity: number; usdCents: number; tokenCost: number | null }
const SHOP_BUNDLE_RESOURCES: readonly string[] = ['summon_scroll', 'boss_key', 'potion_md'];

export function useGame() {
  const [state, setState] = useState<GameState>(() => loadState());
  const combatPresentationRef = useRef<{
    units: CombatUnit[];
    floaters: FloatingNumber[];
    potionFx: { uid: string; born: number } | null;
  }>({ units: [], floaters: [], potionFx: null });
  const combatPresentationListenersRef = useRef(new Set<() => void>());
  const getCombatPresentationSnapshot = useCallback(() => combatPresentationRef.current, []);
  const subscribeCombatPresentation = useCallback((listener: () => void) => {
    combatPresentationListenersRef.current.add(listener);
    return () => combatPresentationListenersRef.current.delete(listener);
  }, []);
  const updateCombatPresentation = useCallback((next: Partial<typeof combatPresentationRef.current>) => {
    combatPresentationRef.current = { ...combatPresentationRef.current, ...next };
    combatPresentationListenersRef.current.forEach((listener) => listener());
  }, []);
  const setUnits = useCallback((units: CombatUnit[]) => updateCombatPresentation({ units }), [updateCombatPresentation]);
  const setFloaters = useCallback((next: FloatingNumber[] | ((current: FloatingNumber[]) => FloatingNumber[])) => {
    const current = combatPresentationRef.current.floaters;
    const floaters = typeof next === 'function' ? next(current) : next;
    if (floaters !== current) updateCombatPresentation({ floaters });
  }, [updateCombatPresentation]);
  const setPotionFx = useCallback((potionFx: { uid: string; born: number } | null) => updateCombatPresentation({ potionFx }), [updateCombatPresentation]);
  const [battleResult, setBattleResult] = useState<BattleResult | null>(null);
  const [combatRecovery, setCombatRecovery] = useState<CombatRecoveryState>(HEALTHY_COMBAT);
  const [autoProgress, setAutoProgress] = useState(true);
  const [paused, setPaused] = useState(false);
  const [respawnCountdowns, setRespawnCountdowns] = useState<Record<string, number>>({});
  const [chestOpenResult, setChestOpenResult] = useState<OwnedItem[] | null>(null);
  const [chestRewardsMailed, setChestRewardsMailed] = useState(false);
  const [chestOpening, setChestOpening] = useState(false);
  const [enchantResult, setEnchantResult] = useState<{ success: boolean; item?: OwnedItem } | null>(null);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [summonPity, setSummonPity] = useState({ legendary: 0, mythic: 0, cosmic: 0, divine: 0, celestial: 0 });
  const [ascensionFocus, setAscensionFocus] = useState<Partial<Record<Rarity, string>>>({});
  const [summonError, setSummonError] = useState('');
  const [serverRevisionHint, setServerRevisionHint] = useState<number | null>(null);
  const serverRevisionHintRef = useRef(serverRevisionHint); serverRevisionHintRef.current = serverRevisionHint;
  const [mailCount, setMailCount] = useState(0);
  const [trainingIncomeRevision, setTrainingIncomeRevision] = useState<number | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [itemUpgradeBusy, setItemUpgradeBusy] = useState(false);

  const stateRef = useRef(state); stateRef.current = state;
  const unitsRef = useRef<CombatUnit[]>([]);
  const autoRef = useRef(autoProgress); autoRef.current = autoProgress;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const combatWakeRef = useRef<() => void>(() => undefined);
  const combatPresentationVisibleRef = useRef(true);
  const floaterId = useRef(0);
  const floaterQueueRef = useRef(new Map<string, number>());
  const resolvingRef = useRef(false);
  const itemUpgradeBusyRef = useRef(false);
  const equipmentErrorRef = useRef('');
  const heroHpRef = useRef<Map<string, number>>(new Map());
  const battleStartedAtRef = useRef(Date.now());
  const lastCombatRenderRef = useRef(0);
  const combatAccumulatorRef = useRef(0);
  const combatRandomRef = useRef<() => number>(Math.random);
  const normalCombatWaveRef = useRef<NormalCombatWave | null>(null);
  const pendingFormationRef = useRef<string | null>(null);
  const combatSessionRef = useRef(createCombatSession());
  const combatRecoveryAttemptRef = useRef(0);
  const lastNormalCombatStartAtRef = useRef(0);
  const offlineSettlementKeyRef = useRef('');
  const chestOpeningRef = useRef(false);
  const storeBusyRef = useRef(false);
  const trainingAssignmentBusyRef = useRef(false);

  const hydrateServerState = useCallback((remoteState: unknown) => {
    const normalized = normalizeState(remoteState as Partial<GameState>);
    const pending = pendingFormationRef.current;
    const localTeam = stateRef.current.team;
    if (pending !== null && localTeam.join('|') === pending
      && localTeam.every((uid) => normalized.ownedHeroes.some((hero) => hero.uid === uid)
        && !normalized.trainingCamp.heroUids.includes(uid))) {
      // Another server action may hydrate an older formation while its save
      // is still pending. Keep the local selection until that save resolves.
      normalized.team = [...localTeam];
    } else {
      pendingFormationRef.current = null;
    }
    setState(normalized);
    setHydrationVersion((version) => version + 1);
  }, []);

  const applyServerRevision = useCallback((revision: number) => {
    if (!Number.isSafeInteger(revision) || revision < 1) return;
    setServerRevisionHint((current) => Math.max(current ?? 0, revision));
  }, []);

  const mergeServerResourceState = useCallback((remoteState: unknown) => {
    const remote = normalizeState(remoteState as Partial<GameState>);
    setState((current) => {
      const localHeroes = new Map(current.ownedHeroes.map((hero) => [hero.uid, hero]));
      return {
        ...current,
        gold: remote.gold,
        accountXp: remote.accountXp,
        accountLevel: remote.accountLevel,
        ownedHeroes: remote.ownedHeroes.map((hero) => {
          const local = localHeroes.get(hero.uid);
          return local ? {
            ...hero,
            equipped: local.equipped,
            locked: local.locked,
            isNew: local.isNew,
            respawnAt: hero.respawnAt ?? local.respawnAt,
          } : hero;
        }),
        totalGoldEarned: remote.totalGoldEarned,
        totalKills: remote.totalKills,
        totalBossKills: remote.totalBossKills,
        potions: remote.potions,
        highestLocation: remote.highestLocation,
        dailyQuests: remote.dailyQuests,
        milestoneQuests: remote.milestoneQuests,
        chests: remote.chests,
        chestsOpenedToday: remote.chestsOpenedToday,
        lastChestReset: remote.lastChestReset,
        combatXpAt: remote.combatXpAt,
        session: remote.session,
        lastSeen: Math.max(current.lastSeen, remote.lastSeen),
        boost: {
          ...current.boost,
          chestProgressSeconds: remote.boost.chestProgressSeconds,
          goldProgressSeconds: remote.boost.goldProgressSeconds,
          combatProgressSeconds: remote.boost.combatProgressSeconds,
        },
      };
    });
  }, []);

  const queueCombatRecovery = useCallback((generation: number, reason: string) => {
    if (!combatSessionRef.current.markRecovering(generation)) return;
    resolvingRef.current = false;
    normalCombatWaveRef.current = null;
    const attempt = combatRecoveryAttemptRef.current + 1;
    combatRecoveryAttemptRef.current = attempt;
    if (attempt > MAX_COMBAT_RECOVERY_ATTEMPTS) {
      setCombatRecovery({ status: 'failed', attempt, retryAt: null, reason });
      return;
    }
    setCombatRecovery({
      status: 'retrying',
      attempt,
      retryAt: Date.now() + combatRecoveryDelay(attempt, reason),
      reason,
    });
  }, []);

  useEffect(() => {
    let timer: number | null = null;
    const advance = () => setState((prev) => advanceTrainingCamp(prev, Date.now()));
    const syncTrainingClock = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      if (document.visibilityState !== 'visible') return;
      advance();
      timer = window.setInterval(advance, 10_000);
    };
    document.addEventListener('visibilitychange', syncTrainingClock);
    syncTrainingClock();
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', syncTrainingClock);
    };
  }, []);

  useEffect(() => {
    // Remove equipment created by the old unrestricted prototype rules
    // (for example, a knight sword equipped by an archer).
    setState((prev) => {
      let changed = false;
      const ownedHeroes = prev.ownedHeroes.map((hero) => {
        const nextHeroId = canonicalHeroId(hero.heroId);
        if (nextHeroId !== hero.heroId) changed = true;
        const base = HERO_MAP[nextHeroId];
        if (!base) return hero;
        const equipped = { ...hero.equipped };
        for (const [slot, uid] of Object.entries(equipped)) {
          const owned = prev.inventory.find((item) => item.uid === uid);
          const itemBase = owned ? ITEM_MAP[owned.itemId] : null;
          if (owned && !meetsItemLevelRequirement(owned, prev.accountLevel)) {
            delete equipped[slot as ItemSlot];
            changed = true;
          } else if (itemBase && !canClassEquipItem(base.heroClass, itemBase)) {
            delete equipped[slot as ItemSlot];
            changed = true;
          }
        }
        return nextHeroId !== hero.heroId || equipped !== hero.equipped ? { ...hero, heroId: nextHeroId, equipped } : hero;
      });
      return changed ? { ...prev, ownedHeroes } : prev;
    });
  }, []);

  const spawnBattle = useCallback(async (locationId: number, teamUids: string[], forceBoss?: boolean) => {
    const st = stateRef.current;
    // An empty Seeker formation waits for a hero instead of starting a server wave.
    if (teamUids.length === 0) return;
    const now = Date.now();
    const serverNormalCombat = tokenomicsEnabled && !forceBoss && !st.bossBattleActive;
    // The server snapshots its saved formation at wave start. Wait for the
    // formation save so a newly selected hero cannot start as an old lane.
    if (serverNormalCombat && pendingFormationRef.current !== null) return;
    const generation = combatSessionRef.current.begin({ locationId, teamUids: [...teamUids], forceBoss: Boolean(forceBoss) });
    if (generation === null) return;
    const fullTeam = teamUids
      .map((uid) => st.ownedHeroes.find((h) => h.uid === uid))
      .filter((h): h is OwnedHero => Boolean(h));
    const localLocation = buildLocation(locationId, fullTeam.length, forceBoss ?? st.bossBattleActive, st.accountLevel);
    const localHeroUnits = fullTeam.map((owned) => {
      const unit = ownedToUnit(owned, st.inventory);
      if (!unit) return null;
      if (owned.respawnAt && owned.respawnAt > now) return { ...unit, hp: 0, alive: false };
      return unit;
    }).filter((unit): unit is CombatUnit => Boolean(unit)).map((unit) => {
      const carriedHp = heroHpRef.current.get(unit.uid);
      return carriedHp === undefined
        ? unit
        : { ...unit, hp: Math.max(1, Math.min(unit.maxHp, carriedHp)), alive: carriedHp > 0 };
    });
    const localEnemyUnits = localLocation.enemies.map((enemy, index) => enemyToUnit(enemy, index));
    const localUnits = [
      ...localHeroUnits.map((unit) => ({ ...unit, attackTimer: 0 })),
      ...localEnemyUnits.map((unit) => ({ ...unit, attackTimer: unit.attackInterval })),
    ];
    if (serverNormalCombat) {
      resolvingRef.current = true;
      // Keep the resolved wave visible until its authoritative replacement is
      // ready. On first entry, render a static local preview so network delay
      // or a retry can never turn a valid formation into an empty battlefield.
      if (unitsRef.current.length === 0 && localUnits.length > 0) {
        unitsRef.current = localUnits;
        lastCombatRenderRef.current = performance.now();
        if (combatPresentationVisibleRef.current) setUnits(localUnits);
      }
      setBattleResult(null);
      setFloaters([]);
      const startWait = Math.max(0, lastNormalCombatStartAtRef.current + NORMAL_COMBAT_START_INTERVAL_MS - Date.now());
      if (startWait > 0) await new Promise((resolve) => window.setTimeout(resolve, startWait));
      if (!combatSessionRef.current.isCurrent(generation)) return;
      lastNormalCombatStartAtRef.current = Date.now();
      let startError = 'start_failed';
      const started = await playerSync<NormalCombatStartResult>('normal_combat_start', {
        location: locationId,
        idempotency_key: createIdempotencyKey(),
      }, (message) => { startError = message; });
      if (!combatSessionRef.current.isCurrent(generation)) return;
      if (!started || typeof started.start_key !== 'string' || !Array.isArray(started.initial_units)) {
        queueCombatRecovery(generation, startError);
        return;
      }
      const serverLocation = Math.floor(Number(started.location));
      const serverSeed = Number(started.seed);
      const availableAt = Date.parse(started.available_at);
      if (!Number.isSafeInteger(serverLocation) || serverLocation < 1 || serverLocation > 20
        || !Number.isSafeInteger(serverSeed) || !Number.isFinite(availableAt)) {
        queueCombatRecovery(generation, 'invalid_start');
        return;
      }
      const location = buildLocation(serverLocation, Math.max(1, started.initial_units.filter((unit) => unit.side === 'hero').length), false, st.accountLevel);
      const heroes = new Map(st.ownedHeroes.map((hero) => [hero.uid, hero]));
      const nextUnits: CombatUnit[] = [];
      for (const serverUnit of started.initial_units) {
        const ownedHero = serverUnit.side === 'hero' ? heroes.get(serverUnit.uid) : null;
        const enemy = serverUnit.side === 'enemy' ? location.enemies[serverUnit.lane] : null;
        const base = ownedHero ? ownedToUnit(ownedHero, st.inventory)
          : enemy ? enemyToUnit(enemy, serverUnit.lane) : null;
        if (!base) {
          queueCombatRecovery(generation, 'invalid_units');
          return;
        }
        nextUnits.push({ ...base, ...serverUnit } as CombatUnit);
      }
      normalCombatWaveRef.current = {
        startKey: started.start_key,
        completionKey: createIdempotencyKey(),
        location: serverLocation,
        availableAt,
        elapsedMs: 0,
        nextAutoPotion: 0,
        autoPotions: Array.isArray(started.outcome?.auto_potions) ? started.outcome.auto_potions : [],
        timeline: null,
        nextTimeline: 0,
        potionTicks: started.outcome?.healing_policy === 'ordinary-potion-v1' ? [] : null,
        nextPotionTick: 0,
      };
      const timelinePayload = started.outcome?.timeline;
      const timelineVersion = Number(started.outcome?.timeline_version);
      const timelineElapsed = Number(started.outcome?.elapsed_ms);
      if (timelinePayload !== undefined || started.outcome?.timeline_version !== undefined || started.outcome?.healing_policy === 'ordinary-potion-v1') {
        const timeline = timelineVersion === COMBAT_TIMELINE_VERSION && Number.isSafeInteger(timelineElapsed)
          ? parseCombatTimeline(timelinePayload, new Set(nextUnits.map((unit) => unit.uid)), timelineElapsed)
          : null;
        if (!timeline) {
          queueCombatRecovery(generation, 'invalid_timeline');
          return;
        }
        normalCombatWaveRef.current.timeline = timeline;
        if (normalCombatWaveRef.current.potionTicks) normalCombatWaveRef.current.potionTicks = timeline.filter(event => event.kind === 'potion');
      }
      combatRandomRef.current = seededCombatRandom(serverSeed);
      combatAccumulatorRef.current = 0;
      unitsRef.current = nextUnits;
      nextUnits.forEach((unit) => {
        if (unit.side === 'hero') heroHpRef.current.set(unit.uid, unit.hp);
      });
      lastCombatRenderRef.current = performance.now();
      battleStartedAtRef.current = now;
      if (combatPresentationVisibleRef.current) setUnits(nextUnits);
      combatSessionRef.current.markPlaying(generation);
      setCombatRecovery(HEALTHY_COMBAT);
      resolvingRef.current = false;
      combatWakeRef.current();
      return;
    }
    normalCombatWaveRef.current = null;
    combatRandomRef.current = Math.random;
    combatAccumulatorRef.current = 0;
    unitsRef.current = localUnits;
    lastCombatRenderRef.current = performance.now();
    battleStartedAtRef.current = now;
    if (combatPresentationVisibleRef.current) setUnits(localUnits);
    setBattleResult(null);
    setFloaters([]);
    combatSessionRef.current.markPlaying(generation);
    combatRecoveryAttemptRef.current = 0;
    setCombatRecovery(HEALTHY_COMBAT);
    resolvingRef.current = false;
    combatWakeRef.current();
  }, [queueCombatRecovery, setFloaters, setUnits]);

  const confirmPersistedFormation = useCallback((teamUids: string[]) => {
    if (pendingFormationRef.current !== teamUids.join('|')) return;
    pendingFormationRef.current = null;
    void spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

  const activeTeamKey = state.team.join('|');
  const respawnTeamKey = state.team.map((uid) => state.ownedHeroes.find((hero) => hero.uid === uid)?.respawnAt ?? 0).join('|');
  useEffect(() => {
    if (state.walletAddress && state.team.length > 0) {
      spawnBattle(state.currentLocation, state.team);
    } else {
      combatSessionRef.current.reset();
      normalCombatWaveRef.current = null;
      resolvingRef.current = false;
      combatRecoveryAttemptRef.current = 0;
      setCombatRecovery(HEALTHY_COMBAT);
      unitsRef.current = [];
      setUnits([]);
      heroHpRef.current.clear();
    }
    // Keep battle units and portraits aligned with the exact saved formation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.walletAddress, state.currentLocation, activeTeamKey, respawnTeamKey, hydrationVersion]);

  useEffect(() => {
    if (combatRecovery.status !== 'retrying' || combatRecovery.retryAt === null || paused || !state.walletAddress || state.team.length === 0) return;
    const timer = window.setTimeout(() => {
      void spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
    }, Math.max(0, combatRecovery.retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [activeTeamKey, combatRecovery, paused, spawnBattle, state.team.length, state.walletAddress]);

  const awardBattle = useCallback((locationId: number, clearedLanes: number, wonHeroUids: string[], deadHeroUids: string[], allCleared: boolean) => {
    const st = stateRef.current;
    // Combat and its rewards keep running continuously while the player is
    // online; only offline/hidden-tab catch-up is gated by the active window.
    if (!st.walletAddress) return;
    const serverWave = normalCombatWaveRef.current;
    const combatGeneration = combatSessionRef.current.markSettling();
    if (combatGeneration === null) return;
    if (tokenomicsEnabled && serverWave) {
      normalCombatWaveRef.current = null;
      deadHeroUids.forEach((uid) => heroHpRef.current.delete(uid));
      const clearSeconds = Math.max(0, (Date.now() - battleStartedAtRef.current) / 1000);
      const combatPower = teamPower(st.team.map((uid) => st.ownedHeroes.find((hero) => hero.uid === uid)).filter((hero): hero is OwnedHero => Boolean(hero)), st.inventory);
      const combatRecommendedPower = recommendedTeamPower(serverWave.location, st.team.length, st.balanceTelemetry);
      const equippedStatLines = st.team.reduce((total, uid) => {
        const hero = st.ownedHeroes.find((owned) => owned.uid === uid);
        return total + (hero ? getEquippedItems(hero, st.inventory).reduce((sum, item) => sum + item.stats.length, 0) : 0);
      }, 0);
      void (async () => {
        // A small margin: phone clocks with automatic time can still run a fraction of a second ahead.
        const delay = Math.max(0, serverWave.availableAt - Date.now() + 400);
        if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
        let completionError = 'complete_failed';
        const complete = () => playerSync<NormalCombatCompleteResult>('normal_combat_complete', {
          start_key: serverWave.startKey,
          idempotency_key: serverWave.completionKey,
        }, (message) => { completionError = message; });
        let completed = await complete();
        // A phone clock running ahead of the server makes the wave end "too early": wait and retry
        // the same completion quietly instead of showing the battle-link recovery banner.
        for (let retry = 0; !completed && completionError === 'normal_combat_too_early' && retry < 6; retry += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          if (!combatSessionRef.current.isCurrent(combatGeneration)) return;
          completionError = 'complete_failed';
          completed = await complete();
        }
        if (!combatSessionRef.current.isCurrent(combatGeneration)) return;
        if (!completed) {
          queueCombatRecovery(combatGeneration, completionError);
          return;
        }
        mergeServerResourceState(completed.state);
        const revision = Number(completed.revision);
        if (Number.isSafeInteger(revision)) setServerRevisionHint(revision);
        const authoritativeWin = completed.outcome?.all_cleared === true;
        setState((current) => ({
          ...current,
          balanceTelemetry: recordBattleTelemetry(current.balanceTelemetry, {
            locationId: serverWave.location,
            teamSize: st.team.length,
            power: combatPower,
            recommendedPower: combatRecommendedPower,
            boss: false,
            win: authoritativeWin,
            clearSeconds,
            heroDeaths: deadHeroUids.length,
            equippedStatLines,
          }),
        }));
        combatSessionRef.current.markIdle(combatGeneration);
        combatRecoveryAttemptRef.current = 0;
        setCombatRecovery(HEALTHY_COMBAT);
        setBattleResult({
          win: authoritativeWin,
          gold: Math.max(0, Number(completed.rewards?.gold) || 0),
          xp: Math.max(0, Number(completed.rewards?.account_xp) || 0),
          tokens: 0,
          chest: false,
          overpowered: false,
        });
      })();
      return;
    }
    const loc = buildLocation(locationId, st.team.length, st.bossBattleActive, st.accountLevel);
    const baseXpPerEnemy = clearedLanes > 0 ? loc.xpReward : 0;

    const teamBonuses = st.team.reduce((acc, uid) => {
      const hero = st.ownedHeroes.find((h) => h.uid === uid);
      if (!hero) return acc;
      const s = heroStats(hero, getEquippedItems(hero, st.inventory));
      if (!s) return acc;
      return { gold: acc.gold + s.goldBonus, xp: acc.xp + s.xpBonus };
    }, { gold: 0, xp: 0 });
    const xpPerEnemy = Math.round(baseXpPerEnemy * (1 + teamBonuses.xp));
    const gold = goldRewardForLanes(loc.goldReward * (isolatedHackathon && !st.bossBattleActive ? 2 : 1), clearedLanes, teamBonuses.gold);
    const accountXpGain = xpPerEnemy * clearedLanes;

    const tokens = 0;
    const overpowered = false;

    let chestDropped = false;
    if (allCleared) {
      chestDropped = Boolean(loc.boss);
    }

    const now = Date.now();
    const combatPower = teamPower(st.team.map((uid) => st.ownedHeroes.find((hero) => hero.uid === uid)).filter((hero): hero is OwnedHero => Boolean(hero)), st.inventory);
    const combatRecommendedPower = recommendedTeamPower(locationId, st.team.length, st.balanceTelemetry);
    const equippedStatLines = st.team.reduce((total, uid) => {
      const hero = st.ownedHeroes.find((owned) => owned.uid === uid);
      return total + (hero ? getEquippedItems(hero, st.inventory).reduce((sum, item) => sum + item.stats.length, 0) : 0);
    }, 0);
    const clearSeconds = Math.max(0, (now - battleStartedAtRef.current) / 1000);
    deadHeroUids.forEach((uid) => heroHpRef.current.delete(uid));
    setState((prev) => {
      const next: GameState = tokenomicsEnabled
        ? { ...prev }
        : { ...prev, combatXpAt: now, gold: prev.gold + gold, totalGoldEarned: prev.totalGoldEarned + gold };
      next.balanceTelemetry = recordBattleTelemetry(prev.balanceTelemetry, {
        locationId, teamSize: st.team.length, power: combatPower, recommendedPower: combatRecommendedPower, boss: Boolean(loc.boss),
        win: allCleared, clearSeconds, heroDeaths: deadHeroUids.length, equippedStatLines,
      });
      next.bossBattleActive = false;
      if (tokenomicsEnabled) {
        next.ownedHeroes = prev.ownedHeroes.map((hero) =>
          deadHeroUids.includes(hero.uid) && !hero.respawnAt ? { ...hero, respawnAt: now + RESPAWN_TIME_MS } : hero
        );
        return next;
      }
      next.ownedHeroes = prev.ownedHeroes.map((h) =>
        deadHeroUids.includes(h.uid) && !h.respawnAt ? { ...h, respawnAt: now + RESPAWN_TIME_MS } : h
      );
      if (clearedLanes > 0) {
        next.totalKills = prev.totalKills + clearedLanes;
        // session + quests
        next.session = { ...prev.session, kills: prev.session.kills + clearedLanes };
        next.dailyQuests = updateQuestProgress(prev.dailyQuests, 'kill-', clearedLanes);
        next.milestoneQuests = updateQuestProgress(prev.milestoneQuests, 'kill-', clearedLanes);
        next.milestoneQuests = updateQuestProgress(next.milestoneQuests, 'gold-earned-', gold);
      }
      if (allCleared) {
        if (locationId === prev.currentLocation && locationId === prev.highestLocation) {
          next.highestLocation = locationId + 1;
        }
        if (loc.boss) {
          next.session.bossKills = prev.session.bossKills + 1;
          next.totalBossKills = prev.totalBossKills + 1;
          next.dailyQuests = updateQuestProgress(next.dailyQuests, 'boss-', 1);
          next.milestoneQuests = updateQuestProgress(next.milestoneQuests, 'boss-', 1);
        }
      }
      if (chestDropped && prev.chests.length < MAX_CHESTS && prev.chestsOpenedToday < MAX_CHESTS_PER_DAY) {
        next.chests = [...prev.chests, { id: `c${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, stage: locationId, boss: loc.boss }];
        next.chestsOpenedToday = prev.chestsOpenedToday + 1;
      }
      return awardSeekerXp(next, accountXpGain, Object.fromEntries(wonHeroUids.map((uid) => [uid, xpPerEnemy])));
    });
    combatSessionRef.current.markIdle(combatGeneration);
    setBattleResult({
      win: allCleared,
      gold: tokenomicsEnabled ? 0 : gold,
      xp: tokenomicsEnabled ? 0 : seekerXpReward(accountXpGain, st.seekerProgression?.accountXpRemainder ?? 0).xp,
      tokens,
      chest: tokenomicsEnabled ? false : chestDropped,
      overpowered,
    });
  }, [mergeServerResourceState, queueCombatRecovery]);

  const summonBoss = useCallback((remainingKeys?: number) => {
    const st = stateRef.current;
    if ((remainingKeys === undefined && st.bossKeys < 1) || st.bossBattleActive || st.team.length === 0) return false;
    flushSync(() => setState((prev) => ({ ...prev, bossKeys: remainingKeys ?? prev.bossKeys - 1, bossBattleActive: true })));
    spawnBattle(st.currentLocation, st.team, true);
    return true;
  }, [spawnBattle]);

  const syncBossKeys = useCallback((bossKeys: number) => {
    const normalizedBossKeys = Math.max(0, Math.floor(bossKeys));
    setState((prev) => prev.bossKeys === normalizedBossKeys
      ? prev
      : { ...prev, bossKeys: normalizedBossKeys });
  }, []);

  const tryAutoPotion = useCallback(() => {
    const st = stateRef.current;
    const healing = isolatedHackathon ? automaticHealingConfig(st.autoPot) : st.autoPot;
    if (!healing.enabled) return;
    const heroes = unitsRef.current.filter((u) => u.side === 'hero' && u.alive);
    for (const hero of heroes) {
      const hpFrac = hero.hp / hero.maxHp;
      if (hpFrac < healing.threshold) {
        const tiers: PotionTier[] = ['xxl', 'xl', 'lg', 'md', 'sm', 'xs'];
        let usedTier: PotionTier | null = null;
        for (const t of tiers) { if (st.potions[t] > 0) { usedTier = t; break; } }
        if (!usedTier && healing.autoBuy) {
          const autoTier = healing.autoSelectTier
            ? (['xs', 'sm', 'md', 'lg', 'xl', 'xxl'] as PotionTier[])
                .find((tier) => POTION_MAP[tier].hpRestore >= hero.maxHp * 0.5) ?? 'xxl'
            : healing.autoBuyTier;
          const def = POTION_MAP[autoTier];
          if (st.gold >= def.cost) usedTier = autoTier;
        }
        if (usedTier) {
          const def = POTION_MAP[usedTier];
          setState((prev) => {
            const inStock = prev.potions[usedTier!] > 0;
            const cost = inStock ? 0 : POTION_MAP[usedTier!].cost;
            if (!inStock && prev.gold < cost) return prev;
            return { ...prev, gold: prev.gold - cost, potions: { ...prev.potions, [usedTier!]: Math.max(0, prev.potions[usedTier!] - (inStock ? 1 : 0)) } };
          });
          const healedUnits = unitsRef.current.map((unit) => unit.uid === hero.uid ? { ...unit, hp: Math.min(unit.maxHp, unit.hp + def.hpRestore) } : unit);
          unitsRef.current = healedUnits;
          setUnits(healedUnits);
          setFloaters((prev) => [...prev.slice(-MAX_LIVE_FLOATERS), ...scheduleFloaters([{ id: floaterId.current++, targetUid: hero.uid, value: def.hpRestore, crit: false, heal: true, born: 0 }], performance.now(), floaterQueueRef.current)]);
          setPotionFx({ uid: hero.uid, born: performance.now() });
          return;
        }
      }
    }
  }, [setFloaters, setPotionFx, setUnits]);

  // Combat loop
  useEffect(() => {
    let raf = 0;
    let wakeTimer = 0;
    let disposed = false;
    let last = performance.now();
    let pendingFloaters: FloatingNumber[] = [];
    let pendingPotionFx: { uid: string; born: number } | null = null;
    const canRun = () => document.visibilityState === 'visible'
      && Boolean(stateRef.current.walletAddress)
      && !pausedRef.current
      && unitsRef.current.length > 0
      && !resolvingRef.current;
    const requestLoop = () => {
      if (!disposed && raf === 0 && canRun()) raf = requestAnimationFrame(loop);
    };
    const schedule = (resetClock = false) => {
      if (disposed || raf !== 0 || wakeTimer !== 0 || !canRun()) return;
      if (resetClock) {
        last = performance.now();
        requestLoop();
        return;
      }
      wakeTimer = window.setTimeout(() => {
        wakeTimer = 0;
        requestLoop();
      }, COMBAT_LOOP_INTERVAL_MS);
    };
    const loop = (now: number) => {
      raf = 0;
      if (!canRun()) return;
      const dt = Math.min((now - last) * COMBAT_SPEED, 100);
      last = now;
      const live = unitsRef.current;
      if (stateRef.current.walletAddress && !pausedRef.current && live.length > 0 && !resolvingRef.current) {
        const activeGeneration = combatSessionRef.current.snapshot().generation;
        combatSessionRef.current.markProgress(activeGeneration);
        // A respawning hero does not freeze the whole battlefield: it simply
        // does not fight (spawned as hp:0/alive:false), while living heroes and
        // monsters in their own lanes keep fighting.
        const resolution = combatResolution(live);
        if (resolution) {
          if (combatPresentationVisibleRef.current && pendingFloaters.length > 0) {
            setUnits(live);
            setFloaters((prev) => [...prev.slice(-MAX_LIVE_FLOATERS), ...scheduleFloaters(pendingFloaters, now, floaterQueueRef.current)]);
            if (pendingPotionFx) setPotionFx({ ...pendingPotionFx, born: now });
          }
          pendingFloaters = [];
          pendingPotionFx = null;
          resolvingRef.current = true;
          // Per-line rewards: each hero is rewarded only for the enemy in its own lane.
          // Other heroes keep fighting after one dies; a dead hero grants nothing for its lane.
          awardBattle(
            stateRef.current.currentLocation,
            resolution.clearedLanes,
            resolution.wonHeroUids,
            resolution.deadHeroUids,
            resolution.allCleared,
          );
        } else {
          const newFloaters: FloatingNumber[] = [];
          let finalUnits = live;
          let remaining = combatAccumulatorRef.current + dt;
          const events: ReturnType<typeof advanceCombatFrame>['events'] = [];
          while (remaining >= 20 && !combatResolution(finalUnits)) {
            const step = advanceCombatFrame(finalUnits, 20, combatRandomRef.current);
            finalUnits = step.units;
            events.push(...step.events);
            remaining -= 20;
            const serverWave = normalCombatWaveRef.current;
            if (serverWave) {
              serverWave.elapsedMs += 20;
              if (serverWave.potionTicks) {
                while (serverWave.nextPotionTick < serverWave.potionTicks.length
                  && serverWave.potionTicks[serverWave.nextPotionTick].elapsedMs <= serverWave.elapsedMs) {
                  const tick = serverWave.potionTicks[serverWave.nextPotionTick++];
                  finalUnits = finalUnits.map(unit => unit.uid === tick.targetUid && unit.alive
                    ? { ...unit, hp: Math.min(unit.maxHp, unit.hp + (tick.amount ?? 0)) } : unit);
                  pendingPotionFx = { uid: tick.targetUid, born: now };
                }
              } else if (!combatResolution(finalUnits)) {
                while (serverWave.nextAutoPotion < serverWave.autoPotions.length
                  && serverWave.autoPotions[serverWave.nextAutoPotion].elapsed_ms <= serverWave.elapsedMs) {
                  const potion = serverWave.autoPotions[serverWave.nextAutoPotion++];
                  finalUnits = finalUnits.map((unit) => unit.uid === potion.hero_uid && unit.alive
                    ? { ...unit, hp: Math.min(unit.maxHp, unit.hp + potion.hp_restore) }
                    : unit);
                  if (!serverWave.timeline) newFloaters.push({ id: floaterId.current++, sourceUid: potion.hero_uid, targetUid: potion.hero_uid, value: potion.hp_restore, crit: false, heal: true, born: now });
                  pendingPotionFx = { uid: potion.hero_uid, born: now };
                }
              }
            }
          }
          combatAccumulatorRef.current = remaining;
          const serverTimeline = normalCombatWaveRef.current;
          const presentationEvents = serverTimeline?.timeline ? (() => {
            const due: CombatTimelineEvent[] = [];
            while (serverTimeline.nextTimeline < serverTimeline.timeline.length
              && serverTimeline.timeline[serverTimeline.nextTimeline].elapsedMs <= serverTimeline.elapsedMs) {
              due.push(serverTimeline.timeline[serverTimeline.nextTimeline++]);
            }
            return due;
          })() : events.map((event) => ({ ...event, sourceUid: 'sourceUid' in event ? event.sourceUid : event.targetUid }));
          presentationEvents.forEach((event) => newFloaters.push(combatFloater(event, floaterId.current++, now)));
          finalUnits.forEach((u) => {
            if (u.side === 'hero') heroHpRef.current.set(u.uid, u.hp);
          });
          unitsRef.current = finalUnits;
          if (newFloaters.length > 0) pendingFloaters = [...pendingFloaters, ...newFloaters].slice(-MAX_LIVE_FLOATERS);
          if (!combatPresentationVisibleRef.current) {
            pendingFloaters = [];
            pendingPotionFx = null;
          }
          if (combatPresentationVisibleRef.current && combatPresentationDue(
            stateRef.current.battleAnimationMode, now - lastCombatRenderRef.current, pendingFloaters.length > 0,
          )) {
            lastCombatRenderRef.current = now;
            setUnits(finalUnits);
            if (pendingFloaters.length > 0) setFloaters((prev) => [...prev.slice(-MAX_LIVE_FLOATERS), ...scheduleFloaters(pendingFloaters, now, floaterQueueRef.current)]);
            if (pendingPotionFx) setPotionFx({ ...pendingPotionFx, born: now });
            pendingFloaters = [];
            pendingPotionFx = null;
          }
          if (!tokenomicsEnabled || !normalCombatWaveRef.current) tryAutoPotion();
        }
      }
      schedule();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (raf !== 0) cancelAnimationFrame(raf);
        if (wakeTimer !== 0) window.clearTimeout(wakeTimer);
        raf = 0;
        wakeTimer = 0;
        pendingFloaters = [];
        pendingPotionFx = null;
        return;
      }
      const snapshot = combatSessionRef.current.snapshot();
      combatSessionRef.current.markProgress(snapshot.generation);
      schedule(true);
    };
    combatWakeRef.current = () => schedule(true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    schedule(true);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (raf !== 0) cancelAnimationFrame(raf);
      if (wakeTimer !== 0) window.clearTimeout(wakeTimer);
      combatWakeRef.current = () => undefined;
    };
  }, [awardBattle, setFloaters, setPotionFx, setUnits, tryAutoPotion]);

  useEffect(() => {
    if (!tokenomicsEnabled) return;
    const check = () => {
      if (document.visibilityState !== 'visible' || pausedRef.current || !stateRef.current.walletAddress) return;
      const snapshot = combatSessionRef.current.snapshot();
      const stalledGeneration = stalledCombatGeneration(snapshot, Date.now());
      if (stalledGeneration !== null) queueCombatRecovery(stalledGeneration, `watchdog_${snapshot.phase}`);
    };
    const resume = () => {
      if (document.visibilityState !== 'visible') return;
      const snapshot = combatSessionRef.current.snapshot();
      combatSessionRef.current.markProgress(snapshot.generation);
      combatWakeRef.current();
    };
    const timer = window.setInterval(check, 5_000);
    document.addEventListener('visibilitychange', resume);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [queueCombatRecovery]);

  useEffect(() => {
    if (!paused) combatWakeRef.current();
  }, [paused]);

  const setCombatPresentationVisible = useCallback((visible: boolean) => {
    combatPresentationVisibleRef.current = visible;
    setFloaters([]);
    setPotionFx(null);
    if (visible) {
      lastCombatRenderRef.current = performance.now();
      setUnits(unitsRef.current);
    }
  }, [setFloaters, setPotionFx, setUnits]);

  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      if (timer !== 0 || combatPresentationRef.current.floaters.length === 0) return;
      timer = window.setTimeout(() => {
        timer = 0;
        const now = performance.now();
        setFloaters((current) => {
          const next = current.filter((floater) => now - floater.born < FLOATER_LIFETIME_MS + (floater.delayMs ?? 0));
          return next.length === current.length ? current : next;
        });
        schedule();
      }, 300);
    };
    const unsubscribe = subscribeCombatPresentation(schedule);
    schedule();
    return () => {
      unsubscribe();
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [setFloaters, subscribeCombatPresentation]);

  useEffect(() => {
    if (!battleResult || pausedRef.current) return;
    const pendingRequest = combatSessionRef.current.snapshot().pendingRequest;
    if (!pendingRequest && !autoRef.current) return;
    // Keep the reward handoff visible without leaving cleared enemy lanes
    // empty long enough to look stalled.
    const delay = battleResult.win ? 250 : 800;
    let ready = false;
    let spawned = false;
    const spawnIfVisible = () => {
      if (!ready || spawned || document.visibilityState !== 'visible') return;
      spawned = true;
      void spawnBattle(
        pendingRequest?.locationId ?? stateRef.current.currentLocation,
        pendingRequest?.teamUids ?? stateRef.current.team,
        pendingRequest?.forceBoss,
      );
    };
    const t = window.setTimeout(() => { ready = true; spawnIfVisible(); }, delay);
    document.addEventListener('visibilitychange', spawnIfVisible);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('visibilitychange', spawnIfVisible);
    };
  }, [battleResult, spawnBattle]);

  useEffect(() => {
    let timer: number | null = null;
    const tickRespawnClock = () => {
      const st = stateRef.current;
      if (!st.walletAddress) return;
      const now = Date.now();
      const countdown: Record<string, number> = {};
      let finished = false;
      st.ownedHeroes.forEach((h) => {
        if (h.respawnAt && h.respawnAt > now) countdown[h.uid] = Math.ceil((h.respawnAt - now) / 1000);
        else if (h.respawnAt && h.respawnAt <= now) finished = true;
      });
      // Keep the previous object when nothing changed: a fresh one every second
      // re-rendered the whole game screen and the Arena, heating phones.
      setRespawnCountdowns((prev) => {
        const keys = Object.keys(countdown);
        return keys.length === Object.keys(prev).length && keys.every((uid) => prev[uid] === countdown[uid]) ? prev : countdown;
      });
      if (finished) setState((prev) => ({ ...prev, ownedHeroes: prev.ownedHeroes.map((h) => h.respawnAt && h.respawnAt <= now ? { ...h, respawnAt: undefined } : h) }));
    };
    const syncRespawnClock = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      if (document.visibilityState !== 'visible') return;
      tickRespawnClock();
      timer = window.setInterval(tickRespawnClock, 1_000);
    };
    document.addEventListener('visibilitychange', syncRespawnClock);
    syncRespawnClock();
    return () => {
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', syncRespawnClock);
    };
  }, []);

  useEffect(() => {
    if (tokenomicsEnabled) return;
    const check = () => { if (Date.now() >= stateRef.current.rotatingShopRefreshAt) setState((prev) => ({ ...prev, rotatingShop: generateRotatingShop().map((s) => ({ ...s, sold: false })), rotatingShopRefreshAt: Date.now() + ROTATING_REFRESH_MS })); };
    const t = setInterval(check, 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (tokenomicsEnabled) return;
    let previousTick = Date.now();
    const resetClock = () => { previousTick = Date.now(); };
    const tick = () => {
      const now = Date.now();
      const elapsed = Math.min(15, Math.max(0, (now - previousTick) / 1000));
      previousTick = now;
      if (document.visibilityState !== 'visible') return;
      setState((prev) => {
        const dayChanged = gameDayKey(prev.lastChestReset) !== gameDayKey(now);
        const base = dayChanged ? { ...prev, chestsOpenedToday: 0, lastChestReset: now } : prev;
        if (!base.walletAddress) return dayChanged ? base : prev;
        const progress = base.boost.chestProgressSeconds + elapsed;
        const earned = Math.floor(progress / ACTIVE_CHEST_SECONDS);
        const remainder = progress % ACTIVE_CHEST_SECONDS;
        if (earned === 0) {
          return { ...base, lastSeen: now, boost: { ...base.boost, chestProgressSeconds: progress } };
        }
        const available = Math.max(0, MAX_CHESTS - base.chests.length);
        const dailyAvailable = Math.max(0, MAX_CHESTS_PER_DAY - base.chestsOpenedToday);
        const awarded = Math.min(earned, available, dailyAvailable);
        const chests = awarded > 0
          ? [...base.chests, ...Array.from({ length: awarded }, (_, index) => ({ id: `active-${now}-${index}`, stage: base.currentLocation }))]
          : base.chests;
        return {
          ...base,
          lastSeen: now,
          chests,
          chestsOpenedToday: base.chestsOpenedToday + awarded,
          boost: { ...base.boost, chestProgressSeconds: remainder },
        };
      });
    };
    const timer = window.setInterval(tick, 10_000);
    document.addEventListener('visibilitychange', resetClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', resetClock);
    };
  }, []);

  // A minimized/background tab can pause requestAnimationFrame before a combat
  // wave resolves. Catch up the complete Active reward stream on return.
  useEffect(() => {
    if (tokenomicsEnabled) return;
    let hiddenSince: number | null = null;
    const markHidden = () => { hiddenSince ??= Date.now(); };
    const catchUp = () => {
      if (document.visibilityState !== 'visible' || hiddenSince === null) return;
      const now = Date.now();
      const elapsed = Math.min(7 * 24 * 60 * 60, Math.max(0, (Date.now() - hiddenSince) / 1000));
      hiddenSince = null;
      setState((prev) => {
        if (!prev.walletAddress) return prev;
        const dayChanged = gameDayKey(prev.lastChestReset) !== gameDayKey(now);
        const base = dayChanged ? { ...prev, chestsOpenedToday: 0, lastChestReset: now } : prev;
        if (base.team.length === 0) return { ...base, lastSeen: now, combatXpAt: now };
        if (elapsed < 12) return { ...base, lastSeen: now, combatXpAt: now };
        const activeSeconds = base.boost.active ? elapsed : Math.min(elapsed, Math.max(0, (base.activeUntil - (now - elapsed * 1000)) / 1000));
        const battles = Math.floor(activeSeconds / 12);
        if (activeSeconds <= 0 || battles <= 0) return { ...base, lastSeen: now, combatXpAt: now };
        const loc = buildLocation(base.currentLocation, base.team.length, false, base.accountLevel);
        const teamBonuses = base.team.reduce((acc, uid) => {
          const hero = base.ownedHeroes.find((candidate) => candidate.uid === uid);
          const stats = hero ? heroStats(hero, getEquippedItems(hero, base.inventory)) : null;
          return stats ? { gold: acc.gold + stats.goldBonus, xp: acc.xp + stats.xpBonus } : acc;
        }, { gold: 0, xp: 0 });
        const gold = tokenomicsEnabled ? 0 : battles * goldRewardForLanes(loc.goldReward, loc.enemies.length, teamBonuses.gold);
        const heroXp = Math.round(battles * loc.xpReward * (1 + teamBonuses.xp));
        const accountXp = heroXp * loc.enemies.length;
        const kills = battles * loc.enemies.length;
        const progress = base.boost.chestProgressSeconds + (tokenomicsEnabled ? 0 : activeSeconds);
        const earned = tokenomicsEnabled ? 0 : Math.floor(progress / ACTIVE_CHEST_SECONDS);
        const available = Math.max(0, MAX_CHESTS - base.chests.length);
        const dailyAvailable = Math.max(0, MAX_CHESTS_PER_DAY - base.chestsOpenedToday);
        const awarded = Math.min(earned, available, dailyAvailable);
        const chests = awarded > 0
          ? [...base.chests, ...Array.from({ length: awarded }, (_, index) => ({ id: `active-${now}-${index}`, stage: base.currentLocation }))]
          : base.chests;
        const penalty = trainingTokenPenalty(base.trainingCamp.heroUids.filter(Boolean).length);
        const tokens = tokenomicsEnabled ? 0 : (canMineTokens(base.currentLocation, base.accountLevel, base.highestLocation, base.seekerProgression?.legacyLocationAccess) ? Math.floor((activeSeconds / 86400) * 20_000 * (1 - penalty)) : 0);
        const awardedXp = awardSeekerXp(base, accountXp, Object.fromEntries(base.team.map((uid) => [uid, heroXp])));
        const dayKey = gameDayKey();
        return {
          ...awardedXp,
          lastSeen: now,
          combatXpAt: now,
          gold: base.gold + gold,
          totalGoldEarned: base.totalGoldEarned + gold,
          hero: base.hero + tokens,
          totalTokensEarned: base.totalTokensEarned + tokens,
          tokensEarnedToday: (base.tokenDayKey === dayKey ? base.tokensEarnedToday : 0) + tokens,
          tokenDayKey: dayKey,
          totalKills: base.totalKills + kills,
          session: { ...base.session, kills: base.session.kills + kills },
          chests,
          chestsOpenedToday: base.chestsOpenedToday + awarded,
          boost: { ...base.boost, chestProgressSeconds: earned > 0 ? progress % ACTIVE_CHEST_SECONDS : progress },
          dailyQuests: updateQuestProgress(base.dailyQuests, 'kill-', kills),
          milestoneQuests: updateQuestProgress(updateQuestProgress(base.milestoneQuests, 'kill-', kills), 'gold-earned-', gold),
        };
      });
    };
    const onVisibilityChange = () => { if (document.visibilityState === 'hidden') markHidden(); else catchUp(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', markHidden);
    window.addEventListener('focus', catchUp);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', markHidden);
      window.removeEventListener('focus', catchUp);
    };
  }, []);

  const [offlineEarnings, setOfflineEarnings] = useState<{ gold: number; seconds: number; tokens?: number; chests?: number; xp?: number } | null>(null);
  useEffect(() => {
    if (tokenomicsEnabled) return;
    const st = stateRef.current;
    if (!st.walletAddress) return;
    const prev = st.combatXpAt;
    const now = Date.now();
    const settlementKey = `${st.walletAddress}:${prev}:${hydrationVersion}`;
    if (offlineSettlementKeyRef.current === settlementKey) return;
    offlineSettlementKeyRef.current = settlementKey;
    const elapsed = Math.max((now - prev) / 1000, 0);
    const activeElapsed = st.boost.active ? elapsed : Math.min(elapsed, Math.max(0, (st.activeUntil - prev) / 1000));
    if (activeElapsed > 30 && st.team.length > 0) {
      const loc = buildLocation(st.currentLocation, st.team.length, false, st.accountLevel);
      const battles = Math.floor(activeElapsed / 12);
      const teamBonuses = st.team.reduce((acc, uid) => {
        const hero = st.ownedHeroes.find((h) => h.uid === uid);
        const stats = hero ? heroStats(hero, getEquippedItems(hero, st.inventory)) : null;
        return stats ? { gold: acc.gold + stats.goldBonus, xp: acc.xp + stats.xpBonus } : acc;
      }, { gold: 0, xp: 0 });
      const gold = tokenomicsEnabled ? 0 : battles * goldRewardForLanes(loc.goldReward, loc.enemies.length, teamBonuses.gold);
      const heroXp = Math.round(battles * loc.xpReward * (1 + teamBonuses.xp));
      const accountXp = heroXp * loc.enemies.length;
      const penalty = trainingTokenPenalty(st.trainingCamp.heroUids.filter(Boolean).length);
      const tokens = !tokenomicsEnabled && canMineTokens(st.currentLocation, st.accountLevel, st.highestLocation, st.seekerProgression?.legacyLocationAccess)
        ? Math.floor((activeElapsed / 86400) * 20_000 * (1 - penalty))
        : 0;
      const chestProgress = st.boost.chestProgressSeconds + (tokenomicsEnabled ? 0 : activeElapsed);
      const chests = tokenomicsEnabled ? 0 : Math.min(
        Math.floor(chestProgress / ACTIVE_CHEST_SECONDS),
        Math.max(0, MAX_CHESTS - st.chests.length),
        Math.max(0, MAX_CHESTS_PER_DAY - st.chestsOpenedToday),
      );
      const kills = battles * loc.enemies.length;
      const dayKey = gameDayKey(now);
      setState((p) => ({
          ...awardSeekerXp(p, accountXp, Object.fromEntries(p.team.map((uid) => [uid, heroXp]))),
          lastSeen: tokenomicsEnabled ? p.lastSeen : now,
          combatXpAt: now,
          gold: p.gold + gold,
          totalGoldEarned: p.totalGoldEarned + gold,
          hero: p.hero + tokens,
          totalTokensEarned: p.totalTokensEarned + tokens,
          tokensEarnedToday: (p.tokenDayKey === dayKey ? p.tokensEarnedToday : 0) + tokens,
          tokenDayKey: dayKey,
          totalKills: p.totalKills + kills,
          session: { ...p.session, kills: p.session.kills + kills },
          chests: chests > 0 ? [...p.chests, ...Array.from({ length: chests }, (_, i) => ({ id: `active-offline-${now}-${i}`, stage: p.currentLocation }))] : p.chests,
          chestsOpenedToday: p.chestsOpenedToday + chests,
          boost: { ...p.boost, chestProgressSeconds: chestProgress >= ACTIVE_CHEST_SECONDS ? chestProgress % ACTIVE_CHEST_SECONDS : chestProgress },
          dailyQuests: updateQuestProgress(p.dailyQuests, 'kill-', kills),
          milestoneQuests: updateQuestProgress(
            updateQuestProgress(updateQuestProgress(p.milestoneQuests, 'kill-', kills), 'gold-earned-', gold),
            'token-earned-',
            tokens,
          ),
        }));
      setOfflineEarnings({ gold, seconds: activeElapsed, tokens: tokens || undefined, chests: chests || undefined, xp: seekerXpReward(accountXp, st.seekerProgression?.accountXpRemainder ?? 0).xp || undefined });
    } else {
      setState((p) => ({ ...p, combatXpAt: now, lastSeen: tokenomicsEnabled ? p.lastSeen : now }));
    }
  }, [hydrationVersion, state.walletAddress]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const creditTestGold = useCallback(async (onError?: (message: string) => void): Promise<boolean> => {
    const result = await playerSync<{ gold: number; total_gold_earned: number; revision: number }>('tester_credit_gold', {}, onError);
    if (!result || !Number.isFinite(result.gold) || !Number.isFinite(result.total_gold_earned)) return false;
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    const nextState = {
      ...stateRef.current,
      gold: result.gold,
      totalGoldEarned: result.total_gold_earned,
    };
    stateRef.current = nextState;
    setState(nextState);
    return true;
  }, []);

  const creditTestAccountXp = useCallback(async (onError?: (message: string) => void): Promise<boolean> => {
    const result = await playerSync<{ state: GameState; revision: number }>('tester_credit_account_xp', {}, onError);
    if (!result?.state || !Number.isSafeInteger(result.revision)) return false;
    setServerRevisionHint(result.revision);
    hydrateServerState(result.state);
    return true;
  }, [hydrateServerState]);

  const creditTestFormationXp = useCallback(async (onError?: (message: string) => void): Promise<boolean> => {
    const result = await playerSync<{ state: GameState; revision: number }>('tester_credit_formation_xp', {}, onError);
    if (!result?.state || !Number.isSafeInteger(result.revision)) return false;
    setServerRevisionHint(result.revision);
    hydrateServerState(result.state);
    return true;
  }, [hydrateServerState]);

  const creditServerTokens = useCallback((amount: number) => {
    const safeAmount = Math.max(0, Math.floor(amount));
    if (safeAmount <= 0) return;
    setState((prev) => {
      const dayKey = gameDayKey();
      return {
        ...prev,
        hero: prev.hero + safeAmount,
        totalTokensEarned: prev.totalTokensEarned + safeAmount,
        tokensEarnedToday: (prev.tokenDayKey === dayKey ? prev.tokensEarnedToday : 0) + safeAmount,
        tokenDayKey: dayKey,
        session: { ...prev.session, heroToday: prev.session.heroToday + safeAmount },
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-earned-', safeAmount),
      };
    });
  }, []);

  const applyServerTokenClaim = useCallback((amount: number, balance: number) => {
    const safeAmount = Math.max(0, Math.floor(amount));
    const safeBalance = Math.max(0, Math.floor(balance));
    setState((prev) => {
      const dayKey = gameDayKey();
      return {
        ...prev,
        hero: safeBalance,
        totalTokensEarned: prev.totalTokensEarned + safeAmount,
        tokensEarnedToday: (prev.tokenDayKey === dayKey ? prev.tokensEarnedToday : 0) + safeAmount,
        tokenDayKey: dayKey,
        session: { ...prev.session, heroToday: prev.session.heroToday + safeAmount },
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-earned-', safeAmount),
      };
    });
  }, []);

  const setServerTokenBalance = useCallback((balance: number) => {
    const safeBalance = Math.max(0, Math.floor(balance));
    setState((prev) => prev.hero === safeBalance ? prev : { ...prev, hero: safeBalance });
  }, []);

  const applyServerBoostStatus = useCallback((active: boolean, progress: number) => {
    const safeProgress = Math.max(0, Math.min(100, Math.round(progress)));
    setState((prev) => prev.boost.active === active && prev.boost.progress === safeProgress ? prev : {
      ...prev,
      boost: { ...prev.boost, active, progress: safeProgress, bonusPct: active ? 100 : 0 },
    });
  }, []);

  const applyServerPityStatus = useCallback((pity: { legendary: number; mythic: number; cosmic: number; divine: number; celestial: number }) => {
    setSummonPity({
      legendary: Math.max(0, Math.floor(pity.legendary)),
      mythic: Math.max(0, Math.floor(pity.mythic)),
      cosmic: Math.max(0, Math.floor(pity.cosmic)),
      divine: Math.max(0, Math.floor(pity.divine)),
      celestial: Math.max(0, Math.floor(pity.celestial)),
    });
  }, []);

  const applyServerAscensionFocus = useCallback((focus: Partial<Record<Rarity, string>> | null | undefined) => {
    const safe: Partial<Record<Rarity, string>> = {};
    if (focus && typeof focus === 'object') {
      for (const [rarity, heroId] of Object.entries(focus)) {
        const base = typeof heroId === 'string' ? HERO_MAP[heroId] : undefined;
        if (base?.rarity === rarity) safe[rarity as Rarity] = heroId;
      }
    }
    setAscensionFocus(safe);
  }, []);

  const setHeroAscensionFocus = useCallback(async (rarity: Rarity, heroId: string | null): Promise<boolean> => {
    if (!tokenomicsEnabled) return false;
    const result = await playerSync<{ ascension_focus: Partial<Record<Rarity, string>> }>('ascension_focus_set', {
      rarity,
      target_hero_id: heroId,
      idempotency_key: createIdempotencyKey(),
    });
    if (!result?.ascension_focus) return false;
    applyServerAscensionFocus(result.ascension_focus);
    return true;
  }, [applyServerAscensionFocus]);

  const quoteHeroSummon = useCallback(async (count: 1 | 10 | 100): Promise<
    { ok: true; quote: { quoteId: string; count: 1 | 10 | 100; tokenCost: number; expiresAt: string } }
    | { ok: false; error: string }
  > => {
    const expectedRevision = serverRevisionHint;
    if (!tokenomicsEnabled || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision)) {
      return { ok: false, error: 'state_unavailable' };
    }
    let failure = 'hero_summon_quote_failed';
    const result = await playerSync<{
      quote_id: string; summon_count: number; pricing_mode: string;
      token_cost: number; expires_at: string;
    }>('hero_summon_quote', { count, expected_revision: expectedRevision }, (code) => { failure = code; });
    if (!result || typeof result.quote_id !== 'string' || result.summon_count !== count
      || result.pricing_mode !== 'test_hero'
      || result.token_cost !== count * 20
      || typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at))) {
      return { ok: false, error: failure };
    }
    return { ok: true, quote: {
      quoteId: result.quote_id, count, tokenCost: result.token_cost, expiresAt: result.expires_at,
    } };
  }, [serverRevisionHint]);

  const settleServerSummon = useCallback(async (
    count: 1 | 10 | 100,
    paymentMethod: 'paid' | 'scroll',
    quoteId: string | null,
  ) => {
    let expectedRevision = serverRevisionHint;
    if (!tokenomicsEnabled || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision)) return null;
    setSummonError('');
    const idempotencyKey = createIdempotencyKey();
    let summonError = '';
    type SummonResult = {
      heroes: OwnedHero[];
      token_balance: number;
      spent: number;
      scrolls_spent: number;
      summon_scrolls: number;
      payment_method: 'paid' | 'scroll';
      revision: number;
      pity_legendary: number;
      pity_mythic: number;
      pity_cosmic: number;
      pity_divine: number;
      pity_celestial: number;
      ascension_focus: Partial<Record<Rarity, string>>;
    };
    const attemptSummon = () => {
      summonError = '';
      return playerSync<SummonResult>('hero_summon', {
        count, expected_revision: expectedRevision, payment_method: paymentMethod,
        quote_id: quoteId, idempotency_key: idempotencyKey,
      }, (error) => { summonError = error; });
    };
    let result = await attemptSummon();
    // A battle settled between the last revision the client saw and this summon.
    // A Scroll summon has no price quote to go stale, so re-read the revision and
    // retry once with the same idempotency key (the pattern quest claims use).
    if (!result && summonError === 'state_conflict' && paymentMethod === 'scroll') {
      const refreshed = await playerSync<{ revision: number }>('game_state_load');
      if (refreshed && Number.isSafeInteger(refreshed.revision)) {
        expectedRevision = refreshed.revision;
        setServerRevisionHint(refreshed.revision);
        result = await attemptSummon();
      }
    }
    if (!result && summonError) setSummonError(summonError);
    if (!result || !Array.isArray(result.heroes) || result.heroes.length !== count
      || result.payment_method !== paymentMethod || !Number.isSafeInteger(result.spent) || result.spent < 0
      || !Number.isSafeInteger(result.scrolls_spent) || result.scrolls_spent < 0
      || !Number.isSafeInteger(result.summon_scrolls) || result.summon_scrolls < 0
      || !Number.isSafeInteger(result.token_balance) || result.token_balance < 0
      || !Number.isSafeInteger(result.revision) || result.revision <= expectedRevision
      || (paymentMethod === 'paid' && (result.spent <= 0 || result.scrolls_spent !== 0))
      || (paymentMethod === 'scroll' && (result.spent !== 0 || result.scrolls_spent !== count))) {
      if (result) setSummonError('invalid_server_response');
      return null;
    }
    const heroes = result.heroes.filter((hero) => hero && typeof hero.uid === 'string' && Boolean(HERO_MAP[hero.heroId]));
    if (heroes.length !== count) {
      setSummonError('invalid_server_hero');
      return null;
    }
    setSummonPity({
      legendary: Math.max(0, Math.floor(result.pity_legendary)),
      mythic: Math.max(0, Math.floor(result.pity_mythic)),
      cosmic: Math.max(0, Math.floor(result.pity_cosmic)),
      divine: Math.max(0, Math.floor(result.pity_divine)),
      celestial: Math.max(0, Math.floor(result.pity_celestial)),
    });
    applyServerAscensionFocus(result.ascension_focus);
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    return {
      heroes, balance: Math.max(0, Math.floor(result.token_balance)), spent: result.spent,
      scrollsSpent: result.scrolls_spent, summonScrolls: result.summon_scrolls,
    };
  }, [applyServerAscensionFocus, serverRevisionHint]);

  const settleServerAscension = useCallback(async (targetUid: string, repeat: boolean) => {
    if (!tokenomicsEnabled) return null;
    const result = await playerSync<{
      owned_heroes: OwnedHero[];
      token_balance: number;
      revision: number;
      spent: number;
      stars_added: number;
    }>('hero_ascend', {
      target_uid: targetUid,
      repeat,
      idempotency_key: createIdempotencyKey(),
    });
    if (!result || !Array.isArray(result.owned_heroes) || result.stars_added < 1) return null;
    const heroes = result.owned_heroes.filter((hero) => hero && typeof hero.uid === 'string' && Boolean(HERO_MAP[hero.heroId]));
    if (heroes.length !== result.owned_heroes.length) return null;
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    return {
      heroes,
      balance: Math.max(0, Math.floor(result.token_balance)),
      spent: Math.max(0, Math.floor(result.spent)),
      starsAdded: Math.max(1, Math.floor(result.stars_added)),
    };
  }, []);

  const settleServerPromotionAll = useCallback(async (targetUids: string[]) => {
    if (!tokenomicsEnabled || targetUids.length === 0) return null;
    const result = await playerSync<{
      owned_heroes: OwnedHero[];
      token_balance: number;
      revision: number;
      spent: number;
      stars_added: number;
      promotions: { target_uid: string; stars_added: number }[];
    }>('hero_ascend', {
      target_uids: targetUids,
      repeat: true,
      idempotency_key: createIdempotencyKey(),
    });
    if (!result || !Array.isArray(result.owned_heroes) || !Array.isArray(result.promotions)) return null;
    const heroes = result.owned_heroes.filter((hero) => hero && typeof hero.uid === 'string' && Boolean(HERO_MAP[hero.heroId]));
    const requested = new Set(targetUids);
    const promotions = result.promotions.filter((promotion) => requested.has(promotion.target_uid)
      && Number.isSafeInteger(promotion.stars_added) && promotion.stars_added > 0);
    if (heroes.length !== result.owned_heroes.length || promotions.length !== result.promotions.length) return null;
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    return {
      heroes,
      promotions,
      balance: Math.max(0, Math.floor(result.token_balance)),
      spent: Math.max(0, Math.floor(result.spent)),
    };
  }, []);

  // Seeker Promote All: duplicates + the Gold total the player saw (src/game/seekerPromotion.ts).
  const seekerPromoteAll = useCallback(async (plan: SeekerPromotionPlan): Promise<
    { ok: true; promotions: (SeekerPromotionStep & { powerBefore: number; powerAfter: number })[]; goldSpent: number } | { ok: false; error: string }> => {
    if (!tokenomicsEnabled || plan.targets.length === 0) return { ok: false, error: 'nothing_to_promote' };
    const before = stateRef.current;
    let failure = 'ascension_failed';
    const result = await playerSync<{
      owned_heroes: OwnedHero[];
      gold: number;
      gold_spent: number;
      revision: number;
      promotions: { target_uid: string; hero_id: string; from_stars: number; to_stars: number; gold: number }[];
    }>('hero_ascend', {
      target_uids: plan.targets,
      repeat: true,
      expected_gold: plan.gold,
      idempotency_key: createIdempotencyKey(),
    }, (message) => { failure = message; });
    if (!result || !Array.isArray(result.owned_heroes) || !Array.isArray(result.promotions) || !Number.isFinite(Number(result.gold))) {
      return { ok: false, error: failure };
    }
    const heroes = result.owned_heroes.filter((hero) => hero && typeof hero.uid === 'string' && Boolean(HERO_MAP[hero.heroId]));
    if (heroes.length !== result.owned_heroes.length) return { ok: false, error: 'invalid_server_response' };
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    const gold = Math.max(0, Number(result.gold));
    setState((prev) => ({ ...prev, ownedHeroes: heroes, gold }));
    return {
      ok: true,
      goldSpent: Math.max(0, Math.floor(Number(result.gold_spent) || 0)),
      promotions: result.promotions.map((entry) => ({
        uid: entry.target_uid, heroId: entry.hero_id, from: entry.from_stars, to: entry.to_stars, gold: entry.gold,
        powerBefore: teamPower(before.ownedHeroes.filter((hero) => hero.uid === entry.target_uid), before.inventory),
        powerAfter: teamPower(heroes.filter((hero) => hero.uid === entry.target_uid), before.inventory),
      })),
    };
  }, []);

  const releaseHero = useCallback(async (uid: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    const expectedRevision = serverRevisionHint;
    if (!tokenomicsEnabled || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision)) {
      return { ok: false, error: 'state_unavailable' };
    }
    let failure = 'hero_release_failed';
    const result = await playerSync<{
      released_uid: string;
      owned_heroes: OwnedHero[];
      remaining_heroes: number;
      avatar_hero_id: string;
      revision: number;
    }>('hero_release', {
      hero_uid: uid,
      expected_revision: expectedRevision,
      idempotency_key: createIdempotencyKey(),
    }, (code) => { failure = code; });
    if (!result || result.released_uid !== uid || !Array.isArray(result.owned_heroes)
      || !Number.isSafeInteger(result.revision) || result.revision <= expectedRevision
      || result.remaining_heroes !== result.owned_heroes.length || result.remaining_heroes < 1
      || typeof result.avatar_hero_id !== 'string' || result.owned_heroes.some((hero) => hero.uid === uid)
      || result.owned_heroes.some((hero) => !hero || typeof hero.uid !== 'string' || !HERO_MAP[hero.heroId])) {
      return { ok: false, error: failure };
    }
    const nextState = {
      ...stateRef.current,
      ownedHeroes: result.owned_heroes,
      avatarHeroId: result.avatar_hero_id,
    };
    stateRef.current = nextState;
    setState(nextState);
    setServerRevisionHint(result.revision);
    return { ok: true };
  }, [serverRevisionHint]);

  const quoteHeroCapacity = useCallback(async (): Promise<
    { ok: true; quote: { quoteId: string; previousCapacity: number; heroCapacity: number; usdCents: number; tokenCost: number; dexSource: string; expiresAt: string } }
    | { ok: false; error: string }
  > => {
    const current = stateRef.current;
    const expectedRevision = serverRevisionHint;
    if (!tokenomicsEnabled || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || current.heroCapacity >= MAX_HERO_CAPACITY) {
      return { ok: false, error: current.heroCapacity >= MAX_HERO_CAPACITY ? 'maximum_capacity' : 'state_unavailable' };
    }
    let failure = 'hero_capacity_quote_failed';
    const result = await playerSync<{
      quote_id: string;
      previous_capacity: number;
      hero_capacity: number;
      catalogue_usd_cents: number;
      token_cost: number;
      dex_source: string;
      expires_at: string;
    }>('hero_capacity_quote', { expected_revision: expectedRevision }, (code) => { failure = code; });
    if (!result || typeof result.quote_id !== 'string'
      || result.previous_capacity !== current.heroCapacity
      || result.hero_capacity !== current.heroCapacity + HERO_CAPACITY_STEP
      || !Number.isSafeInteger(result.catalogue_usd_cents) || result.catalogue_usd_cents < 100
      || !Number.isSafeInteger(result.token_cost) || result.token_cost <= 0
      || typeof result.dex_source !== 'string' || !result.dex_source
      || typeof result.expires_at !== 'string' || !Number.isFinite(Date.parse(result.expires_at))) {
      return { ok: false, error: failure };
    }
    return {
      ok: true,
      quote: {
        quoteId: result.quote_id,
        previousCapacity: result.previous_capacity,
        heroCapacity: result.hero_capacity,
        usdCents: result.catalogue_usd_cents,
        tokenCost: result.token_cost,
        dexSource: result.dex_source,
        expiresAt: result.expires_at,
      },
    };
  }, [serverRevisionHint]);

  const upgradeHeroCapacity = useCallback(async (quoteId: string): Promise<{ ok: true; spent: number } | { ok: false; error: string }> => {
    const current = stateRef.current;
    const expectedRevision = serverRevisionHint;
    if (!tokenomicsEnabled || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || current.heroCapacity >= MAX_HERO_CAPACITY) {
      return { ok: false, error: current.heroCapacity >= MAX_HERO_CAPACITY ? 'maximum_capacity' : 'state_unavailable' };
    }
    let failure = 'hero_capacity_upgrade_failed';
    const result = await playerSync<{
      previous_capacity: number;
      hero_capacity: number;
      token_balance: number;
      spent: number;
      revision: number;
    }>('hero_capacity_upgrade', {
      expected_revision: expectedRevision,
      quote_id: quoteId,
      idempotency_key: createIdempotencyKey(),
    }, (code) => { failure = code; });
    if (!result || result.previous_capacity !== current.heroCapacity
      || result.hero_capacity !== current.heroCapacity + HERO_CAPACITY_STEP
      || result.hero_capacity < BASE_HERO_CAPACITY || result.hero_capacity > MAX_HERO_CAPACITY
      || !Number.isSafeInteger(result.token_balance) || result.token_balance < 0
      || !Number.isSafeInteger(result.spent) || result.spent <= 0
      || !Number.isSafeInteger(result.revision) || result.revision <= expectedRevision) {
      return { ok: false, error: failure };
    }
    const nextState = {
      ...stateRef.current,
      hero: result.token_balance,
      heroCapacity: result.hero_capacity,
      milestoneQuests: updateQuestProgress(stateRef.current.milestoneQuests, 'token-spent-', result.spent),
    };
    stateRef.current = nextState;
    setState(nextState);
    setServerRevisionHint(result.revision);
    return { ok: true, spent: result.spent };
  }, [serverRevisionHint]);

  const [accountBonus, setAccountBonus] = useState<AccountBonusSnapshot | null>(null);
  const serverReady = serverRevisionHint !== null;

  const refreshAccountBonus = useCallback(async (): Promise<void> => {
    if (!tokenomicsEnabled) return;
    const result = await playerSync<{
      bonus?: { gold?: number; xp?: number };
      boost?: { expires_at?: string | null };
      plans?: { plan?: string; catalogue_usd_cents?: number; days?: number; token_cost?: number | null; available?: boolean }[];
      bundles?: { bundle?: string; resource_id?: string; quantity?: number; catalogue_usd_cents?: number; token_cost?: number | null; available?: boolean }[];
      server_time?: string;
    }>('account_bonus_snapshot', {});
    const serverTime = Date.parse(String(result?.server_time ?? ''));
    if (!result || !Array.isArray(result.plans) || !Number.isFinite(serverTime)) return;
    const expiresAt = result.boost?.expires_at ? Date.parse(result.boost.expires_at) : NaN;
    const offsetMs = serverTime - Date.now();
    setAccountBonus({
      gold: Math.max(0, Number(result.bonus?.gold) || 0),
      xp: Math.max(0, Number(result.bonus?.xp) || 0),
      boostEndsAt: Number.isFinite(expiresAt) ? expiresAt - offsetMs : null,
      plans: result.plans.flatMap((plan) => REWARD_BOOST_PLANS.includes(plan.plan as RewardBoostPlan)
        && Number.isSafeInteger(plan.catalogue_usd_cents) && Number.isSafeInteger(plan.days)
        ? [{
          plan: plan.plan as RewardBoostPlan,
          usdCents: plan.catalogue_usd_cents as number,
          days: plan.days as number,
          tokenCost: plan.available === true && Number.isSafeInteger(plan.token_cost) ? plan.token_cost as number : null,
        }]
        : []),
      bundles: (Array.isArray(result.bundles) ? result.bundles : []).flatMap((offer) => typeof offer.bundle === 'string'
        && SHOP_BUNDLE_RESOURCES.includes(offer.resource_id ?? '')
        && Number.isSafeInteger(offer.quantity) && Number.isSafeInteger(offer.catalogue_usd_cents)
        ? [{
          bundle: offer.bundle,
          resourceId: offer.resource_id as ShopBundleResource,
          quantity: offer.quantity as number,
          usdCents: offer.catalogue_usd_cents as number,
          tokenCost: offer.available === true && Number.isSafeInteger(offer.token_cost) ? offer.token_cost as number : null,
        }]
        : []),
    });
  }, []);

  useEffect(() => {
    if (!serverReady) return;
    void refreshAccountBonus();
    const refreshVisible = () => { if (document.visibilityState === 'visible') void refreshAccountBonus(); };
    const timer = window.setInterval(refreshVisible, 60_000);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [serverReady, refreshAccountBonus]);

  const buyRewardBoost = useCallback(async (plan: RewardBoostPlan, maxTokenCost: number): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!tokenomicsEnabled || !serverReady) return { ok: false, error: 'state_unavailable' };
    let failure = 'reward_boost_buy_failed';
    const result = await playerSync<{ spent: number; token_balance: number }>('reward_boost_buy', {
      plan,
      max_token_cost: maxTokenCost,
      idempotency_key: createIdempotencyKey(),
    }, (code) => { failure = code; });
    if (!result || !Number.isFinite(result.spent) || result.spent <= 0
      || !Number.isFinite(result.token_balance) || result.token_balance < 0) {
      return { ok: false, error: failure };
    }
    const nextState = {
      ...stateRef.current,
      hero: result.token_balance,
      milestoneQuests: updateQuestProgress(stateRef.current.milestoneQuests, 'token-spent-', result.spent),
    };
    stateRef.current = nextState;
    setState(nextState);
    await refreshAccountBonus();
    return { ok: true };
  }, [serverReady, refreshAccountBonus]);

  const quoteInventoryBag = useCallback(async (): Promise<{
    bag: number; kind: 'buy' | 'upgrade'; slots: number; catalogue_usd_cents: number;
    token_cost: number; available: boolean; complete?: boolean;
  } | null> => {
    if (!tokenomicsEnabled || !Number.isSafeInteger(serverRevisionHintRef.current)) return null;
    return playerSync('inventory_bag_quote');
  }, []);

  const buyInventoryBag = useCallback(async (bag: number, kind: 'buy' | 'upgrade', maxTokenCost: number): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!tokenomicsEnabled || !Number.isSafeInteger(serverRevisionHint)) return { ok: false, error: 'state_unavailable' };
    const key = createIdempotencyKey();
    let revision = serverRevisionHint as number;
    let failure = 'inventory_bag_buy_failed';
    type BagResult = { bag_slots: number[]; token_balance: number; spent: number; revision: number };
    const attempt = () => playerSync<BagResult>('inventory_bag_buy', {
      bag, kind, max_token_cost: maxTokenCost, expected_revision: revision, idempotency_key: key,
    }, (code) => { failure = code; });
    let result = await attempt();
    if (!result && failure === 'state_conflict') {
      const refreshed = await playerSync<{ revision: number; state?: Partial<GameState> }>('game_state_load');
      if (!refreshed || !Number.isSafeInteger(refreshed.revision)) return { ok: false, error: failure };
      revision = refreshed.revision;
      if (Array.isArray(refreshed.state?.bagSlots) && refreshed.state.bagSlots.length === 4) {
        const merged = { ...stateRef.current, bagSlots: refreshed.state.bagSlots,
          hero: Number.isSafeInteger(refreshed.state.hero) ? refreshed.state.hero as number : stateRef.current.hero };
        stateRef.current = merged;
        setState(merged);
      }
      result = await attempt();
    }
    if (!result || !Number.isSafeInteger(result.revision) || result.revision <= revision
      || !Array.isArray(result.bag_slots) || result.bag_slots.length !== 4
      || !result.bag_slots.every((slots) => slots === 0 || slots === 48 || slots === 64)
      || !Number.isSafeInteger(result.token_balance) || result.token_balance < 0
      || !Number.isSafeInteger(result.spent) || result.spent < 1) return { ok: false, error: failure };
    const current = stateRef.current;
    const nextState = { ...current, bagSlots: result.bag_slots, hero: result.token_balance,
      milestoneQuests: updateQuestProgress(current.milestoneQuests, 'token-spent-', result.spent) };
    stateRef.current = nextState;
    setState(nextState);
    setServerRevisionHint(result.revision);
    return { ok: true };
  }, [serverRevisionHint]);

  // Shop bundle: the server debits $HERO at its quote and credits the resource
  // in one transaction with the save revision; only those balances are merged
  // so unsaved local progress is kept.
  const buyShopBundle = useCallback(async (bundle: string, maxTokenCost: number): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!tokenomicsEnabled || !Number.isSafeInteger(serverRevisionHint)) return { ok: false, error: 'state_unavailable' };
    const idempotencyKey = createIdempotencyKey();
    let expectedRevision = serverRevisionHint as number;
    let failure = 'shop_bundle_buy_failed';
    type BundleResult = { spent: number; token_balance: number; revision: number; state: Partial<GameState> };
    const attempt = () => {
      failure = 'shop_bundle_buy_failed';
      return playerSync<BundleResult>('shop_bundle_buy', {
        bundle, max_token_cost: maxTokenCost, expected_revision: expectedRevision, idempotency_key: idempotencyKey,
      }, (code) => { failure = code; });
    };
    let result = await attempt();
    if (!result && failure === 'state_conflict') {
      const refreshed = await playerSync<{ revision: number }>('game_state_load');
      if (!refreshed || !Number.isSafeInteger(refreshed.revision)) return { ok: false, error: failure };
      expectedRevision = refreshed.revision;
      result = await attempt();
    }
    if (!result || !Number.isSafeInteger(result.revision) || !result.state
      || !Number.isFinite(result.spent) || result.spent <= 0
      || !Number.isFinite(result.token_balance) || result.token_balance < 0) {
      return { ok: false, error: failure };
    }
    const remote = result.state;
    const count = (value: unknown, fallback: number) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
    const current = stateRef.current;
    const nextState = {
      ...current,
      hero: result.token_balance,
      summonScrolls: count(remote.summonScrolls, current.summonScrolls),
      bossKeys: count(remote.bossKeys, current.bossKeys),
      potions: { ...current.potions, md: count(remote.potions?.md, current.potions.md) },
      milestoneQuests: updateQuestProgress(current.milestoneQuests, 'token-spent-', result.spent),
    };
    stateRef.current = nextState;
    setServerRevisionHint(result.revision);
    setState(nextState);
    return { ok: true };
  }, [serverRevisionHint]);

  const settleHeroSpend = useCallback(async (amount: number, actionKind: string): Promise<number | null> => {
    const safeAmount = Math.max(0, Math.floor(amount));
    if (safeAmount === 0) return stateRef.current.hero;
    if (!tokenomicsEnabled) return stateRef.current.hero >= safeAmount ? stateRef.current.hero - safeAmount : null;
    const result = await playerSync<{ token_balance: number }>('spend_tokens', {
      amount: safeAmount,
      action_kind: actionKind,
      idempotency_key: createIdempotencyKey(),
    });
    return result ? Math.max(0, Math.floor(result.token_balance)) : null;
  }, []);

  const starUpHero = useCallback(async (uid: string): Promise<boolean> => {
    const st = stateRef.current;
    const hero = st.ownedHeroes.find((h) => h.uid === uid);
    if (!hero || hero.stars >= MAX_HERO_STARS) return false;
    const base = HERO_MAP[hero.heroId];
    if (!base) return false;
    const cost = starUpCost(hero.stars, base.rarity);
    const dupes = st.ownedHeroes.filter((h) => h.heroId === hero.heroId && h.uid !== uid && h.stars === 0 && !h.locked && !st.team.includes(h.uid) && !st.trainingCamp.heroUids.includes(h.uid));
    if (dupes.length < cost.dupes || (!tokenomicsEnabled && st.hero < cost.hero)) return false;
    if (tokenomicsEnabled) {
      const settled = await settleServerAscension(uid, false);
      if (!settled) return false;
      setState((prev) => ({
        ...prev,
        hero: settled.balance,
        ownedHeroes: settled.heroes,
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-spent-', settled.spent),
      }));
      return true;
    }
    const balance = await settleHeroSpend(cost.hero, 'hero-star-up');
    if (balance === null) return false;
    const consume = dupes.slice(0, cost.dupes).map((h) => h.uid);
    setState((prev) => ({
      ...prev,
      hero: balance,
      ownedHeroes: prev.ownedHeroes.filter((h) => !consume.includes(h.uid)).map((h) => h.uid === uid ? { ...h, stars: h.stars + 1 } : h),
      team: prev.team.filter((t) => !consume.includes(t)),
      milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-spent-', cost.hero),
    }));
    return true;
  }, [settleHeroSpend, settleServerAscension]);

  const promoteAllHeroes = useCallback(async (): Promise<PromotionSummary[]> => {
    const st = stateRef.current;
    let heroes = [...st.ownedHeroes];
    if (tokenomicsEnabled) {
      const heroIds = [...new Set(heroes.map((hero) => hero.heroId))];
      const targets = heroIds.flatMap((heroId) => {
        const ranked = heroes.filter((hero) => hero.heroId === heroId).map((hero, index) => ({
          hero, index, power: teamPower([hero], st.inventory),
        })).sort((a, b) => b.power - a.power || b.hero.level - a.hero.level || b.hero.stars - a.hero.stars || a.index - b.index);
        const target = ranked.find(({ hero }) => hero.stars < MAX_HERO_STARS)?.hero;
        if (!target) return [];
        const base = HERO_MAP[target.heroId];
        if (!base) return [];
        const cost = starUpCost(target.stars, base.rarity);
        const duplicateCount = ranked.filter(({ hero }) => hero.uid !== target.uid && hero.stars === 0 && !hero.locked && !st.team.includes(hero.uid) && !st.trainingCamp.heroUids.includes(hero.uid)).length;
        return duplicateCount >= cost.dupes ? [target] : [];
      });
      if (targets.length === 0) return [];
      const settled = await settleServerPromotionAll(targets.map((hero) => hero.uid));
      if (!settled) return [];
      setState((prev) => ({
        ...prev,
        hero: settled.balance,
        ownedHeroes: settled.heroes,
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-spent-', settled.spent),
      }));
      const targetByUid = new Map(targets.map((hero) => [hero.uid, hero]));
      return settled.promotions.map((promotion) => ({
        heroName: HERO_MAP[targetByUid.get(promotion.target_uid)?.heroId ?? '']?.name ?? 'Hero',
        starsAdded: promotion.stars_added,
      }));
    }
    let available = tokenomicsEnabled ? Number.MAX_SAFE_INTEGER : st.hero;
    let spent = 0;
    const promoted = new Map<string, PromotionSummary>();
    const heroIds = [...new Set(heroes.map((hero) => hero.heroId))];

    for (const heroId of heroIds) {
      while (true) {
        const instances = heroes.filter((hero) => hero.heroId === heroId);
        const ranked = instances.map((hero, index) => ({
          hero, index, power: teamPower([hero], st.inventory),
        })).sort((a, b) => b.power - a.power || b.hero.level - a.hero.level || b.hero.stars - a.hero.stars || a.index - b.index);
        const target = ranked.find(({ hero }) => hero.stars < MAX_HERO_STARS)?.hero;
        if (!target) break;
        const base = HERO_MAP[target.heroId];
        if (!base) break;
        const cost = starUpCost(target.stars, base.rarity);
        const duplicates = ranked.filter(({ hero }) => hero.uid !== target.uid && hero.stars === 0 && !hero.locked && !st.team.includes(hero.uid) && !st.trainingCamp.heroUids.includes(hero.uid))
          .sort((a, b) => a.power - b.power || a.hero.level - b.hero.level || a.hero.stars - b.hero.stars || b.index - a.index);
        if (duplicates.length < cost.dupes || available < cost.hero) break;
        const consumed = new Set(duplicates.slice(0, cost.dupes).map(({ hero }) => hero.uid));
        heroes = heroes.filter((hero) => !consumed.has(hero.uid)).map((hero) => hero.uid === target.uid ? { ...hero, stars: hero.stars + 1 } : hero);
        available -= cost.hero;
        spent += cost.hero;
        const current = promoted.get(target.uid);
        promoted.set(target.uid, { heroName: base?.name ?? 'Hero', starsAdded: (current?.starsAdded ?? 0) + 1 });
      }
    }

    const summary = [...promoted.values()];
    if (summary.length === 0) return [];
    const balance = await settleHeroSpend(spent, 'promote-all');
    if (balance === null) return [];
    setState((prev) => ({
      ...prev,
      hero: balance,
      ownedHeroes: heroes,
      milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-spent-', spent),
    }));
    return summary;
  }, [settleHeroSpend, settleServerPromotionAll]);

  const toggleHeroLock = useCallback((uid: string) => {
    setState((prev) => ({ ...prev, ownedHeroes: prev.ownedHeroes.map((h) => h.uid === uid ? { ...h, locked: !h.locked } : h) }));
  }, []);

  const markHeroSeen = useCallback((uid: string) => {
    setState((prev) => ({ ...prev, ownedHeroes: prev.ownedHeroes.map((hero) => hero.uid === uid && hero.isNew ? { ...hero, isNew: false } : hero) }));
  }, []);

  const loadMarket = useCallback(async (): Promise<ServerMarketSnapshot | null> => {
    if (!tokenomicsEnabled) return null;
    return playerSync<ServerMarketSnapshot>('market_snapshot');
  }, []);

  // Mailbox: Market purchases and full-bag overflow wait on the server until
  // claimed; the claim result carries the canonical inventory and revision.
  const loadMail = useCallback(async (): Promise<MailEntry[] | null> => {
    if (!tokenomicsEnabled) return null;
    const result = await playerSync<{ count: number; items: Omit<MailItemEntry, 'kind'>[]; letters?: RawMailLetter[] }>('mail_list');
    if (!result || !Array.isArray(result.items)) return null;
    setMailCount(Math.max(0, Math.floor(Number(result.count) || 0)));
    const items: MailEntry[] = result.items
      .filter((entry) => entry?.item?.serverOwned === true && Boolean(ITEM_MAP[entry.item.itemId]))
      .map((entry) => ({ ...entry, kind: 'item' }));
    return [...parseMailLetters(result.letters), ...items];
  }, []);

  const claimMail = useCallback(async (mailId: string | null): Promise<MailClaimResult> => {
    if (!tokenomicsEnabled) return { ok: false, error: 'unavailable' };
    let error = '';
    const result = await playerSync<{ claimed: number; remaining: number; inventory: OwnedItem[]; chests?: Chest[]; gold?: number; revision: number; items_full?: boolean; chests_full?: boolean; resources_full?: boolean; resources_changed?: boolean; heroes_full?: boolean; heroes_limited?: boolean; owned_heroes?: OwnedHero[] }>('mail_claim', {
      mail_id: mailId, idempotency_key: createIdempotencyKey(),
    }, (message) => { error = message; });
    if (!result || !Array.isArray(result.inventory)) return { ok: false, error: error || 'mail_failed' };
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    const chests = Array.isArray(result.chests) ? result.chests : null;
    const gold = Number.isSafeInteger(result.gold) ? Number(result.gold) : null;
    const heroes = Array.isArray(result.owned_heroes) ? result.owned_heroes : null;
    setState((prev) => ({ ...prev, inventory: result.inventory, ...(chests ? { chests } : {}), ...(gold !== null ? { gold } : {}), ...(heroes ? { ownedHeroes: heroes } : {}) }));
    setMailCount(Math.max(0, Math.floor(Number(result.remaining) || 0)));
    // Scrolls, keys, potions and materials live in the server resource ledger: reload the save so they show at once.
    if (result.claimed > 0 || result.resources_changed) {
      const refreshed = await playerSync<{ state: GameState; revision: number }>('game_state_load');
      if (refreshed?.state && Number.isSafeInteger(refreshed.revision)) { setServerRevisionHint(refreshed.revision); hydrateServerState(refreshed.state); }
    }
    return { ok: true, claimed: result.claimed, remaining: result.remaining, itemsFull: result.items_full === true, chestsFull: result.chests_full === true, resourcesFull: result.resources_full === true, heroesFull: result.heroes_full === true, heroesLimited: result.heroes_limited === true };
  }, [hydrateServerState]);

  const readMail = useCallback(async (letterId: string) => {
    if (!tokenomicsEnabled) return;
    const result = await playerSync<{ count: number }>('mail_read', { mail_id: letterId });
    if (result) setMailCount(Math.max(0, Math.floor(Number(result.count) || 0)));
  }, []);

  const deleteReadMail = useCallback(async (): Promise<number | null> => {
    if (!tokenomicsEnabled) return null;
    const result = await playerSync<{ deleted: number; count: number }>('mail_delete_read', {});
    if (!result) return null;
    setMailCount(Math.max(0, Math.floor(Number(result.count) || 0)));
    return Math.max(0, Math.floor(Number(result.deleted) || 0));
  }, []);

  // Load once the server save is known, then recheck every minute and on return to the app: rewards and
  // deliveries also arrive from the server on their own (Founder 2026-10-08).
  const serverSaveKnown = serverRevisionHint !== null;
  useEffect(() => {
    if (tokenomicsEnabled && serverSaveKnown) void loadMail();
  }, [serverSaveKnown, loadMail]);
  useEffect(() => {
    if (!tokenomicsEnabled || !serverSaveKnown) return undefined;
    const refresh = () => { if (document.visibilityState === 'visible') void loadMail(); };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [serverSaveKnown, loadMail]);

  const applyMarketState = useCallback((result: { inventory: OwnedItem[]; token_balance: number; revision: number; delivered_to?: string }) => {
    if (!Array.isArray(result.inventory) || !Number.isFinite(result.token_balance)) return false;
    if (result.delivered_to === 'mail') void loadMail();
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    const owned = (result as { owned_heroes?: unknown }).owned_heroes;
    const chests = (result as { chests?: unknown }).chests;
    setState((prev) => ({ ...prev, inventory: result.inventory, hero: Math.max(0, Math.floor(result.token_balance)),
      ...(Array.isArray(owned) ? { ownedHeroes: owned as OwnedHero[] } : {}), ...(Array.isArray(chests) ? { chests: chests as Chest[] } : {}) }));
    return true;
  }, [loadMail]);

  const createMarketListing = useCallback(async (uid: string, price: number): Promise<MarketActionResult> => {
    let error = '';
    const result = await playerSync<{ inventory: OwnedItem[]; token_balance: number; revision: number }>('market_list_item', {
      item_id: uid,
      price: Math.floor(price),
      idempotency_key: createIdempotencyKey(),
    }, (message) => { error = message; });
    return result && applyMarketState(result) ? { ok: true } : { ok: false, error: error || 'market_settlement_failed' };
  }, [applyMarketState]);

  const cancelMarketListing = useCallback(async (id: string): Promise<MarketActionResult> => {
    let error = '';
    const result = await playerSync<{ inventory: OwnedItem[]; token_balance: number; revision: number; delivered_to?: string }>('market_cancel_listing', {
      listing_id: id,
      idempotency_key: createIdempotencyKey(),
    }, (message) => { error = message; });
    return result && applyMarketState(result) ? { ok: true, mailed: result.delivered_to === 'mail' } : { ok: false, error: error || 'market_settlement_failed' };
  }, [applyMarketState]);

  const buyMarketAsset = useCallback(async (id: string): Promise<MarketActionResult> => {
    let error = '';
    const result = await playerSync<{ inventory: OwnedItem[]; token_balance: number; revision: number; delivered_to?: string }>('market_buy_listing', {
      listing_id: id,
      idempotency_key: createIdempotencyKey(),
    }, (message) => { error = message; });
    return result && applyMarketState(result) ? { ok: true, mailed: true } : { ok: false, error: error || 'market_settlement_failed' };
  }, [applyMarketState]);

  const setAvatarHero = useCallback((heroId: string) => {
    setState((prev) => prev.ownedHeroes.some((hero) => hero.heroId === heroId) ? { ...prev, avatarHeroId: heroId } : prev);
  }, []);

  const summonHeroes = useCallback(async (
    count: 1 | 10 | 100,
    paymentMethod: 'paid' | 'scroll' | 'skr',
    quoteId: string | null = null,
  ): Promise<OwnedHero[]> => {
    if (!tokenomicsEnabled || stateRef.current.ownedHeroes.length + count > stateRef.current.heroCapacity
      || (paymentMethod === 'scroll' && stateRef.current.summonScrolls < count)) return [];
    if (paymentMethod === 'skr') {
      if (!isolatedHackathon || !quoteId) return [];
      setSummonError('');
      try {
        const purchase = await commitSkrPurchase(quoteId);
        if (purchase.status !== 'delivered') { setSummonError(skrError(String(purchase.result.code ?? 'skr_purchase_refunded'))); return []; }
        const heroes = purchase.result.heroes;
        const refreshed = await playerSync<{ state: GameState; revision: number }>('game_state_load');
        if (refreshed?.state && Number.isSafeInteger(refreshed.revision)) {
          setServerRevisionHint(refreshed.revision); hydrateServerState(refreshed.state);
        } else {
          // The durable grant is already known; show it and recover the save on next sync.
          setState(prev => {
            const fresh = Array.isArray(heroes) ? (heroes as OwnedHero[]).filter(hero => !prev.ownedHeroes.some(owned => owned.uid === hero.uid)) : [];
            return { ...prev, ownedHeroes: [...prev.ownedHeroes, ...fresh], summons: prev.summons + fresh.length };
          });
        }
        return Array.isArray(heroes) ? heroes as OwnedHero[] : [];
      } catch (error) { setSummonError(skrError(error)); return []; }
    }
    const settled = await settleServerSummon(count, paymentMethod, quoteId);
    if (!settled) return [];
    setState((prev) => {
      let milestones = updateQuestProgress(
        updateQuestProgress(prev.milestoneQuests, 'summon-', count), 'hero-owned-', count,
      );
      if (settled.spent > 0) milestones = updateQuestProgress(milestones, 'token-spent-', settled.spent);
      return {
        ...prev,
        hero: settled.balance,
        summonScrolls: settled.summonScrolls,
        ownedHeroes: [...prev.ownedHeroes, ...settled.heroes],
        summons: prev.summons + count,
        dailyQuests: updateQuestProgress(prev.dailyQuests, 'summon-', count),
        milestoneQuests: milestones,
      };
    });
    return settled.heroes;
  }, [settleServerSummon, hydrateServerState]);

  const settleServerEquipment = useCallback(async (nextState: GameState): Promise<boolean> => {
    equipmentErrorRef.current = '';
    if (!tokenomicsEnabled) return true;
    const assignments = serverEquipmentAssignments(nextState);
    const result = await playerSync<{ assignments: ServerItemAssignment[]; revision: number }>('item_equip', {
      assignments,
      idempotency_key: createIdempotencyKey(),
    }, (message) => { equipmentErrorRef.current = message; });
    if (!result || !Array.isArray(result.assignments) || !sameServerEquipmentAssignments(assignments, result.assignments)) {
      if (!equipmentErrorRef.current) equipmentErrorRef.current = 'invalid_server_response';
      return false;
    }
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    return true;
  }, []);

  const toggleTeamMember = useCallback(async (uid: string): Promise<'added' | 'removed' | 'inventory-full' | 'blocked'> => {
    const st = stateRef.current;
    const hero = st.ownedHeroes.find((h) => h.uid === uid);
    if (!hero || st.trainingCamp.heroUids.includes(uid)) return 'blocked';
    // Seeker may bench a fallen hero; its respawn timestamp stays on the owned hero.
    if (hero.respawnAt && hero.respawnAt > Date.now() && (!isolatedHackathon || !st.team.includes(uid))) return 'blocked';
    let newTeam: string[];
    if (st.team.includes(uid)) {
      if (!isolatedHackathon && st.team.length <= 1) return 'blocked';
      const equippedCount = Object.values(hero.equipped).filter(Boolean).length;
      if (bagItemCount(st) + equippedCount > inventoryCapacity(st)) return 'inventory-full';
      newTeam = st.team.filter((t) => t !== uid);
      const nextState = { ...st, team: newTeam, ownedHeroes: st.ownedHeroes.map((owned) => owned.uid === uid ? { ...owned, equipped: {} } : owned) };
      const before = JSON.stringify(serverEquipmentAssignments(st));
      const after = JSON.stringify(serverEquipmentAssignments(nextState));
      if (before !== after && !(await settleServerEquipment(nextState))) return 'blocked';
      pendingFormationRef.current = newTeam.join('|');
      stateRef.current = nextState;
      setState(nextState);
      spawnBattle(st.currentLocation, newTeam);
      return 'removed';
    }
    if (st.team.length >= MAX_TEAM) return 'blocked';
    newTeam = [...st.team, uid];
    pendingFormationRef.current = newTeam.join('|');
    stateRef.current = { ...st, team: newTeam };
    setState((prev) => ({ ...prev, team: newTeam }));
    spawnBattle(st.currentLocation, newTeam);
    return 'added';
  }, [settleServerEquipment, spawnBattle]);

  const setLocation = useCallback((id: number) => {
    const st = stateRef.current;
    if (id < 1 || id > st.highestLocation || id === st.currentLocation) return;
    if (st.accountLevel < locationUnlockLevel(id) && id > (st.seekerProgression?.legacyLocationAccess ?? 1)) return;
    setState((prev) => ({ ...prev, currentLocation: id }));
    spawnBattle(id, st.team);
  }, [spawnBattle]);

  // ── Equipment ─────────────────────────────────────────────────────────────

  const equipItem = useCallback(async (heroUid: string, itemUid: string, slot: ItemSlot): Promise<boolean> => {
    const current = stateRef.current;
    const hero = current.ownedHeroes.find((candidate) => candidate.uid === heroUid);
    const item = current.inventory.find((candidate) => candidate.uid === itemUid);
    if (!hero || !item || !current.team.includes(heroUid)) return false;
    const itemBase = ITEM_MAP[item.itemId];
    const heroBase = HERO_MAP[hero.heroId];
    if (!itemBase || !heroBase || !canClassEquipItem(heroBase.heroClass, itemBase) || !meetsItemLevelRequirement(item, current.accountLevel)) return false;
    const isRing = itemBase.slot === 'ring1' || itemBase.slot === 'ring2';
    const targetIsRing = slot === 'ring1' || slot === 'ring2';
    if (!(isRing && targetIsRing) && itemBase.slot !== slot) return false;
    const newHeroes = current.ownedHeroes.map((candidate) => {
      const equipped = { ...candidate.equipped };
      for (const [candidateSlot, equippedUid] of Object.entries(equipped)) {
        if (equippedUid === itemUid) delete equipped[candidateSlot as ItemSlot];
      }
      if (candidate.uid === heroUid) equipped[slot] = itemUid;
      return { ...candidate, equipped };
    });
    const nextState = { ...current, ownedHeroes: newHeroes };
    const before = JSON.stringify(serverEquipmentAssignments(current));
    const after = JSON.stringify(serverEquipmentAssignments(nextState));
    if (before !== after && !(await settleServerEquipment(nextState))) return false;
    stateRef.current = nextState;
    setState(nextState);
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
    return true;
  }, [settleServerEquipment, spawnBattle]);

  const unequipItem = useCallback(async (heroUid: string, slot: ItemSlot): Promise<boolean> => {
    const current = stateRef.current;
    const hero = current.ownedHeroes.find((candidate) => candidate.uid === heroUid);
    if (!hero?.equipped[slot]) return false;
    const newHeroes = current.ownedHeroes.map((candidate) => candidate.uid === heroUid
      ? { ...candidate, equipped: Object.fromEntries(Object.entries(candidate.equipped).filter(([candidateSlot]) => candidateSlot !== slot)) }
      : candidate);
    const nextState = { ...current, ownedHeroes: newHeroes };
    const before = JSON.stringify(serverEquipmentAssignments(current));
    const after = JSON.stringify(serverEquipmentAssignments(nextState));
    if (before !== after && !(await settleServerEquipment(nextState))) return false;
    stateRef.current = nextState;
    setState(nextState);
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
    return true;
  }, [settleServerEquipment, spawnBattle]);

  const unequipAll = useCallback(async (heroUid: string): Promise<boolean> => {
    const current = stateRef.current;
    const hero = current.ownedHeroes.find((candidate) => candidate.uid === heroUid);
    if (!hero || Object.values(hero.equipped).every((uid) => !uid)) return false;
    const equippedElsewhere = new Set<string>();
    current.ownedHeroes.forEach((candidate) => {
      if (candidate.uid !== heroUid) Object.values(candidate.equipped).forEach((uid) => { if (uid) equippedElsewhere.add(uid); });
    });
    if (current.inventory.filter((item) => !equippedElsewhere.has(item.uid)).length > inventoryCapacity(current)) return false;
    const nextState = { ...current, ownedHeroes: current.ownedHeroes.map((candidate) => candidate.uid === heroUid ? { ...candidate, equipped: {} } : candidate) };
    const before = JSON.stringify(serverEquipmentAssignments(current));
    const after = JSON.stringify(serverEquipmentAssignments(nextState));
    if (before !== after && !(await settleServerEquipment(nextState))) return false;
    stateRef.current = nextState;
    setState(nextState);
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
    return true;
  }, [settleServerEquipment, spawnBattle]);

  // ── Enchant ───────────────────────────────────────────────────────────────

  const enchantItem = useCallback(async (itemUid: string, useCharm: boolean) => {
    const st = stateRef.current;
    const item = st.inventory.find((i) => i.uid === itemUid);
    if (!item || item.enchantLevel >= MAX_ENCHANT_LEVEL) { setEnchantResult({ success: false }); return; }
    if (tokenomicsEnabled && item.serverOwned) {
      if (itemUpgradeBusyRef.current) return;
      itemUpgradeBusyRef.current = true;
      setItemUpgradeBusy(true);
      try {
        const result = await playerSync<{
          success: boolean; destroyed: boolean; item: OwnedItem | null; inventory: OwnedItem[];
          owned_heroes: OwnedHero[]; gold: number; token_balance: number; token_cost: number; revision: number;
        }>('item_upgrade', {
          operation: 'enchant', item_uid: itemUid, use_charm: useCharm,
          idempotency_key: createIdempotencyKey(),
        });
        if (!result || !Array.isArray(result.inventory) || !Array.isArray(result.owned_heroes)
          || !Number.isFinite(result.gold) || !Number.isFinite(result.token_balance)) {
          setEnchantResult({ success: false });
          return;
        }
        if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
        const nextState = {
          ...stateRef.current, gold: result.gold, hero: result.token_balance,
          inventory: result.inventory, ownedHeroes: result.owned_heroes,
        };
        stateRef.current = nextState;
        setState(nextState);
        setEnchantResult({ success: result.success, item: result.item ?? undefined });
        spawnBattle(nextState.currentLocation, nextState.team);
      } finally {
        itemUpgradeBusyRef.current = false;
        setItemUpgradeBusy(false);
      }
      return;
    }
    const baseCost = enchantCost(item);
    const charmCost = useCharm ? enchantCharmCost(item.enchantLevel) : 0;
    const tokenCost = baseCost.hero + charmCost;
    if (st.gold < baseCost.gold || (!tokenomicsEnabled && st.hero < tokenCost)) { setEnchantResult({ success: false }); return; }
    const balance = await settleHeroSpend(tokenCost, 'item-enchant');
    if (balance === null) { setEnchantResult({ success: false }); return; }
    const baseChance = enchantSuccessChance(item.enchantLevel);
    const success = useCharm ? true : Math.random() < baseChance;
    if (success) {
      const newEnchant = item.enchantLevel + 1;
      const newPower = itemPower(item.stats, newEnchant, 4);
      setState((prev) => ({
        ...prev,
        gold: prev.gold - baseCost.gold,
        hero: balance,
        inventory: prev.inventory.map((i) => i.uid === itemUid ? { ...i, enchantLevel: newEnchant, enchantStatsVersion: 4, power: newPower } : i),
      }));
      setEnchantResult({ success: true, item: { ...item, enchantLevel: newEnchant, enchantStatsVersion: 4, power: newPower } });
    } else {
      const nextState = {
        ...stateRef.current,
        gold: stateRef.current.gold - baseCost.gold,
        hero: balance,
        inventory: stateRef.current.inventory.filter((i) => i.uid !== itemUid),
        ownedHeroes: stateRef.current.ownedHeroes.map((hero) => {
          const equipped = { ...hero.equipped };
          for (const [slot, equippedUid] of Object.entries(equipped)) {
            if (equippedUid === itemUid) delete equipped[slot as ItemSlot];
          }
          return { ...hero, equipped };
        }),
      };
      stateRef.current = nextState;
      setState(nextState);
      setEnchantResult({ success: false });
    }
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [settleHeroSpend, spawnBattle]);

  const rerollItem = useCallback(async (itemUid: string) => {
    const st = stateRef.current;
    const item = st.inventory.find((i) => i.uid === itemUid);
    if (!item) return;
    if (tokenomicsEnabled && item.serverOwned) {
      if (itemUpgradeBusyRef.current) return;
      itemUpgradeBusyRef.current = true;
      setItemUpgradeBusy(true);
      try {
        const result = await playerSync<{
          item: OwnedItem | null; inventory: OwnedItem[]; owned_heroes: OwnedHero[];
          gold: number; token_balance: number; token_cost: number; revision: number;
        }>('item_upgrade', {
          operation: 'reroll', item_uid: itemUid, use_charm: false,
          idempotency_key: createIdempotencyKey(),
        });
        if (!result?.item || !Array.isArray(result.inventory) || !Array.isArray(result.owned_heroes)
          || !Number.isFinite(result.gold) || !Number.isFinite(result.token_balance)) return;
        if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
        const nextState = {
          ...stateRef.current, gold: result.gold, hero: result.token_balance,
          inventory: result.inventory, ownedHeroes: result.owned_heroes,
          milestoneQuests: updateQuestProgress(stateRef.current.milestoneQuests, 'token-spent-', result.token_cost),
        };
        stateRef.current = nextState;
        setState(nextState);
        spawnBattle(nextState.currentLocation, nextState.team);
      } finally {
        itemUpgradeBusyRef.current = false;
        setItemUpgradeBusy(false);
      }
      return;
    }
    const base = ITEM_MAP[item.itemId];
    if (!base) return;
    const cost = rerollCost(base.rarity, item.rerollCount);
    if (!tokenomicsEnabled && st.hero < cost) return;
    const balance = await settleHeroSpend(cost, 'item-reroll');
    if (balance === null) return;
    const newItem = rerollItemStats(item);
    setState((prev) => ({ ...prev, hero: balance, inventory: prev.inventory.map((i) => i.uid === itemUid ? newItem : i), milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-spent-', cost) }));
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [settleHeroSpend, spawnBattle]);

  const sellItem = useCallback(async (itemUid: string): Promise<boolean> => {
    if (!stateRef.current.inventory.some((item) => item.uid === itemUid && !item.locked)) return false;
    const current = stateRef.current.inventory.find((item) => item.uid === itemUid);
    if (tokenomicsEnabled && current?.serverOwned) {
      if (current.locked) return false;
      const result = await playerSync<{ item_ids: string[]; gold_refund: number; revision: number }>('item_mutate', {
        operation: 'sell', item_uids: [itemUid], idempotency_key: createIdempotencyKey(),
      });
      if (!result || !Array.isArray(result.item_ids) || result.item_ids.length !== 1 || result.item_ids[0] !== itemUid
        || !Number.isSafeInteger(result.gold_refund) || result.gold_refund < 0) return false;
      if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
      setState((prev) => ({
        ...prev,
        gold: prev.gold + result.gold_refund,
        inventory: prev.inventory.filter((item) => item.uid !== itemUid),
        ownedHeroes: prev.ownedHeroes.map((hero) => ({
          ...hero,
          equipped: Object.fromEntries(Object.entries(hero.equipped).filter(([, uid]) => uid !== itemUid)),
        })),
      }));
      spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
      return true;
    }
    setState((prev) => {
      const item = prev.inventory.find((i) => i.uid === itemUid);
      if (!item || item.locked) return prev;
      const refund = sellValue(item);
      const newHeroes = prev.ownedHeroes.map((h) => {
        const eq = { ...h.equipped };
        for (const [s, iuid] of Object.entries(eq)) { if (iuid === itemUid) delete eq[s as ItemSlot]; }
        return { ...h, equipped: eq };
      });
      return { ...prev, gold: prev.gold + refund, inventory: prev.inventory.filter((i) => i.uid !== itemUid), ownedHeroes: newHeroes };
    });
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
    return true;
  }, [spawnBattle]);

  const toggleItemLock = useCallback(async (itemUid: string): Promise<boolean> => {
    const current = stateRef.current.inventory.find((item) => item.uid === itemUid);
    if (!current) return false;
    if (tokenomicsEnabled && current.serverOwned) {
      const locked = !current.locked;
      const result = await playerSync<{ item_ids: string[]; locked: boolean; revision: number }>('item_mutate', {
        operation: 'lock', item_uids: [itemUid], locked, idempotency_key: createIdempotencyKey(),
      });
      if (!result || result.locked !== locked || result.item_ids?.[0] !== itemUid) return false;
      if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
      setState((prev) => ({ ...prev, inventory: prev.inventory.map((item) => item.uid === itemUid ? { ...item, locked } : item) }));
      return true;
    }
    setState((prev) => ({ ...prev, inventory: prev.inventory.map((i) => i.uid === itemUid ? { ...i, locked: !i.locked } : i) }));
    return true;
  }, []);

  // FIXED: sellAllUnlocked only sells UNEQUIPPED, UNLOCKED items (not potions, not equipped)
  const sellAllUnlocked = useCallback(async (): Promise<number> => {
    const current = stateRef.current;
    const equipped = new Set(current.ownedHeroes.flatMap((hero) => Object.values(hero.equipped).filter((uid): uid is string => Boolean(uid))));
    const sellable = current.inventory.filter((item) => !item.locked && !equipped.has(item.uid));
    const serverItemUids = tokenomicsEnabled ? sellable.filter((item) => item.serverOwned).map((item) => item.uid) : [];
    const clientItems = sellable.filter((item) => !serverItemUids.includes(item.uid));
    let serverRefund = 0;
    const serverSoldUids: string[] = [];

    // Sell all empties every bag in one request. If the server rejects a batch because one item is missing from
    // its ledger (for example an item an older client removed before selling), halve the batch so the rest still sells;
    // the missing item stays in the bag.
    const sellBatch = async (batch: string[]): Promise<void> => {
      let error = '';
      const result = await playerSync<{ item_ids: string[]; gold_refund: number; revision: number }>('item_mutate', {
        operation: 'sell', item_uids: batch, idempotency_key: createIdempotencyKey(),
      }, (message) => { error = message; });
      if (!result) {
        if (batch.length > 1 && (error === 'item_not_found' || error === 'item_state_mismatch')) {
          const half = Math.ceil(batch.length / 2);
          await sellBatch(batch.slice(0, half));
          await sellBatch(batch.slice(half));
        }
        return;
      }
      if (!Array.isArray(result.item_ids) || result.item_ids.length !== batch.length
        || !Number.isSafeInteger(result.gold_refund) || result.gold_refund < 0) return;
      const settled = new Set(result.item_ids);
      if (batch.some((uid) => !settled.has(uid))) return;
      if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
      serverRefund += result.gold_refund;
      serverSoldUids.push(...batch);
    };
    for (let start = 0; start < serverItemUids.length; start += SELL_BATCH_SIZE) {
      await sellBatch(serverItemUids.slice(start, start + SELL_BATCH_SIZE));
    }

    const soldUids = new Set([...serverSoldUids, ...clientItems.map((item) => item.uid)]);
    const unsold = serverItemUids.length - serverSoldUids.length;
    if (soldUids.size === 0) return unsold;
    const clientRefund = clientItems.reduce((total, item) => total + sellValue(item), 0);
    setState((prev) => {
      const stillEquipped = new Set(prev.ownedHeroes.flatMap((hero) => Object.values(hero.equipped).filter((uid): uid is string => Boolean(uid))));
      const safeSoldUids = new Set([...soldUids].filter((uid) => !stillEquipped.has(uid)));
      return {
        ...prev,
        gold: prev.gold + serverRefund + clientRefund,
        inventory: prev.inventory.filter((item) => !safeSoldUids.has(item.uid)),
      };
    });
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
    return unsold;
  }, [spawnBattle]);

  // ── Potions ──────────────────────────────────────────────────────────────

  const setAutoPot = useCallback((cfg: Partial<GameState['autoPot']>) => {
    setState((prev) => ({ ...prev, autoPot: { ...prev.autoPot, ...cfg } }));
  }, []);

  const setBattleAnimationMode = useCallback((mode: GameState['battleAnimationMode']) => {
    setState((prev) => ({ ...prev, battleAnimationMode: mode }));
  }, []);

  const setTrainingHero = useCallback(async (slot: number, heroUid: string | null): Promise<boolean> => {
    const st = stateRef.current;
    if (slot < 0 || slot >= st.trainingCamp.unlockedSlots) return false;
    const hero = heroUid ? st.ownedHeroes.find((owned) => owned.uid === heroUid) : null;
    if (heroUid && (!hero || hero.level >= st.accountLevel || st.team.includes(heroUid) || st.trainingCamp.heroUids.includes(heroUid))) return false;
    if (tokenomicsEnabled) {
      const expectedRevision = serverRevisionHint;
      if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || trainingAssignmentBusyRef.current) return false;
      trainingAssignmentBusyRef.current = true;
      try {
        const result = await playerSync<{
          hero_uids: Array<string | null>; owned_heroes: OwnedHero[];
          training_camp: GameState['trainingCamp']; training_hero_count: number;
          penalty: number; power: number; combat_power: number; revision: number;
        }>('training_assignment_set', {
          slot_index: slot, hero_uid: heroUid, expected_revision: expectedRevision,
          idempotency_key: createIdempotencyKey(),
        });
        if (!result || !Array.isArray(result.hero_uids) || result.hero_uids.length !== 10
          || !Array.isArray(result.owned_heroes) || !result.training_camp
          || !Number.isSafeInteger(result.revision) || result.revision <= expectedRevision) return false;
        const nextState = {
          ...stateRef.current,
          ownedHeroes: result.owned_heroes,
          trainingCamp: { ...result.training_camp, heroUids: result.hero_uids },
        };
        stateRef.current = nextState;
        setState(nextState);
        setServerRevisionHint(result.revision);
        setTrainingIncomeRevision(result.revision);
        return true;
      } finally {
        trainingAssignmentBusyRef.current = false;
      }
    }
    const heroUids = st.trainingCamp.heroUids.map((uid, index) => index === slot ? heroUid : uid);
    stateRef.current = { ...st, trainingCamp: { ...st.trainingCamp, heroUids } };
    setState((prev) => ({
      ...prev,
      trainingCamp: { ...prev.trainingCamp, heroUids },
    }));
    return true;
  }, [serverRevisionHint]);

  const unlockTrainingSlot = useCallback(async (): Promise<boolean> => {
    const st = stateRef.current;
    const slot = st.trainingCamp.unlockedSlots;
    const cost = TRAINING_SLOT_COSTS[slot];
    if (slot >= 10 || cost === undefined || (!tokenomicsEnabled && st.hero < cost)) return false;
    const balance = await settleHeroSpend(cost, 'training-slot');
    if (balance === null) return false;
    setState((prev) => ({
      ...prev,
      hero: balance,
      trainingCamp: { ...prev.trainingCamp, unlockedSlots: slot + 1 },
      milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-spent-', cost),
    }));
    return true;
  }, [settleHeroSpend]);

  const buyTrainingBoost = useCallback(async (multiplier: 2 | 4, hours: 1 | 4): Promise<boolean> => {
    const key = `${multiplier}x-${hours}h` as TrainingBoostKey;
    const cost = TRAINING_BOOST_COSTS[key];
    const st = stateRef.current;
    if (!cost || (!tokenomicsEnabled && st.hero < cost)) return false;
    const balance = await settleHeroSpend(cost, `training-boost-${multiplier}x-${hours}h`);
    if (balance === null) return false;
    const now = Date.now();
    setState((prev) => {
      const advanced = advanceTrainingCamp(prev, now);
      const durationMs = hours * 60 * 60 * 1000;
      const camp = advanced.trainingCamp;
      const trainingCamp = camp.boostMultiplier <= 1 || camp.boostEndsAt <= now
        ? { ...camp, activeBoostKey: key, boostMultiplier: multiplier, boostEndsAt: now + durationMs }
        : camp.activeBoostKey === key
          ? { ...camp, boostEndsAt: camp.boostEndsAt + durationMs }
          : { ...camp, boostQueue: [...camp.boostQueue, { key, multiplier, durationMs }] };
      return {
        ...advanced,
        hero: balance,
        trainingCamp,
        milestoneQuests: updateQuestProgress(advanced.milestoneQuests, 'token-spent-', cost),
      };
    });
    return true;
  }, [settleHeroSpend]);

  // ── Chests ────────────────────────────────────────────────────────────────

  const openChests = useCallback(async (
    availability: Partial<Record<Rarity, boolean>> = {},
    reserveLimited?: (item: OwnedItem) => Promise<string | null>,
  ) => {
    if (chestOpeningRef.current) return;
    const st = stateRef.current;
    const freeSlots = inventoryCapacity(st) - bagItemCount(st);
    if (freeSlots <= 0 && st.chests.length > 0) return 'inventory-full' as const;
    if (st.chests.length === 0) return;
    chestOpeningRef.current = true;
    setChestOpening(true);
    try {
      let openCount = Math.min(freeSlots, st.chests.length);
      let mailed = false;
      let inventoryFull = false;
      let results: OwnedItem[] = [];
      let revision: number | null = null;
      if (tokenomicsEnabled) {
        // The server opens at most 64 chests per request; extra bags hold up to 256 items, so open in batches.
        // A rejected batch stops the run and keeps every chest that was not settled.
        while (results.length < openCount) {
          const batchCount = Math.min(CHEST_OPEN_BATCH_SIZE, openCount - results.length);
          const idempotencyKey = createIdempotencyKey();
          let response: { items: OwnedItem[]; chest_count: number; revision: number; mailed?: boolean } | null = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            let error = '';
            response = await playerSync<{ items: OwnedItem[]; chest_count: number; revision: number; mailed?: boolean }>('chest_open', {
              count: batchCount,
              idempotency_key: idempotencyKey,
            }, (message) => { error = message; });
            if (error === 'item_capacity_exceeded') inventoryFull = true;
            if (response || error !== 'chest_count_exceeded' || attempt === 2) break;
            await new Promise((resolve) => window.setTimeout(resolve, 900));
          }
          if (!response || response.chest_count !== batchCount || !Array.isArray(response.items) || response.items.length !== batchCount) break;
          const batch = response.items.filter((item) => item && typeof item.uid === 'string' && item.serverOwned === true
            && Boolean(ITEM_MAP[item.itemId]) && Array.isArray(item.stats));
          if (batch.length !== batchCount) break;
          if (results.length > 0 && mailed !== (response.mailed === true)) break;
          mailed = response.mailed === true;
          results = [...results, ...batch];
          if (Number.isSafeInteger(response.revision)) revision = response.revision;
        }
        if (results.length === 0) return inventoryFull ? 'inventory-full' as const : undefined;
        openCount = results.length;
      } else {
        for (let i = 0; i < openCount; i++) {
          const chest = st.chests[i];
          let currentAvailability = { ...availability };
          let item = chest.boss ? openBossChest(st.accountLevel, currentAvailability) : openStandardChest(st.accountLevel, currentAvailability);
          for (let attempt = 0; attempt < 2; attempt++) {
            const rarity = ITEM_MAP[item.itemId]?.rarity;
            if (rarity !== 'divine' && rarity !== 'celestial') break;
            const serverId = reserveLimited ? await reserveLimited(item) : null;
            if (serverId) { item = { ...item, uid: serverId }; break; }
            currentAvailability = { ...currentAvailability, [rarity]: false };
            item = chest.boss ? openBossChest(st.accountLevel, currentAvailability) : openStandardChest(st.accountLevel, currentAvailability);
          }
          results.push(item);
        }
      }
      if (revision !== null) setServerRevisionHint(revision);
      flushSync(() => { setChestRewardsMailed(mailed); setChestOpenResult(results); });
      if (mailed) void loadMail();
      const openedTutorial = st.chests.slice(0, openCount).some((chest) => chest.tutorial);
      setState((prev) => ({
        ...prev,
        chests: prev.chests.slice(openCount),
        inventory: [...prev.inventory, ...(mailed ? [] : results.map((item) => shouldAutoLockItem(item) ? { ...item, locked: true } : item))].sort((a, b) => {
          const rarityDelta = RARITY_INDEX[ITEM_MAP[b.itemId]?.rarity ?? 'common'] - RARITY_INDEX[ITEM_MAP[a.itemId]?.rarity ?? 'common'];
          return rarityDelta || displayItemPower(b) - displayItemPower(a);
        }),
        session: { ...prev.session, chestsOpened: prev.session.chestsOpened + openCount },
        dailyQuests: updateQuestProgress(prev.dailyQuests, 'chest-', openCount),
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'chest-', openCount),
        tutorial: openedTutorial ? { ...prev.tutorial, chestCompleted: true } : prev.tutorial,
      }));
      if (inventoryFull) return 'inventory-full' as const;
    } finally {
      chestOpeningRef.current = false;
      setChestOpening(false);
    }
  }, [loadMail]);

  const closeChestResult = useCallback(() => setChestOpenResult(null), []);
  const dismissEnchantResult = useCallback(() => setEnchantResult(null), []);

  // ── Rotating shop ────────────────────────────────────────────────────────

  const applyStoreState = useCallback((result: { store: GameState['rotatingShop']; refresh_at: number; gold: number; revision: number }) => {
    if (!Array.isArray(result.store) || result.store.length !== 4 || !Number.isFinite(result.refresh_at)
      || !Number.isFinite(result.gold) || !Number.isSafeInteger(result.revision)) return false;
    if (result.store.some((offer) => !offer || !ITEM_MAP[offer.itemId] || !Number.isSafeInteger(offer.price) || offer.price < 0 || typeof offer.sold !== 'boolean')) return false;
    setServerRevisionHint(result.revision);
    setState((prev) => ({
      ...prev,
      rotatingShop: result.store,
      rotatingShopRefreshAt: Math.floor(result.refresh_at),
      gold: Math.max(0, Math.floor(result.gold)),
    }));
    return true;
  }, []);

  const refreshStore = useCallback(async (): Promise<boolean> => {
    if (!tokenomicsEnabled) return true;
    const result = await playerSync<{ store: GameState['rotatingShop']; refresh_at: number; gold: number; revision: number }>('store_snapshot');
    return Boolean(result && applyStoreState(result));
  }, [applyStoreState]);

  const buyRotatingItem = useCallback(async (index: number): Promise<boolean> => {
    if (storeBusyRef.current) return false;
    if (tokenomicsEnabled) {
      const slot = stateRef.current.rotatingShop[index];
      // A full bag no longer blocks buying: the server mails the item.
      if (!slot || slot.sold || stateRef.current.gold < slot.price) return false;
      storeBusyRef.current = true;
      setStoreBusy(true);
      try {
        const result = await playerSync<{
          inventory: OwnedItem[];
          gold: number;
          store: GameState['rotatingShop'];
          refresh_at: number;
          revision: number;
          delivered_to?: string;
        }>('store_buy_item', {
          slot_index: index,
          refresh_at: stateRef.current.rotatingShopRefreshAt,
          idempotency_key: createIdempotencyKey(),
        });
        if (!result || !Array.isArray(result.inventory) || !applyStoreState(result)) {
          await refreshStore();
          return false;
        }
        setState((prev) => ({ ...prev, inventory: result.inventory }));
        if (result.delivered_to === 'mail') void loadMail();
        return true;
      } finally {
        storeBusyRef.current = false;
        setStoreBusy(false);
      }
    }
    setState((prev) => {
      const slot = prev.rotatingShop[index];
      if (!slot || slot.sold || prev.gold < slot.price || bagItemCount(prev) >= inventoryCapacity(prev)) return prev;
      const proper = rollItem(slot.itemId, 1);
      return { ...prev, gold: prev.gold - slot.price, inventory: [...prev.inventory, proper], rotatingShop: prev.rotatingShop.map((s, i) => i === index ? { ...s, sold: true } : s) };
    });
    return true;
  }, [applyStoreState, loadMail, refreshStore]);

  // ── Quests ───────────────────────────────────────────────────────────────

  const claimQuest = useCallback(async (questId: string): Promise<boolean> => {
    if (!tokenomicsEnabled || !Number.isSafeInteger(serverRevisionHint)) return false;
    const idempotencyKey = createIdempotencyKey();
    let expectedRevision = serverRevisionHint;
    let claimError = '';
    const attemptClaim = () => {
      claimError = '';
      return playerSync<{ claimed: boolean; state: GameState; revision: number }>('quest_claim', {
        quest_id: questId, expected_revision: expectedRevision, idempotency_key: idempotencyKey,
      }, (error) => { claimError = error; });
    };
    let result = await attemptClaim();
    // Combat saves move the revision every few seconds, so a single retry can lose the race again.
    for (let attempt = 0; attempt < 4 && !result && claimError === 'state_conflict'; attempt += 1) {
      const refreshed = await playerSync<{ state: GameState; revision: number }>('game_state_load');
      if (!refreshed?.state || !Number.isSafeInteger(refreshed.revision)) return false;
      expectedRevision = refreshed.revision;
      result = await attemptClaim();
      if (!result && (claimError !== 'state_conflict' || attempt === 3)) {
        setServerRevisionHint(refreshed.revision);
        hydrateServerState(refreshed.state);
        return false;
      }
    }
    if (!result?.state || !Number.isSafeInteger(result.revision)) return false;
    setServerRevisionHint(result.revision);
    hydrateServerState(result.state);
    if (result.claimed) void loadMail();
    return result.claimed === true;
  }, [hydrateServerState, loadMail, serverRevisionHint]);

  // Partner Quests: the reward was approved in the Founder panel; the claim is
  // the only step that changes the save, with the same revision retry as quests.
  const claimPartnerQuest = useCallback(async (questId: number): Promise<string | null> => {
    if (!tokenomicsEnabled || !Number.isSafeInteger(serverRevisionHint)) return 'unavailable';
    const idempotencyKey = createIdempotencyKey();
    let expectedRevision = serverRevisionHint;
    let claimError = '';
    const attemptClaim = () => {
      claimError = '';
      return playerSync<{ claimed: boolean; state: GameState; revision: number }>('partner_quest_claim', {
        quest_id: questId, expected_revision: expectedRevision, idempotency_key: idempotencyKey,
      }, (error) => { claimError = error; });
    };
    let result = await attemptClaim();
    // Combat saves move the revision every few seconds, so a single retry can lose the race again.
    for (let attempt = 0; attempt < 4 && !result && claimError === 'state_conflict'; attempt += 1) {
      const refreshed = await playerSync<{ state: GameState; revision: number }>('game_state_load');
      if (!refreshed?.state || !Number.isSafeInteger(refreshed.revision)) return 'unavailable';
      expectedRevision = refreshed.revision;
      result = await attemptClaim();
      if (!result && (claimError !== 'state_conflict' || attempt === 3)) {
        setServerRevisionHint(refreshed.revision);
        hydrateServerState(refreshed.state);
        return claimError || 'unavailable';
      }
    }
    if (!result?.state || !Number.isSafeInteger(result.revision)) return claimError || 'unavailable';
    setServerRevisionHint(result.revision);
    hydrateServerState(result.state);
    return null;
  }, [hydrateServerState, serverRevisionHint]);

  const claimTutorialQuest = useCallback(async (questId: string): Promise<string | null> => {
    if (!tokenomicsEnabled || !Number.isSafeInteger(serverRevisionHint)) return 'state_unavailable';
    const idempotencyKey = createIdempotencyKey();
    let expectedRevision = serverRevisionHint;
    let claimError = '';
    const attemptClaim = () => {
      claimError = '';
      return playerSync<{
        gold: number; revision: number; mailed?: boolean; tutorial: GameState['tutorial'];
        resources: { balances?: Record<string, string> };
      }>('tutorial_quest_claim', {
        quest_id: questId, expected_revision: expectedRevision, idempotency_key: idempotencyKey,
      }, (error) => { claimError = error; });
    };
    let result = await attemptClaim();
    // Combat saves move the revision every few seconds, so a single retry can lose the race again.
    for (let attempt = 0; attempt < 4 && !result && claimError === 'state_conflict'; attempt += 1) {
      const refreshed = await playerSync<{ state: GameState; revision: number }>('game_state_load');
      if (!refreshed?.state || !Number.isSafeInteger(refreshed.revision)) return 'state_unavailable';
      expectedRevision = refreshed.revision;
      result = await attemptClaim();
      if (!result && (claimError !== 'state_conflict' || attempt === 3)) {
        setServerRevisionHint(refreshed.revision);
        hydrateServerState(refreshed.state);
        return claimError || 'unavailable';
      }
    }
    if (!result || !Number.isSafeInteger(result.revision) || !result.tutorial) return claimError || 'invalid_server_response';
    const balances = result.resources?.balances ?? {};
    const read = (key: string, fallback: number) => /^\d+$/.test(balances[key] ?? '') ? Number(balances[key]) : fallback;
    setServerRevisionHint(result.revision);
    setState((prev) => ({
      ...prev, gold: Math.max(0, Math.floor(result.gold)), tutorial: result.tutorial,
      bossKeys: read('boss_key', prev.bossKeys), summonScrolls: read('summon_scroll', prev.summonScrolls),
      potions: { ...prev.potions, xs: read('potion_xs', prev.potions.xs) },
    }));
    if (result.mailed) void loadMail();
    return null;
  }, [hydrateServerState, loadMail, serverRevisionHint]);

  const openTutorialChests = useCallback(async (requestedCount: 1 | 10): Promise<boolean> => {
    if (!tokenomicsEnabled || chestOpeningRef.current) return false;
    const current = stateRef.current;
    const count = Math.min(requestedCount, current.tutorial.chestBalance, isolatedHackathon ? requestedCount : inventoryCapacity(current) - bagItemCount(current));
    if (count !== 1 && count !== 10) return false;
    chestOpeningRef.current = true; setChestOpening(true);
    try {
      const result = await playerSync<{ items: OwnedItem[]; chest_count: number; revision: number; mailed?: boolean; tutorial: GameState['tutorial'] }>('tutorial_chest_open', {
        count, idempotency_key: createIdempotencyKey(),
      });
      if (!result || result.chest_count !== count || !Array.isArray(result.items) || result.items.length !== count || !result.tutorial) return false;
      const items = result.items.filter((item) => item?.serverOwned === true && typeof item.uid === 'string' && Boolean(ITEM_MAP[item.itemId]));
      if (items.length !== count) return false;
      if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
      flushSync(() => { setChestRewardsMailed(result.mailed === true); setChestOpenResult(items); });
      if (result.mailed) void loadMail();
      setState((prev) => ({
        ...prev, tutorial: result.tutorial,
        inventory: [...prev.inventory, ...(result.mailed ? [] : items.map((item) => shouldAutoLockItem(item) ? { ...item, locked: true } : item))]
          .sort((a, b) => RARITY_INDEX[ITEM_MAP[b.itemId]?.rarity ?? 'common'] - RARITY_INDEX[ITEM_MAP[a.itemId]?.rarity ?? 'common'] || displayItemPower(b) - displayItemPower(a)),
        session: { ...prev.session, chestsOpened: prev.session.chestsOpened + count },
        dailyQuests: updateQuestProgress(prev.dailyQuests, 'chest-', count),
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'chest-', count),
      }));
      return true;
    } finally { chestOpeningRef.current = false; setChestOpening(false); }
  }, [loadMail]);

  // Dungeon Chests live only in the server resource ledger; the save never carries them.
  const [dungeonChests, setDungeonChests] = useState<DungeonChestStatus | null>(null);
  const [dungeonChestOpening, setDungeonChestOpening] = useState(false);
  const dungeonChestOpeningRef = useRef(false);
  const readChestBalances = (value: unknown): DungeonChestStatus['balances'] | null => {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const read = (key: string) => Number.isSafeInteger(Number(raw[key])) && Number(raw[key]) >= 0 ? Number(raw[key]) : null;
    const one = read('1'); const two = read('2'); const three = read('3');
    return one === null || two === null || three === null ? null : { 1: one, 2: two, 3: three };
  };
  const loadDungeonChests = useCallback(async () => {
    if (!tokenomicsEnabled || !isolatedHackathon) return;
    const result = await playerSync<{ balances: unknown; odds: DungeonChestStatus['odds'] }>('dungeon_chest_status', {});
    const balances = readChestBalances(result?.balances);
    if (result && balances && result.odds && typeof result.odds === 'object') setDungeonChests({ balances, odds: result.odds });
  }, []);
  const openDungeonChest = useCallback(async (depth: 1 | 2 | 3): Promise<{ hero: OwnedHero } | { error: string }> => {
    if (!tokenomicsEnabled || dungeonChestOpeningRef.current) return { error: 'busy' };
    let expectedRevision = serverRevisionHint;
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision)) return { error: 'state_unavailable' };
    const current = stateRef.current;
    if (current.ownedHeroes.length >= current.heroCapacity) return { error: 'hero_capacity_exceeded' };
    dungeonChestOpeningRef.current = true; setDungeonChestOpening(true);
    try {
      const idempotencyKey = createIdempotencyKey();
      let failure = '';
      const attempt = () => {
        failure = '';
        return playerSync<{ hero: OwnedHero; depth: number; revision: number; balances: unknown }>('dungeon_chest_open', {
          depth, expected_revision: expectedRevision, idempotency_key: idempotencyKey,
        }, (code) => { failure = code; });
      };
      let result = await attempt();
      // Combat saves move the revision every few seconds; re-read it and retry with the same key.
      for (let retry = 0; retry < 3 && !result && failure === 'state_conflict'; retry += 1) {
        const refreshed = await playerSync<{ revision: number }>('game_state_load');
        if (!refreshed || !Number.isSafeInteger(refreshed.revision)) break;
        expectedRevision = refreshed.revision;
        result = await attempt();
      }
      const hero = result?.hero;
      const balances = readChestBalances(result?.balances);
      if (!result || result.depth !== depth || !hero || typeof hero.uid !== 'string' || !HERO_MAP[hero.heroId]
        || !Number.isSafeInteger(result.revision) || !balances) return { error: failure || 'invalid_server_response' };
      setServerRevisionHint(result.revision);
      setDungeonChests((prev) => prev ? { ...prev, balances } : prev);
      setState((prev) => prev.ownedHeroes.some((owned) => owned.uid === hero.uid) ? prev : {
        ...prev, ownedHeroes: [...prev.ownedHeroes, hero],
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'hero-owned-', 1),
      });
      return { hero };
    } finally { dungeonChestOpeningRef.current = false; setDungeonChestOpening(false); }
  }, [serverRevisionHint]);

  const resetAccount = useCallback(() => {
    const initial = makeInitialState();
    combatSessionRef.current.reset();
    normalCombatWaveRef.current = null;
    resolvingRef.current = false;
    setState(initial);
    setUnits([]);
    unitsRef.current = [];
    heroHpRef.current.clear();
  }, [setUnits]);

  const completeWelcomeTutorial = useCallback(() => {
    setState((prev) => ({ ...prev, tutorial: { ...prev.tutorial, welcomeCompleted: true } }));
  }, []);

  const activateBoost = useCallback(() => {
    setState((prev) => {
      const c = prev.boost.conditions;
      const tasks = [
        c.connectTelegram,
        c.connectTwitter,
        c.connectDiscord,
        c.spentTokens >= 500,
        c.holdTokens >= 1000 || prev.hero >= 1000,
      ];
      const progress = Math.round((tasks.filter(Boolean).length / tasks.length) * 100);
      const active = progress >= 100;
      return {
        ...prev,
        boost: { ...prev.boost, progress, active, bonusPct: active ? 100 : 0, conditions: { ...c, holdTokens: prev.hero } },
      };
    });
  }, []);

  const deactivateBoost = useCallback(() => {
    setState((prev) => ({ ...prev, boost: { ...prev.boost, active: false, bonusPct: 0 } }));
  }, []);

  const toggleBoostCondition = useCallback((key: 'connectTelegram' | 'connectTwitter' | 'connectDiscord') => {
    setState((prev) => {
      const conditions = { ...prev.boost.conditions, [key]: !prev.boost.conditions[key], holdTokens: prev.hero };
      const tasks = [conditions.connectTelegram, conditions.connectTwitter, conditions.connectDiscord, conditions.spentTokens >= 500, conditions.holdTokens >= 1000];
      const progress = Math.round((tasks.filter(Boolean).length / tasks.length) * 100);
      const active = progress >= 100;
      return { ...prev, boost: { ...prev.boost, conditions, progress, active, bonusPct: active ? 100 : 0 } };
    });
  }, []);

  const sortInventory = useCallback(() => {
    setState((prev) => {
      const sorted = [...prev.inventory].sort((a, b) => {
        const ra = RARITY_INDEX[ITEM_MAP[a.itemId]?.rarity ?? 'common'];
        const rb = RARITY_INDEX[ITEM_MAP[b.itemId]?.rarity ?? 'common'];
        if (rb !== ra) return rb - ra;
        return displayItemPower(b) - displayItemPower(a);
      });
      return { ...prev, inventory: sorted };
    });
  }, []);

  const autoEquipBest = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    const teamHeroes = current.team
        .map((uid) => current.ownedHeroes.find((candidate) => candidate.uid === uid))
        .filter((hero): hero is OwnedHero => Boolean(hero));
    if (teamHeroes.length === 0) return false;

    // Release the active team's current gear into one shared pool. The first
    // hero in formation gets first choice, then the second and third use only
    // what remains. Gear worn by reserve heroes is never touched.
    const teamUids = new Set(teamHeroes.map((hero) => hero.uid));
    const reservedByReserve = new Set<string>();
    current.ownedHeroes.forEach((candidate) => {
      if (teamUids.has(candidate.uid)) return;
      Object.values(candidate.equipped).forEach((uid) => { if (uid) reservedByReserve.add(uid); });
    });
    const available = new Set(current.inventory.filter((item) => !reservedByReserve.has(item.uid)).map((item) => item.uid));
    // Power derives stat arrays; compute it once per item instead of on every sort comparison.
    const powerByUid = new Map(current.inventory.filter((item) => available.has(item.uid))
      .map((item) => [item.uid, displayItemPower(item)]));
    const slots: ItemSlot[] = ['class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet'];
    const equippedByUid = new Map<string, Partial<Record<ItemSlot, string>>>();
    for (const hero of teamHeroes) {
      const heroBase = HERO_MAP[hero.heroId];
      if (!heroBase) continue;
      const equipped: Partial<Record<ItemSlot, string>> = {};
      for (const slot of slots) {
        const best = current.inventory
          .filter((item) => {
            const itemBase = ITEM_MAP[item.itemId];
            return available.has(item.uid)
              && itemBase?.slot === slot
              && canClassEquipItem(heroBase.heroClass, itemBase)
              && meetsItemLevelRequirement(item, current.accountLevel);
          })
          .sort((a, b) => (powerByUid.get(b.uid) ?? 0) - (powerByUid.get(a.uid) ?? 0) || b.level - a.level)[0];
        if (best) {
          equipped[slot] = best.uid;
          available.delete(best.uid);
        }
      }
      equippedByUid.set(hero.uid, equipped);
    }
    const nextState = {
      ...current,
      ownedHeroes: current.ownedHeroes.map((candidate) => {
        const equipped = equippedByUid.get(candidate.uid);
        return equipped ? { ...candidate, equipped } : candidate;
      }),
    };
    const before = JSON.stringify(serverEquipmentAssignments(current));
    const after = JSON.stringify(serverEquipmentAssignments(nextState));
    // Already wearing the best gear: do not restart combat or schedule another save.
    if (before === after && current.ownedHeroes.every((hero, index) =>
      JSON.stringify(hero.equipped) === JSON.stringify(nextState.ownedHeroes[index].equipped))) return true;
    if (before !== after && !(await settleServerEquipment(nextState))) return false;
    stateRef.current = nextState;
    setState(nextState);
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
    return true;
  }, [settleServerEquipment, spawnBattle]);

  const collectOffline = useCallback(() => setOfflineEarnings(null), []);
  const retry = useCallback(() => {
    combatSessionRef.current.reset();
    normalCombatWaveRef.current = null;
    resolvingRef.current = false;
    combatRecoveryAttemptRef.current = 0;
    setCombatRecovery(HEALTHY_COMBAT);
    void spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

  // The recovery backoff grows to 30 s while offline; when the connection returns, reconnect the
  // battle at once instead of waiting out the backoff (Founder Android test 2026-10-08).
  useEffect(() => {
    if (combatRecovery.status === 'healthy') return;
    const reconnect = () => { if (!paused) retry(); };
    window.addEventListener('online', reconnect);
    return () => window.removeEventListener('online', reconnect);
  }, [combatRecovery.status, paused, retry]);

  // ── Referrals ────────────────────────────────────────────────────────────
  const claimReferralReward = useCallback(() => {
    setState((prev) => {
      if (prev.referral.pendingReward <= 0) return prev;
      return {
        ...prev,
        hero: prev.hero + prev.referral.pendingReward,
        referral: {
          ...prev.referral,
          totalEarned: prev.referral.totalEarned + prev.referral.pendingReward,
          alreadyClaimed: prev.referral.alreadyClaimed + prev.referral.pendingReward,
          pendingReward: 0,
        },
      };
    });
  }, []);

  // Apply only server-owned commerce fields; combat/timers and local progress
  // continue unchanged. A recovered old receipt never overwrites a newer save.
  const applySeekerPurchase = useCallback((result: Record<string, unknown>) => {
    const revision=Number(result.revision);
    if (Number.isSafeInteger(revision) && revision >= (serverRevisionHintRef.current ?? 0)) {
      const current=stateRef.current;
      const next={...current};
      if (Array.isArray(result.inventory)) next.inventory=result.inventory as OwnedItem[];
      if (Array.isArray(result.owned_heroes)) next.ownedHeroes=result.owned_heroes as OwnedHero[];
      if (Array.isArray(result.chests)) next.chests=result.chests as Chest[];
      if (Number.isSafeInteger(result.hero_capacity)) next.heroCapacity=result.hero_capacity as number;
      if (typeof result.gold==='number' && Number.isFinite(result.gold)) next.gold=result.gold;
      if (Array.isArray(result.bag_slots) && result.bag_slots.length===4) next.bagSlots=result.bag_slots as GameState['bagSlots'];
      if (Array.isArray(result.store)) next.rotatingShop=result.store as GameState['rotatingShop'];
      if (Number.isSafeInteger(result.refresh_at)) next.rotatingShopRefreshAt=result.refresh_at as number;
      if (result.training_camp && typeof result.training_camp==='object') next.trainingCamp=result.training_camp as GameState['trainingCamp'];
      const remote=result.state as Partial<GameState>|undefined;
      if (remote) {
        if (Number.isSafeInteger(remote.summonScrolls)) next.summonScrolls=remote.summonScrolls as number;
        if (Number.isSafeInteger(remote.bossKeys)) next.bossKeys=remote.bossKeys as number;
        if (remote.potions) next.potions=remote.potions;
      }
      stateRef.current=next;
      setState(next);
      setServerRevisionHint(revision);
      if (result.training_camp) setTrainingIncomeRevision(revision);
    }
    void loadMail();
    void refreshAccountBonus();
  },[loadMail,refreshAccountBonus]);

  return {
    state, hydrationVersion, summonPity, ascensionFocus, summonError, serverRevisionHint, trainingIncomeRevision, battleResult, combatRecovery, autoProgress, paused, chestOpening, storeBusy, itemUpgradeBusy,
    offlineEarnings, respawnCountdowns, chestOpenResult, chestRewardsMailed, enchantResult,
    getCombatPresentationSnapshot, subscribeCombatPresentation,
    starUpHero, promoteAllHeroes, seekerPromoteAll, releaseHero, quoteHeroCapacity, upgradeHeroCapacity, toggleHeroLock, markHeroSeen,
    applySeekerPurchase, accountBonus, refreshAccountBonus, buyRewardBoost, buyShopBundle, quoteInventoryBag, buyInventoryBag,
    quoteHeroSummon, summonHeroes, summonBoss, syncBossKeys, toggleTeamMember, confirmPersistedFormation, setLocation,
    setAutoProgress, setPaused, collectOffline, creditServerTokens, applyServerTokenClaim, setServerTokenBalance, applyServerBoostStatus, applyServerPityStatus, applyServerAscensionFocus, setHeroAscensionFocus, retry,
    equipItem, unequipItem, unequipAll, equipmentError: () => equipmentErrorRef.current, sellItem, toggleItemLock, sellAllUnlocked,
    enchantItem, rerollItem, dismissEnchantResult,
    setAutoPot, setBattleAnimationMode, setCombatPresentationVisible,
    setTrainingHero, unlockTrainingSlot, buyTrainingBoost,
    openChests, openTutorialChests, dungeonChests, dungeonChestOpening, loadDungeonChests, openDungeonChest, closeChestResult, refreshStore, buyRotatingItem, claimQuest, claimTutorialQuest, claimPartnerQuest,
    claimReferralReward, resetAccount, hydrateServerState, mergeServerResourceState, applyServerRevision, completeWelcomeTutorial, setAvatarHero, loadMarket, mailCount, loadMail, claimMail, readMail, deleteReadMail, buyMarketAsset, createMarketListing, cancelMarketListing, activateBoost, deactivateBoost, toggleBoostCondition, sortInventory, autoEquipBest, creditTestGold, creditTestAccountXp, creditTestFormationXp,
    heroStatsFor: (uid: string) => {
      const owned = state.ownedHeroes.find((h) => h.uid === uid);
      if (!owned) return null;
      return heroStats(owned, getEquippedItems(owned, state.inventory));
    },
    teamPower: () => {
      const heroes = state.team.map(uid => state.ownedHeroes.find(h => h.uid === uid)).filter((h): h is OwnedHero => !!h);
      return teamPower(heroes, state.inventory);
    },
    earningsPerHour: () => {
      const loc = buildLocation(state.currentLocation, state.team.length, false, state.accountLevel);
      const heroes = state.team.map(uid => state.ownedHeroes.find(h => h.uid === uid)).filter((h): h is OwnedHero => !!h);
      const power = teamPower(heroes, state.inventory);
      if (isOverpowered(loc, power) || !canMineTokens(state.currentLocation, state.accountLevel, state.highestLocation, state.seekerProgression?.legacyLocationAccess)) return 0;
      // ~1 battle every 8 seconds = 450/hour
      return loc.tokenReward * 450;
    },
  };
}

export type GameApi = ReturnType<typeof useGame>;

void RARITY_INDEX;
