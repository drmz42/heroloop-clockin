import { WalletAmount, WalletAssetPicker, type DisplayWalletAsset } from './SeekerWalletControls';
import { useCallback,useEffect,useRef,useState } from 'react';
import { loadSkrAccount,createPersonalSkrAccount,type SkrAccountStatus,boundWallet,formatMinor,exactWalletAmount,ASSET_DECIMALS,loadWalletRates,loadWithdrawals,requestWithdrawal,useWalletSnapshot,type WithdrawalRow,type WalletRate } from '@/game/seekerWallet';
import { skrError } from '@/game/skrPurchase';
const withdrawalError=(error:unknown)=>{
  const code=error instanceof Error?error.message:'';
  return ({withdrawals_blocked:'Withdrawals are temporarily unavailable. Please try again later.',
    ore_activation_required:'ORE withdrawals await activation.',
    recipient_ore_account_required:'Create your ORE token account below before withdrawing.',
    recipient_skr_account_required:'Create your token account below before withdrawing.',
    insufficient_account_sol:'Add SOL to your personal wallet to create the token account.',
    account_creation_pending:'Account creation is still confirming. Check again before retrying.',
    invalid_withdrawal_signature:'Your wallet signature could not be verified.',
    wallet_rejected:'Withdrawal cancelled in the wallet. Nothing was reserved.',
    wallet_timeout:'The wallet did not return a signature. Nothing was reserved; try again.',
    wallet_identity_required:'Reconnect the verified wallet linked to this account.',
    withdrawal_may_be_paid:'A payout may already have been sent. The balance stays reserved.',
    payout_not_finalized:'This payout is not finalized yet. Keep the reservation and retry.',
    payout_wrong_amount:'The transaction amount does not match this request.',
    payout_wrong_recipient:'The transaction recipient does not match this request.',
    payout_wrong_sender:'The transaction was not paid by the project wallet.',
    withdrawal_intent_limit:'Three withdrawal authorizations are open. Wait for them to expire.',
    withdrawal_amount_too_small:'This amount is too small after the 5% withdrawal fee.',
    invalid_amount:'Enter a positive amount with at most 6 SKR, 9 SOL or 11 ORE decimals.',
  } as Record<string,string>)[code]??skrError(error);
};
export function SeekerWithdrawalPanel({initialAsset='SKR'}:{initialAsset?:DisplayWalletAsset}={}) {
  const wallet=useWalletSnapshot();
  const [asset,setAsset]=useState<DisplayWalletAsset>(initialAsset);const [amount,setAmount]=useState('');
  const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [rows,setRows]=useState<WithdrawalRow[]>([]);
  const refresh=useCallback(()=>loadWithdrawals().then(r=>setRows(r.withdrawals)).catch(()=>setMessage('Withdrawal history is unavailable.')),[]);
  useEffect(()=>{void refresh();},[refresh]);
  const linkedAddress=boundWallet()?.address;
  const [account,setAccount]=useState<SkrAccountStatus|null>(null);
  const [accountError,setAccountError]=useState(false);
  const activeAsset=useRef(asset);activeAsset.current=asset;
  const checkAccount=useCallback(async()=>{try{const status=await loadSkrAccount(asset==='ORE'?'ORE':'SKR');if(activeAsset.current!==asset)return;setAccount(status);setAccountError(false);}catch{if(activeAsset.current!==asset)return;setAccount(null);setAccountError(true);}},[asset]);
  const accountReady=account?.ready===true&&account.owner===linkedAddress;
  useEffect(()=>{if(asset==='SOL')return;setAccount(null);let stopped=false;
    const check=()=>loadSkrAccount(asset==='ORE'?'ORE':'SKR').then(status=>{if(!stopped){setAccount(status);setAccountError(false);}}).catch(()=>{if(!stopped){setAccount(null);setAccountError(true);}});
    void check();const timer=setInterval(()=>{if(document.visibilityState==='visible')void check();},30000);
    return()=>{stopped=true;clearInterval(timer);};
  },[asset,linkedAddress]);
  async function createAccount(){setBusy(true);setMessage('Confirm account creation in your wallet. Your personal wallet pays the SOL cost.');try{setAccount(await createPersonalSkrAccount(asset==='ORE'?'ORE':'SKR'));setMessage('Your token account is ready. You can now request a withdrawal.');}catch(error){setMessage(error instanceof Error&&error.message==='wallet_rejected'?'Account creation cancelled in your wallet.':withdrawalError(error));await checkAccount();}finally{setBusy(false);}}
  const [rates, setRates] = useState<Partial<Record<'SKR' | 'SOL' | 'ORE', WalletRate>> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => loadWalletRates().then(data => { if (!cancelled) setRates(data.asset_rates); }).catch(() => { if (!cancelled) setRates(null); });
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  const rate = rates?.[asset];
  const valid = (asset !== 'ORE'||wallet?.chain.ore_enabled===true) && new RegExp(`^\\d{1,12}(\\.\\d{1,${ASSET_DECIMALS[asset]}})?$`).test(amount) && Number(amount) > 0;
  const overLimit = (() => {
    if (!valid || !rate || Date.now() - Date.parse(rate.observed_at) >= 60000 || !/^\d+$/.test(rate.usd_micros_per_skr)) return false;
    const [whole, fraction = ''] = amount.split('.');
    const units = BigInt(whole + fraction.padEnd(ASSET_DECIMALS[asset], '0'));
    return units * BigInt(rate.usd_micros_per_skr) > 20_000_000n * 10n ** BigInt(ASSET_DECIMALS[asset]);
  })();
  const [feePreview, receivePreview] = (() => {
    if (!valid) return ['', ''];
    const [whole, fraction = ''] = amount.split('.');
    const units = BigInt(whole + fraction.padEnd(ASSET_DECIMALS[asset], '0'));
    const receive = units * 95n / 100n;
    return [formatMinor((units - receive).toString(), asset, ASSET_DECIMALS[asset]), formatMinor(receive.toString(), asset, ASSET_DECIMALS[asset])];
  })();
  const abortRef=useRef<AbortController|null>(null);
  async function submit(){if(asset==='ORE'&&!wallet?.chain.ore_enabled)return;setBusy(true);setMessage('');const abort=new AbortController();abortRef.current=abort;try{await requestWithdrawal(asset,amount,abort.signal);setMessage('Withdrawal requested. Awaiting approval.');setAmount('');await refresh();}catch(error){setMessage(withdrawalError(error));}finally{abortRef.current=null;setBusy(false);}}
  return <div className="space-y-2.5">
    <p className="text-xs leading-5 text-stone-300">Withdraw to your linked wallet. Sign the request in your wallet. After admin approval, your payout is sent automatically.</p>
    <WalletAssetPicker asset={asset} busy={busy} onChange={entry => { setAsset(entry); setAmount(''); setMessage(''); }} />
    <WalletAmount id="seeker-withdraw-amount" amount={amount} asset={asset} busy={busy} unavailable={asset==='ORE'&&!wallet?.chain.ore_enabled} onChange={setAmount}
      available={asset === 'ORE'&&!wallet?.chain.ore_enabled ? 'ORE withdrawals await activation.' : `Available to withdraw: ${wallet ? formatMinor(wallet.balances[asset], asset, ASSET_DECIMALS[asset]) : '—'} $${asset}`}
      onMax={wallet && (asset!=='ORE'||wallet.chain.ore_enabled) ? () => setAmount(exactWalletAmount(wallet.balances[asset], asset)) : undefined} />
    {feePreview && <p className="text-[11px] text-stone-300">Withdrawal fee 5%: {feePreview} ${asset} · you receive {receivePreview} ${asset}</p>}
    {overLimit && <p role="status" className="text-[11px] text-amber-200">Withdrawals above $20 require additional review.</p>}
    <p className="break-all text-xs text-stone-300">Destination: {boundWallet()?.address??'Link a wallet first'}</p>
    {asset!=='SOL'&&!accountReady&&<div className="stat-tile space-y-2 p-3 text-xs" role="status">
      <p className="font-bold text-amber-100">{accountError?'Unable to check your token account':account?'Create your token account':'Checking your token account…'}</p>
      {account&&!account.ready&&<><p className="leading-5 text-stone-300">Your wallet has no {asset} token account. Creating it costs {formatMinor(account.rent_lamports??'0','SOL',9)} SOL plus a network fee of {formatMinor(account.network_fee_lamports??'0','SOL',9)} SOL. Your personal wallet pays; your in-game balance is unchanged.</p>
        <p className="text-amber-200">Total: {formatMinor(account.required_lamports??'0','SOL',9)} SOL. Your wallet may add a priority fee.</p>
        {!account.funded&&<p className="text-amber-200">Add at least {formatMinor((BigInt(account.required_lamports??'0')-BigInt(account.balance_lamports??'0')).toString(),'SOL',9)} SOL to your linked wallet first.</p>}
        <button type="button" style={{minHeight:44}} className="game-control game-primary w-full text-xs font-bold" disabled={busy||!account.funded} onClick={()=>void createAccount()}>{busy?'Waiting for your wallet…':'Create token account'}</button></>}
      <button type="button" style={{minHeight:44}} className="game-control w-full text-xs" disabled={busy} onClick={()=>void checkAccount()}>Check again</button>
    </div>}
    <button style={{minHeight:44}} className="game-control game-primary min-h-11 w-full text-xs font-bold" disabled={busy||!valid||!boundWallet()||(asset!=='SOL'&&!accountReady)} onClick={()=>void submit()}>{busy?'Waiting for your wallet…':'Sign withdrawal request'}</button>
    {busy&&abortRef.current&&<button type="button" style={{minHeight:44}} className="game-control min-h-11 w-full text-xs" onClick={()=>abortRef.current?.abort()}>Cancel withdrawal request</button>}
    {message&&<p role="status" className="text-xs leading-5 text-amber-200">{message}</p>}
    <h3 className="text-sm font-bold text-amber-100">Withdrawal history</h3>
    {rows.map(row=><div key={row.request_id} className="stat-tile space-y-1 p-3 text-xs"><p>{formatMinor(row.amount_minor,row.asset,ASSET_DECIMALS[row.asset])} {row.asset} · you receive {formatMinor(row.payout_minor,row.asset,ASSET_DECIMALS[row.asset])} · {row.status.replace(/_/g,' ')}</p><p className="text-stone-400">{new Date(row.created_at).toLocaleString()}</p>{row.signature&&<a className="block break-all text-lime-200" target="_blank" rel="noreferrer" href={`https://explorer.solana.com/tx/${row.signature}`}>View finalized payout</a>}{row.reject_reason&&<p>{row.reject_reason}</p>}</div>)}
    <button style={{minHeight:44}} className="game-control min-h-11 w-full text-xs" onClick={()=>void refresh()}>Refresh withdrawals</button>
  </div>;
}
