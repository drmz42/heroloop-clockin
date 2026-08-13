import type { ReactNode } from 'react';
import { Coins, Gift, Package, ShieldCheck, Sparkles, Store } from 'lucide-react';
import { formatNum } from '@/game/state';
import type { GameApi } from '@/game/useGame';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';

const PACKS = [
  { price: 0.99, name: 'Initiate Pack', scrolls: 50, gold: 2_500, keys: 0, accent: '#8ab17d' },
  { price: 4.99, name: 'Adventurer Pack', scrolls: 250, gold: 15_000, keys: 1, accent: '#75a9d4' },
  { price: 9.99, name: 'Citadel Pack', scrolls: 510, gold: 35_000, keys: 2, accent: '#ae83d5' },
  { price: 49.99, name: 'Mythic Treasury', scrolls: 2_650, gold: 250_000, keys: 8, accent: '#d58a62' },
  { price: 99.99, name: 'Abyss Treasury', scrolls: 5_500, gold: 600_000, keys: 18, accent: '#e2b658' },
  { price: 199.99, name: 'Founder Preview', scrolls: 11_500, gold: 1_500_000, keys: 40, accent: '#e8d692' },
] as const;

export function ShopScreen({ game }: { game: GameApi }) {
  const { state } = game;
  return (
    <div className="premium-screen themed-screen themed-screen-store game-scrollbar h-full overflow-y-auto p-2">
      <header className="merchant-surface mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3"><span className="grid h-14 w-14 place-items-center rounded-xl border border-[#a4773d] bg-black/30 text-[#e5b85f]"><Store size={29} /></span><div><div className="section-kicker">HeroLoop Store</div><h2 className="mt-0.5 text-2xl font-black text-[#eee2ce]">Packs & Promotions</h2><p className="mt-1 text-xs text-[#a59b8c]">Resource bundles, seasonal offers and account promotions.</p></div></div>
        <div className="flex gap-2"><Balance icon={<Coins size={15} />} label="Gold" value={formatNum(state.gold)} tone="gold" /><Balance icon={<HeroTokenIcon size={15} />} label="$HERO" value={formatNum(state.hero)} tone="violet" /></div>
      </header>

      <main className="mx-auto mt-2 max-w-6xl">
        <section className="material-panel p-4">
          <div className="flex items-end justify-between gap-3"><div><div className="section-kicker">Test catalogue</div><h3 className="mt-0.5 text-lg font-black text-[#eadbc4]">Launch Resource Packs</h3></div><span className="rounded border border-amber-700/50 bg-amber-950/30 px-2 py-1 text-[8px] font-black uppercase tracking-wider text-amber-300">Preview · purchasing disabled</span></div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PACKS.map((pack, index) => <article key={pack.price} className={`shop-pack ${index === 4 ? 'is-featured' : ''}`} style={{ '--pack-accent': pack.accent } as React.CSSProperties}><div className="shop-pack-icon">{index >= 4 ? <Sparkles size={27} /> : <Gift size={25} />}</div><div className="section-kicker">{index === 0 ? 'Starter offer' : index === 4 ? 'Best launch value' : 'Resource bundle'}</div><h4>{pack.name}</h4><strong>${pack.price.toFixed(2)}</strong><ul><li><span>Summon Scrolls</span><b>{formatNum(pack.scrolls)}</b></li><li><span>Gold</span><b>{formatNum(pack.gold)}</b></li><li><span>Boss Keys</span><b>{pack.keys || '—'}</b></li></ul><button type="button" disabled className="game-control game-primary">TEST OFFER · COMING SOON</button></article>)}
          </div>
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-[#4d402e] bg-black/30 p-3 text-[10px] leading-relaxed text-[#a49b8d]"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-[#c8a45e]" /><span>This replaces rotating equipment and potion sales. Prices and contents are test catalogue values only; no payment or resource settlement is active until the final catalogue, rolling spend limits and server receipt verification are approved.</span></div>
        </section>
        <section className="material-panel mt-2 grid gap-2 p-3 sm:grid-cols-3"><Promo title="Weekly Citadel" text="Dungeon-oriented Scroll and Boss Key promotion slot." /><Promo title="Seasonal Sale" text="Time-bounded catalogue promotion without hidden odds." /><Promo title="Account Offers" text="Eligibility and purchase limits will be server-owned." /></section>
      </main>
    </div>
  );
}

function Promo({ title, text }: { title: string; text: string }) { return <div className="rounded-lg border border-[#4f4536] bg-black/25 p-3"><Package size={16} className="text-[#b8955d]" /><b className="mt-1 block text-xs text-[#ddd0bb]">{title}</b><p className="mt-1 text-[9px] leading-4 text-[#898176]">{text}</p></div>; }
function Balance({ icon, label, value, tone }: { icon: ReactNode; label: string; value: string; tone: 'gold' | 'violet' }) { return <div className="stat-tile flex min-w-[110px] items-center gap-2 px-3 py-2"><span className={tone === 'gold' ? 'text-[#e3b759]' : 'text-violet-300'}>{icon}</span><span><span className="block text-[8px] uppercase tracking-wider text-[#7f796f]">{label}</span><b className="block text-sm text-[#eee3d1]">{value}</b></span></div>; }
