import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, Check, ExternalLink, Loader2, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import {
  commitSkrPurchase,boundWallet, deposit, formatAmountShort, formatMinor, refreshWallet, SeekerWalletError, useWalletSnapshot, waitForDeposit,
  type WalletAsset, type WalletSnapshot,
} from '@/game/seekerWallet';

const ERRORS: Record<string, string> = {
  wallet_not_linked: 'Sign in with your Solana wallet first.',
  wallet_rejected: 'You declined the transfer in your wallet. Nothing was sent.',
  wallet_account_mismatch: 'Your wallet shows a different account. Switch to the account you signed in with.',
  wallet_send_unsupported: 'This wallet cannot send transactions from the game. Use Phantom or the Seeker wallet.',
  wallet_send_failed: 'The wallet did not send the transfer. Nothing was credited; try again.',
  payer_not_allowed: 'Deposits from this wallet are not enabled yet on this test server.',
  insufficient_skr: 'Your wallet does not hold enough SKR for this deposit.',
  invalid_amount: 'Enter an amount between the minimum and the per-deposit limit.',
  deposit_intent_limit: 'You have three unfinished deposits. Wait for them to complete or expire (10 minutes).',
  chain_unavailable: 'The Solana network is not responding. Try again in a minute.',
  rate_limited: 'Too many requests. Wait a few seconds and try again.',
  deposit_wrong_amount: 'The transfer on chain does not match this deposit. It was not credited.',
  deposit_outside_window: 'The transfer arrived after the deposit expired. Contact support with the transaction link.',
};
const message = (code: string) => ERRORS[code] ?? 'The deposit could not be completed. Nothing was credited twice; try again.';
const QUICK: Record<WalletAsset, string[]> = { SKR: ['10', '50', '100', '500'], SOL: ['0.01', '0.05', '0.1', '0.5'] };
const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}`;

function useWalletState() {
  const snapshot = useWalletSnapshot();
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      await refreshWallet();
      setError('');
    } catch (reason) {
      setError(reason instanceof SeekerWalletError ? reason.code : 'wallet_unavailable');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { snapshot, error, refresh };
}

function Balances({ snapshot }: { snapshot: WalletSnapshot | null }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(['SKR', 'SOL'] as const).map((asset) => (
        <div key={asset} className="stat-tile p-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[#8f887b]">In-game {asset}</div>
          <div className="mt-1 text-xl font-black tabular-nums text-[#f1d188]">
            {snapshot ? formatAmountShort(snapshot.balances[asset], asset, 'down') : '—'}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SeekerDepositPanel() {
  const { snapshot, error, refresh } = useWalletState();
  const [asset, setAsset] = useState<WalletAsset>('SKR');
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<'idle' | 'prepare' | 'sign' | 'confirm'>('idle');
  const [result, setResult] = useState<{ ok: boolean; text: string; signature?: string } | null>(null);
  const bound = boundWallet();
  const busy = stage !== 'idle';
  const valid = /^\d{1,12}(\.\d{1,9})?$/.test(amount) && Number(amount) > 0;

  const submit = async () => {
    setResult(null);
    try {
      const outcome = await deposit(asset, amount, setStage);
      setResult(outcome.status === 'settled'
        ? { ok: true, text: `${amount} ${asset} credited to your in-game balance.`, signature: outcome.signature }
        : outcome.status === 'expired'
        ? { ok: false, text: 'No transfer arrived before the deposit expired. Nothing was credited.' }
        : { ok: true, text: 'Transfer sent. It will be credited once the network finalizes it — check back in a minute.', signature: outcome.signature });
      setAmount('');
    } catch (reason) {
      setResult({ ok: false, text: message(reason instanceof SeekerWalletError ? reason.code : 'wallet_send_failed') });
    } finally {
      setStage('idle');
      void refresh();
    }
  };

  const resume = async (intentId: string) => {
    setStage('confirm');
    try {
      const outcome = await waitForDeposit(intentId);
      setResult(outcome.status === 'settled'
        ? { ok: true, text: 'Deposit credited.', signature: outcome.signature }
        : { ok: false, text: outcome.status === 'expired' ? 'This deposit expired without a transfer.' : 'Still waiting for the network.' });
    } catch (reason) {
      setResult({ ok: false, text: message(reason instanceof SeekerWalletError ? reason.code : 'wallet_unavailable') });
    } finally {
      setStage('idle');
      void refresh();
    }
  };

  return (
    <>
      <Balances snapshot={snapshot} />
      <div role="radiogroup" aria-label="Token to deposit" className="grid grid-cols-2 gap-2">
        {(['SKR', 'SOL'] as const).map((entry) => (
          <button key={entry} type="button" role="radio" aria-checked={asset === entry} disabled={busy}
            onClick={() => { setAsset(entry); setAmount(''); }}
            className={`game-control min-h-11 px-3 text-sm font-black ${asset === entry ? 'border-[#e0a83c] text-[#f6d283]' : 'text-[#8f887b]'}`}>
            {entry}{entry === 'SOL' ? <span className="ml-1 text-[10px] font-bold text-[#8f887b]">for ORE Mines</span> : null}
          </button>
        ))}
      </div>
      <div>
        <label htmlFor="seeker-deposit-amount" className="text-xs font-semibold uppercase tracking-[.14em] text-[#8f887b]">Amount to deposit</label>
        <div className="mt-2 flex items-center gap-2">
          <input id="seeker-deposit-amount" inputMode="decimal" autoComplete="off" value={amount} disabled={busy}
            onChange={(event) => setAmount(event.target.value.replace(',', '.').replace(/[^\d.]/g, ''))}
            placeholder="0" className="min-h-12 min-w-0 flex-1 rounded-xl border border-[#3f3626] bg-black/30 px-4 text-lg font-bold text-[#f1d188]" />
          <span className="text-sm font-black text-[#8f887b]">{asset}</span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {QUICK[asset].map((value) => (
            <button key={value} type="button" disabled={busy} onClick={() => setAmount(value)}
              className="game-control min-h-9 px-1 text-xs font-bold text-[#d9d1c0]">{value}</button>
          ))}
        </div>
      </div>
      <button type="button" disabled={!bound || !valid || busy} onClick={() => void submit()}
        className="game-control flex min-h-12 w-full items-center justify-center gap-2 px-4 py-3 font-black text-[#f6d283] disabled:opacity-45">
        {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowDownToLine size={16} />}
        {stage === 'prepare' ? 'Preparing transfer…' : stage === 'sign' ? 'Approve in your wallet…' : stage === 'confirm'
          ? 'Waiting for the network…' : `Deposit ${valid ? amount : ''} ${asset}`}
      </button>
      {result && (
        <div role="status" className={`flex gap-2 rounded-xl border p-3 text-xs leading-5 ${result.ok ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100' : 'border-rose-400/30 bg-rose-400/10 text-rose-100'}`}>
          {result.ok ? <Check size={16} className="mt-0.5 shrink-0" /> : <AlertTriangle size={16} className="mt-0.5 shrink-0" />}
          <span>
            {result.text}
            {result.signature && snapshot && (
              <a href={explorer(result.signature)} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-1 underline">
                Transaction <ExternalLink size={11} />
              </a>
            )}
          </span>
        </div>
      )}
      {snapshot && snapshot.pending_deposits.length > 0 && (
        <div className="stat-tile space-y-2 p-3 text-xs">
          <div className="font-bold text-[#d9d1c0]">Unfinished deposits</div>
          {snapshot.pending_deposits.map((row) => (
            <div key={row.intent_id} className="flex items-center justify-between gap-2 text-[#a29b8e]">
              <span>{formatMinor(row.amount_minor, row.asset)} {row.asset}</span>
              <button type="button" disabled={busy} onClick={() => void resume(row.intent_id)}
                className="game-control flex min-h-9 items-center gap-1 px-2.5 font-bold"><RefreshCw size={12} /> Check</button>
            </div>
          ))}
        </div>
      )}
      {error && !snapshot && <div role="alert" className="text-xs text-rose-200">{message(error)}</div>}
      <div className="flex gap-2 text-[11px] leading-5 text-[#8f887b]">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-amber-300/80" />
        <span>Your wallet shows the exact amount and the HeroLoop address before you approve. The Solana network fee is about 0.000005 SOL. HeroLoop credits your balance only after the transfer is final on chain, once per transfer.</span>
      </div>
    </>
  );
}

