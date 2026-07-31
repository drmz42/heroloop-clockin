import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { GameState, OwnedHero, CombatUnit, FloatingNumber, ItemSlot, OwnedItem, PotionTier, DailyQuest } from '@/game/types';
import {
  loadState, saveState, genUid, starUpCost, summonCostHero,
  MAX_TEAM, MAX_INVENTORY, MAX_CHESTS, RESPAWN_TIME_MS, ROTATING_REFRESH_MS,
  accountLevelFromXp, heroLevelFromXp, heroSellValue, generateDailyQuests,
} from '@/game/state';
import { buildLocation, ownedToUnit, enemyToUnit, heroStats, getEquippedItems, teamPower, isOverpowered, canMineTokens, locationUnlockLevel } from '@/game/engine';
import { HEROES, HERO_MAP, RARITY_WEIGHT, RARITY_INDEX } from '@/game/heroes';
import {
  rollDropForStage, rollChestDrop, openChest, generateRotatingShop,
  ITEM_MAP, POTION_MAP, sellValue, rollItem, rerollItemStats,
  enchantSuccessChance, enchantGoldCost, enchantCharmCost, enchantedStats,
  maxChestRarityForLocation, MAX_CHESTS_PER_DAY, rerollCost,
  canClassEquipItem, chestDropChance,
} from '@/game/items';
import type { Rarity } from '@/game/types';

const COMBAT_SPEED = 1;

function pickRarity(rand: number): Rarity {
  let acc = 0;
  const total = Object.values(RARITY_WEIGHT).reduce((a, b) => a + b, 0);
  const r = rand * total;
  for (const [rarity, w] of Object.entries(RARITY_WEIGHT)) {
    acc += w;
    if (r <= acc) return rarity as Rarity;
  }
  return 'common';
}

