import type { Wallet } from '@wallet-standard/base';
import { backendUrl, supabase } from './backend';
import { createSolanaWalletProof, SolanaWalletAuthError } from './solanaWalletAuth';
export {
  compatibleSolanaWallets,
  observeCompatibleSolanaWallets,
  watchSolanaWalletSession,
} from './solanaWalletRegistry';
import { compatibleSolanaWallets } from './solanaWalletRegistry';

const STORAGE_KEY = 'heroloop.siws.wallet-session.v1';
const TOKEN_PATTERN = /^hlw_[A-Za-z0-9_-]{43}$/;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export const solanaAuthEnabled = env?.VITE_ENABLE_SOLANA_AUTH === 'true';

export type SolanaWalletSession = {
  accountId: string;
  address: string;
  expiresAt: string;
  token: string;
  walletName: string;
};

type StoredSession = Omit<SolanaWalletSession, 'walletName'> & { walletName: string };
type Fetch = typeof globalThis.fetch;

export type SolanaSessionOptions = {
  fetch?: Fetch;
  now?: () => number;
  wallets?: readonly Wallet[];
};

function fail(code: string): never {
  throw new SolanaWalletAuthError(code);
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
      !UUID_PATTERN.test(value.accountId ?? '') || typeof value.walletName !== 'string' ||
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

export async function connectSolanaWallet(
  wallet: Wallet,
  options: SolanaSessionOptions = {},
): Promise<SolanaWalletSession> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const existing = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  if (existing.data.session?.user.is_anonymous === false) fail('account_session_conflict');
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
    !UUID_PATTERN.test(loginResult.account_id) || typeof auth?.access_token !== 'string' ||
    typeof auth.refresh_token !== 'string' || auth.token_type !== 'bearer') {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    fail('account_session_unavailable');
  }
  const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
    access_token: auth.access_token,
    refresh_token: auth.refresh_token,
  }).catch(() => ({ data: { session: null }, error: new Error('account_session_unavailable') }));
  if (sessionError || !sessionData.session || sessionData.session.user.id !== loginResult.account_id) {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    fail('account_session_unavailable');
  }
  const accepted: StoredSession = {
    accountId: loginResult.account_id,
    address: proof.address,
    expiresAt,
    token,
    walletName: wallet.name,
  };
  try {
    persist(accepted);
  } catch {
    await revokeToken(backendUrl, token, 'expired_identity', fetchImpl);
    throw new SolanaWalletAuthError('wallet_session_unavailable');
  }
  return accepted;
}

export async function restoreSolanaWalletSession(options: SolanaSessionOptions = {}): Promise<SolanaWalletSession | null> {
  const now = (options.now ?? Date.now)();
  const stored = parseStored(now);
  if (!stored) { clearSolanaWalletSession(); return null; }
  const wallets = compatibleSolanaWallets(options.wallets);
  const wallet = wallets.find((candidate) => candidate.name === stored.walletName &&
    candidate.accounts.some((account) => account.address === stored.address));
  if (!wallet) { clearSolanaWalletSession(); return null; }
  const { data: { session: accountSession } } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  if (!accountSession || accountSession.user.id !== stored.accountId) { clearSolanaWalletSession(); return null; }
  const response = await (options.fetch ?? globalThis.fetch)(`${backendUrl}/api/v1/auth/solana/session`, {
    headers: { authorization: `Bearer ${stored.token}` },
    credentials: 'same-origin',
  }).catch(() => null);
  if (!response?.ok) { clearSolanaWalletSession(); return null; }
  let envelope: Record<string, unknown>;
  try {
    envelope = await json(response);
  } catch {
    clearSolanaWalletSession();
    return null;
  }
  const result = envelope.result as Record<string, unknown> | undefined;
  if (result?.valid !== true || result.address !== stored.address || result.account_id !== stored.accountId ||
    result.expires_at !== stored.expiresAt) {
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
