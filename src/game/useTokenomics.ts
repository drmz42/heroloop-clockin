import { useCallback, useEffect, useRef, useState } from 'react';
import { ITEM_MAP } from '@/game/items';
import type { OwnedItem } from '@/game/types';
import type { Rarity } from '@/game/types';
import { authHeaders as getAuthHeaders, supabaseUrl, tokenomicsEnabled } from '@/game/backend';

export interface TokenomicsStatus {
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
  resource_state?: unknown;
  resource_revision?: number | null;
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
  const powerRef = useRef(power);
  const playerIdRef = useRef(playerId);
  const accountLevelRef = useRef(accountLevel);
  const usernameRef = useRef(username);
  const statsRef = useRef(stats);
  powerRef.current = power;
  playerIdRef.current = playerId;
  accountLevelRef.current = accountLevel;
  usernameRef.current = username;
  statsRef.current = stats;

  const authHeaders = useCallback(() => getAuthHeaders(), []);

  const syncUp = useCallback(async () => {
    if (!tokenomicsEnabled) return;
    const pid = playerIdRef.current;
    if (!pid) return;
    const currentStats = statsRef.current;
    try {
      const headers = await authHeaders();
      if (!headers) return;
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'sync',
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
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.pending_tokens !== undefined) {
        setStatus((prev) => prev ? { ...prev, pending_tokens: data.pending_tokens, total_claimed: data.total_claimed } : prev);
      }
    } catch { /* silent */ }
  }, [authHeaders]);

  const fetchStatus = useCallback(async () => {
    if (!tokenomicsEnabled) return;
    const pid = playerIdRef.current;
    if (!pid) return;
    try {
      const headers = await authHeaders();
      if (!headers) return;
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'status', player_id: pid }),
      });
      if (!res.ok) return;
      const data: TokenomicsStatus = await res.json();
      setStatus(data);
    } catch { /* silent */ }
  }, [authHeaders]);

  const claimTokens = useCallback(async () => {
    if (!tokenomicsEnabled) return null;
    const pid = playerIdRef.current;
    if (!pid) return null;
    setLoading(true);
    try {
      const headers = await authHeaders();
      if (!headers) return null;
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'claim', player_id: pid }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      setStatus((prev) => prev ? { ...prev, pending_tokens: data.pending, total_claimed: data.total_claimed, token_balance: data.token_balance, boost: prev.boost ? { ...prev.boost, token_balance: data.token_balance } : prev.boost } : prev);
      return { claimed: Number(data.claimed) || 0, tokenBalance: Number(data.token_balance) || 0 };
    } catch { return null; } finally { setLoading(false); }
  }, [authHeaders]);

  const spendTokens = useCallback(async (amount: number, actionKind: string, idempotencyKey = crypto.randomUUID()) => {
    if (!tokenomicsEnabled || amount <= 0) return null;
    const headers = await authHeaders();
    if (!headers) return null;
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST', headers,
        body: JSON.stringify({ action: 'spend_tokens', amount, action_kind: actionKind, idempotency_key: idempotencyKey }),
      });
      if (!res.ok) return null;
      const data = await res.json() as { spent: number; token_balance: number; boost_tokens_spent: number };
      setStatus((prev) => prev ? {
        ...prev,
        token_balance: data.token_balance,
        boost: prev.boost ? { ...prev.boost, token_balance: data.token_balance, tokens_spent: data.boost_tokens_spent } : prev.boost,
      } : prev);
      return data;
    } catch { return null; }
  }, [authHeaders]);

  const setBoostMaxActive = useCallback(async (active: boolean) => {
    if (!tokenomicsEnabled) return null;
    const headers = await authHeaders();
    if (!headers) return null;
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST', headers,
        body: JSON.stringify({ action: 'set_boost_max_active', active }),
      });
      if (!res.ok) return null;
      const data = await res.json() as NonNullable<TokenomicsStatus['boost']>;
      setStatus((prev) => prev ? { ...prev, token_balance: data.token_balance, boost: data } : prev);
      return data;
    } catch { return null; }
  }, [authHeaders]);

  const summonBoss = useCallback(async (location: number) => {
    if (!tokenomicsEnabled) return null;
    const headers = await authHeaders();
    if (!headers) return null;
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST', headers,
        body: JSON.stringify({ action: 'summon_boss', location }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      setStatus((prev) => prev ? { ...prev, boss_keys: Number(data.remaining_keys) } : prev);
      return data as { encounter_id: string; remaining_keys: number };
    } catch { return null; }
  }, [authHeaders]);

  const reserveLimitedItem = useCallback(async (item: OwnedItem) => {
    const base = ITEM_MAP[item.itemId];
    if (!tokenomicsEnabled || !base || (base.rarity !== 'divine' && base.rarity !== 'celestial')) return null;
    const headers = await authHeaders();
    if (!headers) return null;
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST', headers,
        body: JSON.stringify({
          action: 'reserve_limited_item', base_item_id: base.id, slot: base.slot,
          rarity: base.rarity, item_level: item.level, stats: item.stats,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.item_id === 'string' ? data.item_id : null;
    } catch { return null; }
  }, [authHeaders]);

  const removeLimitedItem = useCallback(async (itemId: string) => {
    if (!tokenomicsEnabled) return false;
    const headers = await authHeaders();
    if (!headers) return false;
    try {
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST', headers,
        body: JSON.stringify({ action: 'remove_limited_item', item_id: itemId }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data.removed);
    } catch { return false; }
  }, [authHeaders]);

  useEffect(() => {
    if (!tokenomicsEnabled || !playerId) return;
    const refresh = async () => {
      await syncUp();
      await fetchStatus();
    };
    void refresh();
    const refreshInterval = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(refreshInterval);
  }, [playerId, syncUp, fetchStatus]);

  return { status, loading, claimTokens, spendTokens, setBoostMaxActive, summonBoss, reserveLimitedItem, removeLimitedItem, syncUp, fetchStatus };
}

export type TokenomicsApi = ReturnType<typeof useTokenomics>;
