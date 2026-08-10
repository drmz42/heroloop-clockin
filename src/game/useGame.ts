import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { GameState, OwnedHero, CombatUnit, FloatingNumber, ItemSlot, OwnedItem, PotionTier, DailyQuest, TrainingBoostKey } from '@/game/types';
import {
  loadState, saveLegacyState, normalizeState, makeInitialState, makeRegisteredStarterState, genUid, starUpCost, summonCostHero,
  MAX_TEAM, MAX_HEROES, MAX_HERO_STARS, MAX_INVENTORY, MAX_CHESTS, RESPAWN_TIME_MS, ROTATING_REFRESH_MS,
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
  enchantSuccessChance, enchantGoldCost, enchantCharmCost, itemPower,
  MAX_CHESTS_PER_DAY, rerollCost,
  canClassEquipItem,
  isMarketEligibleEquipment,
  meetsItemLevelRequirement,
} from '@/game/items';
import type { Rarity } from '@/game/types';
import { recordBattleTelemetry } from '@/game/balance';
import { playerSync, tokenomicsEnabled } from '@/game/backend';

const COMBAT_SPEED = 1;
const COMBAT_RENDER_INTERVAL_MS = 50;
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

export interface MarketBuyInput { kind: 'item' | 'hero'; sourceId: string; name: string; level: number; price: number }

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
  const [units, setUnits] = useState<CombatUnit[]>([]);
  const [floaters, setFloaters] = useState<FloatingNumber[]>([]);
  const [battleResult, setBattleResult] = useState<BattleResult | null>(null);
  const [autoProgress, setAutoProgress] = useState(true);
  const [paused, setPaused] = useState(false);
  const [respawnCountdowns, setRespawnCountdowns] = useState<Record<string, number>>({});
  const [potionFx, setPotionFx] = useState<{ uid: string; born: number } | null>(null);
  const [chestOpenResult, setChestOpenResult] = useState<OwnedItem[] | null>(null);
  const [enchantResult, setEnchantResult] = useState<{ success: boolean; item?: OwnedItem } | null>(null);
  const [hydrationVersion, setHydrationVersion] = useState(0);
  const [summonPity, setSummonPity] = useState({ legendary: 0, mythic: 0, cosmic: 0, divine: 0 });
  const [summonError, setSummonError] = useState('');
  const [serverRevisionHint, setServerRevisionHint] = useState<number | null>(null);

  const stateRef = useRef(state); stateRef.current = state;
  const unitsRef = useRef<CombatUnit[]>([]);
  const autoRef = useRef(autoProgress); autoRef.current = autoProgress;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const floaterId = useRef(0);
  const resolvingRef = useRef(false);
  const heroHpRef = useRef<Map<string, number>>(new Map());
  const battleStartedAtRef = useRef(Date.now());
  const lastCombatRenderRef = useRef(0);
  const offlineSettlementKeyRef = useRef('');

  const hydrateServerState = useCallback((remoteState: unknown) => {
    setState(normalizeState(remoteState as Partial<GameState>));
    setHydrationVersion((version) => version + 1);
    setUnits([]);
    unitsRef.current = [];
    heroHpRef.current.clear();
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
          return local ? { ...hero, equipped: local.equipped, locked: local.locked, isNew: local.isNew, respawnAt: local.respawnAt } : hero;
        }),
        totalGoldEarned: remote.totalGoldEarned,
        totalKills: remote.totalKills,
        totalBossKills: remote.totalBossKills,
        highestLocation: remote.highestLocation,
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
    const timer = window.setInterval(() => {
      setState((prev) => advanceTrainingCamp(prev, Date.now()));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const potionsEmpty = Object.values(state.potions).every((count) => count <= 0);
    if (!potionsEmpty || !state.autoPot.autoBuy || state.tutorial.autoPotCompleted) return;
    setState((prev) => {
      if (prev.tutorial.autoPotCompleted) return prev;
      const tutorialChest = { id: `tutorial-${genUid()}`, stage: Math.max(1, prev.currentLocation), tutorial: true };
      return {
        ...prev,
        chests: prev.tutorial.chestGranted ? prev.chests : [tutorialChest, ...prev.chests].slice(0, MAX_CHESTS),
        tutorial: { ...prev.tutorial, autoPotCompleted: true, chestGranted: true },
      };
    });
  }, [state.potions, state.autoPot.autoBuy, state.tutorial.autoPotCompleted]);

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

  const spawnBattle = useCallback((locationId: number, teamUids: string[], forceBoss?: boolean) => {
    const st = stateRef.current;
    const now = Date.now();
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
    setUnits(nextUnits);
    setBattleResult(null);
    setFloaters([]);
    resolvingRef.current = false;
  }, []);

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
      next.accountXp = prev.accountXp + accountXpGain;
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
  }, []);

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
  }, []);

  // Combat loop
  useEffect(() => {
    let raf = 0; let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) * COMBAT_SPEED, 100);
      last = now;
      const live = unitsRef.current;
      if (stateRef.current.walletAddress && !pausedRef.current && live.length > 0 && !resolvingRef.current) {
        // A respawning hero does not freeze the whole battlefield: it simply
        // does not fight (spawned as hp:0/alive:false), while living heroes and
        // monsters in their own lanes keep fighting.
        const heroes = live.filter((u) => u.side === 'hero' && u.alive);
        const enemies = live.filter((u) => u.side === 'enemy' && u.alive);
        const formations = {
          heroes: live.filter((u) => u.side === 'hero'),
          enemies: live.filter((u) => u.side === 'enemy'),
        };
        const activeLaneExists = formations.heroes.some((hero, lane) => hero.alive && formations.enemies[lane]?.alive);
        if (heroes.length === 0 || enemies.length === 0 || !activeLaneExists) {
          resolvingRef.current = true;
          // Per-line rewards: each hero is rewarded only for the enemy in its own lane.
          // Other heroes keep fighting after one dies; a dead hero grants nothing for its lane.
          const deadHeroes = formations.heroes.filter((h) => !h.alive).map((h) => h.uid);
          const wonHeroUids = formations.enemies
            .map((e, lane) => (e.alive ? null : formations.heroes[lane]?.uid))
            .filter((uid): uid is string => Boolean(uid));
          const clearedLanes = wonHeroUids.length;
          const allCleared = formations.enemies.length > 0 && formations.enemies.every((e) => !e.alive);
          awardBattle(stateRef.current.currentLocation, clearedLanes, wonHeroUids, deadHeroes, allCleared);
        } else {
          const newFloaters: FloatingNumber[] = [];
          const hpDelta = new Map<string, number>();
          const updated = live.map((u) => {
            if (!u.alive) return u;
            if (u.heroClass === 'druid' && u.regenTimer !== undefined) {
              const newRegen = u.regenTimer + dt;
              if (newRegen >= 3000) {
                const regenAmount = Math.min(Math.round(u.maxHp * 0.015), u.maxHp - u.hp);
                if (regenAmount > 0) newFloaters.push({ id: floaterId.current++, targetUid: u.uid, value: regenAmount, crit: false, heal: true, born: now });
                return { ...u, hp: u.hp + regenAmount, regenTimer: 0 };
              }
              u = { ...u, regenTimer: newRegen };
            }
            const timer = u.attackTimer + dt;
            if (timer < u.attackInterval) return { ...u, attackTimer: timer };
            const formation = live.filter((fighter) => fighter.side === u.side);
            const opposingFormation = live.filter((fighter) => fighter.side !== u.side);
            const lane = Math.max(0, formation.findIndex((fighter) => fighter.uid === u.uid));
            const opposite = opposingFormation[lane];
            if (!opposite?.alive) return { ...u, attackTimer: u.attackInterval };
            const target = opposite;
            if ((target.dodge ?? 0) > 0 && Math.random() < target.dodge!) {
              newFloaters.push({ id: floaterId.current++, targetUid: target.uid, value: 0, crit: false, heal: false, miss: true, born: now });
              return { ...u, attackTimer: 0 };
            }
            const isCrit = Math.random() < u.critChance;
            const rawDmg = Math.max(u.atk - target.def * 0.5, u.atk * 0.12);
            const dmg = Math.round(rawDmg * (isCrit ? u.critDamage : 1) * (0.9 + Math.random() * 0.2));
            hpDelta.set(target.uid, (hpDelta.get(target.uid) || 0) + dmg);
            newFloaters.push({ id: floaterId.current++, targetUid: target.uid, value: dmg, crit: isCrit, heal: false, born: now });
            return { ...u, attackTimer: 0 };
          });
          const finalUnits = updated.map((u) => {
            const dmg = hpDelta.get(u.uid);
            if (dmg !== undefined) { const newHp = Math.max(0, u.hp - dmg); return { ...u, hp: newHp, alive: newHp > 0 }; }
            return u;
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
          if (now - lastCombatRenderRef.current >= COMBAT_RENDER_INTERVAL_MS) {
            lastCombatRenderRef.current = now;
            setUnits(finalUnits);
          }
          if (newFloaters.length > 0) setFloaters((prev) => [...prev.slice(-24), ...newFloaters]);
          tryAutoPotion();
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [awardBattle, tryAutoPotion]);

  useEffect(() => {
    const t = setInterval(() => { const now = performance.now(); setFloaters((prev) => prev.filter((f) => now - f.born < 850)); }, 300);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!battleResult || pausedRef.current || !autoRef.current) return;
    const delay = battleResult.win ? 1100 : 1600;
    const t = setTimeout(() => spawnBattle(stateRef.current.currentLocation, stateRef.current.team), delay);
    return () => clearTimeout(t);
  }, [battleResult, spawnBattle]);

  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const st = stateRef.current;
      const countdown: Record<string, number> = {};
      let finished = false;
      st.ownedHeroes.forEach((h) => {
        if (h.respawnAt && h.respawnAt > now) countdown[h.uid] = Math.ceil((h.respawnAt - now) / 1000);
        else if (h.respawnAt && h.respawnAt <= now) finished = true;
      });
      setRespawnCountdowns(countdown);
      if (finished) setState((prev) => ({ ...prev, ownedHeroes: prev.ownedHeroes.map((h) => h.respawnAt && h.respawnAt <= now ? { ...h, respawnAt: undefined } : h) }));
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
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
        const nextAccountXp = base.accountXp + accountXp;
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
          accountXp: p.accountXp + accountXp,
          accountLevel: accountLevelFromXp(p.accountXp + accountXp),
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

  const creditTestGold = useCallback((amount: number) => {
    const safeAmount = Math.max(0, Math.floor(amount));
    if (safeAmount <= 0) return;
    setState((prev) => ({ ...prev, gold: prev.gold + safeAmount, totalGoldEarned: prev.totalGoldEarned + safeAmount }));
  }, []);

  const creditTestAccountXp = useCallback((amount: number) => {
    const safeAmount = Math.max(0, Math.floor(amount));
    if (safeAmount <= 0) return;
    setState((prev) => ({ ...prev, accountXp: prev.accountXp + safeAmount, accountLevel: accountLevelFromXp(prev.accountXp + safeAmount) }));
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

  const applyServerPityStatus = useCallback((pity: { legendary: number; mythic: number; cosmic: number; divine: number }) => {
    setSummonPity({
      legendary: Math.max(0, Math.floor(pity.legendary)),
      mythic: Math.max(0, Math.floor(pity.mythic)),
      cosmic: Math.max(0, Math.floor(pity.cosmic)),
      divine: Math.max(0, Math.floor(pity.divine)),
    });
  }, []);

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
    });
    if (Number.isSafeInteger(result.revision)) setServerRevisionHint(result.revision);
    return { heroes, balance: Math.max(0, Math.floor(result.token_balance)) };
  }, []);

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
    const cost = starUpCost(hero.stars);
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
      let balance = st.hero;
      let spent = 0;
      const promoted = new Map<string, PromotionSummary>();
      const heroIds = [...new Set(heroes.map((hero) => hero.heroId))];
      for (const heroId of heroIds) {
        while (true) {
          const ranked = heroes.filter((hero) => hero.heroId === heroId).map((hero, index) => ({
            hero, index, power: teamPower([hero], st.inventory),
          })).sort((a, b) => b.power - a.power || b.hero.level - a.hero.level || b.hero.stars - a.hero.stars || a.index - b.index);
          const target = ranked.find(({ hero }) => hero.stars < MAX_HERO_STARS)?.hero;
          if (!target) break;
          const cost = starUpCost(target.stars);
          const duplicateCount = ranked.filter(({ hero }) => hero.uid !== target.uid && hero.stars === 0 && !hero.locked && !st.team.includes(hero.uid) && !st.trainingCamp.heroUids.includes(hero.uid)).length;
          if (duplicateCount < cost.dupes) break;
          const settled = await settleServerAscension(target.uid, true);
          if (!settled) break;
          heroes = settled.heroes;
          balance = settled.balance;
          spent += settled.spent;
          const current = promoted.get(target.uid);
          promoted.set(target.uid, { heroName: HERO_MAP[target.heroId]?.name ?? 'Hero', starsAdded: (current?.starsAdded ?? 0) + settled.starsAdded });
        }
      }
      const summary = [...promoted.values()];
      if (summary.length === 0) return [];
      setState((prev) => ({
        ...prev,
        hero: balance,
        ownedHeroes: heroes,
        milestoneQuests: updateQuestProgress(prev.milestoneQuests, 'token-spent-', spent),
      }));
      return summary;
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
        const cost = starUpCost(target.stars);
        const duplicates = ranked.filter(({ hero }) => hero.uid !== target.uid && hero.stars === 0 && !hero.locked && !st.team.includes(hero.uid) && !st.trainingCamp.heroUids.includes(hero.uid))
          .sort((a, b) => a.power - b.power || a.hero.level - b.hero.level || a.hero.stars - b.hero.stars || b.index - a.index);
        if (duplicates.length < cost.dupes || available < cost.hero) break;
        const consumed = new Set(duplicates.slice(0, cost.dupes).map(({ hero }) => hero.uid));
        heroes = heroes.filter((hero) => !consumed.has(hero.uid)).map((hero) => hero.uid === target.uid ? { ...hero, stars: hero.stars + 1 } : hero);
        available -= cost.hero;
        spent += cost.hero;
        const base = HERO_MAP[target.heroId];
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
  }, [settleHeroSpend, settleServerAscension]);

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

  const buyMarketAsset = useCallback(async (input: MarketBuyInput): Promise<boolean> => {
    const st = stateRef.current;
    if (input.price <= 0 || (!tokenomicsEnabled && st.hero < input.price)) return false;
    if (input.kind === 'item' && (st.inventory.length >= MAX_INVENTORY || !ITEM_MAP[input.sourceId])) return false;
    if (input.kind === 'hero' && (st.ownedHeroes.length >= MAX_HEROES || !HERO_MAP[input.sourceId])) return false;
    const balance = await settleHeroSpend(input.price, `market-${input.kind}`);
    if (balance === null) return false;
    setState((prev) => {
      const record = { id: genUid(), kind: input.kind, sourceId: input.sourceId, name: input.name, price: input.price, createdAt: Date.now(), action: 'bought' as const };
      if (input.kind === 'item') return { ...prev, hero: balance, inventory: [...prev.inventory, rollItem(input.sourceId, input.level)], marketHistory: [record, ...prev.marketHistory].slice(0, 100) };
      const owned: OwnedHero = { uid: genUid(), heroId: input.sourceId, level: input.level, stars: 0, equipped: {}, xp: 0, isNew: true };
      return { ...prev, hero: balance, ownedHeroes: [...prev.ownedHeroes, owned], marketHistory: [record, ...prev.marketHistory].slice(0, 100) };
    });
    return true;
  }, [settleHeroSpend]);

  const createMarketListing = useCallback((kind: 'item' | 'hero', uid: string, price: number): boolean => {
    const st = stateRef.current;
    const safePrice = Math.max(1, Math.floor(price));
    if (kind === 'item') {
      const item = st.inventory.find((owned) => owned.uid === uid);
      const equipped = st.ownedHeroes.some((hero) => Object.values(hero.equipped).includes(uid));
      const itemBase = item ? ITEM_MAP[item.itemId] : null;
      if (!item || !itemBase || !isMarketEligibleEquipment(itemBase) || item.locked || equipped) return false;
      setState((prev) => ({ ...prev, inventory: prev.inventory.filter((owned) => owned.uid !== uid), marketListings: [{ id: genUid(), kind, price: safePrice, createdAt: Date.now(), item }, ...prev.marketListings] }));
      return true;
    }
    const hero = st.ownedHeroes.find((owned) => owned.uid === uid);
    const lastAvatarCopy = hero && hero.heroId === st.avatarHeroId && st.ownedHeroes.filter((owned) => owned.heroId === hero.heroId).length <= 1;
    if (!hero || hero.locked || st.team.includes(uid) || st.trainingCamp.heroUids.includes(uid) || st.ownedHeroes.length <= 1 || lastAvatarCopy) return false;
    setState((prev) => ({ ...prev, ownedHeroes: prev.ownedHeroes.filter((owned) => owned.uid !== uid), marketListings: [{ id: genUid(), kind, price: safePrice, createdAt: Date.now(), hero }, ...prev.marketListings] }));
    return true;
  }, []);

  const cancelMarketListing = useCallback((id: string) => setState((prev) => {
    const listing = prev.marketListings.find((entry) => entry.id === id);
    if (!listing) return prev;
    return { ...prev, marketListings: prev.marketListings.filter((entry) => entry.id !== id), inventory: listing.item ? [...prev.inventory, listing.item] : prev.inventory, ownedHeroes: listing.hero ? [...prev.ownedHeroes, listing.hero] : prev.ownedHeroes };
  }), []);

  const completeMarketListing = useCallback((id: string) => setState((prev) => {
    const listing = prev.marketListings.find((entry) => entry.id === id);
    if (!listing) return prev;
    const sourceId = listing.item?.itemId ?? listing.hero?.heroId ?? '';
    const name = listing.item ? ITEM_MAP[sourceId]?.name : HERO_MAP[sourceId]?.name;
    const record = { id: genUid(), kind: listing.kind, sourceId, name: name ?? 'Asset', price: listing.price, createdAt: Date.now(), action: 'sold' as const };
    return { ...prev, hero: prev.hero + listing.price, marketListings: prev.marketListings.filter((entry) => entry.id !== id), marketHistory: [record, ...prev.marketHistory].slice(0, 100) };
  }), []);

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

  const toggleTeamMember = useCallback((uid: string): 'added' | 'removed' | 'inventory-full' | 'blocked' => {
    const st = stateRef.current;
    const hero = st.ownedHeroes.find((h) => h.uid === uid);
    if (!hero || st.trainingCamp.heroUids.includes(uid) || (hero.respawnAt && hero.respawnAt > Date.now())) return 'blocked';
    let newTeam: string[];
    if (st.team.includes(uid)) {
      if (st.team.length <= 1) return 'blocked';
      const equippedCount = Object.values(hero.equipped).filter(Boolean).length;
      if (bagItemCount(st) + equippedCount > MAX_INVENTORY) return 'inventory-full';
      newTeam = st.team.filter((t) => t !== uid);
      stateRef.current = { ...st, team: newTeam };
      setState((prev) => ({ ...prev, team: newTeam, ownedHeroes: prev.ownedHeroes.map((owned) => owned.uid === uid ? { ...owned, equipped: {} } : owned) }));
      spawnBattle(st.currentLocation, newTeam);
      return 'removed';
    }
    if (st.team.length >= MAX_TEAM) return 'blocked';
    newTeam = [...st.team, uid];
    stateRef.current = { ...st, team: newTeam };
    setState((prev) => ({ ...prev, team: newTeam }));
    spawnBattle(st.currentLocation, newTeam);
    return 'added';
  }, [spawnBattle]);

  const setLocation = useCallback((id: number) => {
    const st = stateRef.current;
    if (id < 1 || id > st.highestLocation || id === st.currentLocation) return;
    if (st.accountLevel < locationUnlockLevel(id)) return;
    setState((prev) => ({ ...prev, currentLocation: id }));
    spawnBattle(id, st.team);
  }, [spawnBattle]);

  // ── Equipment ─────────────────────────────────────────────────────────────

  const equipItem = useCallback((heroUid: string, itemUid: string, slot: ItemSlot) => {
    setState((prev) => {
      const hero = prev.ownedHeroes.find((h) => h.uid === heroUid);
      const item = prev.inventory.find((i) => i.uid === itemUid);
      if (!hero || !item || !prev.team.includes(heroUid)) return prev;
      const itemBase = ITEM_MAP[item.itemId];
      const heroBase = HERO_MAP[hero.heroId];
      if (!itemBase || !heroBase || !canClassEquipItem(heroBase.heroClass, itemBase) || !meetsItemLevelRequirement(item, prev.accountLevel)) return prev;
      const isRing = itemBase.slot === 'ring1' || itemBase.slot === 'ring2';
      const targetIsRing = slot === 'ring1' || slot === 'ring2';
      if (!(isRing && targetIsRing) && itemBase.slot !== slot) return prev;
      // Remove item from all heroes, then assign to target hero+slot
      const newHeroes = prev.ownedHeroes.map((h) => {
        const eq = { ...h.equipped };
        for (const [s, iuid] of Object.entries(eq)) { if (iuid === itemUid) delete eq[s as ItemSlot]; }
        if (h.uid === heroUid) eq[slot] = itemUid;
        return { ...h, equipped: eq };
      });
      return { ...prev, ownedHeroes: newHeroes };
    });
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

  const unequipItem = useCallback((heroUid: string, slot: ItemSlot) => {
    setState((prev) => ({ ...prev, ownedHeroes: prev.ownedHeroes.map((h) => h.uid === heroUid ? { ...h, equipped: { ...h.equipped, [slot]: undefined } } : h) }));
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

  const unequipAll = useCallback((heroUid: string) => {
    setState((prev) => {
      const equippedElsewhere = new Set<string>();
      prev.ownedHeroes.forEach((hero) => {
        if (hero.uid !== heroUid) Object.values(hero.equipped).forEach((uid) => { if (uid) equippedElsewhere.add(uid); });
      });
      const resultingBagCount = prev.inventory.filter((item) => !equippedElsewhere.has(item.uid)).length;
      if (resultingBagCount > 64) return prev;
      return { ...prev, ownedHeroes: prev.ownedHeroes.map((hero) => hero.uid === heroUid ? { ...hero, equipped: {} } : hero) };
    });
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

  // ── Enchant ───────────────────────────────────────────────────────────────

  const enchantItem = useCallback(async (itemUid: string, useCharm: boolean) => {
    const st = stateRef.current;
    const item = st.inventory.find((i) => i.uid === itemUid);
    if (!item || item.enchantLevel >= 10) { setEnchantResult({ success: false }); return; }
    const goldCost = enchantGoldCost(item.enchantLevel);
    const charmCost = useCharm ? enchantCharmCost(item.enchantLevel) : 0;
    if (st.gold < goldCost || (!tokenomicsEnabled && st.hero < charmCost)) { setEnchantResult({ success: false }); return; }
    const balance = await settleHeroSpend(charmCost, 'enchant-charm');
    if (balance === null) { setEnchantResult({ success: false }); return; }
    const baseChance = enchantSuccessChance(item.enchantLevel);
    const success = useCharm ? true : Math.random() < baseChance;
    if (success) {
      const newEnchant = item.enchantLevel + 1;
      const newPower = itemPower(item.stats, newEnchant);
      setState((prev) => ({
        ...prev,
        gold: prev.gold - goldCost,
        hero: balance,
        inventory: prev.inventory.map((i) => i.uid === itemUid ? { ...i, enchantLevel: newEnchant, enchantStatsVersion: 2, power: newPower } : i),
      }));
      setEnchantResult({ success: true, item: { ...item, enchantLevel: newEnchant, enchantStatsVersion: 2, power: newPower } });
    } else {
      // Item destroyed on failure
      setState((prev) => ({
        ...prev,
        gold: prev.gold - goldCost,
        hero: balance,
        inventory: prev.inventory.filter((i) => i.uid !== itemUid),
        ownedHeroes: prev.ownedHeroes.map((h) => {
          const eq = { ...h.equipped };
          for (const [s, iuid] of Object.entries(eq)) { if (iuid === itemUid) delete eq[s as ItemSlot]; }
          return { ...h, equipped: eq };
        }),
      }));
      setEnchantResult({ success: false });
    }
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [settleHeroSpend, spawnBattle]);

  const rerollItem = useCallback(async (itemUid: string) => {
    const st = stateRef.current;
    const item = st.inventory.find((i) => i.uid === itemUid);
    if (!item) return;
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

  const sellItem = useCallback((itemUid: string) => {
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

  const toggleItemLock = useCallback((itemUid: string) => {
    setState((prev) => ({ ...prev, inventory: prev.inventory.map((i) => i.uid === itemUid ? { ...i, locked: !i.locked } : i) }));
  }, []);

  // FIXED: sellAllUnlocked only sells UNEQUIPPED, UNLOCKED items (not potions, not equipped)
  const sellAllUnlocked = useCallback(() => {
    setState((prev) => {
      // find all equipped item UIDs
      const equippedUids = new Set<string>();
      prev.ownedHeroes.forEach((h) => {
        for (const iuid of Object.values(h.equipped)) { if (iuid) equippedUids.add(iuid); }
      });
      // only sell: not locked, not equipped
      const toSell = prev.inventory.filter((i) => !i.locked && !equippedUids.has(i.uid));
      const total = toSell.reduce((acc, i) => acc + sellValue(i), 0);
      const keep = prev.inventory.filter((i) => i.locked || equippedUids.has(i.uid));
      return { ...prev, gold: prev.gold + total, inventory: keep };
    });
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

  // ── Potions ──────────────────────────────────────────────────────────────

  const buyPotion = useCallback((tier: PotionTier, qty: number = 1) => {
    setState((prev) => {
      const def = POTION_MAP[tier];
      const cost = def.cost * qty;
      if (prev.gold < cost) return prev;
      return { ...prev, gold: prev.gold - cost, potions: { ...prev.potions, [tier]: prev.potions[tier] + qty } };
    });
  }, []);

  const usePotion = useCallback((tier: PotionTier, heroUid: string) => {
    const st = stateRef.current;
    if (st.potions[tier] <= 0) return;
    const def = POTION_MAP[tier];
    setState((prev) => ({ ...prev, potions: { ...prev.potions, [tier]: prev.potions[tier] - 1 } }));
    const healedUnits = unitsRef.current.map((unit) => unit.uid === heroUid ? { ...unit, hp: Math.min(unit.maxHp, unit.hp + def.hpRestore) } : unit);
    unitsRef.current = healedUnits;
    setUnits(healedUnits);
    setFloaters((prev) => [...prev.slice(-20), { id: floaterId.current++, targetUid: heroUid, value: def.hpRestore, crit: false, heal: true, born: performance.now() }]);
    setPotionFx({ uid: heroUid, born: performance.now() });
  }, []);

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
    const st = stateRef.current;
    const freeSlots = MAX_INVENTORY - bagItemCount(st);
    if (freeSlots <= 0 || st.chests.length === 0) return;
    const openCount = Math.min(freeSlots, st.chests.length);
    const results: OwnedItem[] = [];
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
  }, []);

  const closeChestResult = useCallback(() => setChestOpenResult(null), []);
  const dismissEnchantResult = useCallback(() => setEnchantResult(null), []);

  // ── Rotating shop ────────────────────────────────────────────────────────

  const buyRotatingItem = useCallback((index: number) => {
    setState((prev) => {
      const slot = prev.rotatingShop[index];
      if (!slot || slot.sold || prev.gold < slot.price || bagItemCount(prev) >= MAX_INVENTORY) return prev;
      const proper = rollItem(slot.itemId, 1);
      return { ...prev, gold: prev.gold - slot.price, inventory: [...prev.inventory, proper], rotatingShop: prev.rotatingShop.map((s, i) => i === index ? { ...s, sold: true } : s) };
    });
  }, []);

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
  }, []);

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

  const autoEquipBest = useCallback(() => {
    setState((prev) => {
      const teamHeroes = prev.team
        .map((uid) => prev.ownedHeroes.find((candidate) => candidate.uid === uid))
        .filter((hero): hero is OwnedHero => Boolean(hero));
      if (teamHeroes.length === 0) return prev;

      // Release the active team's current gear into one shared pool. The first
      // hero in formation gets first choice, then the second and third use only
      // what remains. Gear worn by reserve heroes is never touched.
      const teamUids = new Set(teamHeroes.map((hero) => hero.uid));
      const reservedByReserve = new Set<string>();
      prev.ownedHeroes.forEach((candidate) => {
        if (teamUids.has(candidate.uid)) return;
        Object.values(candidate.equipped).forEach((uid) => { if (uid) reservedByReserve.add(uid); });
      });
      const available = new Set(prev.inventory.filter((item) => !reservedByReserve.has(item.uid)).map((item) => item.uid));
      const slots: ItemSlot[] = ['class_weapon', 'offhand', 'helmet', 'chest', 'gloves', 'boots', 'ring', 'amulet'];
      const equippedByUid = new Map<string, Partial<Record<ItemSlot, string>>>();
      for (const hero of teamHeroes) {
        const heroBase = HERO_MAP[hero.heroId];
        if (!heroBase) continue;
        const equipped: Partial<Record<ItemSlot, string>> = {};
        for (const slot of slots) {
          const best = prev.inventory
            .filter((item) => {
              const itemBase = ITEM_MAP[item.itemId];
              return available.has(item.uid)
                && itemBase?.slot === slot
                && canClassEquipItem(heroBase.heroClass, itemBase)
                && meetsItemLevelRequirement(item, prev.accountLevel);
            })
            .sort((a, b) => b.power - a.power || b.level - a.level)[0];
          if (best) {
            equipped[slot] = best.uid;
            available.delete(best.uid);
          }
        }
        equippedByUid.set(hero.uid, equipped);
      }
      return {
        ...prev,
        ownedHeroes: prev.ownedHeroes.map((candidate) => {
          const equipped = equippedByUid.get(candidate.uid);
          return equipped ? { ...candidate, equipped } : candidate;
        }),
      };
    });
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

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
    state, hydrationVersion, summonPity, summonError, serverRevisionHint, units, floaters, battleResult, autoProgress, paused,
    offlineEarnings, respawnCountdowns, potionFx, chestOpenResult, enchantResult,
    starUpHero, promoteAllHeroes, sellHero, sellHeroes, toggleHeroLock, markHeroSeen,
    summon, summonTen, summonHundred, summonBoss, syncBossKeys, toggleTeamMember, setLocation,
    setAutoProgress, setPaused, collectOffline, creditServerTokens, applyServerTokenClaim, setServerTokenBalance, applyServerBoostStatus, applyServerPityStatus, retry,
    equipItem, unequipItem, unequipAll, sellItem, toggleItemLock, sellAllUnlocked,
    enchantItem, rerollItem, dismissEnchantResult,
    buyPotion, usePotion, setAutoPot, setBattleAnimationMode,
    setTrainingHero, unlockTrainingSlot, buyTrainingBoost,
    openChests, closeChestResult, buyRotatingItem, claimQuest,
    claimReferralReward, setUserProfile, resetAccount, hydrateServerState, mergeServerResourceState, completeWelcomeTutorial, setAvatarHero, buyMarketAsset, createMarketListing, cancelMarketListing, completeMarketListing, activateBoost, deactivateBoost, toggleBoostCondition, sortInventory, autoEquipBest, creditTestGold, creditTestAccountXp, creditTestFormationXp,
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
