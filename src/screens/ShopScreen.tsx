import { useEffect, useState, type ReactNode } from 'react';
import { Coins, RefreshCw, Package, Store, Clock3, ShieldCheck, ScrollText } from 'lucide-react';
import { formatNum } from '@/game/state';
import { POTIONS, ITEM_MAP } from '@/game/items';
import { RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import type { PotionTier } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { ItemArtwork } from '@/components/ItemArtwork';

export function ShopScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const equipped = new Set(state.ownedHeroes.flatMap((hero) => Object.values(hero.equipped)).filter(Boolean));
  const bagCount = state.inventory.filter((item) => !equipped.has(item.uid)).length;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const refreshIn = Math.max(0, state.rotatingShopRefreshAt - now);
  const refreshH = Math.floor(refreshIn / 3600000);
  const refreshM = Math.floor((refreshIn % 3600000) / 60000);

  return (
    <div className="premium-screen themed-screen themed-screen-store game-scrollbar h-full overflow-y-auto p-2">
      <header className="merchant-surface mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3"><span className="grid h-14 w-14 place-items-center rounded-xl border border-[#a4773d] bg-black/30 text-[#e5b85f]"><Store size={29} /></span><div><div className="section-kicker">The Brass Lantern</div><h2 className="mt-0.5 text-2xl font-black text-[#eee2ce]">Adventurer Store</h2><p className="mt-1 text-xs text-[#a59b8c]">Field supplies and rotating equipment. Every offer shows its real effect.</p></div></div>
        <div className="flex gap-2"><Balance icon={<Coins size={15} />} label="Gold" value={formatNum(state.gold)} tone="gold" /><Balance icon={<HeroTokenIcon size={15} />} label="$HERO" value={formatNum(state.hero)} tone="violet" /></div>
      </header>

      <main className="mx-auto mt-2 grid max-w-6xl gap-2">
        <section className="material-panel p-3">
          <div className="section-kicker">Inventory expansion</div>
          <h3 className="mt-0.5 text-lg font-black text-[#eadbc4]">Extra Bags</h3>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {[2, 3, 4].map((bag) => <article key={bag} className="shop-card p-3 text-center"><Package className="mx-auto text-[#b6914f]" size={22} /><div className="mt-1 text-xs font-black text-[#ddd0bc]">Bag {bag}</div><button type="button" disabled className="game-control mt-2 w-full py-1 text-[9px] font-bold">Price pending</button></article>)}
          </div>
          <p className="mt-2 text-[9px] text-[#817a70]">Purchase stays disabled until the founder approves exact prices and payment currency.</p>
        </section>
        <section className="material-panel p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><div className="section-kicker">Rotating stock</div><h3 className="mt-0.5 text-lg font-black text-[#eadbc4]">Adventurer's Wares</h3></div><div className="game-control flex items-center gap-2 px-3 text-xs text-[#b4ab9d]"><RefreshCw size={13} /> Refreshes in <b className="text-[#e3bc69]">{refreshH}h {refreshM}m</b></div></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {state.rotatingShop.map((slot, index) => {
              const base = ITEM_MAP[slot.itemId]; if (!base) return null;
              const rc = RARITY_COLORS[base.rarity];
              const unavailable = slot.sold || state.gold < slot.price || bagCount >= 64;
              return <article key={index} className={`shop-card rarity-${base.rarity} p-2.5`}><div className="mx-auto h-20 w-20 overflow-hidden rounded-lg border border-white/5 bg-black/20"><ItemArtwork itemId={base.id} name={base.name} fallback={base.icon} /></div><div className="mt-1 truncate text-center text-xs font-black" style={{ color: rc }}>{base.name}</div><div className="mt-0.5 flex items-center justify-center gap-1 text-[9px] uppercase tracking-wide text-[#888174]"><Package size={10} /> {RARITY_LABEL[base.rarity]} equipment</div><div className="mt-2 grid grid-cols-2 gap-1 text-[9px]"><Info label="Benefit" value="Owned gear" /><Info label="Duration" value="Permanent" /></div><button type="button" onClick={() => game.buyRotatingItem(index)} disabled={unavailable} className="game-control game-primary mt-2 flex w-full items-center justify-center gap-1 px-2 text-xs font-black">{slot.sold ? 'Sold' : bagCount >= 64 ? 'Inventory full' : state.gold < slot.price ? 'Not enough Gold' : <><Coins size={12} /> {formatNum(slot.price)}</>}</button></article>;
            })}
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-[#4d402e] bg-black/20 p-2.5 text-[10px] text-[#928b80]"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[#b6914f]" /><span>Store equipment follows existing rarity and inventory rules. It never bypasses unlock levels, global limits or crafting-only rarities.</span></div>
        </section>

        <aside className="material-panel p-3">
          <div className="section-kicker">Field supplies</div><h3 className="mt-0.5 text-lg font-black text-[#dce9dc]">Health Potions</h3><p className="mt-1 text-[10px] text-[#8f897e]">Instant combat consumables already supported by Auto-potion.</p>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
            {POTIONS.map((potion) => <article key={potion.tier} className="shop-card grid grid-cols-[64px_minmax(0,1fr)] items-center gap-3 p-2.5"><div className="h-16 w-16 shrink-0 rounded-lg border border-emerald-800/50 bg-emerald-950/15"><ItemArtwork itemId={`potion-${potion.tier}`} name={potion.name} fallback="Potion" /></div><div className="min-w-0"><div className="truncate text-xs font-black text-emerald-200">{potion.name}</div><div className="mt-0.5 text-[9px] text-emerald-400">Restores {formatNum(potion.hpRestore)} HP</div><div className="mt-0.5 flex items-center gap-2 text-[9px] text-[#857f75]"><span>Owned {state.potions[potion.tier]}</span><span className="flex items-center gap-1"><Clock3 size={9} /> Instant</span></div><button type="button" onClick={() => game.buyPotion(potion.tier as PotionTier, 1)} disabled={state.gold < potion.cost} className="game-control mt-2 flex h-8 w-full items-center justify-center gap-1 px-2 text-[10px] font-black text-[#e5bd68]"><Coins size={11} />{formatNum(potion.cost)}</button></div></article>)}
          </div>
          <div className="mt-3 stat-tile p-2.5"><div className="flex items-center gap-2 text-xs font-bold text-[#d7c8ae]"><ScrollText size={14} className="text-[#a98952]" /> Boost offers review</div><p className="mt-1 text-[10px] leading-relaxed text-[#898378]">Gold Surge, XP Surge, loot boosts and paid keys are excluded for now: the current game has no approved duration, price or server-authoritative activation support.</p></div>
        </aside>
      </main>
    </div>
  );
}

function Balance({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: 'gold' | 'violet' }) { return <div className="stat-tile flex min-w-[110px] items-center gap-2 px-3 py-2"><span className={tone === 'gold' ? 'text-[#e3b759]' : 'text-violet-300'}>{icon}</span><span><span className="block text-[8px] uppercase tracking-wider text-[#7f796f]">{label}</span><b className="block text-sm text-[#eee3d1]">{value}</b></span></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="rounded border border-[#40372b] bg-black/20 p-1.5 text-center"><span className="block text-[7px] uppercase text-[#6f6a62]">{label}</span><b className="text-[9px] text-[#b8afa1]">{value}</b></div>; }
