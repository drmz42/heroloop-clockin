import { WalletAmount, WalletAssetPicker, type DisplayWalletAsset } from './SeekerWalletControls';
import { useCallback,useEffect,useState } from 'react';
import { boundWallet,formatMinor,exactWalletAmount,ASSET_DECIMALS,loadWalletRates,loadWithdrawals,loadFounderWallet,requestWithdrawal,reviewWithdrawal,useWalletSnapshot,type WithdrawalRow,type WalletRate,type Reconciliation } from '@/game/seekerWallet';
import { skrError } from '@/game/skrPurchase';
const withdrawalError=(error:unknown)=>{
  const code=error instanceof Error?error.message:'';
  return ({withdrawals_blocked:'Treasury reconciliation is blocked. Contact the Founder.',
    invalid_withdrawal_signature:'Your wallet signature could not be verified.',
    wallet_rejected:'Withdrawal cancelled in the wallet. Nothing was reserved.',
    wallet_timeout:'The wallet did not answer. Nothing was reserved; try again.',
    wallet_identity_required:'Reconnect the verified wallet linked to this account.',
    withdrawal_may_be_paid:'A payout may already have been sent. The balance stays reserved.',
    payout_not_finalized:'This payout is not finalized yet. Keep the reservation and retry.',
    payout_wrong_amount:'The transaction amount does not match this request.',
    payout_wrong_recipient:'The transaction recipient does not match this request.',
    payout_wrong_sender:'The transaction was not paid by the project wallet.',
    withdrawal_intent_limit:'Three withdrawal authorizations are open. Wait for them to expire.',
    withdrawal_amount_too_small:'This amount is too small after the 5% withdrawal fee.',
    invalid_amount:'Enter a positive amount with at most 6 SKR or 9 SOL decimals.',
  } as Record<string,string>)[code]??skrError(error);
};
export function SeekerWithdrawalPanel() {
  const wallet=useWalletSnapshot();
  const [asset,setAsset]=useState<DisplayWalletAsset>('SKR');const [amount,setAmount]=useState('');
  const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [rows,setRows]=useState<WithdrawalRow[]>([]);
  const refresh=useCallback(()=>loadWithdrawals().then(r=>setRows(r.withdrawals)).catch(()=>setMessage('Withdrawal history is unavailable.')),[]);
  useEffect(()=>{void refresh();},[refresh]);
  const [rates, setRates] = useState<Record<'SKR' | 'SOL', WalletRate> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => loadWalletRates().then(data => { if (!cancelled) setRates(data.asset_rates); }).catch(() => { if (!cancelled) setRates(null); });
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const rate = asset === 'ORE' ? null : rates?.[asset];
  const valid = asset !== 'ORE' && new RegExp(`^\\d{1,12}(\\.\\d{1,${ASSET_DECIMALS[asset]}})?$`).test(amount) && Number(amount) > 0;
  const overLimit = (() => {
    if (asset === 'ORE' || !valid || !rate || Date.now() - Date.parse(rate.observed_at) >= 60000 || !/^\d+$/.test(rate.usd_micros_per_skr)) return false;
    const [whole, fraction = ''] = amount.split('.');
    const units = BigInt(whole + fraction.padEnd(ASSET_DECIMALS[asset], '0'));
    return units * BigInt(rate.usd_micros_per_skr) > 20_000_000n * 10n ** BigInt(ASSET_DECIMALS[asset]);
  })();
  const [feePreview, receivePreview] = (() => {
    if (asset === 'ORE' || !valid) return ['', ''];
    const [whole, fraction = ''] = amount.split('.');
    const units = BigInt(whole + fraction.padEnd(ASSET_DECIMALS[asset], '0'));
    const receive = units * 95n / 100n;
    return [formatMinor((units - receive).toString(), asset, ASSET_DECIMALS[asset]), formatMinor(receive.toString(), asset, ASSET_DECIMALS[asset])];
  })();
  async function submit(){if(asset==='ORE')return;setBusy(true);setMessage('');try{const r=await requestWithdrawal(asset,amount);setMessage(r.status==='approval_required'?'Balance reserved. This request needs Founder approval above the daily $20 limit.':'Balance reserved. Awaiting a manual Founder payout.');setAmount('');await refresh();}catch(error){setMessage(withdrawalError(error));}finally{setBusy(false);}}
  return <div className="space-y-2.5">
    <p className="text-xs leading-5 text-stone-300">Withdraw to the verified wallet you signed in with. Your wallet signs an authorization; the Founder pays manually.</p>
    <WalletAssetPicker asset={asset} busy={busy} onChange={entry => { setAsset(entry); setAmount(''); setMessage(''); }} />
    <WalletAmount id="seeker-withdraw-amount" amount={amount} asset={asset} busy={busy} onChange={setAmount}
      available={asset === 'ORE' ? 'ORE transfers are not available yet.' : `Available to withdraw: ${wallet ? formatMinor(wallet.balances[asset], asset, ASSET_DECIMALS[asset]) : '—'} $${asset}`}
      onMax={asset !== 'ORE' && wallet ? () => setAmount(exactWalletAmount(wallet.balances[asset], asset)) : undefined} />
    {feePreview && <p className="text-[11px] text-stone-300">Withdrawal fee 5%: {feePreview} ${asset} · you receive {receivePreview} ${asset}</p>}
    {overLimit && <p role="status" className="text-[11px] text-amber-200">This withdrawal exceeds $20 and requires Founder approval.</p>}
    <p className="break-all text-xs text-stone-300">Destination: {boundWallet()?.address??'Link a wallet first'}</p>
    <button style={{minHeight:44}} className="game-control game-primary min-h-11 w-full text-xs font-bold" disabled={busy||!valid||!boundWallet()} onClick={()=>void submit()}>{busy?'Authorizing…':'Sign withdrawal request'}</button>
    {message&&<p role="status" className="text-xs leading-5 text-amber-200">{message}</p>}
    <h3 className="text-sm font-bold text-amber-100">Withdrawal history</h3>
    {rows.map(row=><div key={row.request_id} className="stat-tile space-y-1 p-3 text-xs"><p>{formatMinor(row.amount_minor,row.asset,row.asset==='SKR'?6:9)} {row.asset} · you receive {formatMinor(row.payout_minor,row.asset,row.asset==='SKR'?6:9)} · {row.status.replace(/_/g,' ')}</p><p className="text-stone-400">{new Date(row.created_at).toLocaleString()}</p>{row.signature&&<a className="block break-all text-lime-200" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/tx/${row.signature}`}>View finalized payout</a>}{row.reject_reason&&<p>{row.reject_reason}</p>}</div>)}
    <button style={{minHeight:44}} className="game-control min-h-11 w-full text-xs" onClick={()=>void refresh()}>Refresh withdrawals</button>
  </div>;
}
export function SeekerFounderPanel() {
  const [rows,setRows]=useState<WithdrawalRow[]>([]);const [report,setReport]=useState<Reconciliation|null>(null);
  const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
  const refresh=useCallback(async()=>{try{const data=await loadFounderWallet();setRows(data.withdrawals);setReport(data.reconciliation);}catch{/* Server enforces Founder identity; other players see no panel. */}},[]);
  useEffect(()=>{void refresh();},[refresh]);
  async function review(row:WithdrawalRow,action:'begin_payout'|'finalize'|'reject') {
    const value=action==='finalize'?window.prompt('Paste the transaction signature of the payout already sent.'):action==='reject'?window.prompt('Reason for rejecting this request before any payout was sent:'):'';
    if(value===null)return;
    if(action==='begin_payout'&&!window.confirm(`Approve and start one manual payout of ${formatMinor(row.payout_minor,row.asset,row.asset==='SKR'?6:9)} ${row.asset} (request ${formatMinor(row.amount_minor,row.asset,row.asset==='SKR'?6:9)}, 5% fee kept) to ${row.destination}?${row.status==='approval_required'?' This exceeds the normal $20 daily limit.':''} The balance stays reserved until the transaction finalizes.`))return;
    setBusy(true);setMessage('');try{await reviewWithdrawal(row.request_id,action,value);await refresh();}catch(error){setMessage(withdrawalError(error));}finally{setBusy(false);}
  }
  if(!report)return null;
  return <section className="space-y-3 border-t border-amber-700/40 pt-4"><h3 className="text-lg font-bold text-amber-100">Staging2 payout control</h3>
    <p className="text-xs text-amber-200">{report.withdrawals_blocked?'Treasury shortfall: new withdrawals blocked.':'Treasury reconciliation passed.'}</p>
    {(['SKR','SOL'] as const).map(asset=><p key={asset} className="break-words text-xs text-stone-300">{asset}: on chain {formatMinor(report.assets[asset].on_chain_minor,asset,9)} · accounted {formatMinor(report.assets[asset].accounted_minor,asset,9)}</p>)}
    {rows.filter(r=>['pending','approval_required','paying'].includes(r.status)).map(row=><article key={row.request_id} className="stat-tile space-y-2 p-3 text-xs"><p className="font-bold text-amber-200">Send {formatMinor(row.payout_minor,row.asset,row.asset==='SKR'?6:9)} {row.asset} · request {formatMinor(row.amount_minor,row.asset,row.asset==='SKR'?6:9)} · {row.status.replace(/_/g,' ')}</p><code className="block break-all">{row.destination}</code><button style={{minHeight:44}} className="game-control min-h-11 w-full" onClick={()=>void navigator.clipboard.writeText(`${formatMinor(row.payout_minor,row.asset,row.asset==='SKR'?6:9).replace(/,/g,'')}`)}>Copy exact amount</button><button style={{minHeight:44}} className="game-control min-h-11 w-full" onClick={()=>void navigator.clipboard.writeText(row.destination)}>Copy destination</button>
      {row.status==='paying'?<><p className="text-amber-200">Payout started. Send once, then paste its signature. Keep funds reserved on timeout.</p><button style={{minHeight:44}} disabled={busy} className="game-control game-primary min-h-11 w-full" onClick={()=>void review(row,'finalize')}>Verify sent payout</button></>:<><button style={{minHeight:44}} disabled={busy||report.withdrawals_blocked} className="game-control game-primary min-h-11 w-full" onClick={()=>void review(row,'begin_payout')}>Approve · begin manual payout</button><button style={{minHeight:44}} disabled={busy} className="game-control min-h-11 w-full" onClick={()=>void review(row,'reject')}>Reject before payout</button></>}
    </article>)}
    {message&&<p role="status" className="text-xs text-amber-200">{message}</p>}<button style={{minHeight:44}} className="game-control min-h-11 w-full text-xs" onClick={()=>void refresh()}>Refresh reconciliation</button>
  </section>;
}
