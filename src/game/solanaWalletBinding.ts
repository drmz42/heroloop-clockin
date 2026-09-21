import type { Wallet } from '@wallet-standard/base';

const BINDING_KEY = 'heroloop.siws.wallet-binding.v1';
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Non-secret record of which wallet and account a browser is signed in with.
 * It carries no bearer: the short-lived wallet proof stays in sessionStorage,
 * while this binding lets a returning tab keep its account session after the
 * proof expires, as long as the same wallet is still exposed by the browser.
 */
export type WalletBinding = {
  accountId: string;
  address: string;
  authSubjectId: string;
  /** Last server-confirmed Boost Max state; it extends the session limit. */
  boostMax: boolean;
  /** Epoch milliseconds of the wallet sign-in that created this binding. */
  signedInAt: number;
  walletName: string;
};

/** A sign-in lasts as long as the offline-earnings window: 8 hours, or 24 hours with Boost Max. */
export const WALLET_SESSION_LIMIT_MS = 8 * 60 * 60 * 1_000;
export const WALLET_SESSION_BOOST_LIMIT_MS = 24 * 60 * 60 * 1_000;

export function walletBindingExpired(binding: WalletBinding, now = Date.now()): boolean {
  return now - binding.signedInAt >= (binding.boostMax ? WALLET_SESSION_BOOST_LIMIT_MS : WALLET_SESSION_LIMIT_MS);
}

function localStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readWalletBinding(store: Storage | null = localStore()): WalletBinding | null {
  try {
    const raw = store?.getItem(BINDING_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<WalletBinding>;
    if (!ADDRESS_PATTERN.test(value.address ?? '') || !UUID_PATTERN.test(value.accountId ?? '') ||
      !UUID_PATTERN.test(value.authSubjectId ?? '') || typeof value.walletName !== 'string' || !value.walletName ||
      !Number.isSafeInteger(value.signedInAt) || (value.signedInAt as number) <= 0 || typeof value.boostMax !== 'boolean') return null;
    return {
      accountId: value.accountId!, address: value.address!, authSubjectId: value.authSubjectId!,
      boostMax: value.boostMax, signedInAt: value.signedInAt as number, walletName: value.walletName,
    };
  } catch {
    return null;
  }
}

export function writeWalletBinding(binding: WalletBinding, store: Storage | null = localStore()): void {
  try { store?.setItem(BINDING_KEY, JSON.stringify(binding)); } catch { /* the proof session still works without it */ }
}

/** Records the server-confirmed Boost Max state so a returning tab knows its 8h or 24h limit. */
export function setWalletBindingBoost(boostMax: boolean, store: Storage | null = localStore()): void {
  const binding = readWalletBinding(store);
  if (binding && binding.boostMax !== boostMax) writeWalletBinding({ ...binding, boostMax }, store);
}

export function clearWalletBinding(store: Storage | null = localStore()): void {
  try { store?.removeItem(BINDING_KEY); } catch { /* nothing else to clear */ }
}

/** True only for a signed-in non-anonymous account of this binding whose wallet still exposes the bound address. */
export function walletBindingRestorable(
  binding: WalletBinding,
  accountSession: { user: { id: string; is_anonymous?: boolean } } | null,
  wallets: readonly Wallet[],
): boolean {
  return Boolean(accountSession) && accountSession!.user.is_anonymous !== true &&
    accountSession!.user.id === binding.authSubjectId &&
    wallets.some((wallet) => wallet.name === binding.walletName &&
      wallet.accounts.some((account) => account.address === binding.address));
}
