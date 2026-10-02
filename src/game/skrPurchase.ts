import { useEffect,useState } from 'react';
import { formatAmountShort,loadSkrRate,SeekerWalletError } from './seekerWallet';
export function skrError(error: unknown): string {
  const code=error instanceof SeekerWalletError ? error.code : String(error);
  return ({
    skr_insufficient_balance_or_overflow:'Not enough in-game SKR. Deposit SKR in Wallet.',
    skr_quote_expired:'The quote expired. Check a new price before paying.',
    stale_skr_rate:'A fresh SKR rate is unavailable. Try again shortly.',
    skr_purchase_pending:'Payment is pending. Retry this payment from Wallet history.',
    skr_purchase_refunded:'This payment was refunded. Start a new purchase.',
    rate_limited:'Too many requests. Wait a moment and try again.',
    market_listing_unavailable:'The listing is no longer available. Any charge was refunded.',
    item_locked:'Unlock the item before listing.',item_equipped:'Unequip the item before listing.',
    market_seller_limit_reached:'You already have 20 active listings.',
    store_offer_expired:'The equipment offer expired. Refresh the Store.',
  } as Record<string,string>)[code]??'The purchase could not finish. Check Wallet history before trying again.';
}
export function useSkrRate() {
  const [rate,setRate]=useState<string|null>(null);
  useEffect(()=>{
    let active=true;
    const refresh=()=>{void loadSkrRate().then(r=>{if(active)setRate(r.usd_micros_per_skr);}).catch(()=>{if(active)setRate(null);});};
    refresh();const timer=setInterval(refresh,30_000);
    return ()=>{active=false;clearInterval(timer);};
  },[]);
  return rate;
}
export function skrPrice(cents:number,rate:string|null):string {
  const usd=`$${(Math.ceil(cents)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  if(!rate)return `${usd} · SKR rate unavailable`;
  const d=BigInt(rate),n=BigInt(Math.round(cents*10000))*1_000_000n;
  return `${usd} · ${formatAmountShort(((n+d-1n)/d).toString(),'SKR','up')} SKR`;
}
