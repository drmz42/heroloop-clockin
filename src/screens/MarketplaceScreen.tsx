import { useState, useMemo } from 'react';
import { Search, Zap, ShoppingCart, Tag, X, TrendingUp } from 'lucide-react';
import { ITEM_MAP, formatStatValue, sellValue, STAT_LABEL } from '@/game/items';
import { RARITY_COLORS, RARITY_LABEL, RARITY_INDEX, HERO_MAP, CLASS_LABEL } from '@/game/heroes';
import { formatNum } from '@/game/state';
import type { Rarity, OwnedItem, OwnedHero } from '@/game/types';
import type { GameApi } from '@/game/useGame';

type Category = 'all' | 'items' | 'heroes';
type ViewTab = 'browse' | 'sell';

interface Listing {
  uid: string;
  name: string;
  rarity: Rarity;
  icon: string;
  subtitle: string;
  stats?: { key: string; value: string }[];
  power: number;
  level: number;
  price: number;
  seller: string;
  owner: boolean;
}

// Mock marketplace listings (other players)
function generateMockListings(): Listing[] {
  const mockItems: { itemId: string; price: number; seller: string }[] = [
    { itemId: 'w-starcall',  price: 15,  seller: 'DragonSlayer' },
    { itemId: 'h-dragonscale', price: 8, seller: 'FrostQueen' },
    { itemId: 'a-voidshroud', price: 12, seller: 'ShadowKing' },
    { itemId: 'g-storm',     price: 20,  seller: 'ThunderGod' },
    { itemId: 'w-soulblade', price: 35,  seller: 'VoidWalker' },
    { itemId: 'am-soulstone',price: 18,  seller: 'MysticSage' },
    { itemId: 'r-signet',    price: 10,  seller: 'RoyalGuard' },
    { itemId: 'b-void',      price: 14,  seller: 'WindRider' },
  ];
  return mockItems.map((m, i) => {
    const base = ITEM_MAP[m.itemId];
    if (!base) return null;
    const fakeStats = base.rarity === 'epic' ? [{ key: 'atk', value: '+25' }, { key: 'critChance', value: '+4.0%' }] : [{ key: 'hp', value: '+150' }];
    return {
      uid: `mock-${i}`, name: base.name, rarity: base.rarity, icon: base.icon,
      subtitle: STAT_LABEL[base.slot === 'ring1' || base.slot === 'ring2' ? 'atk' : 'atk'] || base.slot,
      stats: fakeStats, power: 100 + i * 50, level: 5 + i, price: m.price, seller: m.seller, owner: false,
    };
  }).filter(Boolean) as Listing[];
}

