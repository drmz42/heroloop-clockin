import { useCallback, useEffect, useRef, useState } from 'react';
import { ITEM_MAP } from '@/game/items';
import type { OwnedItem } from '@/game/types';
import type { Rarity } from '@/game/types';
import { playerSync, tokenomicsEnabled } from '@/game/backend';

export interface TokenomicsStatus {
  score_version: number;
  player_power: number;
  training_hero_count: number;
  training_penalty: number;
  highest_location: number;
  location_multiplier: number;
  boost_multiplier: number;
  my_score: number;
  total_score: number;
  denominator_as_of: string;
  daily_pool: number;
  pool_share_percent: number;
  save_revision: number;
  pool_amount: number;
  total_distributed: number;
  distribution_rate: number;
  total_power: number;
  my_power: number;
  my_daily_share: number;
  my_hourly_share: number;
  pending_tokens: number;
  total_claimed: number;
  token_balance: number;
  account_restriction?: 'review' | 'hold' | null;
  resource_state?: unknown;
  resource_revision?: number | null;
  resources?: { revision: string; balances: Record<string, string> } | null;
  boost: {
    active: boolean;
    login_days: number;
    online_seconds: number;
    tokens_earned: number;
    tokens_spent: number;
    token_balance: number;
  } | null;
  pity: {
    legendary: number;
    mythic: number;
    cosmic: number;
    divine: number;
    celestial: number;
  } | null;
  ascension_focus: Partial<Record<Rarity, string>>;
  boss_keys: number;
  rarity_capacity: { divine?: boolean; celestial?: boolean };
  rarity_supply?: Partial<Record<'divine' | 'celestial' | 'cursed' | 'immortal' | 'god', { existing: number; max: number }>>;
}

