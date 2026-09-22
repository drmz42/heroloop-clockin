import type { Wallet } from '@wallet-standard/base';
import { authClient, backendUrl, validatedGuestSession } from './backend';
import { isAuthTransient, isTemporaryAuthStatus, runAuthCall } from './authTransient';
import { createSolanaWalletProof, SolanaWalletAuthError } from './solanaWalletAuth';
export {
  compatibleSolanaWallets,
  observeCompatibleSolanaWallets,
  watchSolanaWalletSession,
} from './solanaWalletRegistry';
import { compatibleSolanaWallets } from './solanaWalletRegistry';
import { clearWalletBinding, readWalletBinding, walletBindingExpired, walletBindingRestorable, writeWalletBinding } from './solanaWalletBinding';
export { readWalletBinding, setWalletBindingBoost, walletBindingExpired } from './solanaWalletBinding';

const STORAGE_KEY = 'heroloop.siws.wallet-session.v2';
const TOKEN_PATTERN = /^hlw_[A-Za-z0-9_-]{43}$/;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export const solanaAuthEnabled = env?.VITE_ENABLE_SOLANA_AUTH === 'true';

export type SolanaWalletSession = {
  accountId: string;
  authSubjectId: string;
  address: string;
  expiresAt: string;
  token: string;
  walletName: string;
};

type StoredSession = Omit<SolanaWalletSession, 'walletName'> & { walletName: string };
type Fetch = typeof globalThis.fetch;

export type SolanaSessionOptions = {
  allowExistingAccountLogin?: boolean;
  fetch?: Fetch;
  now?: () => number;
  wallets?: readonly Wallet[];
};

function fail(code: string): never {
  throw new SolanaWalletAuthError(code);
}

// Restoring an account never signs the player out because of a temporary failure - a rejected
// getSession() call included - it throws instead, so the caller can offer Retry while the stored
// identity stays intact.
async function currentAccountSession() {
  const result = await runAuthCall(() => authClient.auth.getSession());
  if (isAuthTransient(result)) fail('wallet_session_temporarily_unavailable');
  return result.data.session;
}

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function parseStored(now = Date.now()): StoredSession | null {
  try {
    const raw = sessionStore()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (!TOKEN_PATTERN.test(value.token ?? '') || !ADDRESS_PATTERN.test(value.address ?? '') ||
      !UUID_PATTERN.test(value.accountId ?? '') || !UUID_PATTERN.test(value.authSubjectId ?? '') ||
      typeof value.walletName !== 'string' ||
      typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= now) return null;
    return value as StoredSession;
  } catch {
    return null;
  }
}

function persist(session: StoredSession): void {
  try {
    const store = sessionStore();
    if (!store) fail('wallet_session_unavailable');
    store.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    fail('wallet_session_unavailable');
  }
}

export function clearSolanaWalletSession(): void {
  try { sessionStore()?.removeItem(STORAGE_KEY); } catch { /* fail closed in memory */ }
  clearWalletBinding();
}

async function json(response: Response): Promise<Record<string, unknown>> {
  if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) fail('wallet_session_unavailable');
  const text = await response.text();
  if (text.length > 16_384) fail('wallet_session_unavailable');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('wallet_session_unavailable');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SolanaWalletAuthError) throw error;
    return fail('wallet_session_unavailable');
  }
}

async function revokeToken(
  backend: string,
  token: string,
  reason: 'logout' | 'wallet_disconnect' | 'account_change' | 'expired_identity',
  fetchImpl: Fetch,
): Promise<void> {
  await fetchImpl(`${backend}/api/v1/auth/solana/session/revoke`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'x-heroloop-wallet-session': token,
      'x-idempotency-key': crypto.randomUUID(),
      'x-wallet-session-reason': reason,
    },
  }).catch(() => undefined);
}