export function MarketplaceScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const [viewTab, setViewTab] = useState<ViewTab>('browse');
  const [category, setCategory] = useState<Category>('all');
  const [rarityFilter, setRarityFilter] = useState<Rarity | 'all'>('all');
  const [search, setSearch] = useState('');
  const [maxPrice, setMaxPrice] = useState<number>(0);
  const [sortBy, setSortBy] = useState<'price' | 'power' | 'rarity'>('rarity');

  const mockListings = useMemo(() => generateMockListings(), []);

  // Player's own listings from inventory (for Sell tab)
  const myListings = useMemo(() => {
    return state.inventory.map(item => {
      const b = ITEM_MAP[item.itemId];
      if (!b) return null;
      return {
        uid: item.uid, name: b.name, rarity: b.rarity, icon: b.icon,
        subtitle: b.slot, stats: item.stats.map(s => ({ key: s.key, value: formatStatValue(s) })),
        power: item.power, level: item.level, price: Math.round(sellValue(item) * 3),
        seller: 'You', owner: true,
      } as Listing;
    }).filter(Boolean) as Listing[];
  }, [state.inventory]);

  const heroListings = useMemo(() => {
    return state.ownedHeroes.map(hero => {
      const b = HERO_MAP[hero.heroId];
      if (!b) return null;
      const rv: Record<string, number> = { common: 3, uncommon: 8, rare: 20, epic: 50, legendary: 150, mythic: 400, relic: 1200, cursed: 3500, cosmic: 10000, divine: 30000 };
      return { uid: hero.uid, name: b.name, rarity: b.rarity, icon: b.heroClass === 'knight' ? '⚔️' : b.heroClass === 'archer' ? '🏹' : b.heroClass === 'assassin' ? '🗡️' : b.heroClass === 'shepherd' ? '✨' : '🌿', subtitle: `${CLASS_LABEL[b.heroClass]} Lv${hero.level} ★${hero.stars}`, power: hero.level * 100, level: hero.level, price: Math.round((rv[b.rarity] ?? 3) * (1 + hero.stars * 0.5)), seller: 'You', owner: true } as Listing;
    }).filter(Boolean) as Listing[];
  }, [state.ownedHeroes]);

  const browseListings = category === 'heroes' ? [] : mockListings;
  const sellListings = category === 'heroes' ? heroListings : myListings;

  const active = viewTab === 'browse' ? browseListings : sellListings;

  const filtered = active.filter(l => {
    if (rarityFilter !== 'all' && l.rarity !== rarityFilter) return false;
    if (search && !l.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (maxPrice > 0 && l.price > maxPrice) return false;
    return true;
  }).sort((a, b) => {
    if (sortBy === 'price') return a.price - b.price;
    if (sortBy === 'power') return b.power - a.power;
    return RARITY_INDEX[b.rarity] - RARITY_INDEX[a.rarity];
  });

  const rarities: (Rarity | 'all')[] = ['all', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'relic', 'cursed', 'cosmic', 'divine'];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-white/10 bg-slate-950/60 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-bold text-white flex items-center gap-1.5"><ShoppingCart size={17} className="text-violet-300" /> Marketplace</h2>
          <span className="flex items-center gap-1 text-xs text-violet-300"><Zap size={12} /> {formatNum(state.hero)} $HERO</span>
        </div>

        {/* Browse / Sell tabs */}
        <div className="flex gap-1 mb-2">
          <button onClick={() => setViewTab('browse')} className={`px-4 py-1.5 rounded-full text-xs font-bold transition ${viewTab === 'browse' ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40' : 'bg-slate-800 text-slate-500 border border-white/5'}`}>Browse</button>
          <button onClick={() => setViewTab('sell')} className={`px-4 py-1.5 rounded-full text-xs font-bold transition ${viewTab === 'sell' ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40' : 'bg-slate-800 text-slate-500 border border-white/5'}`}>My Listings</button>
        </div>

        {/* Category + filters */}
        <div className="flex items-center gap-2 flex-wrap mb-2">
          <div className="flex gap-1">
            {(['all', 'items', 'heroes'] as Category[]).map(c => <button key={c} onClick={() => setCategory(c)} className={`px-2.5 py-1 rounded-full text-[10px] font-bold capitalize transition ${category === c ? 'bg-violet-500/20 text-violet-300 border border-violet-500/40' : 'bg-slate-800 text-slate-500 border border-white/5'}`}>{c}</button>)}
          </div>
          <div className="relative flex-1 min-w-[100px]"><Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." className="w-full pl-6 pr-2 py-1 rounded-lg bg-slate-800/60 border border-white/10 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-violet-500/40" /></div>
          <select value={sortBy} onChange={e => setSortBy(e.target.value as 'price' | 'power' | 'rarity')} className="px-2 py-1 rounded-lg bg-slate-800/60 border border-white/10 text-xs text-slate-300 focus:outline-none"><option value="rarity">Rarity</option><option value="power">Power</option><option value="price">Price</option></select>
        </div>

        {/* Rarity chips */}
        <div className="flex gap-1 flex-wrap">
          {rarities.map(r => <button key={r} onClick={() => setRarityFilter(r)} className={`px-1.5 py-0.5 rounded-full text-[8px] font-bold uppercase transition ${rarityFilter === r ? 'border' : 'bg-slate-800/60 text-slate-500 border border-white/5'}`} style={rarityFilter === r ? { borderColor: r === 'all' ? '#94a3b8' : RARITY_COLORS[r as Rarity] + '88', color: r === 'all' ? '#94a3b8' : RARITY_COLORS[r as Rarity], background: (r === 'all' ? '#94a3b8' : RARITY_COLORS[r as Rarity]) + '15' } : undefined}>{r === 'all' ? 'All' : RARITY_LABEL[r as Rarity]}</button>)}
        </div>
      </div>

      {/* Listings grid */}
      <div className="flex-1 overflow-y-auto no-scrollbar p-3">
        {viewTab === 'browse' && (
          <div className="text-[10px] text-slate-500 mb-2 flex items-center gap-1"><TrendingUp size={11} /> Live listings from other players</div>
        )}
        {viewTab === 'sell' && (
          <div className="text-[10px] text-slate-500 mb-2">List your items/heroes for $HERO. (Listing UI — buyers will see these when the game launches.)</div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
          {filtered.map(l => {
            const rc = RARITY_COLORS[l.rarity];
            return (
              <div key={l.uid} className="rounded-xl border p-2.5" style={{ borderColor: rc + '44', background: rc + '0a' }}>
                <div className="flex items-start gap-2">
                  <div className="text-xl shrink-0">{l.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-bold truncate" style={{ color: rc }}>{l.name}</div>
                    <div className="text-[8px] text-slate-500 uppercase">{RARITY_LABEL[l.rarity]}</div>
                    <div className="text-[8px] text-slate-400">Lv{l.level} · ⚡{l.power}</div>
                  </div>
                </div>
                {l.stats && l.stats.length > 0 && <div className="text-[8px] text-emerald-300/80 mt-1 truncate">{l.stats.map(s => s.value).join(' ')}</div>}
                <div className="mt-2 flex items-center justify-between">
                  <span className="flex items-center gap-0.5 text-violet-300 text-xs font-bold"><Zap size={9} /> {l.price}</span>
                  {viewTab === 'browse' ? <button className="px-2 py-1 rounded-lg bg-violet-500/15 border border-violet-500/30 text-violet-300 text-[10px] font-bold hover:bg-violet-500/25 transition">Buy</button> : <button className="px-2 py-1 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-bold hover:bg-amber-500/25 transition">List</button>}
                </div>
                <div className="text-[7px] text-slate-600 mt-0.5 text-center">{l.seller}</div>
              </div>
            );
          })}
        </div>
        {filtered.length === 0 && <div className="text-slate-600 text-sm text-center py-8">No listings match your filters.</div>}
      </div>

      <div className="px-4 py-2 border-t border-white/10 bg-slate-950/60 text-center shrink-0">
        <span className="text-[10px] text-slate-500 flex items-center justify-center gap-1.5"><Tag size={10} /> On-chain trading via Solana + Phantom wallet coming soon</span>
      </div>
    </div>
  );
}

void X;
