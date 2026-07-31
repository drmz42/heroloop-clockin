import { useState } from 'react';
import { Sparkles, Zap, X } from 'lucide-react';
import { HERO_MAP, RARITY_COLORS, RARITY_GLOW, RARITY_LABEL, RARITY_WEIGHT } from '@/game/heroes';
import { summonCostHero, formatNum } from '@/game/state';
import { heroPortraitSrc } from '@/game/portraits';
import type { OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';

function SummonResult({ heroes, onClose }: { heroes: OwnedHero[]; onClose: () => void }) {
  const [revealed, setRevealed] = useState(0);
  const revealNext = () => { if (revealed < heroes.length) setRevealed(r => r + 1); };
  const allRevealed = revealed >= heroes.length;
  const order: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5, relic: 6, cursed: 7, cosmic: 8, divine: 9 };
  const best = heroes.reduce((b, h) => { const r = HERO_MAP[h.heroId]?.rarity ?? 'common'; return order[r] > order[b] ? r : b; }, 'common' as Rarity);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur p-4 anim-fade">
      <div className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(circle at 50% 50%, ${RARITY_COLORS[best]}22, transparent 60%)` }} />
      <div className="relative w-full max-w-lg">
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
          {heroes.map((h, i) => {
            const base = HERO_MAP[h.heroId]; const isRevealed = i < revealed; if (!base) return null;
            const rc = RARITY_COLORS[base.rarity]; const svg = heroPortraitSrc(base.id, base.heroClass, base.rarity, base.color);
            return (
              <button key={h.uid} onClick={revealNext} className="relative aspect-[3/4] rounded-xl flex flex-col items-center justify-center overflow-hidden border-2 transition" style={{ borderColor: isRevealed ? rc : '#334155', background: isRevealed ? `radial-gradient(circle at 50% 30%, ${base.color}33, ${rc}18)` : 'linear-gradient(160deg, #1e293b, #0f172a)', boxShadow: isRevealed ? `0 0 20px ${RARITY_GLOW[base.rarity]}` : 'none' }}>
                {isRevealed ? <div className="anim-reveal flex flex-col items-center gap-1"><img src={svg} alt="" className="w-14 h-14 rounded-lg" /><span className="text-[9px] font-bold text-center px-1 leading-tight" style={{ color: rc }}>{base.name}</span><span className="text-[7px] uppercase tracking-wide" style={{ color: rc + 'cc' }}>{RARITY_LABEL[base.rarity]}</span></div> : <div className="relative"><Sparkles size={24} className="text-slate-600" /><div className="absolute inset-0 anim-pulse-ring rounded-full border border-slate-600/50" /></div>}
              </button>
            );
          })}
        </div>
        <div className="mt-5 flex flex-col items-center gap-3">
          {!allRevealed ? <button onClick={revealNext} className="px-6 py-2.5 rounded-full bg-amber-500/20 border border-amber-500/50 text-amber-300 font-bold text-sm hover:bg-amber-500/30 transition">Reveal ({revealed}/{heroes.length})</button> : <button onClick={onClose} className="px-6 py-2.5 rounded-full bg-slate-800 border border-white/20 text-slate-200 font-bold text-sm hover:bg-slate-700 transition">Continue</button>}
        </div>
      </div>
      <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-full bg-slate-800/80 border border-white/10"><X size={18} className="text-slate-400" /></button>
    </div>
  );
}

export function SummonScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const [results, setResults] = useState<OwnedHero[] | null>(null);
  const cost = summonCostHero();
  const canSingle = state.hero >= cost;
  const canTen = state.hero >= cost * 10;
  const doSingle = () => { const r = game.summon(); if (r) setResults([r]); };
  const doTen = () => { const r = game.summonTen(); if (r.length > 0) setResults(r); };
  const rarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'relic', 'cursed', 'cosmic', 'divine'];

  return (
    <div className="flex flex-col h-full bg-fantasy overflow-y-auto no-scrollbar">
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center py-8">
        <div className="relative mb-5"><div className="w-32 h-32 rounded-full anim-glow" style={{ background: 'radial-gradient(circle, rgba(168,85,247,0.3), rgba(59,130,246,0.15), transparent)', '--glow': 'rgba(168,85,247,0.6)' } as React.CSSProperties} /><div className="absolute inset-0 flex items-center justify-center"><Sparkles size={44} className="text-purple-300 anim-bob" /></div></div>
        <h2 className="text-2xl font-black text-white mb-1"><span className="text-purple-300">Hero</span> Summon</h2>
        <p className="text-slate-400 text-sm max-w-sm mb-1">Summon heroes using $HERO tokens. All heroes are unique and tradeable.</p>
        <p className="text-slate-500 text-[11px] mb-4 flex items-center gap-1"><Zap size={12} className="text-violet-300" /> {formatNum(state.hero)} $HERO · {state.summons} summons</p>

        <div className="flex flex-wrap items-center justify-center gap-1.5 mb-5 text-[9px] max-w-lg">
          {rarities.map(r => <span key={r} className="px-1.5 py-0.5 rounded-full border font-semibold uppercase tracking-wide" style={{ color: RARITY_COLORS[r], borderColor: RARITY_COLORS[r] + '55', background: RARITY_COLORS[r] + '11' }}>{RARITY_LABEL[r]} {RARITY_WEIGHT[r]}%</span>)}
        </div>

        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button onClick={doSingle} disabled={!canSingle} className="flex items-center justify-between px-5 py-3 rounded-xl bg-gradient-to-r from-purple-600/30 to-blue-600/30 border border-purple-500/40 hover:from-purple-600/40 hover:to-blue-600/40 disabled:opacity-40 transition">
            <span className="flex items-center gap-2 text-white font-bold text-sm"><Sparkles size={16} className="text-purple-300" /> Summon x1</span>
            <span className="flex items-center gap-1 text-violet-300 text-sm font-bold"><Zap size={13} /> {cost}</span>
          </button>
          <button onClick={doTen} disabled={!canTen} className="flex items-center justify-between px-5 py-3 rounded-xl bg-gradient-to-r from-amber-600/30 to-purple-600/30 border border-amber-500/40 hover:from-amber-600/40 hover:to-purple-600/40 disabled:opacity-40 transition anim-glow" style={{ '--glow': 'rgba(245,158,11,0.4)' } as React.CSSProperties}>
            <span className="flex items-center gap-2 text-white font-bold text-sm"><Sparkles size={16} className="text-amber-300" /> Summon x10</span>
            <span className="flex items-center gap-1 text-violet-300 text-sm font-bold"><Zap size={13} /> {cost * 10}</span>
          </button>
        </div>
        <p className="text-slate-600 text-[10px] mt-4">Earn $HERO by winning battles in locations (when not overpowered).</p>
      </div>
      {results && <SummonResult heroes={results} onClose={() => setResults(null)} />}
    </div>
  );
}
