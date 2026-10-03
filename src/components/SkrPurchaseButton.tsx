import { useEffect,useState } from 'react';
import { commitSkrPurchase,formatAmountShort,quoteSkrPurchase,SeekerWalletError,useWalletSnapshot,type SkrPurchaseQuote } from '@/game/seekerWallet';
import { skrError } from '@/game/skrPurchase';
import { SkrTokenIcon } from '@/components/SkrTokenIcon';
export function SkrPurchaseButton({product,params,label='Buy',disabled=false,onDelivered}:{
  product:string;params:Record<string,unknown>;label?:string;disabled?:boolean;
  onDelivered:(result:Record<string,unknown>)=>void;
}) {
  const snapshot=useWalletSnapshot();
  const [quote,setQuote]=useState<SkrPurchaseQuote|null>(null);
  const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState(false);
  const [message,setMessage]=useState('');
  const paramsKey=JSON.stringify(params);
  useEffect(()=>{setQuote(null);setMessage('');setPending(false);},[product,paramsKey]);
  async function buy() {
    setBusy(true);setMessage('');
    try {
      if(!quote){setQuote(await quoteSkrPurchase(product,params));return;}
      if(quote.context.action!==product||Object.keys(params).some(key=>JSON.stringify(params[key])!==JSON.stringify(quote.context.params[key]))) {
        setQuote(null);setMessage('The selection changed. Check a new quote.');return;
      }
      const result=await commitSkrPurchase(quote.quote_id);
      if(result.status==='delivered'){onDelivered(result.result);setMessage('Paid with SKR. Purchase delivered.');}
      else setMessage(skrError(String(result.result.code)));
      setQuote(null);setPending(false);
    }catch(error){
      const code=error instanceof SeekerWalletError?error.code:'';
      setMessage(skrError(error));
      const uncertain=Boolean(quote)&&!['skr_quote_expired','skr_insufficient_balance_or_overflow','skr_purchase_refunded'].includes(code);
      setPending(uncertain);
      if(!uncertain)setQuote(null);
    }finally{setBusy(false);}
  }
  const affordable=!quote||!snapshot||BigInt(snapshot.balances.SKR)>=BigInt(quote.amount_minor)||pending;
  return <div className="mt-2 space-y-2">
    {quote&&<p className="flex flex-wrap items-center gap-1 break-words text-xs text-amber-200"><SkrTokenIcon size={14} />{formatAmountShort(quote.amount_minor,'SKR','up')} SKR · expires {new Date(quote.expires_at).toLocaleTimeString()}</p>}
    <button type="button" disabled={busy||disabled||!affordable} onClick={()=>void buy()} style={{minHeight:44}} className="game-control game-primary min-h-11 w-full px-3 text-xs font-bold disabled:opacity-40">
      {busy?'Checking…':pending?'Retry pending payment':quote?`Confirm ${formatAmountShort(quote.amount_minor,'SKR','up')} SKR`:label}
    </button>
    {quote&&!affordable&&<p role="status" className="text-xs text-amber-200">Not enough in-game SKR. Deposit in Wallet.</p>}
    {quote&&!pending&&!busy&&<button type="button" style={{minHeight:44}} className="game-control min-h-11 w-full text-xs" onClick={()=>setQuote(null)}>Cancel quote</button>}
    {message&&<p role="status" className="text-xs leading-5 text-amber-200">{message}</p>}
  </div>;
}
