import { createClient } from '@supabase/supabase-js';

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
export const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
export const tokenomicsEnabled = import.meta.env.VITE_ENABLE_TOKENOMICS !== 'false';
// Client-side token accrual is never safe for a value-bearing economy.
export const demoTokenomicsEnabled = import.meta.env.VITE_DEMO_TOKENOMICS === 'true';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function authHeaders(refresh = false): Promise<Record<string, string> | null> {
  let { data: { session } } = await supabase.auth.getSession();
  if (refresh && session) {
    const refreshed = await supabase.auth.refreshSession();
    session = refreshed.data.session;
  }
  if (!session) {
    if (refresh) return null;
    const { data } = await supabase.auth.signInAnonymously();
    session = data.session;
  }
  return session ? {
    'Content-Type': 'application/json',
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${session.access_token}`,
  } : null;
}

export async function playerSync<T>(
  action: string,
  payload: Record<string, unknown> = {},
  onError?: (message: string) => void,
  networkRetry = 0,
): Promise<T | null> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = await authHeaders(attempt === 1);
      if (!headers) return null;
      const response = await fetch(`${supabaseUrl}/functions/v1/player-sync`, {
        method: 'POST', headers, body: JSON.stringify({ action, ...payload }),
      });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) {
        const detail = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
        const message = detail.error ?? `HTTP ${response.status}`;
        onError?.(message);
        if (action === 'spend_tokens' || action === 'hero_ascend') {
          const label = action === 'hero_ascend' ? 'Ascension' : '$HERO purchase';
          window.alert(`${label} failed: ${message}`);
        }
        return null;
      }
      return response.json() as Promise<T>;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network_error';
    const retrySafe = typeof payload.idempotency_key === 'string' && (
      action === 'hero_summon' || action === 'hero_ascend' || action === 'spend_tokens' || action === 'chest_open'
      || action === 'item_mutate' || action === 'item_equip' || action === 'market_list_item'
      || action === 'market_cancel_listing' || action === 'market_buy_listing' || action === 'store_buy_item'
    );
    if (retrySafe && networkRetry < 1) return playerSync<T>(action, payload, onError, networkRetry + 1);
    onError?.(message);
    if (action === 'spend_tokens' || action === 'hero_ascend') {
      const label = action === 'hero_ascend' ? 'Ascension' : '$HERO purchase';
      window.alert(`${label} failed: ${message}`);
    }
  }
  return null;
}
