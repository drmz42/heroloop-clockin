import { useEffect } from 'react';
import { FlaskConical,Rocket,Store } from 'lucide-react';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import type { GameApi } from '@/game/useGame';
import { SkrTokenIcon } from '@/components/SkrTokenIcon';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { SkrUsd } from '@/components/SkrUsd';
import { skrPrice,useSkrRate } from '@/game/skrPurchase';
import { formatAmountShort,useWalletSnapshot } from '@/game/seekerWallet';

function BundleArt({resource}:{resource:string}) {
  if(resource==='summon_scroll')return <SummonScrollArtwork size={36}/>;
  if(resource==='boss_key')return <BossKeyIcon size={34}/>;
  return <FlaskConical size={30} className="shrink-0 text-emerald-300" aria-hidden="true"/>;
}
function Balance() {
  const wallet=useWalletSnapshot();
  return <span className="stat-tile flex items-center gap-1.5 px-3 py-2 text-sm font-bold text-lime-200"><SkrTokenIcon size={16} />{wallet?formatAmountShort(wallet.balances.SKR,'SKR','down'):'—'} SKR</span>;
}
export function SeekerShopScreen({game}:{game:GameApi}) {
  const rate=useSkrRate();
  const refresh=game.refreshStore;
  useEffect(()=>{void refresh();},[refresh]);
  const delivered=(result:Record<string,unknown>)=>game.applySeekerPurchase(result);
  return <div className="premium-screen themed-screen themed-screen-store game-scrollbar h-full overflow-y-auto p-3">
    <header className="merchant-surface flex flex-wrap items-center justify-between gap-3 p-4 pr-14"><h2 className="flex items-center gap-2 text-xl font-black text-amber-100"><Store/>Store · SKR</h2><Balance/></header>
    <p className="my-3 text-xs leading-5 text-stone-300">Pay from your in-game SKR balance. Check the exact amount before confirming. Free game progress stays available.</p>
    <h3 className="mb-2 text-lg font-black text-amber-100">Resource bundles</h3>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">{(game.accountBonus?.bundles??[]).map(offer=><article key={offer.bundle} className="stat-tile min-w-0 p-3"><div className="flex items-center gap-2"><BundleArt resource={offer.resourceId}/><h4 className="min-w-0 text-sm font-bold text-amber-100">{offer.quantity} × {offer.resourceId.replace(/_/g,' ')}</h4></div><p className="my-2 text-xs text-amber-200">{skrPrice(offer.usdCents,rate)}<SkrUsd cents={offer.usdCents}/></p><SkrPurchaseButton product="shop_bundle_buy" params={{bundle:offer.bundle}} onDelivered={delivered}/></article>)}</div>
    <h3 className="my-3 text-lg font-black text-amber-100">Gold/XP Boost ×2</h3>
    <p className="mb-2 text-xs text-stone-300">+100% Gold and XP. Buying again extends time.</p>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">{(game.accountBonus?.plans??[]).map(plan=><article key={plan.plan} className="stat-tile min-w-0 p-3"><h4 className="flex items-center gap-1.5 text-sm font-bold text-amber-100"><Rocket size={16} className="shrink-0 text-amber-300" aria-hidden="true"/>{plan.days} day{plan.days===1?'':'s'}</h4><p className="my-2 text-xs text-amber-200">{skrPrice(plan.usdCents,rate)}<SkrUsd cents={plan.usdCents}/></p><SkrPurchaseButton product="reward_boost_buy" params={{plan:plan.plan}} onDelivered={delivered}/></article>)}</div>
  </div>;
}