export function useTokenomics(power: number, accountLevel: number, username: string, playerId: string | null, stats?: {
  totalKills: number; bossKills: number; chestsOpened: number; heroesOwned: number; highestLocation: number; tokenEligible: boolean;
  lineup: Array<{ hero_id: string; level: number; stars: number }>; avatarHeroId: string; summons: number; totalTokensEarned: number;
  trainingHeroCount: number;
}) {
  const [status, setStatus] = useState<TokenomicsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [incomeStale, setIncomeStale] = useState(false);
  const powerRef = useRef(power);
  const playerIdRef = useRef(playerId);
  const accountLevelRef = useRef(accountLevel);
  const usernameRef = useRef(username);
  const statsRef = useRef(stats);
  const confirmedIncomeRevisionRef = useRef(0);
  const incomeRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const queuedIncomeRevisionRef = useRef(0);
  powerRef.current = power;
  playerIdRef.current = playerId;
  accountLevelRef.current = accountLevel;
  usernameRef.current = username;
  statsRef.current = stats;

  const syncUp = useCallback(async () => {
    if (!tokenomicsEnabled) return false;
    const pid = playerIdRef.current;
    if (!pid) return false;
    const currentStats = statsRef.current;
    try {
      const data = await playerSync<{ pending_tokens: number; total_claimed: number }>('sync', {
          player_id: pid,
          power: powerRef.current,
          account_level: accountLevelRef.current,
          username: usernameRef.current,
          total_kills: currentStats?.totalKills ?? 0,
          boss_kills: currentStats?.bossKills ?? 0,
          chests_opened: currentStats?.chestsOpened ?? 0,
          heroes_owned: currentStats?.heroesOwned ?? 1,
          highest_location: currentStats?.highestLocation ?? 1,
          lineup: currentStats?.lineup ?? [],
          avatar_hero_id: currentStats?.avatarHeroId ?? '',
          summons: currentStats?.summons ?? 0,
          total_tokens_earned: currentStats?.totalTokensEarned ?? 0,
          token_eligible: currentStats?.tokenEligible ?? true,
          training_hero_count: currentStats?.trainingHeroCount ?? 0,
      });
      if (data?.pending_tokens !== undefined) {
        setStatus((prev) => prev ? { ...prev, pending_tokens: data.pending_tokens, total_claimed: data.total_claimed } : prev);
        return true;
      }
    } catch { /* silent */ }
    return false;
  }, []);

  const fetchStatus = useCallback(async (expectedRevision = 0) => {
    if (!tokenomicsEnabled) return;
    const pid = playerIdRef.current;
    if (!pid) return;
    try {
      const data = await playerSync<TokenomicsStatus>('status', { player_id: pid });
      if (!data) { setIncomeStale(true); return false; }
      const revision = Number.isSafeInteger(data.save_revision) ? data.save_revision : 0;
      if (revision < Math.max(expectedRevision, confirmedIncomeRevisionRef.current)) { setIncomeStale(true); return false; }
      confirmedIncomeRevisionRef.current = Math.max(confirmedIncomeRevisionRef.current, revision);
      setStatus(data);
      setIncomeStale(false);
      return true;
    } catch { setIncomeStale(true); }
    return false;
  }, []);

  const refreshIncome = useCallback((expectedRevision = 0): Promise<void> => {
    queuedIncomeRevisionRef.current = Math.max(queuedIncomeRevisionRef.current, expectedRevision);
    if (incomeRefreshInFlightRef.current) return incomeRefreshInFlightRef.current;
    const run = async () => {
      while (true) {
        const targetRevision = queuedIncomeRevisionRef.current;
        queuedIncomeRevisionRef.current = 0;
        const synced = await syncUp();
        if (synced) await fetchStatus(targetRevision);
        else setIncomeStale(true);
        if (queuedIncomeRevisionRef.current <= targetRevision) break;
      }
    };
    const request = run().finally(() => {
      if (incomeRefreshInFlightRef.current === request) incomeRefreshInFlightRef.current = null;
    });
    incomeRefreshInFlightRef.current = request;
    return request;
  }, [fetchStatus, syncUp]);

  const claimTokens = useCallback(async () => {
    if (!tokenomicsEnabled) return null;
    const pid = playerIdRef.current;
    if (!pid) return null;
    setLoading(true);
    try {
      const data = await playerSync<{ pending: number; total_claimed: number; token_balance: number; claimed: number }>('claim', { player_id: pid });
      if (!data) return null;
      setStatus((prev) => prev ? { ...prev, pending_tokens: data.pending, total_claimed: data.total_claimed, token_balance: data.token_balance, boost: prev.boost ? { ...prev.boost, token_balance: data.token_balance } : prev.boost } : prev);
      return { claimed: Number(data.claimed) || 0, tokenBalance: Number(data.token_balance) || 0 };
    } catch { return null; } finally { setLoading(false); }
  }, []);

  const spendTokens = useCallback(async (amount: number, actionKind: string, idempotencyKey = crypto.randomUUID()) => {
    if (!tokenomicsEnabled || amount <= 0) return null;
    try {
      const data = await playerSync<{ spent: number; token_balance: number; boost_tokens_spent: number }>('spend_tokens', {
        amount, action_kind: actionKind, idempotency_key: idempotencyKey,
      });
      if (!data) return null;
      setStatus((prev) => prev ? {
        ...prev,
        token_balance: data.token_balance,
        boost: prev.boost ? { ...prev.boost, token_balance: data.token_balance, tokens_spent: data.boost_tokens_spent } : prev.boost,
      } : prev);
      return data;
    } catch { return null; }
  }, []);

  const setBoostMaxActive = useCallback(async (active: boolean) => {
    if (!tokenomicsEnabled) return null;
    try {
      const data = await playerSync<NonNullable<TokenomicsStatus['boost']>>('set_boost_max_active', { active });
      if (!data) return null;
      setStatus((prev) => prev ? { ...prev, token_balance: data.token_balance, boost: data } : prev);
      await fetchStatus();
      return data;
    } catch { return null; }
  }, [fetchStatus]);

  const summonBoss = useCallback(async (location: number) => {
    if (!tokenomicsEnabled) return null;
    try {
      const data = await playerSync<{ encounter_id: string; remaining_keys: number }>('summon_boss', { location, idempotency_key: crypto.randomUUID() });
      if (!data) return null;
      setStatus((prev) => prev ? { ...prev, boss_keys: Number(data.remaining_keys) } : prev);
      return data;
    } catch { return null; }
  }, []);

  const reserveLimitedItem = useCallback(async (item: OwnedItem) => {
    const base = ITEM_MAP[item.itemId];
    if (!tokenomicsEnabled || !base || (base.rarity !== 'divine' && base.rarity !== 'celestial')) return null;
    try {
      const data = await playerSync<{ item_id: string }>('reserve_limited_item', {
        base_item_id: base.id, slot: base.slot, rarity: base.rarity, item_level: item.level, stats: item.stats,
      });
      return typeof data?.item_id === 'string' ? data.item_id : null;
    } catch { return null; }
  }, []);

  const removeLimitedItem = useCallback(async (itemId: string) => {
    if (!tokenomicsEnabled) return false;
    try {
      const data = await playerSync<{ removed: boolean }>('remove_limited_item', { item_id: itemId });
      return Boolean(data?.removed);
    } catch { return false; }
  }, []);

  useEffect(() => {
    if (!tokenomicsEnabled || !playerId) return;
    let refreshInterval: number | null = null;
    const refresh = () => { void refreshIncome(); };
    const syncRefresh = () => {
      if (refreshInterval !== null) window.clearInterval(refreshInterval);
      refreshInterval = null;
      if (document.visibilityState !== 'visible') return;
      refresh();
      refreshInterval = window.setInterval(refresh, 30_000);
    };
    document.addEventListener('visibilitychange', syncRefresh);
    syncRefresh();
    return () => {
      if (refreshInterval !== null) window.clearInterval(refreshInterval);
      document.removeEventListener('visibilitychange', syncRefresh);
    };
  }, [playerId, refreshIncome]);

  return { status, incomeStale, loading, claimTokens, spendTokens, setBoostMaxActive, summonBoss, reserveLimitedItem, removeLimitedItem, syncUp, fetchStatus, refreshIncome };
}

export type TokenomicsApi = ReturnType<typeof useTokenomics>;
