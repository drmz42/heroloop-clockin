import assert from 'node:assert/strict';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { authFetch, isAuthTransient, isTemporaryAuthStatus, isTransientAuthError, runAuthCall } from '../src/game/authTransient.ts';

const KEY = 'sb-staging-auth-token';
const storedSession = {
  access_token: 'expired-access',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) - 60,
  refresh_token: 'refresh-1',
  user: { id: '123e4567-e89b-42d3-a456-426614174000', is_anonymous: true },
};

type Reply = { status: number; body?: unknown } | 'network';

async function refreshWith(reply: Reply, useAuthFetch = true) {
  const store = new Map<string, string>([[KEY, JSON.stringify(storedSession)]]);
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let offset = 0;
  const calls: string[] = [];
  // Each request advances the clock past auth-js's 30 s retry window, so a retryable
  // failure is reported once instead of being retried with real back-off delays.
  Date.now = () => realNow() + offset;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    offset += 31_000;
    if (reply === 'network') throw new TypeError('fetch failed');
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = createClient('https://staging.heroloop.xyz', 'selfhosted-public-auth', {
      auth: { storage, storageKey: KEY, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: useAuthFetch ? authFetch : (input, init) => globalThis.fetch(input, init) },
    });
    const result = await client.auth.getSession();
    return { result, kept: store.has(KEY), stored: store.get(KEY), calls };
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
}

test('temporary statuses are network, rate limit and server errors only', () => {
  for (const status of [0, 429, 500, 502, 503, 504, 520]) assert.equal(isTemporaryAuthStatus(status), true, String(status));
  for (const status of [200, 400, 401, 403, 404, 409, 422]) assert.equal(isTemporaryAuthStatus(status), false, String(status));
  assert.equal(isTransientAuthError(null), false);
  // A missing status (e.g. auth-js's AuthUnknownError) must NOT be treated as transient - only a
  // status auth-js itself attached counts, so an unidentified error can't be retried forever.
  assert.equal(isTransientAuthError({}), false);
  assert.equal(isTransientAuthError({ status: 429 }), true);
  assert.equal(isTransientAuthError({ status: 400 }), false);
});

test('runAuthCall folds a rejected call into the same signal as a resolved transient error', async () => {
  const rejected = await runAuthCall(() => Promise.reject(new Error('storage write failed')));
  assert.equal(isAuthTransient(rejected), true);

  const resolvedTransient = await runAuthCall(async () => ({ data: { session: null }, error: { status: 429 } }));
  assert.equal(isAuthTransient(resolvedTransient), true);

  const resolvedPermanent = await runAuthCall(async () => ({ data: { session: null }, error: { status: 400 } }));
  assert.equal(isAuthTransient(resolvedPermanent), false);

  const resolvedOk = await runAuthCall(async () => ({ data: { session: 'ok' }, error: null }));
  assert.equal(isAuthTransient(resolvedOk), false);
  if (!isAuthTransient(resolvedOk)) assert.equal(resolvedOk.data.session, 'ok');
});

for (const [label, reply] of [
  ['rate limit 429', { status: 429, body: { code: 'over_request_rate_limit', msg: 'slow down' } }],
  ['server error 500', { status: 500, body: { msg: 'boom' } }],
  ['network failure', 'network'],
] as const) {
  test(`${label} during refresh keeps the stored identity`, async () => {
    const { result, kept, calls } = await refreshWith(reply);
    assert.ok(calls[0]?.endsWith('/auth/v1/token?grant_type=refresh_token'));
    assert.equal(result.data.session, null);
    assert.equal(isTransientAuthError(result.error), true);
    assert.equal(kept, true);
  });
}

test('an explicit refresh rejection still clears the session', async () => {
  const { result, kept } = await refreshWith({ status: 400, body: { code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } });
  assert.equal(result.data.session, null);
  assert.equal(result.error?.status, 400);
  assert.equal(isTransientAuthError(result.error), false);
  assert.equal(kept, false);
});

test('without authFetch the library erases the identity on 429', async () => {
  const { kept } = await refreshWith({ status: 429, body: { msg: 'slow down' } }, false);
  assert.equal(kept, false);
});

test('a successful refresh passes through unchanged and is stored', async () => {
  const { result, stored } = await refreshWith({ status: 200, body: {
    access_token: 'fresh-access', token_type: 'bearer', expires_in: 3600, refresh_token: 'refresh-2', user: storedSession.user,
  } });
  assert.equal(result.error, null);
  assert.equal(result.data.session?.access_token, 'fresh-access');
  assert.equal(JSON.parse(stored ?? '{}').refresh_token, 'refresh-2');
});
