import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { GameState, OwnedHero, CombatUnit, FloatingNumber, ItemSlot, OwnedItem, PotionTier, DailyQuest, TrainingBoostKey } from '@/game/types';
import {
  loadState, saveLegacyState, normalizeState, makeInitialState, makeRegisteredStarterState, starUpCost, summonCostHero,
  MAX_TEAM, MAX_HEROES, MAX_HERO_STARS, MAX_INVENTORY, MAX_CHESTS, MAX_ACCOUNT_XP, RESPAWN_TIME_MS, ROTATING_REFRESH_MS,
  accountLevelFromXp, advanceHeroXp, heroSellValue, milestoneQuest, moscowDayKey,
  heroXpForLevel, TRAINING_SLOT_COSTS, TRAINING_BOOST_COSTS,
  ACTIVE_SESSION_MS,
  trainingTokenPenalty,
} from '@/game/state';
import { buildLocation, ownedToUnit, enemyToUnit, heroStats, getEquippedItems, teamPower, isOverpowered, canMineTokens, locationUnlockLevel, latestTokenLocation } from '@/game/engine';
import { HERO_MAP, RARITY_INDEX, canonicalHeroId } from '@/game/heroes';
import {
  openStandardChest, openBossChest, generateRotatingShop,
  ITEM_MAP, POTION_MAP, sellValue, rollItem, rerollItemStats,
  enchantSuccessChance, enchantCost, enchantCharmCost, itemPower,
  MAX_CHESTS_PER_DAY, rerollCost,
  canClassEquipItem,
  meetsItemLevelRequirement,
} from '@/game/items';
import type { Rarity } from '@/game/types';
import { recordBattleTelemetry } from '@/game/balance';
import { advanceCombatFrame, combatResolution, seededCombatRandom } from '../../supabase/functions/player-sync/combat-step.mjs';
import { playerSync, tokenomicsEnabled } from '@/game/backend';