function pickHero(rand: number): string {
  const rarity = pickRarity(rand);
  const pool = HEROES.filter((h) => h.rarity === rarity);
  if (pool.length === 0) return HEROES[0].id;
  return pool[Math.floor(rand * 9999) % pool.length].id;
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

function updateQuestProgress(quests: DailyQuest[], type: string, amount: number): DailyQuest[] {
  return quests.map(q => {
    if (q.id.startsWith(type) && !q.claimed) {
      return { ...q, progress: Math.min(q.target, q.progress + amount) };
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

  const stateRef = useRef(state); stateRef.current = state;
  const unitsRef = useRef<CombatUnit[]>([]);
  const autoRef = useRef(autoProgress); autoRef.current = autoProgress;
  const pausedRef = useRef(paused); pausedRef.current = paused;
  const floaterId = useRef(0);
  const resolvingRef = useRef(false);
  const heroHpRef = useRef<Map<string, number>>(new Map());

  useEffect(() => { saveState(state); }, [state]);

  useEffect(() => {
    // Remove equipment created by the old unrestricted prototype rules
    // (for example, a knight sword equipped by an archer).
    setState((prev) => {
      let changed = false;
      const ownedHeroes = prev.ownedHeroes.map((hero) => {
        const base = HERO_MAP[hero.heroId];
        if (!base) return hero;
        const equipped = { ...hero.equipped };
        for (const [slot, uid] of Object.entries(equipped)) {
          const owned = prev.inventory.find((item) => item.uid === uid);
          const itemBase = owned ? ITEM_MAP[owned.itemId] : null;
          if (itemBase && !canClassEquipItem(base.heroClass, itemBase)) {
            delete equipped[slot as ItemSlot];
            changed = true;
          }
        }
        return changed ? { ...hero, equipped } : hero;
      });
      return changed ? { ...prev, ownedHeroes } : prev;
    });
  }, []);

  const spawnBattle = useCallback((locationId: number, teamUids: string[]) => {
    const st = stateRef.current;
    const now = Date.now();
    const aliveTeam = teamUids
      .map((uid) => st.ownedHeroes.find((h) => h.uid === uid))
      .filter((h): h is OwnedHero => !!h && (!h.respawnAt || h.respawnAt <= now));
    const loc = buildLocation(locationId, aliveTeam.length);
    const heroUnits = aliveTeam.map((o) => ownedToUnit(o, st.inventory)).filter((u): u is CombatUnit => !!u).map((u) => {
      const carriedHp = heroHpRef.current.get(u.uid);
      return carriedHp === undefined ? u : { ...u, hp: Math.max(1, Math.min(u.maxHp, carriedHp)), alive: carriedHp > 0 };
    });
    const enemyUnits = loc.enemies.map((e, i) => enemyToUnit(e, i));
    setUnits([...heroUnits.map(u => ({ ...u, attackTimer: u.attackInterval * 0.5 })), ...enemyUnits]);
    setBattleResult(null);
    setFloaters([]);
    resolvingRef.current = false;
  }, []);

  useEffect(() => {
    if (state.walletAddress && state.team.length > 0) {
      spawnBattle(state.currentLocation, state.team);
    } else {
      setUnits([]);
    }
    // Battle begins only after registration creates the player's game wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.walletAddress]);

  const awardBattle = useCallback((locationId: number, win: boolean, deadHeroUids: string[]) => {
    const st = stateRef.current;
    const aliveTeamSize = st.team.filter(uid => {
      const h = st.ownedHeroes.find(h => h.uid === uid);
      return h && !deadHeroUids.includes(uid);
    }).length;
    const loc = buildLocation(locationId, aliveTeamSize);
    let gold = win ? loc.goldReward : Math.round(loc.goldReward * 0.15);
    const baseXp = win ? loc.xpReward : 0;

    const teamBonuses = st.team.reduce((acc, uid) => {
      const hero = st.ownedHeroes.find((h) => h.uid === uid);
      if (!hero) return acc;
      const s = heroStats(hero, getEquippedItems(hero, st.inventory));
      if (!s) return acc;
      return { gold: acc.gold + s.goldBonus, xp: acc.xp + s.xpBonus };
    }, { gold: 0, xp: 0 });
    gold = Math.round(gold * (1 + teamBonuses.gold));
    const xpGain = Math.round(baseXp * (1 + teamBonuses.xp));

    const tokens = 0;
    const overpowered = false;

    let drop: OwnedItem | undefined;
    let chestDropped = false;
    if (win) {
      const d = rollDropForStage(locationId, loc.maxChestRarity);
      if (d) drop = d;
      if (rollChestDrop(locationId, st.chestsOpenedToday)) chestDropped = true;
    }

    const now = Date.now();
    deadHeroUids.forEach((uid) => heroHpRef.current.delete(uid));
    const enemyCount = loc.enemies.length;
    setState((prev) => {
      const next: GameState = { ...prev, gold: prev.gold + gold, totalGoldEarned: prev.totalGoldEarned + gold };
      next.accountXp = prev.accountXp + xpGain;
      next.accountLevel = accountLevelFromXp(next.accountXp);
      next.ownedHeroes = prev.ownedHeroes.map((h) =>
        deadHeroUids.includes(h.uid) ? { ...h, respawnAt: now + RESPAWN_TIME_MS } : h
      );
      if (win) {
        next.totalKills = prev.totalKills + enemyCount;
        next.ownedHeroes = next.ownedHeroes.map((h) => {
          if (prev.team.includes(h.uid) && !deadHeroUids.includes(h.uid)) {
            const { level, remaining } = heroLevelFromXp(h.xp + xpGain);
            return { ...h, xp: remaining, level };
          }
          return h;
        });
        if (locationId === prev.currentLocation && locationId === prev.highestLocation) {
          next.highestLocation = locationId + 1;
        }
        // session + quests
        next.session = { ...prev.session, kills: prev.session.kills + enemyCount };
        if (loc.boss) next.session.bossKills = prev.session.bossKills + 1;
        next.dailyQuests = updateQuestProgress(prev.dailyQuests, 'kill-', enemyCount);
        if (loc.boss) next.dailyQuests = updateQuestProgress(next.dailyQuests, 'boss-', 1);
      }
      if (drop && prev.inventory.length < MAX_INVENTORY) next.inventory = [...prev.inventory, drop];
      if (chestDropped && prev.chests.length < MAX_CHESTS && prev.chestsOpenedToday < MAX_CHESTS_PER_DAY) {
        next.chests = [...prev.chests, { id: `c${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, stage: locationId }];
        next.chestsOpenedToday = prev.chestsOpenedToday + 1;
      }
      return next;
    });
    setBattleResult({ win, gold, xp: xpGain, tokens, drop, chest: chestDropped, overpowered });
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
          if (st.gold >= def.cost) {
            setState((prev) => ({ ...prev, gold: prev.gold - def.cost, potions: { ...prev.potions, [autoTier]: prev.potions[autoTier] + 1 } }));
            usedTier = autoTier;
          }
        }
        if (usedTier) {
          const def = POTION_MAP[usedTier];
          setState((prev) => ({ ...prev, potions: { ...prev.potions, [usedTier!]: prev.potions[usedTier!] - 1 } }));
          setUnits((prev) => prev.map((u) => u.uid === hero.uid ? { ...u, hp: Math.min(u.maxHp, u.hp + def.hpRestore) } : u));
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
        const heroes = live.filter((u) => u.side === 'hero' && u.alive);
        const enemies = live.filter((u) => u.side === 'enemy' && u.alive);
        if (heroes.length === 0 || enemies.length === 0) {
          resolvingRef.current = true;
          const win = heroes.length > 0;
          const deadHeroes = live.filter((u) => u.side === 'hero' && !u.alive).map((u) => u.uid);
          awardBattle(stateRef.current.currentLocation, win, deadHeroes);
        } else {
          const newFloaters: FloatingNumber[] = [];
          const hpDelta = new Map<string, number>();
          const healTarget = new Map<string, number>();
          const allHealTarget = new Map<string, number>();
          const updated = live.map((u) => {
            if (!u.alive) return u;
            if (u.heroClass === 'druid' && u.regenTimer !== undefined) {
              const newRegen = u.regenTimer + dt;
              if (newRegen >= 3000) {
                const regenAmount = Math.round(u.maxHp * 0.015);
                newFloaters.push({ id: floaterId.current++, targetUid: u.uid, value: regenAmount, crit: false, heal: true, born: now });
                return { ...u, hp: Math.min(u.maxHp, u.hp + regenAmount), regenTimer: 0 };
              }
              u = { ...u, regenTimer: newRegen };
            }
            const timer = u.attackTimer + dt;
            if (timer < u.attackInterval) return { ...u, attackTimer: timer };
            const allies = u.side === 'hero' ? heroes : enemies;
            const foes = u.side === 'hero' ? enemies : heroes;
            if (foes.length === 0) return { ...u, attackTimer: u.attackInterval };
            if (u.heroClass === 'shepherd') {
              const wounded = allies.slice().sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
              const target = wounded[0];
              if (target && target.hp < target.maxHp) {
                const healAmount = Math.round(u.atk * 1.6);
                healTarget.set(target.uid, Math.min(target.maxHp, target.hp + healAmount));
                newFloaters.push({ id: floaterId.current++, targetUid: target.uid, value: healAmount, crit: false, heal: true, born: now });
                for (const a of allies) {
                  if (a.uid !== target.uid && a.hp < a.maxHp) {
                    const aoeHeal = Math.round(u.atk * 0.05);
                    allHealTarget.set(a.uid, Math.min(a.maxHp, (allHealTarget.get(a.uid) ?? a.hp) + aoeHeal));
                  }
                }
              }
              return { ...u, attackTimer: 0 };
            }
            const formation = u.side === 'hero' ? heroes : enemies;
            const lane = Math.max(0, formation.findIndex((fighter) => fighter.uid === u.uid));
            const target = foes[lane % foes.length];
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
            const healed = healTarget.get(u.uid); if (healed !== undefined) return { ...u, hp: healed };
            const aoeHealed = allHealTarget.get(u.uid); if (aoeHealed !== undefined) return { ...u, hp: Math.min(u.maxHp, aoeHealed) };
            return u;
          });
          finalUnits.forEach((u) => {
            if (u.side === 'hero') heroHpRef.current.set(u.uid, u.hp);
          });
          unitsRef.current = finalUnits;
          setUnits(finalUnits);
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

  useEffect(() => { unitsRef.current = units; }, [units]);

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

  const [offlineEarnings, setOfflineEarnings] = useState<{ gold: number; seconds: number; tokens?: number; chests?: number; xp?: number } | null>(null);
  useEffect(() => {
    const st = stateRef.current;
    const prev = st.lastSeen;
    const now = Date.now();
    const elapsed = Math.max((now - prev) / 1000, 0);
    if (elapsed > 30) {
      const loc = buildLocation(st.currentLocation, st.team.length);
      const battles = Math.floor(elapsed / 12);
      const teamBonuses = st.team.reduce((acc, uid) => {
        const hero = st.ownedHeroes.find((h) => h.uid === uid);
        const stats = hero ? heroStats(hero, getEquippedItems(hero, st.inventory)) : null;
        return stats ? { gold: acc.gold + stats.goldBonus, xp: acc.xp + stats.xpBonus } : acc;
      }, { gold: 0, xp: 0 });
      const gold = Math.round(battles * loc.goldReward * (1 + teamBonuses.gold));
      const xp = Math.round(battles * loc.xpReward * (1 + teamBonuses.xp));
      const requestedChests = Math.floor(battles * chestDropChance(st.currentLocation));
      const chests = Math.min(requestedChests, Math.max(0, MAX_CHESTS - st.chests.length));
      const kills = battles * loc.enemies.length;
      setState((p) => ({
          ...p,
          gold: p.gold + gold,
          totalGoldEarned: p.totalGoldEarned + gold,
          accountXp: p.accountXp + xp,
          accountLevel: accountLevelFromXp(p.accountXp + xp),
          totalKills: p.totalKills + kills,
          ownedHeroes: p.ownedHeroes.map((h) => {
            if (!p.team.includes(h.uid)) return h;
            const leveled = heroLevelFromXp(h.xp + xp);
            return { ...h, xp: leveled.remaining, level: Math.max(h.level, leveled.level) };
          }),
          chests: chests > 0 ? [...p.chests, ...Array.from({ length: chests }, (_, i) => ({ id: `oc${now}-${i}`, stage: p.currentLocation }))] : p.chests,
        }));
      setOfflineEarnings({ gold, seconds: elapsed, chests: chests || undefined, xp: xp || undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────

  const starUpHero = useCallback((uid: string) => {
    setState((prev) => {
      const hero = prev.ownedHeroes.find((h) => h.uid === uid);
      if (!hero || hero.stars >= 5) return prev;
      const cost = starUpCost(hero.stars);
      const dupes = prev.ownedHeroes.filter((h) => h.heroId === hero.heroId && h.uid !== uid && !h.locked);
      if (dupes.length < cost.dupes || prev.hero < cost.hero) return prev;
      const consume = dupes.slice(0, cost.dupes).map((h) => h.uid);
      return { ...prev, hero: prev.hero - cost.hero, ownedHeroes: prev.ownedHeroes.filter((h) => !consume.includes(h.uid)).map((h) => h.uid === uid ? { ...h, stars: h.stars + 1 } : h), team: prev.team.filter((t) => !consume.includes(t)) };
    });
  }, []);

  const sellHero = useCallback((uid: string) => {
    setState((prev) => {
      const hero = prev.ownedHeroes.find((h) => h.uid === uid);
      if (!hero) return prev;
      const base = HERO_MAP[hero.heroId];
      if (!base) return prev;
      const refund = heroSellValue(base.rarity, hero.stars);
      return { ...prev, gold: prev.gold + refund, ownedHeroes: prev.ownedHeroes.filter((h) => h.uid !== uid), team: prev.team.filter((t) => t !== uid) };
    });
  }, []);

  const toggleHeroLock = useCallback((uid: string) => {
    setState((prev) => ({ ...prev, ownedHeroes: prev.ownedHeroes.map((h) => h.uid === uid ? { ...h, locked: !h.locked } : h) }));
  }, []);

  const summon = useCallback((): OwnedHero | null => {
    const cost = summonCostHero();
    if (stateRef.current.hero < cost) return null;
    const heroId = pickHero(Math.random());
    const owned: OwnedHero = { uid: genUid(), heroId, level: 1, stars: 0, equipped: {}, xp: 0 };
    setState((prev) => ({ ...prev, hero: prev.hero - cost, ownedHeroes: [...prev.ownedHeroes, owned], summons: prev.summons + 1, dailyQuests: updateQuestProgress(prev.dailyQuests, 'summon-', 1) }));
    return owned;
  }, []);

  const summonTen = useCallback((): OwnedHero[] => {
    const cost = summonCostHero() * 10;
    if (stateRef.current.hero < cost) return [];
    const results: OwnedHero[] = [];
    for (let i = 0; i < 10; i++) results.push({ uid: genUid(), heroId: pickHero(Math.random()), level: 1, stars: 0, equipped: {}, xp: 0 });
    setState((prev) => ({ ...prev, hero: prev.hero - cost, ownedHeroes: [...prev.ownedHeroes, ...results], summons: prev.summons + 10, dailyQuests: updateQuestProgress(prev.dailyQuests, 'summon-', 1) }));
    return results;
  }, []);

  const toggleTeamMember = useCallback((uid: string) => {
    const st = stateRef.current;
    const hero = st.ownedHeroes.find((h) => h.uid === uid);
    if (!hero || (hero.respawnAt && hero.respawnAt > Date.now())) return;
    let newTeam: string[];
    if (st.team.includes(uid)) { if (st.team.length <= 1) return; newTeam = st.team.filter((t) => t !== uid); }
    else { if (st.team.length >= MAX_TEAM) return; newTeam = [...st.team, uid]; }
    setState((prev) => ({ ...prev, team: newTeam }));
    spawnBattle(st.currentLocation, newTeam);
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
      if (!hero || !item) return prev;
      const itemBase = ITEM_MAP[item.itemId];
      const heroBase = HERO_MAP[hero.heroId];
      if (!itemBase || !heroBase || !canClassEquipItem(heroBase.heroClass, itemBase)) return prev;
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

  // ── Enchant ───────────────────────────────────────────────────────────────

  const enchantItem = useCallback((itemUid: string, useCharm: boolean) => {
    const st = stateRef.current;
    const item = st.inventory.find((i) => i.uid === itemUid);
    if (!item || item.enchantLevel >= 10) { setEnchantResult({ success: false }); return; }
    const goldCost = enchantGoldCost(item.enchantLevel);
    const charmCost = useCharm ? enchantCharmCost(item.enchantLevel) : 0;
    if (st.gold < goldCost || st.hero < charmCost) { setEnchantResult({ success: false }); return; }
    const baseChance = enchantSuccessChance(item.enchantLevel);
    const success = useCharm ? true : Math.random() < baseChance;
    if (success) {
      const newEnchant = item.enchantLevel + 1;
      const enchStats = enchantedStats(item.stats, newEnchant);
      const newPower = Math.round(item.power * (1 + 0.10));
      setState((prev) => ({
        ...prev,
        gold: prev.gold - goldCost,
        hero: prev.hero - charmCost,
        inventory: prev.inventory.map((i) => i.uid === itemUid ? { ...i, enchantLevel: newEnchant, stats: enchStats, power: newPower } : i),
      }));
      setEnchantResult({ success: true, item: { ...item, enchantLevel: newEnchant, stats: enchStats, power: newPower } });
    } else {
      // Item destroyed on failure
      setState((prev) => ({
        ...prev,
        gold: prev.gold - goldCost,
        hero: prev.hero - charmCost,
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
  }, [spawnBattle]);

  const rerollItem = useCallback((itemUid: string) => {
    const st = stateRef.current;
    const item = st.inventory.find((i) => i.uid === itemUid);
    if (!item) return;
    const base = ITEM_MAP[item.itemId];
    if (!base) return;
    const cost = rerollCost(base.rarity, item.rerollCount);
    if (st.hero < cost) return;
    const newItem = rerollItemStats(item);
    setState((prev) => ({ ...prev, hero: prev.hero - cost, inventory: prev.inventory.map((i) => i.uid === itemUid ? newItem : i) }));
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

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
    setUnits((prev) => prev.map((u) => u.uid === heroUid ? { ...u, hp: Math.min(u.maxHp, u.hp + def.hpRestore) } : u));
    setFloaters((prev) => [...prev.slice(-20), { id: floaterId.current++, targetUid: heroUid, value: def.hpRestore, crit: false, heal: true, born: performance.now() }]);
    setPotionFx({ uid: heroUid, born: performance.now() });
  }, []);

  const setAutoPot = useCallback((cfg: Partial<GameState['autoPot']>) => {
    setState((prev) => ({ ...prev, autoPot: { ...prev.autoPot, ...cfg } }));
  }, []);

  // ── Chests ────────────────────────────────────────────────────────────────

  const openChests = useCallback(() => {
    const st = stateRef.current;
    const freeSlots = MAX_INVENTORY - st.inventory.length;
    if (freeSlots <= 0 || st.chests.length === 0) return;
    const openCount = Math.min(freeSlots, st.chests.length);
    const results: OwnedItem[] = [];
    for (let i = 0; i < openCount; i++) {
      const chest = st.chests[i];
      const maxR = maxChestRarityForLocation(chest.stage);
      results.push(openChest(chest.stage, maxR));
    }
    flushSync(() => setChestOpenResult(results));
    setState((prev) => ({
      ...prev,
      chests: prev.chests.slice(openCount),
      inventory: [...prev.inventory, ...results],
      session: { ...prev.session, chestsOpened: prev.session.chestsOpened + openCount },
      dailyQuests: updateQuestProgress(prev.dailyQuests, 'chest-', openCount),
    }));
  }, []);

  const closeChestResult = useCallback(() => setChestOpenResult(null), []);
  const dismissEnchantResult = useCallback(() => setEnchantResult(null), []);

  // ── Rotating shop ────────────────────────────────────────────────────────

  const buyRotatingItem = useCallback((index: number) => {
    setState((prev) => {
      const slot = prev.rotatingShop[index];
      if (!slot || slot.sold || prev.gold < slot.price || prev.inventory.length >= MAX_INVENTORY) return prev;
      const proper = rollItem(slot.itemId, 1);
      return { ...prev, gold: prev.gold - slot.price, inventory: [...prev.inventory, proper], rotatingShop: prev.rotatingShop.map((s, i) => i === index ? { ...s, sold: true } : s) };
    });
  }, []);

  // ── Quests ───────────────────────────────────────────────────────────────

  const claimQuest = useCallback((questId: string) => {
    setState((prev) => {
      const q = prev.dailyQuests.find((q) => q.id === questId);
      if (!q || q.claimed || q.progress < q.target) return prev;
      return {
        ...prev,
        gold: prev.gold + q.reward.gold,
        hero: prev.hero + q.reward.hero,
        dailyQuests: prev.dailyQuests.map((q) => q.id === questId ? { ...q, claimed: true } : q),
      };
    });
  }, []);

  const setUserProfile = useCallback((username: string, walletAddress: string, starterHeroId?: string) => {
    setState((prev) => {
      if (!starterHeroId || prev.ownedHeroes.length !== 1) return { ...prev, username, walletAddress, lastSeen: Date.now() };
      const currentStarter = prev.ownedHeroes[0];
      const starter = { ...currentStarter, heroId: starterHeroId };
      return {
        ...prev,
        username,
        walletAddress,
        lastSeen: Date.now(),
        ownedHeroes: [starter],
        team: [starter.uid],
      };
    });
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
      const equippedUids = new Set<string>();
      prev.ownedHeroes.forEach((h) => { for (const u of Object.values(h.equipped)) { if (u) equippedUids.add(u); } });
      const bagItems = prev.inventory.filter((i) => !equippedUids.has(i.uid));
      const newHeroes = prev.ownedHeroes.map((h) => ({ ...h, equipped: { ...h.equipped } }));
      for (const slot of ['weapon','helmet','armor','gloves','boots','ring1','ring2','amulet'] as ItemSlot[]) {
        const candidates = bagItems
          .filter((i) => { const ib = ITEM_MAP[i.itemId]; return ib && (ib.slot === slot || (slot === 'ring1' && ib.slot === 'ring1') || (slot === 'ring2' && ib.slot === 'ring2')); })
          .sort((a, b) => b.power - a.power);
        for (const hero of newHeroes) {
          const heroBase = HERO_MAP[hero.heroId];
          if (!heroBase) continue;
          const currentUid = hero.equipped[slot];
          const currentItem = currentUid ? prev.inventory.find((i) => i.uid === currentUid) : null;
          const best = candidates.find((i) => {
            const itemBase = ITEM_MAP[i.itemId];
            return itemBase && canClassEquipItem(heroBase.heroClass, itemBase) && !newHeroes.some((hh) => Object.values(hh.equipped).includes(i.uid));
          });
          if (!best) continue;
          if (!currentItem || best.power > currentItem.power) {
            if (currentUid) equippedUids.add(currentUid);
            hero.equipped[slot] = best.uid;
          }
        }
      }
      return { ...prev, ownedHeroes: newHeroes };
    });
    spawnBattle(stateRef.current.currentLocation, stateRef.current.team);
  }, [spawnBattle]);

  const healTeam = useCallback(() => {
    setUnits((prev) => prev.map((u) => {
      if (u.side !== 'hero') return u;
      heroHpRef.current.set(u.uid, u.maxHp);
      return { ...u, hp: u.maxHp };
    }));
    setFloaters((prev) => [...prev.slice(-20), ...units.filter(u => u.side === 'hero').map(u => ({ id: floaterId.current++, targetUid: u.uid, value: Math.round(u.maxHp - u.hp), crit: false, heal: true, born: performance.now() }))]);
    setPotionFx({ uid: 'team', born: performance.now() });
  }, [units]);

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
    state, units, floaters, battleResult, autoProgress, paused,
    offlineEarnings, respawnCountdowns, potionFx, chestOpenResult, enchantResult,
    starUpHero, sellHero, toggleHeroLock,
    summon, summonTen, toggleTeamMember, setLocation,
    setAutoProgress, setPaused, collectOffline, retry,
    equipItem, unequipItem, sellItem, toggleItemLock, sellAllUnlocked,
    enchantItem, rerollItem, dismissEnchantResult,
    buyPotion, usePotion, setAutoPot,
    openChests, closeChestResult, buyRotatingItem, claimQuest,
    claimReferralReward, setUserProfile, activateBoost, deactivateBoost, toggleBoostCondition, sortInventory, autoEquipBest, healTeam,
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
      if (isOverpowered(loc, power) || !canMineTokens(state.currentLocation, state.accountLevel)) return 0;
      // ~1 battle every 8 seconds = 450/hour
      return loc.tokenReward * 450;
    },
  };
}

export type GameApi = ReturnType<typeof useGame>;

void RARITY_INDEX;
