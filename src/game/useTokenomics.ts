import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const tokenomicsEnabled = import.meta.env.VITE_ENABLE_TOKENOMICS === 'true';

const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
}

export function useTokenomics(power: number, accountLevel: number, username: string, playerId: string | null) {
  const [status, setStatus] = useState<TokenomicsStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const powerRef = useRef(power);
  const playerIdRef = useRef(playerId);
  powerRef.current = power;
  playerIdRef.current = playerId;

  const authHeaders = useCallback(async () => {
    let { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      const { data } = await supabase.auth.signInAnonymously();
      session = data.session;
    }
    return session ? {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${session.access_token}`,
    } : null;
  }, []);

  const syncUp = useCallback(async () => {
    if (!tokenomicsEnabled) return;
    const pid = playerIdRef.current;
    if (!pid) return;
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
          account_level: accountLevel,
          username,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.pending_tokens !== undefined) {
        setStatus((prev) => prev ? { ...prev, pending_tokens: data.pending_tokens, total_claimed: data.total_claimed } : prev);
      }
    } catch { /* silent */ }
  }, [accountLevel, username, authHeaders]);

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
    if (!tokenomicsEnabled) return 0;
    const pid = playerIdRef.current;
    if (!pid) return 0;
    setLoading(true);
    try {
      const headers = await authHeaders();
      if (!headers) return 0;
      const res = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'claim', player_id: pid }),
      });
      if (!res.ok) return 0;
      const data = await res.json();
      setStatus((prev) => prev ? { ...prev, pending_tokens: data.pending, total_claimed: data.total_claimed } : prev);
      return data.claimed || 0;
    } catch { return 0; } finally { setLoading(false); }
  }, [authHeaders]);

  useEffect(() => {
    if (!tokenomicsEnabled || !playerId) return;
    syncUp();
    fetchStatus();
    const syncInterval = setInterval(syncUp, 30_000);
    const statusInterval = setInterval(fetchStatus, 30_000);
    return () => { clearInterval(syncInterval); clearInterval(statusInterval); };
  }, [playerId, syncUp, fetchStatus]);

  return { status, loading, claimTokens, syncUp, fetchStatus };
}