async function linkAnonymousAccount(
  accountSession: { access_token: string; user: { id: string } },
  token: string,
  fetchImpl: Fetch,
): Promise<'existing' | 'linked'> {
  const response = await fetchImpl(`${backendUrl}/api/v1/auth/solana/link`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      authorization: `Bearer ${accountSession.access_token}`,
      'x-heroloop-wallet-session': token,
      'x-idempotency-key': crypto.randomUUID(),
    },
  }).catch(() => fail('wallet_link_unavailable'));
  if (response.status === 409) return 'existing';
  if (!response.ok) fail('wallet_link_unavailable');
  const envelope = await json(response);
  const result = envelope.result as Record<string, unknown> | undefined;
  if (result?.linked !== true || result.account_id !== accountSession.user.id) fail('wallet_link_unavailable');
  return 'linked';
}

export async function connectSolanaWallet(
  wallet: Wallet,
  options: SolanaSessionOptions = {},
): Promise<SolanaWalletSession> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const existing = await validatedGuestSession();
  if (!existing) fail('account_session_unavailable');
  const proof = await createSolanaWalletProof(wallet, {
    challengeEndpoint: `${backendUrl}/api/v1/auth/solana/challenge`,
    fetch: fetchImpl,
    now: options.now,
  });
  const verification = await fetchImpl(`${backendUrl}/api/v1/auth/solana/verify`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(proof),
  }).catch(() => fail('wallet_session_unavailable'));
  if (!verification.ok) fail(verification.status === 429 ? 'wallet_rate_limited' : 'wallet_proof_invalid');
  const envelope = await json(verification);
  const result = envelope.result as Record<string, unknown> | undefined;
  const session = result?.session as Record<string, unknown> | undefined;
  const token = session?.wallet_session_token;
  const expiresAt = session?.expires_at;
  if (result?.verified !== true || result.address !== proof.address || typeof token !== 'string' ||
    !TOKEN_PATTERN.test(token) || typeof expiresAt !== 'string' || Date.parse(expiresAt) <= (options.now ?? Date.now)()) {
    fail('wallet_session_unavailable');
  }

  if (existing.user.is_anonymous !== false) {
    try {
      const link = await linkAnonymousAccount(existing, token, fetchImpl);
      if (link === 'existing' && options.allowExistingAccountLogin !== true) {
        fail('wallet_already_linked');
      }
    } catch (error) {
      await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
      throw error;
    }
  }

  const key = crypto.randomUUID();
  let login: Response;
  try {
    login = await fetchImpl(`${backendUrl}/api/v1/auth/solana/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-heroloop-wallet-session': token,
        'x-idempotency-key': key,
      },
      body: JSON.stringify(proof),
    });
  } catch {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    fail('account_session_unavailable');
  }
  if (!login.ok) {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    fail(login.status === 409 ? 'wallet_already_linked' : 'account_session_unavailable');
  }
  let loginEnvelope: Record<string, unknown>;
  try {
    loginEnvelope = await json(login);
  } catch {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    return fail('account_session_unavailable');
  }
  const loginResult = loginEnvelope.result as Record<string, unknown> | undefined;
  const auth = loginResult?.auth as Record<string, unknown> | undefined;
  if (loginResult?.address !== proof.address || typeof loginResult.account_id !== 'string' ||
    !UUID_PATTERN.test(loginResult.account_id) || typeof loginResult.auth_subject_id !== 'string' ||
    !UUID_PATTERN.test(loginResult.auth_subject_id) || typeof auth?.access_token !== 'string' ||
    typeof auth.refresh_token !== 'string' || auth.token_type !== 'bearer') {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    fail('account_session_unavailable');
  }
  const { data: sessionData, error: sessionError } = await authClient.auth.setSession({
    access_token: auth.access_token,
    refresh_token: auth.refresh_token,
  }).catch(() => ({ data: { session: null }, error: new Error('account_session_unavailable') }));
  if (sessionError || !sessionData.session || sessionData.session.user.id !== loginResult.auth_subject_id) {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    await authClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
    fail('account_session_unavailable');
  }
  const accepted: StoredSession = {
    accountId: loginResult.account_id,
    authSubjectId: loginResult.auth_subject_id,
    address: proof.address,
    expiresAt,
    token,
    walletName: wallet.name,
  };
  try {
    persist(accepted);
    writeWalletBinding({ accountId: accepted.accountId, address: accepted.address, authSubjectId: accepted.authSubjectId, boostMax: false, signedInAt: Date.now(), walletName: accepted.walletName });
  } catch {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    throw new SolanaWalletAuthError('wallet_session_unavailable');
  }
  return accepted;
}

export async function restoreSolanaWalletSession(options: SolanaSessionOptions = {}): Promise<SolanaWalletSession | null> {
  const now = (options.now ?? Date.now)();
  const stored = parseStored(now);
  const wallets = compatibleSolanaWallets(options.wallets);
  const limitBinding = readWalletBinding();
  if (limitBinding && walletBindingExpired(limitBinding, now)) { clearSolanaWalletSession(); return null; }
  if (!stored) {
    // The short-lived wallet proof is missing or expired. Keep the account
    // signed in only while its non-anonymous session belongs to the bound
    // wallet and that wallet still exposes the same address; never prompts.
    const binding = readWalletBinding();
    const session = await currentAccountSession();
    if (binding && walletBindingRestorable(binding, session, wallets)) {
      return { ...binding, expiresAt: new Date(0).toISOString(), token: '' };
    }
    clearSolanaWalletSession();
    return null;
  }
  const wallet = wallets.find((candidate) => candidate.name === stored.walletName &&
    candidate.accounts.some((account) => account.address === stored.address));
  if (!wallet) { clearSolanaWalletSession(); return null; }
  const accountSession = await currentAccountSession();
  if (!accountSession || accountSession.user.id !== stored.authSubjectId) { clearSolanaWalletSession(); return null; }
  const response = await (options.fetch ?? globalThis.fetch)(`${backendUrl}/api/v1/auth/solana/session`, {
    headers: { authorization: `Bearer ${stored.token}` },
    credentials: 'same-origin',
  }).catch(() => null);
  if (!response || isTemporaryAuthStatus(response.status)) fail('wallet_session_temporarily_unavailable');
  if (!response.ok) { clearSolanaWalletSession(); return null; }
  let envelope: Record<string, unknown>;
  try {
    envelope = await json(response);
  } catch {
    clearSolanaWalletSession();
    return null;
  }
  const result = envelope.result as Record<string, unknown> | undefined;
  if (result?.valid !== true || result.address !== stored.address || result.account_id !== stored.accountId ||
    typeof result.expires_at !== 'string' ||
    Date.parse(result.expires_at) !== Date.parse(stored.expiresAt)) {
    clearSolanaWalletSession();
    return null;
  }
  return stored;
}

export async function revokeSolanaWalletSession(
  reason: 'logout' | 'wallet_disconnect' | 'account_change' | 'expired_identity',
  fetchImpl: Fetch = globalThis.fetch,
): Promise<void> {
  const stored = parseStored(0);
  clearSolanaWalletSession();
  if (!stored) return;
  await revokeToken(backendUrl, stored.token, reason, fetchImpl);
}

export async function unlinkSolanaIdentity(
  action: 'unlink' | 'provider_revoke',
  fetchImpl: Fetch = globalThis.fetch,
): Promise<{ accountState: string; unlinked: true }> {
  const stored = parseStored(0);
  if (!stored) fail('wallet_session_unavailable');
  const session = await currentAccountSession();
  if (!session || session.user.id !== stored.authSubjectId) fail('account_session_unavailable');
  const response = await fetchImpl(`${backendUrl}/api/v1/auth/solana/unlink`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
      'x-heroloop-wallet-session': stored.token,
      'x-idempotency-key': crypto.randomUUID(),
    },
    body: JSON.stringify({ action }),
  }).catch(() => fail('wallet_unlink_unavailable'));
  if (!response.ok) {
    if (response.status === 409) fail('last_identity_required');
    if (response.status === 429) fail('wallet_rate_limited');
    fail('wallet_unlink_unavailable');
  }
  const envelope = await json(response);
  const result = envelope.result as Record<string, unknown> | undefined;
  if (result?.unlinked !== true || result.action !== action || typeof result.account_state !== 'string') {
    fail('wallet_unlink_unavailable');
  }
  clearSolanaWalletSession();
  await authClient.auth.signOut({ scope: 'local' }).catch(() => undefined);
  return { accountState: result.account_state, unlinked: true };
}
