export { skrListingPriceCents } from './skrListingPrice';
import { useEffect,useState } from 'react';
import { formatAmountShort,loadSkrRate,SeekerWalletError } from './seekerWallet';
export function skrError(error: unknown): string {
  const code=error instanceof SeekerWalletError ? error.code : String(error);
  return ({
    skr_insufficient_balance_or_overflow:'Not enough in-game SKR. Deposit SKR in Wallet.',
    hero_capacity_exceeded:'Not enough free Hero slots. No heroes were summoned.',
    skr_quote_expired:'The quote expired. Check a new price before paying.',
    stale_skr_rate:'A fresh SKR rate is unavailable. Try again shortly.',
    skr_purchase_pending:'Payment is pending. Retry this payment from Wallet history.',
    skr_purchase_refunded:'This payment was refunded. Start a new purchase.',
    rate_limited:'Too many requests. Wait a moment and try again.',
    market_listing_unavailable:'The listing is no longer available. Any charge was refunded.',
    item_locked:'Unlock the item before listing.',item_equipped:'Unequip the item before listing.',
    market_seller_limit_reached:'You already have 20 active listings.',
    store_offer_expired:'The equipment offer expired. Refresh the Store.',
    chest_not_found:'Not enough tradable Boss Chests. Any charge was refunded.',
    chest_capacity_exceeded:'Your chest queue is full. Open chests first.',
    market_chest_limit_reached:'You already have 20 active chest listings.',
  } as Record<string,string>)[code]??'The purchase could not finish. Check Wallet history before trying again.';
}
// One shared 30 s rate poll for every price on screen (hero cards, item panels, Store, Market).
let sharedRate: string | null = null;
let rateTimer: ReturnType<typeof setInterval> | undefined;
const rateListeners = new Set<(rate: string | null) => void>();
function refreshSharedRate() {
  void loadSkrRate().then(r => r.usd_micros_per_skr, () => null).then(rate => {
    sharedRate = rate;
    rateListeners.forEach(listener => listener(rate));
  });
}
export function useSkrRate(enabled = true) {
  const [rate,setRate]=useState<string|null>(enabled ? sharedRate : null);
  useEffect(()=>{
    if (!enabled) return;
    rateListeners.add(setRate);
    setRate(sharedRate);
    if (rateListeners.size === 1) { refreshSharedRate(); rateTimer = setInterval(refreshSharedRate, 30_000); }
    return ()=>{
      rateListeners.delete(setRate);
      if (rateListeners.size === 0) { clearInterval(rateTimer); rateTimer = undefined; }
    };
  },[enabled]);
  return rate;
}
export function skrPrice(cents:number,rate:string|null):string {
  if(!rate || !/^\d+$/.test(rate) || BigInt(rate) <= 0n)return 'SKR rate unavailable';
  const d=BigInt(rate),n=BigInt(Math.round(cents*10000))*1_000_000n;
  return `${formatAmountShort(((n+d-1n)/d).toString(),'SKR','up')} SKR`;
}
