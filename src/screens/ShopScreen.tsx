import { useEffect, useState } from 'react';
import { Coins, FlaskConical, RefreshCw, Package, Zap } from 'lucide-react';
import { formatNum } from '@/game/state';
import { POTIONS, ITEM_MAP } from '@/game/items';
import { RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import type { PotionTier } from '@/game/types';
import type { GameApi } from '@/game/useGame';

export function ShopScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refreshIn = Math.max(0, state.rotatingShopRefreshAt - now);
  const refreshH = Math.floor(refreshIn / 3600000);
  const refreshM = Math.floor((refreshIn % 3600000) / 60000);

  return (
    <div className="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div className="px-4 py-3 border-b border-white/10 bg-slate-950/60 shrink-0">
        <h2 className="text-lg font-bold text-white">Shop</h2>
      </div>

      <div className="p-4 space-y-5 max-w-3xl mx-auto w-full">
        {/* $HERO info */}
        <section>
          <h3 className="text-sm font-bold text-violet-300 mb-2 flex items-center gap-1.5"><Zap size={15} /> $HERO Token</h3>
          <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3.5">
            <div className="text-[11px] text-slate-400 space-y-1.5">
              <p>$HERO is the in-game crypto token (Solana). Balance: <span className="text-violet-300 font-bold">{formatNum(state.hero)} $HERO</span></p>
              <ul className="pl-3 space-y-1">
                <li>• Earn $HERO by winning battles in locations (when not overpowered)</li>
                <li>• Use $HERO to summon heroes (30 per summon)</li>
                <li>• Star up heroes requires $HERO</li>
                <li>• Buy & sell items/heroes on the Marketplace</li>
                <li>• Withdraw to your Phantom wallet (coming soon)</li>
              </ul>
              <p className="text-slate-600 mt-2">$HERO cannot be purchased with gold. Earn it through gameplay.</p>
            </div>
          </div>
        </section>

        {/* Potions */}
        <section>
          <h3 className="text-sm font-bold text-emerald-300 mb-2 flex items-center gap-1.5"><FlaskConical size={15} /> Health Potions</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {POTIONS.map(p => (
              <div key={p.tier} className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-2.5 flex flex-col items-center gap-1">
                <div className="text-2xl">🧪</div>
                <div className="text-[10px] font-bold text-emerald-200 text-center leading-tight">{p.name}</div>
                <div className="text-[9px] text-emerald-400">+{formatNum(p.hpRestore)} HP</div>
                <div className="text-[9px] text-slate-500">Owned: {state.potions[p.tier]}</div>
                <button onClick={() => game.buyPotion(p.tier as PotionTier, 1)} disabled={state.gold < p.cost} className="w-full mt-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-bold bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 disabled:opacity-40 transition"><Coins size={11} /> {formatNum(p.cost)}</button>
              </div>
            ))}
          </div>
        </section>

        {/* Rotating items */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold text-amber-300 flex items-center gap-1.5"><Package size={15} /> Adventurer's Wares</h3>
            <span className="text-[10px] text-slate-500 flex items-center gap-1"><RefreshCw size={11} /> Refreshes in {refreshH}h {refreshM}m</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {state.rotatingShop.map((slot, i) => {
              const base = ITEM_MAP[slot.itemId]; if (!base) return null;
              const rc = RARITY_COLORS[base.rarity];
              return (
                <div key={i} className="rounded-xl border p-2.5 flex flex-col items-center gap-1" style={{ borderColor: rc + '44', background: rc + '0a' }}>
                  <div className="text-2xl">{base.icon}</div>
                  <div className="text-[10px] font-bold text-center" style={{ color: rc }}>{base.name}</div>
                  <div className="text-[8px] text-slate-500 uppercase">{RARITY_LABEL[base.rarity]}</div>
                  <button onClick={() => game.buyRotatingItem(i)} disabled={slot.sold || state.gold < slot.price || state.inventory.length >= 64} className="w-full mt-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-bold bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 disabled:opacity-40 transition">{slot.sold ? 'SOLD' : <><Coins size={11} /> {formatNum(slot.price)}</>}</button>
                </div>
              );
            })}
          </div>
          <p className="text-[9px] text-slate-600 mt-1.5">Rare+ gear must be found in battle, from chests, or on the Marketplace with $HERO.</p>
        </section>
      </div>
    </div>
  );
}