export function SeekerHistoryPanel({onPurchase}:{onPurchase?:(result:Record<string,unknown>)=>void}) {
  const { snapshot, error } = useWalletState();
  const [recovering,setRecovering]=useState(false);
  const [notice,setNotice]=useState('');
  async function recover(id:string) {
    setRecovering(true);
    try {const result=await commitSkrPurchase(id);if(result.status==='delivered'){onPurchase?.(result.result);setNotice('Payment recovered. Your purchase is delivered.');}else setNotice('Purchase refused. Your SKR was refunded.');}
    catch {setNotice('Payment is still pending. Keep the same request and retry later.');}
    finally{setRecovering(false);}
  }
  return (
    <>
      <Balances snapshot={snapshot} />
      {snapshot?.pending_purchases?.map(quote=><div key={quote.quote_id} className="stat-tile p-3 text-xs"><p>Pending {quote.context.action.replace(/_/g,' ')} · {formatAmountShort(quote.amount_minor,'SKR','up')} SKR</p><button disabled={recovering} className="game-control mt-2 min-h-11 w-full" onClick={()=>void recover(quote.quote_id)}>Recover this payment</button></div>)}
      {notice&&<p role="status" className="text-xs text-amber-200">{notice}</p>}
      {snapshot && snapshot.history.length === 0 && (
        <div className="stat-tile p-3 text-xs text-[#a29b8e]">No wallet activity yet.</div>
      )}
      {snapshot && snapshot.history.length > 0 && (
        <ul className="space-y-1.5">
          {snapshot.history.map((row) => (
            <li key={`${row.event_id}-${row.asset}`} className="stat-tile flex items-center justify-between gap-2 p-2.5 text-xs">
              <div className="min-w-0">
                <div className="font-bold capitalize text-[#d9d1c0]">{row.kind.replace('_', ' ')}</div>
                <div className="text-[10px] text-[#8f887b]">{new Date(row.at).toLocaleString()}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`font-black tabular-nums ${row.delta_minor.startsWith('-') ? 'text-rose-300' : 'text-emerald-300'}`}>
                  {row.delta_minor.startsWith('-') ? '' : '+'}{formatMinor(row.delta_minor, row.asset)} {row.asset}
                </span>
                {row.signature && (
                  <a href={explorer(row.signature)} target="_blank" rel="noreferrer" aria-label="Open transaction" className="text-[#8f887b]">
                    <ExternalLink size={13} />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && !snapshot && <div role="alert" className="text-xs text-rose-200">{message(error)}</div>}
    </>
  );
}