const COMBAT_SPEED = 1;
const COMBAT_LOOP_INTERVAL_MS = 50;
const COMBAT_PRESENTATION_INTERVAL_MS: Record<GameState['battleAnimationMode'], number> = {
  off: 1_000,
  light: 750,
  spectacular: 500,
};
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

  const locationId = latestTokenLocation(state.accountLevel, state.highestLocation);
  const xpGain = Math.floor((buildLocation(locationId, 1).xpReward * 1.6 / 12) * effectiveSeconds);
  const eligibleTrainees = camp.heroUids.map((uid) => {
    const hero = uid ? state.ownedHeroes.find((owned) => owned.uid === uid) : null;
    return hero && !state.team.includes(hero.uid) && hero.level < state.accountLevel ? hero.uid : null;
  });
  const trainees = new Set(eligibleTrainees.filter((uid): uid is string => Boolean(uid)));
  const ownedHeroes = xpGain > 0 ? state.ownedHeroes.map((hero) => {
    if (!trainees.has(hero.uid) || state.team.includes(hero.uid) || hero.level >= state.accountLevel) return hero;
    const advanced = advanceHeroXp(hero.level, hero.xp, xpGain);
    if (advanced.level >= state.accountLevel) return { ...hero, level: state.accountLevel, xp: 0 };
    return { ...hero, level: advanced.level, xp: Math.min(advanced.remaining, heroXpForLevel(advanced.level) - 1) };
  }) : state.ownedHeroes;

  return {
    ...state,
    ownedHeroes,
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

function bagItemCount(state: GameState): number {
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

export interface ServerMarketSnapshot {
  listings: ServerMarketListing[];
  history: { id: string; name: string; price: number; createdAt: number; action: 'bought' | 'sold' }[];
  active_limit: number;
  fee_percent: number;
  pool_day: string;
  pool_fee_total: number;
  pool_trade_count: number;
}

export interface MarketActionResult { ok: boolean; error?: string }

interface NormalCombatWave {
  startKey: string;
  completionKey: string;
  location: number;
  availableAt: number;
  elapsedMs: number;
  nextAutoPotion: number;
  autoPotions: NormalCombatAutoPotion[];
}

interface NormalCombatAutoPotion {
  elapsed_ms: number;
  hero_uid: string;
  tier: PotionTier;
  hp_restore: number;
}

interface NormalCombatStartResult {
  start_key: string;
  location: number;
  seed: number;
  available_at: string;
  initial_units: Array<Partial<CombatUnit> & Pick<CombatUnit, 'uid' | 'side'> & { lane: number }>;
  outcome?: { auto_potions?: NormalCombatAutoPotion[] };
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
  const [autoProgress, setAutoProgress] = useState(true);
  const [paused, setPaused] = useState(false);
  const [respawnCountdowns, setRespawnCountdowns] = useState<Record<string, number>>({});
  const [presentationNow, setPresentationNow] = useState(Date.now);
  const [chestOpenResult, setChestOpenResult] = useState<OwnedItem[] | null>(null);
  const [chestOpening, setChestOpening] = useState(false);
  const [enchantResult, setEnchantResult] = useState<{ success: boolean; item?: OwnedItem } | null>(null);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [summonPity, setSummonPity] = useState({ legendary: 0, mythic: 0, cosmic: 0, divine: 0, celestial: 0 });
  const [ascensionFocus, setAscensionFocus] = useState<Partial<Record<Rarity, string>>>({});
  const [summonError, setSummonError] = useState('');
  const [serverRevisionHint, setServerRevisionHint] = useState<number | null>(null);
  const [storeBusy, setStoreBusy] = useState(false);
  const [itemUpgradeBusy, setItemUpgradeBusy] = useState(false);

  const stateRef = useRef(state); stateRef.current = state;
  const unitsRef = useRef<CombatUnit[]>([]);
  const autoRef = useRef(autoProgress); autoRef.current = autoProgress;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const combatWakeRef = useRef<() => void>(() => undefined);
  const combatPresentationVisibleRef = useRef(true);
  const floaterId = useRef(0);
  const resolvingRef = useRef(false);
  const itemUpgradeBusyRef = useRef(false);
  const equipmentErrorRef = useRef('');
  const heroHpRef = useRef<Map<string, number>>(new Map());
  const battleStartedAtRef = useRef(Date.now());
  const lastCombatRenderRef = useRef(0);
  const combatAccumulatorRef = useRef(0);
  const combatRandomRef = useRef<() => number>(Math.random);
  const normalCombatWaveRef = useRef<NormalCombatWave | null>(null);
  const combatSpawnSequenceRef = useRef(0);
  const offlineSettlementKeyRef = useRef('');
  const chestOpeningRef = useRef(false);
  const storeBusyRef = useRef(false);

  const hydrateServerState = useCallback((remoteState: unknown) => {
    setState(normalizeState(remoteState as Partial<GameState>));
    setHydrationVersion((version) => version + 1);
    setUnits([]);
    unitsRef.current = [];
    heroHpRef.current.clear();
  }, [setUnits]);

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
    const now = Date.now();
    const serverNormalCombat = tokenomicsEnabled && !forceBoss && !st.bossBattleActive;
    const sequence = ++combatSpawnSequenceRef.current;
    if (serverNormalCombat) {
      resolvingRef.current = true;
      unitsRef.current = [];
      setUnits([]);
      setBattleResult(null);
      setFloaters([]);
      const started = await playerSync<NormalCombatStartResult>('normal_combat_start', {
        location: locationId,
        idempotency_key: createIdempotencyKey(),
      });
      if (sequence !== combatSpawnSequenceRef.current) return;
      if (!started || typeof started.start_key !== 'string' || !Array.isArray(started.initial_units)) {
        resolvingRef.current = false;
        setBattleResult({ win: false, gold: 0, xp: 0, tokens: 0, chest: false, overpowered: false });
        return;
      }
      const serverLocation = Math.floor(Number(started.location));
      const serverSeed = Number(started.seed);
      const availableAt = Date.parse(started.available_at);
      if (!Number.isSafeInteger(serverLocation) || serverLocation < 1 || serverLocation > 10
        || !Number.isSafeInteger(serverSeed) || !Number.isFinite(availableAt)) {
        resolvingRef.current = false;
        setBattleResult({ win: false, gold: 0, xp: 0, tokens: 0, chest: false, overpowered: false });
        return;
      }
      const location = buildLocation(serverLocation, Math.max(1, started.initial_units.filter((unit) => unit.side === 'hero').length), false);
      const heroes = new Map(st.ownedHeroes.map((hero) => [hero.uid, hero]));
      const nextUnits: CombatUnit[] = [];
      for (const serverUnit of started.initial_units) {
        const ownedHero = serverUnit.side === 'hero' ? heroes.get(serverUnit.uid) : null;
        const enemy = serverUnit.side === 'enemy' ? location.enemies[serverUnit.lane] : null;
        const base = ownedHero ? ownedToUnit(ownedHero, st.inventory)
          : enemy ? enemyToUnit(enemy, serverUnit.lane) : null;
        if (!base) {
          resolvingRef.current = false;
          setBattleResult({ win: false, gold: 0, xp: 0, tokens: 0, chest: false, overpowered: false });
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
      };
      combatRandomRef.current = seededCombatRandom(serverSeed);
      combatAccumulatorRef.current = 0;
      unitsRef.current = nextUnits;
      lastCombatRenderRef.current = performance.now();
      battleStartedAtRef.current = now;
      if (combatPresentationVisibleRef.current) setUnits(nextUnits);
      resolvingRef.current = false;
      combatWakeRef.current();
      return;
    }
    normalCombatWaveRef.current = null;
    combatRandomRef.current = Math.random;
    combatAccumulatorRef.current = 0;
    const fullTeam = teamUids
      .map((uid) => st.ownedHeroes.find((h) => h.uid === uid))
      .filter((h): h is OwnedHero => Boolean(h));
    const loc = buildLocation(locationId, fullTeam.length, forceBoss ?? st.bossBattleActive);
    const heroUnits = fullTeam.map((o) => {
      const unit = ownedToUnit(o, st.inventory);
      if (!unit) return null;
      if (o.respawnAt && o.respawnAt > now) return { ...unit, hp: 0, alive: false };
      return unit;
    }).filter((u): u is CombatUnit => Boolean(u)).map((u) => {
      const carriedHp = heroHpRef.current.get(u.uid);
      return carriedHp === undefined ? u : { ...u, hp: Math.max(1, Math.min(u.maxHp, carriedHp)), alive: carriedHp > 0 };
    });
    const enemyUnits = loc.enemies.map((e, i) => enemyToUnit(e, i));
    const nextUnits = [
      ...heroUnits.map((u) => ({ ...u, attackTimer: 0 })),
      ...enemyUnits.map((u) => ({ ...u, attackTimer: u.attackInterval })),
    ];
    unitsRef.current = nextUnits;
    lastCombatRenderRef.current = performance.now();
    battleStartedAtRef.current = now;
    if (combatPresentationVisibleRef.current) setUnits(nextUnits);
    setBattleResult(null);
    setFloaters([]);
    resolvingRef.current = false;
    combatWakeRef.current();
  }, [setFloaters, setUnits]);

  const activeTeamKey = state.team.join('|');
  const respawnTeamKey = state.team.map((uid) => state.ownedHeroes.find((hero) => hero.uid === uid)?.respawnAt ?? 0).join('|');
  useEffect(() => {
    if (state.walletAddress && state.team.length > 0) {
      spawnBattle(state.currentLocation, state.team);
    } else {
      unitsRef.current = [];
      setUnits([]);
    }
    // Keep battle units and portraits aligned with the exact saved formation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.walletAddress, state.currentLocation, activeTeamKey, respawnTeamKey, hydrationVersion]);

  const awardBattle = useCallback((locationId: number, clearedLanes: number, wonHeroUids: string[], deadHeroUids: string[], allCleared: boolean) => {
    const st = stateRef.current;
    // Combat and its rewards keep running continuously while the player is
    // online; only offline/hidden-tab catch-up is gated by the active window.
    if (!st.walletAddress) return;
    const serverWave = normalCombatWaveRef.current;
    if (tokenomicsEnabled && serverWave) {
      normalCombatWaveRef.current = null;
      deadHeroUids.forEach((uid) => heroHpRef.current.delete(uid));
      const clearSeconds = Math.max(0, (Date.now() - battleStartedAtRef.current) / 1000);
      const combatPower = teamPower(st.team.map((uid) => st.ownedHeroes.find((hero) => hero.uid === uid)).filter((hero): hero is OwnedHero => Boolean(hero)), st.inventory);
      const equippedStatLines = st.team.reduce((total, uid) => {
        const hero = st.ownedHeroes.find((owned) => owned.uid === uid);
        return total + (hero ? getEquippedItems(hero, st.inventory).reduce((sum, item) => sum + item.stats.length, 0) : 0);
      }, 0);
      void (async () => {
        const delay = Math.max(0, serverWave.availableAt - Date.now());
        if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
        const completed = await playerSync<NormalCombatCompleteResult>('normal_combat_complete', {
          start_key: serverWave.startKey,
          idempotency_key: serverWave.completionKey,
        });
        if (!completed) {
          setBattleResult({ win: false, gold: 0, xp: 0, tokens: 0, chest: false, overpowered: false });
          return;
        }
        mergeServerResourceState(completed.state);
        const revision = Number(completed.revision);
        if (Number.isSafeInteger(revision)) setServerRevisionHint(revision);
        setState((current) => ({
          ...current,
          balanceTelemetry: recordBattleTelemetry(current.balanceTelemetry, {
            locationId: serverWave.location,
            teamSize: st.team.length,
            power: combatPower,
            boss: false,
            win: allCleared,
            clearSeconds,
            heroDeaths: deadHeroUids.length,
            equippedStatLines,
          }),
        }));
        const authoritativeWin = completed.outcome?.all_cleared === true;
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
    const loc = buildLocation(locationId, st.team.length, st.bossBattleActive);
    let goldPerEnemy = clearedLanes > 0 ? loc.goldReward : 0;
    const baseXpPerEnemy = clearedLanes > 0 ? loc.xpReward : 0;

    const teamBonuses = st.team.reduce((acc, uid) => {
      const hero = st.ownedHeroes.find((h) => h.uid === uid);
      if (!hero) return acc;
      const s = heroStats(hero, getEquippedItems(hero, st.inventory));
      if (!s) return acc;
      return { gold: acc.gold + s.goldBonus, xp: acc.xp + s.xpBonus };
    }, { gold: 0, xp: 0 });
    goldPerEnemy = Math.round(goldPerEnemy * (1 + teamBonuses.gold));
    const xpPerEnemy = Math.round(baseXpPerEnemy * (1 + teamBonuses.xp));
    const gold = goldPerEnemy * clearedLanes;
    const accountXpGain = xpPerEnemy * clearedLanes;

    const tokens = 0;
    const overpowered = false;

    let chestDropped = false;
    if (allCleared) {
      chestDropped = Boolean(loc.boss);
    }

    const now = Date.now();
    const combatPower = teamPower(st.team.map((uid) => st.ownedHeroes.find((hero) => hero.uid === uid)).filter((hero): hero is OwnedHero => Boolean(hero)), st.inventory);
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
        locationId, teamSize: st.team.length, power: combatPower, boss: Boolean(loc.boss),
        win: allCleared, clearSeconds, heroDeaths: deadHeroUids.length, equippedStatLines,
      });
      next.bossBattleActive = false;
      if (tokenomicsEnabled) {
        next.ownedHeroes = prev.ownedHeroes.map((hero) =>
          deadHeroUids.includes(hero.uid) && !hero.respawnAt ? { ...hero, respawnAt: now + RESPAWN_TIME_MS } : hero
        );
        return next;
      }
      next.accountXp = Math.min(MAX_ACCOUNT_XP, prev.accountXp + accountXpGain);
      next.accountLevel = accountLevelFromXp(next.accountXp);
      next.ownedHeroes = prev.ownedHeroes.map((h) =>
        deadHeroUids.includes(h.uid) && !h.respawnAt ? { ...h, respawnAt: now + RESPAWN_TIME_MS } : h
      );
      if (clearedLanes > 0) {
        next.totalKills = prev.totalKills + clearedLanes;
        // Each hero earns XP only for the enemy of its own cleared lane.
        next.ownedHeroes = next.ownedHeroes.map((h) => {
          if (wonHeroUids.includes(h.uid)) {
            const { level, remaining } = advanceHeroXp(h.level, h.xp, xpPerEnemy);
            return { ...h, xp: remaining, level };
          }
          return h;
        });
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
      return next;
    });
    setBattleResult({
      win: allCleared,
      gold: tokenomicsEnabled ? 0 : gold,
      xp: tokenomicsEnabled ? 0 : accountXpGain,
      tokens,
      chest: tokenomicsEnabled ? false : chestDropped,
      overpowered,
    });
  }, [mergeServerResourceState]);

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
    if (!st.autoPot.enabled) return;
    const heroes = unitsRef.current.filter((u) => u.side === 'hero' && u.alive);
    for (const hero of heroes) {
      const hpFrac = hero.hp / hero.maxHp;
      if (hpFrac < st.autoPot.threshold) {
        const tiers: PotionTier[] = ['xxl', 'xl', 'lg', 'md', 'sm', 'xs'];
        let usedTier: PotionTier | null = null;
        for (const t of tiers) { if (st.potions[t] > 0) { usedTier = t; break; } }
        if (!usedTier && st.autoPot.autoBuy) {
          const autoTier = st.autoPot.autoSelectTier
            ? (['xs', 'sm', 'md', 'lg', 'xl', 'xxl'] as PotionTier[])
                .find((tier) => POTION_MAP[tier].hpRestore >= hero.maxHp * 0.5) ?? 'xxl'
            : st.autoPot.autoBuyTier;
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
          setFloaters((prev) => [...prev.slice(-20), { id: floaterId.current++, targetUid: hero.uid, value: def.hpRestore, crit: false, heal: true, born: performance.now() }]);
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
        // A respawning hero does not freeze the whole battlefield: it simply
        // does not fight (spawned as hp:0/alive:false), while living heroes and
        // monsters in their own lanes keep fighting.
        const resolution = combatResolution(live);
        if (resolution) {
          if (combatPresentationVisibleRef.current && pendingFloaters.length > 0) {
            setUnits(live);
            setFloaters((prev) => [...prev.slice(-24), ...pendingFloaters.map((floater) => ({ ...floater, born: now }))]);
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
              if (!combatResolution(finalUnits)) {
                while (serverWave.nextAutoPotion < serverWave.autoPotions.length
                  && serverWave.autoPotions[serverWave.nextAutoPotion].elapsed_ms <= serverWave.elapsedMs) {
                  const potion = serverWave.autoPotions[serverWave.nextAutoPotion++];
                  finalUnits = finalUnits.map((unit) => unit.uid === potion.hero_uid && unit.alive
                    ? { ...unit, hp: Math.min(unit.maxHp, unit.hp + potion.hp_restore) }
                    : unit);
                  newFloaters.push({ id: floaterId.current++, targetUid: potion.hero_uid, value: potion.hp_restore, crit: false, heal: true, born: now });
                  pendingPotionFx = { uid: potion.hero_uid, born: now };
                }
              }
            }
          }
          combatAccumulatorRef.current = remaining;
          events.forEach((event) => {
            if (event.kind === 'heal') {
              newFloaters.push({ id: floaterId.current++, targetUid: event.targetUid, value: event.amount, crit: false, heal: true, born: now });
            } else if (event.kind === 'miss') {
              newFloaters.push({ id: floaterId.current++, targetUid: event.targetUid, value: 0, crit: false, heal: false, miss: true, born: now });
            } else {
              newFloaters.push({ id: floaterId.current++, targetUid: event.targetUid, value: event.amount, crit: event.critical, heal: false, born: now });
            }
          });
          const rewardLocation = buildLocation(stateRef.current.currentLocation, stateRef.current.team.length, stateRef.current.bossBattleActive);
          const finalHeroes = finalUnits.filter((fighter) => fighter.side === 'hero');
          const finalEnemies = finalUnits.filter((fighter) => fighter.side === 'enemy');
          finalEnemies.forEach((unit, lane) => {
            const previous = live.find((candidate) => candidate.uid === unit.uid);
            if (unit.side === 'enemy' && previous?.alive && !unit.alive) {
              newFloaters.push({
                id: floaterId.current++, targetUid: finalHeroes[lane]?.uid ?? unit.uid, value: 0, crit: false, heal: false,
                rewardGold: rewardLocation.goldReward, rewardXp: rewardLocation.xpReward, born: now,
              });
            }
          });
          finalUnits.forEach((u) => {
            if (u.side === 'hero') heroHpRef.current.set(u.uid, u.hp);
          });
          unitsRef.current = finalUnits;
          if (newFloaters.length > 0) pendingFloaters = [...pendingFloaters, ...newFloaters].slice(-24);
          if (!combatPresentationVisibleRef.current) {
            pendingFloaters = [];
            pendingPotionFx = null;
          }
          const presentationInterval = COMBAT_PRESENTATION_INTERVAL_MS[stateRef.current.battleAnimationMode];
          if (combatPresentationVisibleRef.current && now - lastCombatRenderRef.current >= presentationInterval) {
            lastCombatRenderRef.current = now;
            setUnits(finalUnits);
            if (pendingFloaters.length > 0) setFloaters((prev) => [...prev.slice(-24), ...pendingFloaters.map((floater) => ({ ...floater, born: now }))]);
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
          const next = current.filter((floater) => now - floater.born < 850);
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
    if (!battleResult || pausedRef.current || !autoRef.current) return;
    const delay = battleResult.win ? 1100 : 1600;
    let ready = false;
    let spawned = false;
    const spawnIfVisible = () => {
      if (!ready || spawned || document.visibilityState !== 'visible') return;
      spawned = true;
      void spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
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
      setPresentationNow(now);
      const countdown: Record<string, number> = {};
      let finished = false;
      st.ownedHeroes.forEach((h) => {
        if (h.respawnAt && h.respawnAt > now) countdown[h.uid] = Math.ceil((h.respawnAt - now) / 1000);
        else if (h.respawnAt && h.respawnAt <= now) finished = true;
      });
      setRespawnCountdowns(countdown);
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
        const dayChanged = moscowDayKey(prev.lastChestReset) !== moscowDayKey(now);
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
        const dayChanged = moscowDayKey(prev.lastChestReset) !== moscowDayKey(now);
        const base = dayChanged ? { ...prev, chestsOpenedToday: 0, lastChestReset: now } : prev;
        if (base.team.length === 0) return { ...base, lastSeen: now, combatXpAt: now };
        if (elapsed < 12) return { ...base, lastSeen: now, combatXpAt: now };
        const activeSeconds = base.boost.active ? elapsed : Math.min(elapsed, Math.max(0, (base.activeUntil - (now - elapsed * 1000)) / 1000));
        const battles = Math.floor(activeSeconds / 12);
        if (activeSeconds <= 0 || battles <= 0) return { ...base, lastSeen: now, combatXpAt: now };
        const loc = buildLocation(base.currentLocation, base.team.length);
        const teamBonuses = base.team.reduce((acc, uid) => {
          const hero = base.ownedHeroes.find((candidate) => candidate.uid === uid);
          const stats = hero ? heroStats(hero, getEquippedItems(hero, base.inventory)) : null;
          return stats ? { gold: acc.gold + stats.goldBonus, xp: acc.xp + stats.xpBonus } : acc;
        }, { gold: 0, xp: 0 });
        const gold = tokenomicsEnabled ? 0 : Math.round(battles * loc.goldReward * (1 + teamBonuses.gold));
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
        const tokens = tokenomicsEnabled ? 0 : (canMineTokens(base.currentLocation, base.accountLevel, base.highestLocation) ? Math.floor((activeSeconds / 86400) * 20_000 * (1 - penalty)) : 0);
        const nextAccountXp = Math.min(MAX_ACCOUNT_XP, base.accountXp + accountXp);
        const dayKey = moscowDayKey();
        return {
          ...base,
          lastSeen: now,
          combatXpAt: now,
          gold: base.gold + gold,
          totalGoldEarned: base.totalGoldEarned + gold,
          hero: base.hero + tokens,
          totalTokensEarned: base.totalTokensEarned + tokens,
          tokensEarnedToday: (base.tokenDayKey === dayKey ? base.tokensEarnedToday : 0) + tokens,
          tokenDayKey: dayKey,
          accountXp: nextAccountXp,
          totalKills: base.totalKills + kills,
          session: { ...base.session, kills: base.session.kills + kills },
          accountLevel: accountLevelFromXp(nextAccountXp),
          ownedHeroes: base.ownedHeroes.map((hero) => {
            if (!base.team.includes(hero.uid)) return hero;
            const advanced = advanceHeroXp(hero.level, hero.xp, heroXp);
            return { ...hero, level: advanced.level, xp: advanced.remaining };
          }),
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
      const loc = buildLocation(st.currentLocation, st.team.length);
      const battles = Math.floor(activeElapsed / 12);
      const teamBonuses = st.team.reduce((acc, uid) => {
        const hero = st.ownedHeroes.find((h) => h.uid === uid);
        const stats = hero ? heroStats(hero, getEquippedItems(hero, st.inventory)) : null;
        return stats ? { gold: acc.gold + stats.goldBonus, xp: acc.xp + stats.xpBonus } : acc;
      }, { gold: 0, xp: 0 });
      const gold = tokenomicsEnabled ? 0 : Math.round(battles * loc.goldReward * (1 + teamBonuses.gold));
      const heroXp = Math.round(battles * loc.xpReward * (1 + teamBonuses.xp));
      const accountXp = heroXp * loc.enemies.length;
      const penalty = trainingTokenPenalty(st.trainingCamp.heroUids.filter(Boolean).length);
      const tokens = !tokenomicsEnabled && canMineTokens(st.currentLocation, st.accountLevel, st.highestLocation)
        ? Math.floor((activeElapsed / 86400) * 20_000 * (1 - penalty))
        : 0;
      const chestProgress = st.boost.chestProgressSeconds + (tokenomicsEnabled ? 0 : activeElapsed);
      const chests = tokenomicsEnabled ? 0 : Math.min(
        Math.floor(chestProgress / ACTIVE_CHEST_SECONDS),
        Math.max(0, MAX_CHESTS - st.chests.length),
        Math.max(0, MAX_CHESTS_PER_DAY - st.chestsOpenedToday),
      );
      const kills = battles * loc.enemies.length;
      const dayKey = moscowDayKey(now);
      setState((p) => ({
          ...p,
          lastSeen: tokenomicsEnabled ? p.lastSeen : now,
          combatXpAt: now,
          gold: p.gold + gold,
          totalGoldEarned: p.totalGoldEarned + gold,
          hero: p.hero + tokens,
          totalTokensEarned: p.totalTokensEarned + tokens,
          tokensEarnedToday: (p.tokenDayKey === dayKey ? p.tokensEarnedToday : 0) + tokens,
          tokenDayKey: dayKey,
          accountXp: Math.min(MAX_ACCOUNT_XP, p.accountXp + accountXp),
          accountLevel: accountLevelFromXp(Math.min(MAX_ACCOUNT_XP, p.accountXp + accountXp)),
          totalKills: p.totalKills + kills,
          session: { ...p.session, kills: p.session.kills + kills },
          ownedHeroes: p.ownedHeroes.map((h) => {
            if (!p.team.includes(h.uid)) return h;
            const leveled = advanceHeroXp(h.level, h.xp, heroXp);
            return { ...h, xp: leveled.remaining, level: Math.max(h.level, leveled.level) };
          }),
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
      setOfflineEarnings({ gold, seconds: activeElapsed, tokens: tokens || undefined, chests: chests || undefined, xp: accountXp || undefined });
    } else {
      setState((p) => ({ ...p, combatXpAt: now, lastSeen: tokenomicsEnabled ? p.lastSeen : now }));
    }
  }, [hydrationVersion, state.walletAddress]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const creditTestGold = useCallback(async (): Promise<boolean> => {
    const result = await playerSync<{ gold: number; total_gold_earned: number; revision: number }>('tester_credit_gold');
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

  const creditTestAccountXp = useCallback((amount: number) => {
    const safeAmount = Math.max(0, Math.floor(amount));
    if (safeAmount <= 0) return;
    setState((prev) => ({ ...prev, accountXp: Math.min(MAX_ACCOUNT_XP, prev.accountXp + safeAmount), accountLevel: accountLevelFromXp(Math.min(MAX_ACCOUNT_XP, prev.accountXp + safeAmount)) }));
  }, []);

  const creditTestFormationXp = useCallback((amount: number) => {
    const safeAmount = Math.max(0, Math.floor(amount));
    if (safeAmount <= 0) return;
    setState((prev) => ({
      ...prev,
      ownedHeroes: prev.ownedHeroes.map((hero) => {
        if (!prev.team.includes(hero.uid) || hero.level >= prev.accountLevel) return hero;
        const advanced = advanceHeroXp(hero.level, hero.xp, safeAmount);
        return advanced.level >= prev.accountLevel
          ? { ...hero, level: prev.accountLevel, xp: 0 }
          : { ...hero, level: advanced.level, xp: advanced.remaining };
      }),
    }));
  }, []);

  const creditServerTokens = useCallback((amount: number) => {
    const safeAmount = Math.max(0, Math.floor(amount));
    if (safeAmount <= 0) return;
    setState((prev) => {
      const dayKey = moscowDayKey();
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
      const dayKey = moscowDayKey();
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

  const settleServerSummon = useCallback(async (count: 1 | 10 | 100) => {
    if (!tokenomicsEnabled) return null;
    setSummonError('');
    const result = await playerSync<{
      heroes: OwnedHero[];
      token_balance: number;
      revision: number;
      pity_legendary: number;
      pity_mythic: number;
      pity_cosmic: number;
      pity_divine: number;
      pity_celestial: number;
      ascension_focus: Partial<Record<Rarity, string>>;
    }>('hero_summon', { count, idempotency_key: createIdempotencyKey() }, setSummonError);
    if (!result || !Array.isArray(result.heroes) || result.heroes.length !== count) {
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
    return { heroes, balance: Math.max(0, Math.floor(result.token_balance)) };
  }, [applyServerAscensionFocus]);

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

  const sellHero = useCallback((uid: string) => {
    setState((prev) => {
      const hero = prev.ownedHeroes.find((h) => h.uid === uid);
      const isLastAvatarCopy = hero && hero.heroId === prev.avatarHeroId && prev.ownedHeroes.filter((owned) => owned.heroId === hero.heroId).length <= 1;
      if (!hero || hero.locked || prev.team.includes(uid) || prev.trainingCamp.heroUids.includes(uid) || prev.ownedHeroes.length <= 1 || isLastAvatarCopy) return prev;
      const base = HERO_MAP[hero.heroId];
      if (!base) return prev;
      const refund = heroSellValue(base.rarity, hero.stars);
      return { ...prev, gold: prev.gold + refund, ownedHeroes: prev.ownedHeroes.filter((h) => h.uid !== uid), team: prev.team.filter((t) => t !== uid) };
    });
  }, []);

  const sellHeroes = useCallback((uids: string[]) => {
    setState((prev) => {
      const requested = new Set(uids);
      const remainingByType = new Map<string, number>();
      prev.ownedHeroes.forEach((hero) => remainingByType.set(hero.heroId, (remainingByType.get(hero.heroId) ?? 0) + 1));
      const eligible = prev.ownedHeroes.filter((hero) => {
        if (!requested.has(hero.uid) || hero.locked || prev.team.includes(hero.uid) || prev.trainingCamp.heroUids.includes(hero.uid)) return false;
        const remaining = remainingByType.get(hero.heroId) ?? 0;
        if (hero.heroId === prev.avatarHeroId && remaining <= 1) return false;
        remainingByType.set(hero.heroId, remaining - 1);
        return true;
      });
      const sellable = eligible.slice(0, Math.max(0, prev.ownedHeroes.length - 1));
      if (sellable.length === 0) return prev;
      const sold = new Set(sellable.map((hero) => hero.uid));
      const refund = sellable.reduce((total, hero) => {
        const base = HERO_MAP[hero.heroId];
        return total + (base ? heroSellValue(base.rarity, hero.stars) : 0);
      }, 0);
      return { ...prev, gold: prev.gold + refund, ownedHeroes: prev.ownedHeroes.filter((hero) => !sold.has(hero.uid)) };
    });
  }, []);

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

  const applyMarketState = useCallback((result: { inventory: OwnedItem[]; token_balance: number; revision: number }) => {
    if (!Array.isArray(result.inventory) || !Number.isFinite(result.token_balance)) return false;
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    setState((prev) => ({ ...prev, inventory: result.inventory, hero: Math.max(0, Math.floor(result.token_balance)) }));
    return true;
  }, []);

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
    const result = await playerSync<{ inventory: OwnedItem[]; token_balance: number; revision: number }>('market_cancel_listing', {
      listing_id: id,
      idempotency_key: createIdempotencyKey(),
    }, (message) => { error = message; });
    return result && applyMarketState(result) ? { ok: true } : { ok: false, error: error || 'market_settlement_failed' };
  }, [applyMarketState]);

  const buyMarketAsset = useCallback(async (id: string): Promise<MarketActionResult> => {
    let error = '';
    const result = await playerSync<{ inventory: OwnedItem[]; token_balance: number; revision: number }>('market_buy_listing', {
      listing_id: id,
      idempotency_key: createIdempotencyKey(),
    }, (message) => { error = message; });
    return result && applyMarketState(result) ? { ok: true } : { ok: false, error: error || 'market_settlement_failed' };
  }, [applyMarketState]);

  const setAvatarHero = useCallback((heroId: string) => {
    setState((prev) => prev.ownedHeroes.some((hero) => hero.heroId === heroId) ? { ...prev, avatarHeroId: heroId } : prev);
  }, []);

  const summon = useCallback(async (): Promise<OwnedHero | null> => {
    const cost = summonCostHero();
    if ((!tokenomicsEnabled && stateRef.current.hero < cost) || stateRef.current.ownedHeroes.length >= MAX_HEROES) return null;
    const settled = await settleServerSummon(1);
    if (!settled) return null;
    const owned = settled.heroes[0];
    setState((prev) => ({ ...prev, hero: settled.balance, ownedHeroes: [...prev.ownedHeroes, owned], summons: prev.summons + 1, dailyQuests: updateQuestProgress(prev.dailyQuests, 'summon-', 1), milestoneQuests: updateQuestProgress(updateQuestProgress(updateQuestProgress(prev.milestoneQuests, 'summon-', 1), 'hero-owned-', 1), 'token-spent-', cost) }));
    return owned;
  }, [settleServerSummon]);

  const summonTen = useCallback(async (): Promise<OwnedHero[]> => {
    const cost = summonCostHero() * 10;
    if ((!tokenomicsEnabled && stateRef.current.hero < cost) || stateRef.current.ownedHeroes.length + 10 > MAX_HEROES) return [];
    const settled = await settleServerSummon(10);
    if (!settled) return [];
    const results = settled.heroes;
    setState((prev) => ({ ...prev, hero: settled.balance, ownedHeroes: [...prev.ownedHeroes, ...results], summons: prev.summons + 10, dailyQuests: updateQuestProgress(prev.dailyQuests, 'summon-', 10), milestoneQuests: updateQuestProgress(updateQuestProgress(updateQuestProgress(prev.milestoneQuests, 'summon-', 10), 'hero-owned-', 10), 'token-spent-', cost) }));
    return results;
  }, [settleServerSummon]);

  const summonHundred = useCallback(async (): Promise<OwnedHero[]> => {
    const count = 100;
    const cost = summonCostHero() * count;
    if ((!tokenomicsEnabled && stateRef.current.hero < cost) || stateRef.current.ownedHeroes.length + count > MAX_HEROES) return [];
    const settled = await settleServerSummon(100);
    if (!settled) return [];
    const results = settled.heroes;
    setState((prev) => ({ ...prev, hero: settled.balance, ownedHeroes: [...prev.ownedHeroes, ...results], summons: prev.summons + count, dailyQuests: updateQuestProgress(prev.dailyQuests, 'summon-', count), milestoneQuests: updateQuestProgress(updateQuestProgress(updateQuestProgress(prev.milestoneQuests, 'summon-', count), 'hero-owned-', count), 'token-spent-', cost) }));
    return results;
  }, [settleServerSummon]);

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
    if (!hero || st.trainingCamp.heroUids.includes(uid) || (hero.respawnAt && hero.respawnAt > Date.now())) return 'blocked';
    let newTeam: string[];
    if (st.team.includes(uid)) {
      if (st.team.length <= 1) return 'blocked';
      const equippedCount = Object.values(hero.equipped).filter(Boolean).length;
      if (bagItemCount(st) + equippedCount > MAX_INVENTORY) return 'inventory-full';
      newTeam = st.team.filter((t) => t !== uid);
      const nextState = { ...st, team: newTeam, ownedHeroes: st.ownedHeroes.map((owned) => owned.uid === uid ? { ...owned, equipped: {} } : owned) };
      const before = JSON.stringify(serverEquipmentAssignments(st));
      const after = JSON.stringify(serverEquipmentAssignments(nextState));
      if (before !== after && !(await settleServerEquipment(nextState))) return 'blocked';
      stateRef.current = nextState;
      setState(nextState);
      spawnBattle(st.currentLocation, newTeam);
      return 'removed';
    }
    if (st.team.length >= MAX_TEAM) return 'blocked';
    newTeam = [...st.team, uid];
    stateRef.current = { ...st, team: newTeam };
    setState((prev) => ({ ...prev, team: newTeam }));
    spawnBattle(st.currentLocation, newTeam);
    return 'added';
  }, [settleServerEquipment, spawnBattle]);

  const setLocation = useCallback((id: number) => {
    const st = stateRef.current;
    if (id < 1 || id > st.highestLocation || id === st.currentLocation) return;
    if (st.accountLevel < locationUnlockLevel(id)) return;
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
    if (current.inventory.filter((item) => !equippedElsewhere.has(item.uid)).length > MAX_INVENTORY) return false;
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
    if (!item || item.enchantLevel >= 10) { setEnchantResult({ success: false }); return; }
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
      const newPower = itemPower(item.stats, newEnchant);
      setState((prev) => ({
        ...prev,
        gold: prev.gold - baseCost.gold,
        hero: balance,
        inventory: prev.inventory.map((i) => i.uid === itemUid ? { ...i, enchantLevel: newEnchant, enchantStatsVersion: 2, power: newPower } : i),
      }));
      setEnchantResult({ success: true, item: { ...item, enchantLevel: newEnchant, enchantStatsVersion: 2, power: newPower } });
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

  const sellItem = useCallback(async (itemUid: string) => {
    const current = stateRef.current.inventory.find((item) => item.uid === itemUid);
    if (tokenomicsEnabled && current?.serverOwned) {
      if (current.locked) return;
      const result = await playerSync<{ item_ids: string[]; gold_refund: number; revision: number }>('item_mutate', {
        operation: 'sell', item_uids: [itemUid], idempotency_key: createIdempotencyKey(),
      });
      if (!result || !Array.isArray(result.item_ids) || result.item_ids.length !== 1 || result.item_ids[0] !== itemUid
        || !Number.isSafeInteger(result.gold_refund) || result.gold_refund < 0) return;
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
      return;
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
  }, [spawnBattle]);

  const toggleItemLock = useCallback(async (itemUid: string) => {
    const current = stateRef.current.inventory.find((item) => item.uid === itemUid);
    if (tokenomicsEnabled && current?.serverOwned) {
      const locked = !current.locked;
      const result = await playerSync<{ item_ids: string[]; locked: boolean; revision: number }>('item_mutate', {
        operation: 'lock', item_uids: [itemUid], locked, idempotency_key: createIdempotencyKey(),
      });
      if (!result || result.locked !== locked || result.item_ids?.[0] !== itemUid) return;
      if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
      setState((prev) => ({ ...prev, inventory: prev.inventory.map((item) => item.uid === itemUid ? { ...item, locked } : item) }));
      return;
    }
    setState((prev) => ({ ...prev, inventory: prev.inventory.map((i) => i.uid === itemUid ? { ...i, locked: !i.locked } : i) }));
  }, []);

  // FIXED: sellAllUnlocked only sells UNEQUIPPED, UNLOCKED items (not potions, not equipped)
  const sellAllUnlocked = useCallback(async () => {
    const current = stateRef.current;
    const equipped = new Set(current.ownedHeroes.flatMap((hero) => Object.values(hero.equipped).filter((uid): uid is string => Boolean(uid))));
    const sellable = current.inventory.filter((item) => !item.locked && !equipped.has(item.uid));
    const serverItemUids = tokenomicsEnabled ? sellable.filter((item) => item.serverOwned).map((item) => item.uid) : [];
    const clientItems = sellable.filter((item) => !serverItemUids.includes(item.uid));
    let serverRefund = 0;

    if (serverItemUids.length > 0) {
      const result = await playerSync<{ item_ids: string[]; gold_refund: number; revision: number }>('item_mutate', {
        operation: 'sell', item_uids: serverItemUids, idempotency_key: createIdempotencyKey(),
      });
      if (!result || !Array.isArray(result.item_ids) || result.item_ids.length !== serverItemUids.length
        || !Number.isSafeInteger(result.gold_refund) || result.gold_refund < 0) return;
      const settled = new Set(result.item_ids);
      if (serverItemUids.some((uid) => !settled.has(uid))) return;
      if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
      serverRefund = result.gold_refund;
    }

    const soldUids = new Set([...serverItemUids, ...clientItems.map((item) => item.uid)]);
    if (soldUids.size === 0) return;
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
  }, [spawnBattle]);

  // ── Potions ──────────────────────────────────────────────────────────────

  const setAutoPot = useCallback((cfg: Partial<GameState['autoPot']>) => {
    setState((prev) => ({ ...prev, autoPot: { ...prev.autoPot, ...cfg } }));
  }, []);

  const setBattleAnimationMode = useCallback((mode: GameState['battleAnimationMode']) => {
    setState((prev) => ({ ...prev, battleAnimationMode: mode }));
  }, []);

  const setTrainingHero = useCallback((slot: number, heroUid: string | null): boolean => {
    const st = stateRef.current;
    if (slot < 0 || slot >= st.trainingCamp.unlockedSlots) return false;
    const hero = heroUid ? st.ownedHeroes.find((owned) => owned.uid === heroUid) : null;
    if (heroUid && (!hero || hero.level >= st.accountLevel || st.team.includes(heroUid) || st.trainingCamp.heroUids.includes(heroUid))) return false;
    const heroUids = st.trainingCamp.heroUids.map((uid, index) => index === slot ? heroUid : uid);
    stateRef.current = { ...st, trainingCamp: { ...st.trainingCamp, heroUids } };
    setState((prev) => ({
      ...prev,
      trainingCamp: { ...prev.trainingCamp, heroUids },
    }));
    return true;
  }, []);

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
    const freeSlots = MAX_INVENTORY - bagItemCount(st);
    if (freeSlots <= 0 || st.chests.length === 0) return;
    chestOpeningRef.current = true;
    setChestOpening(true);
    try {
      const openCount = Math.min(freeSlots, st.chests.length);
      let results: OwnedItem[] = [];
      let revision: number | null = null;
      if (tokenomicsEnabled) {
        const idempotencyKey = createIdempotencyKey();
        let response: { items: OwnedItem[]; chest_count: number; revision: number } | null = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          let error = '';
          response = await playerSync<{ items: OwnedItem[]; chest_count: number; revision: number }>('chest_open', {
            count: openCount,
            idempotency_key: idempotencyKey,
          }, (message) => { error = message; });
          if (response || error !== 'chest_count_exceeded' || attempt === 2) break;
          await new Promise((resolve) => window.setTimeout(resolve, 900));
        }
        if (!response || response.chest_count !== openCount || !Array.isArray(response.items) || response.items.length !== openCount) return;
        results = response.items.filter((item) => item && typeof item.uid === 'string' && item.serverOwned === true
          && Boolean(ITEM_MAP[item.itemId]) && Array.isArray(item.stats));
        if (results.length !== openCount) return;
        revision = Number.isSafeInteger(response.revision) ? response.revision : null;
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
      flushSync(() => setChestOpenResult(results));
      const openedTutorial = st.chests.slice(0, openCount).some((chest) => chest.tutorial);
      setState((prev) => ({
        ...prev,
        chests: prev.chests.slice(openCount),
        inventory: [...prev.inventory, ...results.map((item) => shouldAutoLockItem(item) ? { ...item, locked: true } : item)].sort((a, b) => {
          const rarityDelta = RARITY_INDEX[ITEM_MAP[b.itemId]?.rarity ?? 'common'] - RARITY_INDEX[ITEM_MAP[a.itemId]?.rarity ?? 'common'];
          return rarityDelta || b.power - a.power;
        }),
        session: { ...prev.session, chestsOpened: prev.session.chestsOpened + openCount },
        dailyQuests: updateQuestProgress(prev.dailyQuests, 'chest-', openCount),
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'chest-', openCount),
        tutorial: openedTutorial ? { ...prev.tutorial, chestCompleted: true } : prev.tutorial,
      }));
    } finally {
      chestOpeningRef.current = false;
      setChestOpening(false);
    }
  }, []);

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
      if (!slot || slot.sold || stateRef.current.gold < slot.price || bagItemCount(stateRef.current) >= MAX_INVENTORY) return false;
      storeBusyRef.current = true;
      setStoreBusy(true);
      try {
        const result = await playerSync<{
          inventory: OwnedItem[];
          gold: number;
          store: GameState['rotatingShop'];
          refresh_at: number;
          revision: number;
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
        return true;
      } finally {
        storeBusyRef.current = false;
        setStoreBusy(false);
      }
    }
    setState((prev) => {
      const slot = prev.rotatingShop[index];
      if (!slot || slot.sold || prev.gold < slot.price || bagItemCount(prev) >= MAX_INVENTORY) return prev;
      const proper = rollItem(slot.itemId, 1);
      return { ...prev, gold: prev.gold - slot.price, inventory: [...prev.inventory, proper], rotatingShop: prev.rotatingShop.map((s, i) => i === index ? { ...s, sold: true } : s) };
    });
    return true;
  }, [applyStoreState, refreshStore]);

  // ── Quests ───────────────────────────────────────────────────────────────

  const claimQuest = useCallback((questId: string) => {
    setState((prev) => {
      const q = prev.dailyQuests.find((q) => q.id === questId) ?? prev.milestoneQuests.find((q) => q.id === questId);
      if (!q || q.claimed || q.progress < q.target) return prev;
      const overflow = Math.max(0, q.progress - q.target);
      const nextProgress = q.chain === 'summon' ? prev.summons : overflow;
      const nextMilestone = q.kind === 'milestone' && q.chain ? milestoneQuest(q.chain, (q.tier ?? 0) + 1, nextProgress) : null;
      return {
        ...prev,
        gold: prev.gold + q.reward.gold,
        hero: prev.hero + q.reward.hero,
        summonScrolls: prev.summonScrolls + (q.reward.summonScrolls ?? 0),
        totalTokensEarned: prev.totalTokensEarned + q.reward.hero,
        tokensEarnedToday: prev.tokensEarnedToday + q.reward.hero,
        dailyQuests: prev.dailyQuests.map((q) => q.id === questId ? { ...q, claimed: true } : q),
        milestoneQuests: q.kind === 'milestone'
          ? [...prev.milestoneQuests.filter((quest) => quest.id !== questId), ...(nextMilestone ? [nextMilestone] : [])]
          : updateQuestProgress(prev.milestoneQuests, 'token-earned-', q.reward.hero),
      };
    });
  }, []);

  const claimTutorialQuest = useCallback(async (questId: string): Promise<boolean> => {
    if (!tokenomicsEnabled || !Number.isSafeInteger(serverRevisionHint)) return false;
    const result = await playerSync<{
      gold: number; revision: number; tutorial: GameState['tutorial'];
      resources: { balances?: Record<string, string> };
    }>('tutorial_quest_claim', {
      quest_id: questId, expected_revision: serverRevisionHint, idempotency_key: createIdempotencyKey(),
    });
    if (!result || !Number.isSafeInteger(result.revision) || !result.tutorial) return false;
    const balances = result.resources?.balances ?? {};
    const read = (key: string, fallback: number) => /^\d+$/.test(balances[key] ?? '') ? Number(balances[key]) : fallback;
    setServerRevisionHint(result.revision);
    setState((prev) => ({
      ...prev, gold: Math.max(0, Math.floor(result.gold)), tutorial: result.tutorial,
      bossKeys: read('boss_key', prev.bossKeys), summonScrolls: read('summon_scroll', prev.summonScrolls),
      potions: { ...prev.potions, xs: read('potion_xs', prev.potions.xs) },
    }));
    return true;
  }, [serverRevisionHint]);

  const openTutorialChests = useCallback(async (requestedCount: 1 | 10): Promise<boolean> => {
    if (!tokenomicsEnabled || chestOpeningRef.current) return false;
    const current = stateRef.current;
    const count = Math.min(requestedCount, current.tutorial.chestBalance, MAX_INVENTORY - bagItemCount(current));
    if (count !== 1 && count !== 10) return false;
    chestOpeningRef.current = true; setChestOpening(true);
    try {
      const result = await playerSync<{ items: OwnedItem[]; chest_count: number; revision: number; tutorial: GameState['tutorial'] }>('tutorial_chest_open', {
        count, idempotency_key: createIdempotencyKey(),
      });
      if (!result || result.chest_count !== count || !Array.isArray(result.items) || result.items.length !== count || !result.tutorial) return false;
      const items = result.items.filter((item) => item?.serverOwned === true && typeof item.uid === 'string' && Boolean(ITEM_MAP[item.itemId]));
      if (items.length !== count) return false;
      if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
      flushSync(() => setChestOpenResult(items));
      setState((prev) => ({
        ...prev, tutorial: result.tutorial,
        inventory: [...prev.inventory, ...items.map((item) => shouldAutoLockItem(item) ? { ...item, locked: true } : item)]
          .sort((a, b) => RARITY_INDEX[ITEM_MAP[b.itemId]?.rarity ?? 'common'] - RARITY_INDEX[ITEM_MAP[a.itemId]?.rarity ?? 'common'] || b.power - a.power),
        session: { ...prev.session, chestsOpened: prev.session.chestsOpened + count },
        dailyQuests: updateQuestProgress(prev.dailyQuests, 'chest-', count),
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'chest-', count),
      }));
      return true;
    } finally { chestOpeningRef.current = false; setChestOpening(false); }
  }, []);

  const setUserProfile = useCallback((username: string, walletAddress: string, starterHeroId?: string) => {
    setState((prev) => {
      if (!starterHeroId) return { ...prev, username, walletAddress, activeUntil: Date.now() + ACTIVE_SESSION_MS, lastSeen: Date.now() };
      const registeredState = makeRegisteredStarterState(username, walletAddress, starterHeroId);
      // The new page instance imports this exact profile into player_saves,
      // then removes the temporary browser copy after server confirmation.
      saveLegacyState(registeredState);
      return registeredState;
    });
  }, []);

  const resetAccount = useCallback(() => {
    const initial = makeInitialState();
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
        return b.power - a.power;
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
          .sort((a, b) => b.power - a.power || b.level - a.level)[0];
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
    if (before !== after && !(await settleServerEquipment(nextState))) return false;
    stateRef.current = nextState;
    setState(nextState);
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
    return true;
  }, [settleServerEquipment, spawnBattle]);

  const collectOffline = useCallback(() => setOfflineEarnings(null), []);
  const retry = useCallback(() => spawnBattle(stateRef.current.currentLocation, stateRef.current.team), [spawnBattle]);

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

  return {
    state, hydrationVersion, summonPity, ascensionFocus, summonError, serverRevisionHint, battleResult, autoProgress, paused, chestOpening, storeBusy, itemUpgradeBusy,
    offlineEarnings, respawnCountdowns, presentationNow, chestOpenResult, enchantResult,
    getCombatPresentationSnapshot, subscribeCombatPresentation,
    starUpHero, promoteAllHeroes, sellHero, sellHeroes, toggleHeroLock, markHeroSeen,
    summon, summonTen, summonHundred, summonBoss, syncBossKeys, toggleTeamMember, setLocation,
    setAutoProgress, setPaused, collectOffline, creditServerTokens, applyServerTokenClaim, setServerTokenBalance, applyServerBoostStatus, applyServerPityStatus, applyServerAscensionFocus, setHeroAscensionFocus, retry,
    equipItem, unequipItem, unequipAll, equipmentError: () => equipmentErrorRef.current, sellItem, toggleItemLock, sellAllUnlocked,
    enchantItem, rerollItem, dismissEnchantResult,
    setAutoPot, setBattleAnimationMode, setCombatPresentationVisible,
    setTrainingHero, unlockTrainingSlot, buyTrainingBoost,
    openChests, openTutorialChests, closeChestResult, refreshStore, buyRotatingItem, claimQuest, claimTutorialQuest,
    claimReferralReward, setUserProfile, resetAccount, hydrateServerState, mergeServerResourceState, completeWelcomeTutorial, setAvatarHero, loadMarket, buyMarketAsset, createMarketListing, cancelMarketListing, activateBoost, deactivateBoost, toggleBoostCondition, sortInventory, autoEquipBest, creditTestGold, creditTestAccountXp, creditTestFormationXp,
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
      const loc = buildLocation(state.currentLocation, state.team.length);
      const heroes = state.team.map(uid => state.ownedHeroes.find(h => h.uid === uid)).filter((h): h is OwnedHero => !!h);
      const power = teamPower(heroes, state.inventory);
      if (isOverpowered(loc, power) || !canMineTokens(state.currentLocation, state.accountLevel, state.highestLocation)) return 0;
      // ~1 battle every 8 seconds = 450/hour
      return loc.tokenReward * 450;
    },
  };
}

export type GameApi = ReturnType<typeof useGame>;

void RARITY_INDEX;
