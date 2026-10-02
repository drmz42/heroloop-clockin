// Seeker in-game wallet: SKR/SOL deposits into the private ledger (docs/game/seeker-skr-payments.md).
// The server builds the exact unsigned transfer; the player's wallet only signs and sends it.
// Balances, history and crediting come from the server, never from this client.
import { useSyncExternalStore } from 'react';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { playerSync } from './backend';
import { compatibleSolanaWallets } from './solanaWalletRegistry';
import { nativeMwaSession, readWalletBinding } from './solanaWalletSession';
import { mobileWalletAppIdentity } from '@/platform/platform';

export type WalletAsset = 'SKR' | 'SOL';
export const ASSET_DECIMALS: Record<WalletAsset, number> = { SKR: 6, SOL: 9 };

export type WalletChain = { cluster: 'devnet' | 'mainnet'; skr_mint: string; treasury: string };
export type WalletHistoryRow = { event_id: string; kind: string; asset: WalletAsset; delta_minor: string; signature: string | null; at: string };
export type WalletSnapshot = {
  balances: Record<WalletAsset, string>;
  pending_deposits: { intent_id: string; asset: WalletAsset; amount_minor: string; expires_at: string }[];
  history: WalletHistoryRow[];
  chain: WalletChain;
};
type DepositIntent = { intent_id: string; asset: WalletAsset; amount_minor: string; payer: string; transaction: string; chain: WalletChain };
type ConfirmResult = { status: 'settled' | 'pending' | 'expired'; signature?: string };

export class SeekerWalletError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/** "1.5" from 1500000 minimal SKR units, trimmed. */
export function formatMinor(minor: string, asset: WalletAsset, maxFraction = 4): string {
  const decimals = ASSET_DECIMALS[asset];
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).padStart(decimals + 1, '0');
  const whole = BigInt(digits.slice(0, -decimals)).toLocaleString('en-US');
  const fraction = digits.slice(-decimals).slice(0, maxFraction).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

async function command<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  let code = 'wallet_unavailable';
  const result = await playerSync<T>(action, payload, (message) => { code = message; });
  if (!result) throw new SeekerWalletError(code);
  return result;
}

// One shared snapshot for every SKR display (top bar, wallet). It refreshes on
// first use, every 60 s and when the app becomes visible again, and right after
// each deposit settles; callers that change SKR call refreshWallet().
let current: WalletSnapshot | null = null;
let inflight: Promise<WalletSnapshot> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

export function refreshWallet(): Promise<WalletSnapshot> {
  inflight ??= command<WalletSnapshot>('wallet_snapshot')
    .then((snapshot) => {
      current = snapshot;
      listeners.forEach((listener) => listener());
      return snapshot;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
export const loadWalletSnapshot = refreshWallet;

function onVisible() {
  if (document.visibilityState === 'visible') void refreshWallet().catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshWallet().catch(() => undefined);
    timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshWallet().catch(() => undefined); }, 60_000);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

/** The latest server wallet snapshot (null until the first load). */
export function useWalletSnapshot(): WalletSnapshot | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** The signing wallet bound to this account session (address and wallet name). */
export function boundWallet(): { address: string; walletName: string } | null {
  const binding = readWalletBinding();
  return binding ? { address: binding.address, walletName: binding.walletName } : null;
}

async function signAndSend(transaction: string, chain: WalletChain, payer: string, walletName: string): Promise<string> {
  const chainId = `solana:${chain.cluster}` as const;
  if (nativeMwaSession(walletName)) {
    const [{ transact }, { base64ToUint8Array }] = await Promise.all([
      import('@solana-mobile/mobile-wallet-adapter-protocol'),
      import('@solana-mobile/mobile-wallet-adapter-protocol/encoding'),
    ]);
    return transact(async (wallet) => {
      const authorization = await wallet.authorize({ chain: chainId, identity: mobileWalletAppIdentity() });
      const account = authorization.accounts.find((entry) => base58(base64ToUint8Array(entry.address)) === payer);
      if (!account) throw new SeekerWalletError('wallet_account_mismatch');
      const { signatures } = await wallet.signAndSendTransactions({ payloads: [transaction] });
      if (signatures.length !== 1) throw new SeekerWalletError('wallet_send_failed');
      return base58(base64ToUint8Array(signatures[0]));
    });
  }
  const wallet: Wallet | undefined = compatibleSolanaWallets().find((entry) => entry.name === walletName);
  const account: WalletAccount | undefined = wallet?.accounts.find((entry) => entry.address === payer);
  const feature = wallet?.features['solana:signAndSendTransaction'] as {
    signAndSendTransaction: (...inputs: { account: WalletAccount; transaction: Uint8Array; chain: string }[]) =>
      Promise<readonly { signature: Uint8Array }[]>;
  } | undefined;
  if (!wallet || !account) throw new SeekerWalletError('wallet_account_mismatch');
  if (!feature) throw new SeekerWalletError('wallet_send_unsupported');
  const [output] = await feature.signAndSendTransaction({ account, transaction: fromBase64(transaction), chain: chainId });
  if (!output?.signature) throw new SeekerWalletError('wallet_send_failed');
  return base58(output.signature);
}

function rejected(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return code === 4001 || code === -1 || code === -3 || /reject|declin|cancel/i.test(message);
}

/**
 * Creates the server intent, asks the wallet to approve the exact transfer and
 * then polls the server until the finalized transfer is credited.
 */
export async function deposit(
  asset: WalletAsset,
  amount: string,
  onStage: (stage: 'prepare' | 'sign' | 'confirm') => void,
): Promise<ConfirmResult> {
  const bound = boundWallet();
  if (!bound) throw new SeekerWalletError('wallet_not_linked');
  onStage('prepare');
  const intent = await command<DepositIntent>('wallet_deposit_intent', { asset, amount, payer: bound.address });
  onStage('sign');
  let signature: string;
  try {
    signature = await signAndSend(intent.transaction, intent.chain, bound.address, bound.walletName);
  } catch (error) {
    if (error instanceof SeekerWalletError) throw error;
    throw new SeekerWalletError(rejected(error) ? 'wallet_rejected' : 'wallet_send_failed');
  }
  onStage('confirm');
  return waitForDeposit(intent.intent_id, signature);
}

/** Polls finalization (about 15 s on Solana); a missing signature is found by the intent reference. */
export async function waitForDeposit(intentId: string, signature?: string): Promise<ConfirmResult> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await command<ConfirmResult>('wallet_deposit_confirm', {
      intent_id: intentId,
      ...(signature ? { signature } : {}),
    }).catch((error: unknown) => {
      if (error instanceof SeekerWalletError && ['chain_unavailable', 'rate_limited'].includes(error.code)) {
        return { status: 'pending' as const };
      }
      throw error;
    });
    if (result.status !== 'pending') {
      if (result.status === 'settled') void refreshWallet().catch(() => undefined);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  return { status: 'pending', signature };
}
