import { createClient, type Session } from '@supabase/supabase-js';

export const backendMode = import.meta.env.VITE_BACKEND_MODE === 'selfhosted' ? 'selfhosted' : 'supabase';
export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
export const selfhostedUrl = (import.meta.env.VITE_SELFHOSTED_URL as string | undefined)?.replace(/\/$/, '')
  || window.location.origin;
export const backendUrl = backendMode === 'selfhosted' ? selfhostedUrl : supabaseUrl;
export const supabaseAnonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)
  || 'selfhosted-public-auth';
export const tokenomicsEnabled = import.meta.env.VITE_ENABLE_TOKENOMICS !== 'false';
// Client-side token accrual is never safe for a value-bearing economy.
export const demoTokenomicsEnabled = import.meta.env.VITE_DEMO_TOKENOMICS === 'true';

// GoTrue retains the supported Supabase Auth protocol after the database/API exit.
export const supabase = createClient(backendUrl, supabaseAnonKey);

let replacementSession: Promise<Session | null> | null = null;

async function replaceLocalSession(): Promise<Session | null> {
  if (!replacementSession) {
    replacementSession = (async () => {
      // A session from an older backend/project cannot be refreshed. Clear only
      // this browser's auth state, then establish a fresh anonymous identity.
      await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
      const { data, error } = await supabase.auth.signInAnonymously();
      return error ? null : data.session;
    })().finally(() => {
      replacementSession = null;
    });
  }
  return replacementSession;
}

export async function validatedGuestSession(): Promise<Session | null> {
  let session: Session | null = null;
  try {
    ({ data: { session } } = await supabase.auth.getSession());
  } catch {
    // Corrupt local auth state is replaced below.
  }
  if (session?.user.is_anonymous === false) return session;
  if (session) {
    try {
      const { data, error } = await supabase.auth.getUser(session.access_token);
      if (!error && data.user?.id === session.user.id && data.user.is_anonymous === true) return session;
      if (error && ![400, 401, 403].includes(error.status ?? 0)) return null;
    } catch {
      return null;
    }
  }
  return replaceLocalSession();
}

export async function authHeaders(refresh = false): Promise<Record<string, string> | null> {
  let session: Session | null = null;
  try {
    ({ data: { session } } = await supabase.auth.getSession());
  } catch {
    // Corrupt or obsolete browser auth storage must not strand onboarding
    // before its first API request. replaceLocalSession clears only this
    // browser identity and establishes a fresh anonymous session.
  }
  if (refresh && session) {
    const { data, error } = await supabase.auth.refreshSession();
    session = error ? null : data.session;
  }
  if (!session) {
    session = await replaceLocalSession();
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
      const idempotencyKey = typeof payload.idempotency_key === 'string' ? payload.idempotency_key : undefined;
      const commandPayload = { ...payload };
      delete commandPayload.idempotency_key;
      if (backendMode === 'selfhosted') delete commandPayload.player_id;
      const endpoint = backendMode === 'selfhosted'
        ? `${backendUrl}/api/v1/player/commands`
        : `${supabaseUrl}/functions/v1/player-sync`;
      const body = backendMode === 'selfhosted'
        ? {
          contract_version: 1,
          action,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
          payload: commandPayload,
        }
        : { action, ...payload };
      const response = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) {
        const detail = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as {
          error?: string;
          code?: string;
          revision?: number;
          result?: Record<string, unknown>;
        };
        const message = detail.code ?? detail.error ?? `HTTP ${response.status}`;
        onError?.(message);
        if (backendMode === 'selfhosted' && action === 'game_state_save'
          && response.status === 409 && detail.code === 'state_conflict' && detail.result) {
          return {
            ...detail.result,
            ...(detail.revision === undefined ? {} : { revision: detail.revision }),
          } as T;
        }
        if (action === 'spend_tokens' || action === 'hero_ascend') {
          const label = action === 'hero_ascend' ? 'Ascension' : '$HERO purchase';
          window.alert(`${label} failed: ${message}`);
        }
        return null;
      }
      const responseBody = await response.json() as T | {
        ok: true;
        revision?: number;
        result: Record<string, unknown>;
      };
      if (backendMode !== 'selfhosted') return responseBody as T;
      const envelope = responseBody as { revision?: number; result: Record<string, unknown> };
      return {
        ...envelope.result,
        ...(envelope.revision === undefined ? {} : { revision: envelope.revision }),
      } as T;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network_error';
    const retrySafe = typeof payload.idempotency_key === 'string' && (
      action === 'hero_summon' || action === 'hero_ascend' || action === 'hero_release' || action === 'hero_capacity_upgrade' || action === 'ascension_focus_set' || action === 'promo_redeem' || action === 'spend_tokens' || action === 'chest_open'
      || action === 'training_assignment_set'
      || action === 'tutorial_quest_claim' || action === 'quest_claim' || action === 'tutorial_chest_open'
      || action === 'item_mutate' || action === 'item_equip' || action === 'item_upgrade' || action === 'market_list_item'
      || action === 'market_cancel_listing' || action === 'market_buy_listing' || action === 'store_buy_item'
      || action === 'dungeon_start' || action === 'dungeon_room_start' || action === 'dungeon_room_action'
      || action === 'dungeon_room_complete' || action === 'dungeon_room_choose' || action === 'dungeon_abandon'
      || action === 'summon_boss' || action === 'boss_claim'
      || action === 'normal_combat_start' || action === 'normal_combat_complete'
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
