import { useCallback,useEffect,useState } from 'react';
import { FlaskConical,RefreshCw,Rocket,Store,ShoppingBag } from 'lucide-react';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import type { GameApi,ServerMarketSnapshot } from '@/game/useGame';
import type { OwnedItem } from '@/game/types';
import { ITEM_MAP,isMarketEligibleEquipment } from '@/game/items';
import { RARITY_COLORS } from '@/game/heroes';
import { ItemArtwork } from '@/components/ItemArtwork';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { skrPrice,useSkrRate } from '@/game/skrPurchase';
import { formatMinor,useWalletSnapshot } from '@/game/seekerWallet';

function BundleArt({resource}:{resource:string}) {
  if(resource==='summon_scroll')return <SummonScrollArtwork size={36}/>;
  if(resource==='boss_key')return <BossKeyIcon size={34}/>;
  return <FlaskConical size={30} className="shrink-0 text-emerald-300" aria-hidden="true"/>;
}
function Balance() {
  const wallet=useWalletSnapshot();
  return <span className="stat-tile px-3 py-2 text-sm font-bold text-lime-200">{wallet?formatMinor(wallet.balances.SKR,'SKR',6):'—'} SKR</span>;
}
function ItemCard({item}:{item:OwnedItem}) {
  const base=ITEM_MAP[item.itemId];
  return <><div className="mx-auto h-24 w-24"><ItemArtwork itemId={item.itemId} name={base?.name??item.itemId} fallback={base?.icon??''}/></div>
    <h3 className="break-words text-sm font-bold" style={{color:RARITY_COLORS[base?.rarity??'common']}}>{base?.name??item.itemId} {item.enchantLevel>0?`+${item.enchantLevel}`:''}</h3>
    <p className="text-xs text-stone-400">Lv {item.level} · {Math.floor(item.power)} PWR</p>
    <details className="text-xs text-stone-300"><summary className="min-h-11 cursor-pointer py-3">Properties</summary>{item.stats.map((stat,index)=><p key={index}>{stat.key}: {stat.value}</p>)}</details></>;
}
export function SeekerMarketScreen({game}:{game:GameApi}) {
  const [market,setMarket]=useState<ServerMarketSnapshot|null>(null);
  const [tab,setTab]=useState<'browse'|'sell'|'listings'|'history'>('browse');
  const [price,setPrice]=useState('0.10');
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const rate=useSkrRate();
  const load=game.loadMarket;
  const refresh=useCallback(async()=>{const next=await load();if(next){setMarket(next);setMessage('');}else setMessage('Market is unavailable. Try refreshing.');},[load]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),30_000);return()=>clearInterval(timer);},[refresh]);
  const delivered=(result:Record<string,unknown>)=>{game.applySeekerPurchase(result);void refresh();};
  const cents=Math.round(Number(price)*100);
  const valid=/^\d{1,6}(\.\d{1,2})?$/.test(price)&&Number.isSafeInteger(cents)&&cents>=1;
  const equipped=new Set(game.state.ownedHeroes.flatMap(h=>Object.values(h.equipped)));
  const eligible=game.state.inventory.filter(item=>item.serverOwned&&!!ITEM_MAP[item.itemId]&&isMarketEligibleEquipment(ITEM_MAP[item.itemId]));
  const listings=(market?.listings??[]).filter(l=>tab!=='listings'||l.is_own);
  return <div className="premium-screen themed-screen themed-screen-market game-scrollbar h-full overflow-y-auto p-3">
    <header className="merchant-surface flex flex-wrap items-center justify-between gap-3 p-4 pr-14"><h2 className="flex items-center gap-2 text-xl font-black text-amber-100"><ShoppingBag/>Market · SKR</h2><Balance/></header>
    <p className="my-3 text-xs leading-5 text-stone-300">Listing fee: {skrPrice(2,rate)}. Non-refundable after listing, including cancellation. Sale fee: 5%; the seller receives 95% in SKR. Purchases arrive in Mailbox.</p>
    <nav aria-label="Market sections" className="mb-3 flex flex-wrap gap-2">{(['browse','sell','listings','history'] as const).map(t=><button style={{minHeight:44}} key={t} className={`game-control min-h-11 px-3 text-xs capitalize ${tab===t?'game-primary':''}`} aria-pressed={tab===t} onClick={()=>setTab(t)}>{t==='listings'?'My listings':t}</button>)}<button style={{minHeight:44}} aria-label="Refresh market" className="game-control min-h-11 px-3" onClick={()=>void refresh()}><RefreshCw size={15}/></button></nav>
    {message&&<p role="status" className="my-2 text-xs text-amber-200">{message}</p>}
    {tab==='sell'&&<label className="mb-3 block text-xs text-stone-300">Sale price in USD<input aria-label="Sale price in USD" inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} className="market-input ml-3 min-h-11 w-28 px-3"/></label>}
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
      {tab==='sell'?eligible.map(item=><article key={item.uid} className="stat-tile min-w-0 p-3"><ItemCard item={item}/><p className="text-xs text-amber-200">{valid?skrPrice(cents,rate):'Enter a USD price'}</p><SkrPurchaseButton product="market_list_item" params={{item_id:item.uid,price:cents}} label={item.locked?'Locked':equipped.has(item.uid)?'Equipped':'List · pay $0.02 fee'} disabled={!valid||item.locked||equipped.has(item.uid)} onDelivered={delivered}/></article>)
      :tab==='history'?(market?.history??[]).map(row=><article key={row.id} className="stat-tile min-w-0 p-3 text-xs"><p className="break-words text-amber-100">{ITEM_MAP[row.name]?.name??row.name}</p><p>{row.action} · ${(row.price/100).toFixed(2)}</p></article>)
      :listings.map(listing=><article key={listing.id} className="stat-tile min-w-0 p-3"><ItemCard item={listing.item}/><p className="text-xs text-stone-400">{listing.is_own?'Your listing':listing.seller}</p><p className="text-xs font-bold text-amber-200">{skrPrice(listing.price,rate)}</p>{listing.is_own?<button style={{minHeight:44}} className="game-control mt-2 min-h-11 w-full text-xs" disabled={busy} onClick={()=>{setBusy(true);void game.cancelMarketListing(listing.id).then(r=>{if(!r.ok)setMessage('Cancellation failed. Refresh and try again.');else void refresh();}).finally(()=>setBusy(false));}}>Cancel listing</button>:<SkrPurchaseButton product="market_buy_listing" params={{listing_id:listing.id}} onDelivered={delivered}/>}</article>)}
    </div>
    {!market&&<p className="my-4 text-xs text-stone-400">Loading server listings…</p>}
    {market&&tab!=='sell'&&tab!=='history'&&listings.length===0&&<p className="my-4 text-xs text-stone-400">No active listings.</p>}
    {tab==='sell'&&eligible.length===0&&<p className="my-4 text-xs text-stone-400">No server-owned equipment to list.</p>}
  </div>;
}
export function SeekerShopScreen({game}:{game:GameApi}) {
  const rate=useSkrRate();
  const refresh=game.refreshStore;
  useEffect(()=>{void refresh();},[refresh]);
  const delivered=(result:Record<string,unknown>)=>game.applySeekerPurchase(result);
  return <div className="premium-screen themed-screen themed-screen-store game-scrollbar h-full overflow-y-auto p-3">
    <header className="merchant-surface flex flex-wrap items-center justify-between gap-3 p-4"><h2 className="flex items-center gap-2 text-xl font-black text-amber-100"><Store/>Store · SKR</h2><Balance/></header>
    <p className="my-3 text-xs leading-5 text-stone-300">Pay from your in-game SKR balance. Check the exact amount before confirming. Free game progress stays available.</p>
    <h3 className="mb-2 text-lg font-black text-amber-100">Resource bundles</h3>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">{(game.accountBonus?.bundles??[]).map(offer=><article key={offer.bundle} className="stat-tile min-w-0 p-3"><div className="flex items-center gap-2"><BundleArt resource={offer.resourceId}/><h4 className="min-w-0 text-sm font-bold text-amber-100">{offer.quantity} × {offer.resourceId.replace(/_/g,' ')}</h4></div><p className="my-2 text-xs text-amber-200">{skrPrice(offer.usdCents,rate)}</p><SkrPurchaseButton product="shop_bundle_buy" params={{bundle:offer.bundle}} onDelivered={delivered}/></article>)}</div>
    <h3 className="my-3 text-lg font-black text-amber-100">Gold/XP Boost ×2</h3>
    <p className="mb-2 text-xs text-stone-300">+100% Gold and XP. Buying again extends time.</p>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">{(game.accountBonus?.plans??[]).map(plan=><article key={plan.plan} className="stat-tile min-w-0 p-3"><h4 className="flex items-center gap-1.5 text-sm font-bold text-amber-100"><Rocket size={16} className="shrink-0 text-amber-300" aria-hidden="true"/>{plan.days} day{plan.days===1?'':'s'}</h4><p className="my-2 text-xs text-amber-200">{skrPrice(plan.usdCents,rate)}</p><SkrPurchaseButton product="reward_boost_buy" params={{plan:plan.plan}} onDelivered={delivered}/></article>)}</div>
  </div>;
}
