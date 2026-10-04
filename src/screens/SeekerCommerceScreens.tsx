import { useEffect, type CSSProperties } from 'react';
import { Rocket } from 'lucide-react';
import { PotionIcon } from '@/components/PotionIcon';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import type { GameApi } from '@/game/useGame';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { SkrUsd } from '@/components/SkrUsd';
import { skrPrice,useSkrRate } from '@/game/skrPurchase';
import '@/theme/scene/scene.css';

function BundleArt({resource}:{resource:string}) {
  if(resource==='summon_scroll')return <SummonScrollArtwork size={52}/>;
  if(resource==='boss_key')return <BossKeyIcon size={48}/>;
  return <PotionIcon size={52}/>;
}
export function SeekerShopScreen({game}:{game:GameApi}) {
  const rate=useSkrRate();
  const refresh=game.refreshStore;
  useEffect(()=>{void refresh();},[refresh]);
  const delivered=(result:Record<string,unknown>)=>game.applySeekerPurchase(result);
  const still=game.state.battleAnimationMode==='off';
  return <div className={`sc-root st-root${still?' sc-still':''}`}>
    <section className="sc-stage st-stage" aria-label="Apothecary">
      <div className="sc-stage-art" aria-hidden="true"/>
      <div className="sc-glow" aria-hidden="true"/>
      {!still&&<div className="sc-embers" aria-hidden="true">{[0,1,2,3,4,5,6].map(i=><i key={i} style={{'--i':i} as CSSProperties}/>)}</div>}
      <header className="sc-head"><span className="sc-kicker">The Apothecary</span><h2 className="sc-title">Store · SKR</h2><p className="sc-lede">Pay from your in-game SKR balance. Check the exact amount before confirming. Free game progress stays available.</p></header>
    </section>
    <div className="sc-body">
      <section className="sc-panel">
        <div className="sc-section-head"><h3>Resource bundles</h3></div>
        <div className="st-grid">{(game.accountBonus?.bundles??[]).map(offer=><article key={offer.bundle} className="st-card"><span className="st-art"><BundleArt resource={offer.resourceId}/></span><h4><b>{offer.quantity}</b> × {offer.resourceId.replace(/_/g,' ')}</h4><p className="st-price">{skrPrice(offer.usdCents,rate)}<SkrUsd cents={offer.usdCents}/></p><SkrPurchaseButton product="shop_bundle_buy" params={{bundle:offer.bundle}} onDelivered={delivered}/></article>)}</div>
      </section>
      <section className="sc-panel">
        <div className="sc-section-head"><h3>Gold/XP Boost ×2</h3></div>
        <p className="sc-muted st-note">+100% Gold and XP. Buying again extends time.</p>
        <div className="st-grid st-grid--plans">{(game.accountBonus?.plans??[]).map(plan=><article key={plan.plan} className="st-card st-card--boost"><span className="st-art"><Rocket size={30} aria-hidden="true"/></span><h4><b>{plan.days}</b> day{plan.days===1?'':'s'}</h4><p className="st-price">{skrPrice(plan.usdCents,rate)}<SkrUsd cents={plan.usdCents}/></p><SkrPurchaseButton product="reward_boost_buy" params={{plan:plan.plan}} onDelivered={delivered}/></article>)}</div>
      </section>
    </div>
  </div>;
}
