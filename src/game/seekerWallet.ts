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

export type WalletChain = { cluster: 'mainnet'; skr_mint: string; treasury: string };
export type WalletHistoryRow = { event_id: string; kind: string; asset: WalletAsset; delta_minor: string; signature: string | null; at: string };
export type WalletSnapshot = {
  balances: Record<WalletAsset, string>;
  external_balances?: Record<WalletAsset, string>;
  max_deposit_balances?: Record<WalletAsset, string>;
  pending_deposits: { intent_id: string; asset: WalletAsset; amount_minor: string; expires_at: string }[];
  history: WalletHistoryRow[];
  pending_purchases?: SkrPurchaseQuote[];
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
  const whole = BigInt(digits.slice(0, -decimals)).toLocaleString('en-US').replace(/,/g, '\u00a0');
  const fraction = digits.slice(-decimals).slice(0, maxFraction).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Display prices rounded up and balances rounded down to hundredths.
 * Integer minor units keep rounding exact, including large balances. */
export function formatAmountShort(minor: string, asset: WalletAsset, round: 'up' | 'down'): string {
  const decimals = ASSET_DECIMALS[asset];
  const value = BigInt(minor);
  const step = 10n ** BigInt(decimals - 2);
  let hundredths = value / step;
  const remainder = value % step;
  if (round === 'up' && remainder > 0n) hundredths += 1n;
  if (round === 'down' && remainder < 0n) hundredths -= 1n;
  const magnitude = hundredths < 0n ? -hundredths : hundredths;
  const whole = (magnitude / 100n).toLocaleString('en-US').replace(/,/g, '\u00a0');
  const fraction = (magnitude % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${hundredths < 0n ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
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
async function refreshAfterChange(): Promise<WalletSnapshot> {
  // Finish any pre-mutation read before requesting the post-mutation balance.
  if (inflight) await inflight.catch(() => undefined);
  return refreshWallet();
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
      if (result.status === 'settled') void refreshAfterChange().catch(() => undefined);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  return { status: 'pending', signature };
}

export type SkrPurchaseQuote = {
  quote_id:string; usd_cents:number; amount_minor:string; expires_at:string;
  status:'quoted'|'charged'|'committed'|'refunded'; context:{action:string;params:Record<string,unknown>};
};
export async function quoteSkrPurchase(product:string,params:Record<string,unknown>):Promise<SkrPurchaseQuote> {
  return command('skr_purchase_quote',{product,params,idempotency_key:crypto.randomUUID()});
}
export async function commitSkrPurchase(quoteId:string):Promise<{status:'delivered'|'rejected';result:Record<string,unknown>}> {
  try { return await command('skr_purchase_commit',{quote_id:quoteId}); }
  finally { void refreshAfterChange().catch(()=>undefined); }
}
export type WalletRate = {usd_micros_per_skr:string;observed_at:string};
export function loadExternalWallet(): Promise<WalletSnapshot> {
  const bound = boundWallet();
  if (!bound) return Promise.reject(new SeekerWalletError('wallet_not_linked'));
  return command('wallet_snapshot', { address: bound.address });
}
export function loadWalletRates(): Promise<WalletRate & {asset_rates: Record<WalletAsset, WalletRate>}> { return command('wallet_rates'); }
export function exactWalletAmount(minor: string, asset: WalletAsset): string {
  return formatMinor(minor, asset, ASSET_DECIMALS[asset]).replace(/,/g, '');
}
export function loadSkrRate():Promise<{usd_micros_per_skr:string;observed_at:string}> { return command('wallet_rates'); }

export type WithdrawalRow={ request_id:string;asset:WalletAsset;amount_minor:string;fee_minor:string;payout_minor:string;destination:string;
  usd_cents:number;status:'authorization'|'pending'|'approval_required'|'paying'|'paid'|'rejected';created_at:string;expires_at:string;signature:string|null;reject_reason:string|null };
export function loadWithdrawals():Promise<{withdrawals:WithdrawalRow[]}>{return command('wallet_withdrawals');}
async function signAuthorization(message:string,address:string,walletName:string):Promise<string> {
  const payload=new TextEncoder().encode(message);
  if(nativeMwaSession(walletName)) {
    const [{transact},{base64ToUint8Array}]=await Promise.all([
      import('@solana-mobile/mobile-wallet-adapter-protocol'),import('@solana-mobile/mobile-wallet-adapter-protocol/encoding')]);
    return transact(async wallet=>{
      const auth=await wallet.authorize({chain:'solana:mainnet',identity:mobileWalletAppIdentity()});
      const account=auth.accounts.find(a=>base58(base64ToUint8Array(a.address))===address);
      if(!account)throw new SeekerWalletError('wallet_account_mismatch');
      const {signed_payloads}=await wallet.signMessages({addresses:[account.address],payloads:[btoa(String.fromCharCode(...payload))]});
      if(signed_payloads.length!==1)throw new SeekerWalletError('invalid_withdrawal_signature');
      const signed=base64ToUint8Array(signed_payloads[0]);
      // MWA returns the message with the 64-byte signature appended; some wallets (Phantom) return only the signature.
      // The wallet service verifies the signature against the exact authorization text either way.
      if(signed.length!==64 && (signed.length!==payload.length+64 || payload.some((byte,index)=>signed[index]!==byte)))throw new SeekerWalletError('invalid_withdrawal_signature');
      return btoa(String.fromCharCode(...signed.slice(-64)));
    });
  }
  const wallet=compatibleSolanaWallets().find(w=>w.name===walletName);
  const account=wallet?.accounts.find(a=>a.address===address);
  const feature=wallet?.features['solana:signMessage'] as {signMessage:(input:{account:WalletAccount;message:Uint8Array})=>Promise<readonly {signature:Uint8Array}[]>}|undefined;
  if(!account||!feature)throw new SeekerWalletError('wallet_account_mismatch');
  const [proof]=await feature.signMessage({account,message:payload});
  if(!proof?.signature)throw new SeekerWalletError('wallet_rejected');
  return btoa(String.fromCharCode(...proof.signature));
}
export async function requestWithdrawal(asset:WalletAsset,amount:string,signal?:AbortSignal):Promise<WithdrawalRow> {
  const bound=boundWallet();if(!bound)throw new SeekerWalletError('wallet_not_linked');
  const intent=await command<WithdrawalRow&{message:string}>('wallet_withdraw_intent',{asset,amount,destination:bound.address});
  // A cancelled request may never settle in some wallets (MWA or in-app). Give the player
  // time to read and sign (the authorization lives 10 minutes), allow a manual cancel, and
  // once the game is visible again after the wallet app, wait briefly for its answer.
  let cap:ReturnType<typeof setTimeout>|undefined;
  let grace:ReturnType<typeof setTimeout>|undefined;
  let onVisible:(()=>void)|undefined;
  let onAbort:(()=>void)|undefined;
  let signature:string;
  try {
    signature=await Promise.race([
      signAuthorization(intent.message,bound.address,bound.walletName),
      new Promise<never>((_,reject)=>{
        const fail=(code:string)=>reject(new SeekerWalletError(code));
        cap=setTimeout(()=>fail('wallet_timeout'),9*60_000);
        let hidden=document.visibilityState==='hidden';
        onVisible=()=>{
          if(document.visibilityState==='hidden'){hidden=true;clearTimeout(grace);return;}
          if(hidden){clearTimeout(grace);grace=setTimeout(()=>fail('wallet_timeout'),30_000);}
        };
        document.addEventListener('visibilitychange',onVisible);
        onAbort=()=>fail('wallet_rejected');
        signal?.addEventListener('abort',onAbort);
      }),
    ]);
  } catch(error) {
    if(error instanceof SeekerWalletError)throw error;
    throw new SeekerWalletError(rejected(error)?'wallet_rejected':'invalid_withdrawal_signature');
  } finally {
    clearTimeout(cap);clearTimeout(grace);
    if(onVisible)document.removeEventListener('visibilitychange',onVisible);
    if(onAbort)signal?.removeEventListener('abort',onAbort);
  }
  try{return await command('wallet_withdraw_confirm',{request_id:intent.request_id,signature});}
  finally{void refreshAfterChange().catch(()=>undefined);}
}
export type Reconciliation={withdrawals_blocked:boolean;checked_at:string;assets:Record<WalletAsset,{on_chain_minor:string;accounted_minor:string;liabilities_minor:string;earned_minor:string;shortfall:boolean}>};
export function loadFounderWallet():Promise<{withdrawals:WithdrawalRow[];reconciliation:Reconciliation}> {
 const bound=boundWallet();if(!bound)throw new SeekerWalletError('wallet_not_linked');
 return command('wallet_founder_status',{founder_address:bound.address});
}
export function reviewWithdrawal(request_id:string,action:'begin_payout'|'finalize'|'reject',value=''):Promise<WithdrawalRow> {
 const bound=boundWallet();if(!bound)throw new SeekerWalletError('wallet_not_linked');
 return command('wallet_withdraw_review',{founder_address:bound.address,request_id,action,...(action==='finalize'?{signature:value}:action==='reject'?{reason:value}:{})});
}

// ORE Mine (server custody). The server derives budget, policy and custody wallet.
export type MineRound = { seq: number; status: 'pending' | 'settled'; ore_round_id: string | null; cost_minor: string | null; signature: string | null };
export type MineSession = {
  id: string; status: 'active' | 'stopped' | 'closed'; reserved_minor: string; spent_minor: string; released_minor: string | null;
  credited_minor: string; completed: number; round_limit: number; stake_minor: string; square_mask: string | null; custody_address: string | null;
  created_at: string; rounds: MineRound[];
};
export type MineStatus = {
  enabled: boolean; float_address: string | null; terms_version: string; accepted_terms_version: string | null; tiers: string[]; max_rounds: number;
  session_limit_minor: string; daily_limit_minor: string; available_minor: string | null; used_today_minor: string;
  session: MineSession | null;
};
export const loadMineStatus = (): Promise<MineStatus> => command('mine_status');
export const acceptMineTerms = (version: string): Promise<MineStatus> => command('mine_accept_terms', { version });
export const startMine = (tier: string, rounds: number, squares: number[]): Promise<MineSession> =>
  command('mine_start', { session_id: crypto.randomUUID(), tier, rounds, squares });
export type MineBoard = {
  round_id: string; ends_in_seconds: number | null; deployed_minor: string[]; miners: number[];
  previous: { round_id: string; winning_square: number | null; winning_deployed_minor: string | null; total_deployed_minor: string } | null;
};
export const loadMineBoard = (): Promise<MineBoard> => command('mine_board');
export const stopMine = (sessionId: string): Promise<MineSession> => command('mine_stop', { session_id: sessionId });

export type SkrAccountStatus = {ready:boolean;owner:string;chain:WalletChain;rent_lamports?:string;network_fee_lamports?:string;required_lamports?:string;balance_lamports?:string;funded?:boolean;transaction?:string};
export async function loadSkrAccount():Promise<SkrAccountStatus>{
 const bound=boundWallet();if(!bound)throw new SeekerWalletError('wallet_identity_required');
 return command('wallet_skr_account',{address:bound.address});
}
export async function createPersonalSkrAccount():Promise<SkrAccountStatus>{
 const bound=boundWallet();if(!bound)throw new SeekerWalletError('wallet_identity_required');
 const status=await loadSkrAccount();
 if(status.owner!==bound.address||boundWallet()?.address!==bound.address)throw new SeekerWalletError('wallet_account_mismatch');
 if(status.ready)return status;
 if(!status.funded||!status.transaction)throw new SeekerWalletError('insufficient_account_sol');
 try {await signAndSend(status.transaction,status.chain,bound.address,bound.walletName);}catch(error){
  if(error instanceof SeekerWalletError)throw error;
  throw new SeekerWalletError(rejected(error)?'wallet_rejected':'wallet_send_failed');
 }
 for(let attempt=0;attempt<15;attempt++){
  await new Promise(resolve=>setTimeout(resolve,4000));
  const current=await loadSkrAccount();if(current.ready)return current;
 }
 throw new SeekerWalletError('account_creation_pending');
}
