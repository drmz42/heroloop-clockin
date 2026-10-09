import { isolatedHackathon, editionStorageKey } from './editionStorage';
import { createClient, type Session } from '@supabase/supabase-js';
import { authFetch, isAuthTransient, runAuthCall } from './authTransient';

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
export const authClient = createClient(backendUrl, supabaseAnonKey, { global: { fetch: authFetch }, ...(isolatedHackathon ? { auth: { storageKey: editionStorageKey('auth') } } : {}) });

let replacementSession: Promise<Session | null> | null = null;

async function replaceLocalSession(): Promise<Session | null> {
  if (!replacementSession) {
    replacementSession = (async () => {
      // A session from an older backend/project cannot be refreshed. Clear only
      // this browser's auth state, then establish a fresh anonymous identity.
      await authClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
      const { data, error } = await authClient.auth.signInAnonymously();
      return error ? null : data.session;
    })().finally(() => {
      replacementSession = null;
    });
  }
  return replacementSession;
}

export async function validatedGuestSession(): Promise<Session | null> {
  const sessionResult = await runAuthCall(() => authClient.auth.getSession());
  if (isAuthTransient(sessionResult)) return null;
  const session = sessionResult.data.session;
  if (session?.user.is_anonymous === false) return session;
  if (session) {
    try {
      const { data, error } = await authClient.auth.getUser(session.access_token);
      if (!error && data.user?.id === session.user.id && data.user.is_anonymous === true) return session;
      if (error && ![400, 401, 403].includes(error.status ?? 0)) return null;
    } catch {
      return null;
    }
  }
  return replaceLocalSession();
}

export async function authHeaders(refresh = false): Promise<Record<string, string> | null> {
  // A genuinely corrupt/malformed stored session still resolves cleanly to session: null (the SDK
  // clears it itself) and falls through to replaceLocalSession below. runAuthCall only intercepts
  // an actual rejection (e.g. a storage write throwing during an internal refresh) or a resolved
  // transient status - both mean "try again shortly", not "this identity is gone".
  const sessionResult = await runAuthCall(() => authClient.auth.getSession());
  if (isAuthTransient(sessionResult)) return null;
  let session = sessionResult.data.session;
  if (refresh && session) {
    const refreshResult = await runAuthCall(() => authClient.auth.refreshSession());
    if (isAuthTransient(refreshResult)) return null;
    session = refreshResult.error ? null : refreshResult.data.session;
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

// Seconds from the latest 429 Retry-After header, for messages such as the Boss summon cooldown.
let lastRetryAfter = 30;
export const lastRetryAfterSeconds = () => lastRetryAfter;

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
        const code = detail.code ?? detail.error ?? `HTTP ${response.status}`;
        if (response.status === 429) lastRetryAfter = Math.max(1, Number(response.headers.get('retry-after')) || 30);
        // A Staging kill switch paused this command before it touched state.
        const message = code === 'feature_paused' ? 'This feature is paused for maintenance. Please try again later.' : code;
        onError?.(message);
        if (backendMode === 'selfhosted' && action === 'game_state_save'
          && response.status === 409 && detail.code === 'state_conflict' && detail.result) {
          return {
            ...detail.result,
            ...(detail.revision === undefined ? {} : { revision: detail.revision }),
          } as T;
        }
        if ((action === 'spend_tokens' || action === 'hero_ascend') && !isolatedHackathon) {
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
      || action === 'training_assignment_set' || action === 'reward_boost_buy' || action === 'shop_bundle_buy' || action === 'inventory_bag_buy'
      || action === 'tutorial_quest_claim' || action === 'quest_claim' || action === 'tutorial_chest_open' || action === 'dungeon_chest_open'
      || action === 'item_mutate' || action === 'item_equip' || action === 'item_upgrade' || action === 'market_list_item'
      || action === 'market_cancel_listing' || action === 'market_buy_listing' || action === 'store_buy_item'
      || action === 'dungeon_start' || action === 'dungeon_room_start' || action === 'dungeon_room_action'
      || action === 'dungeon_room_complete' || action === 'dungeon_room_choose' || action === 'dungeon_abandon'
      || action === 'summon_boss' || action === 'boss_claim' || action === 'premium_potion_upgrade' || action === 'premium_potion_use'
      || action === 'normal_combat_start' || action === 'normal_combat_complete' || action === 'player_report'
      || action === 'support_ticket_submit' || action === 'partner_quest_claim' || action === 'mail_claim' || action === 'seeker_event_claim'
    );
    if (retrySafe && networkRetry < 1) return playerSync<T>(action, payload, onError, networkRetry + 1);
    onError?.(message);
    if ((action === 'spend_tokens' || action === 'hero_ascend') && !isolatedHackathon) {
      const label = action === 'hero_ascend' ? 'Ascension' : '$HERO purchase';
      window.alert(`${label} failed: ${message}`);
    }
  }
  return null;
}
