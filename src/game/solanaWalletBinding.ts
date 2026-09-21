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
  walletName: string;
};

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
      !UUID_PATTERN.test(value.authSubjectId ?? '') || typeof value.walletName !== 'string' || !value.walletName) return null;
    return { accountId: value.accountId!, address: value.address!, authSubjectId: value.authSubjectId!, walletName: value.walletName };
  } catch {
    return null;
  }
}

export function writeWalletBinding(binding: WalletBinding, store: Storage | null = localStore()): void {
  try { store?.setItem(BINDING_KEY, JSON.stringify(binding)); } catch { /* the proof session still works without it */ }
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
