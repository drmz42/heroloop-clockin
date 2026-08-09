import { useEffect, useState } from 'react';
import { AlertTriangle, Sparkles, X } from 'lucide-react';
import { HERO_MAP, RARITY_COLORS, RARITY_GLOW, RARITY_INDEX, RARITY_LABEL, RARITY_WEIGHT } from '@/game/heroes';
import { summonCostHero, formatNum, MAX_HEROES } from '@/game/state';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import type { OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';

function SummonResult({ heroes, onClose }: { heroes: OwnedHero[]; onClose: () => void }) {
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [phase, setPhase] = useState<'charge' | 'ready' | 'revealing' | 'revealed'>(reducedMotion ? 'ready' : 'charge');
  const order: Record<Rarity, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, mythic: 5, relic: 5, cosmic: 6, divine: 7, celestial: 8, cursed: 9, immortal: 10, god: 11 };
  const displayHeroes = [...heroes].sort((a, b) => order[HERO_MAP[b.heroId]?.rarity ?? 'common'] - order[HERO_MAP[a.heroId]?.rarity ?? 'common']);
  const best = HERO_MAP[displayHeroes[0]?.heroId]?.rarity ?? 'common';
  const screenWow = order[best] >= order.rare;
  const revealed = phase === 'revealing' || phase === 'revealed';

  useEffect(() => {
    if (phase !== 'charge') return;
    const timer = window.setTimeout(() => setPhase('ready'), 2100);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const reveal = () => {
    if (reducedMotion) { setPhase('revealed'); return; }
    setPhase('revealing');
    window.setTimeout(() => setPhase('revealed'), 950);
  };

  return (
    <div className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 backdrop-blur p-4 anim-fade${revealed && screenWow ? ' summon-rarity-burst' : ''}${phase === 'revealing' ? ' summon-rupture' : ''}`} style={{ '--summon-best': RARITY_COLORS[best] } as React.CSSProperties}>
      {revealed && screenWow && <div className="summon-screen-rays" aria-hidden="true" />}
      {phase === 'revealing' && <i className="summon-flash" aria-hidden="true" />}
      <div className="absolute inset-0 pointer-events-none" style={{ background: `radial-gradient(circle at 50% 50%, ${RARITY_COLORS[best]}26, transparent 62%)` }} />
      {phase === 'charge' ? (
        <div className="summon-ritual-charge relative z-10 grid place-items-center text-center">
          <div className="summon-charge-orb"><Sparkles size={42} /></div>
          <div className="mt-7 text-[10px] font-black uppercase tracking-[.38em] text-[#d9b9ff]">The Covenant Answers</div>
          <div className="mt-2 text-xs text-[#8d8196]">Fate is gathering beyond the veil…</div>
        </div>
      ) : <div className="relative w-full max-w-4xl">
        {revealed && <div className="summon-best-banner mb-3 text-center" style={{ color: RARITY_COLORS[best] }}><span>{RARITY_LABEL[best]}</span><strong>{displayHeroes.length === 1 ? HERO_MAP[displayHeroes[0].heroId]?.name : `Best of ${displayHeroes.length} summons`}</strong></div>}
        <div className={`no-scrollbar max-h-[72vh] overflow-y-auto rounded-xl ${heroes.length > 20 ? 'p-1' : ''}`}>
        <div className={`mx-auto grid gap-3 ${displayHeroes.length === 1 ? 'w-[210px] grid-cols-1' : displayHeroes.length > 20 ? 'grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8' : 'grid-cols-3 sm:grid-cols-5'}`}>
          {displayHeroes.map((h, index) => {
            const base = HERO_MAP[h.heroId]; if (!base) return null;
            const rc = RARITY_COLORS[base.rarity]; const svg = heroPortraitSrc(base.id, base.heroClass, base.rarity, base.color);
            const isWow = RARITY_INDEX[base.rarity] >= RARITY_INDEX.rare;
            return (
              <div key={h.uid} className={`relative aspect-[3/4] rounded-xl flex flex-col items-center justify-center overflow-hidden border-2 transition ${revealed ? 'summon-card-unseal' : 'summon-card-sealed'} ${revealed && isWow ? 'summon-wow summon-rarity-card' : ''}`} style={{ borderColor: revealed ? rc : '#5b4770', background: revealed ? `radial-gradient(circle at 50% 30%, ${base.color}33, ${rc}18)` : 'linear-gradient(145deg,#23172f,#09070d 68%)', boxShadow: revealed ? `0 0 24px ${RARITY_GLOW[base.rarity]}` : 'inset 0 0 28px rgba(176,91,255,.18),0 0 12px rgba(115,65,150,.25)', '--summon-color': rc, '--reveal-delay': `${Math.min(index, 12) * 55}ms` } as React.CSSProperties}>
                {revealed && isWow && <div className="summon-card-rays" aria-hidden="true" />}
                {revealed && isWow && <i className="summon-card-shine" aria-hidden="true" />}
                {revealed && isWow && Array.from({ length: 7 }, (_, spark) => <i key={spark} className="summon-spark" style={{ '--spark-index': spark } as React.CSSProperties} />)}
                {revealed ? <div className="absolute inset-0"><img src={svg} alt="" className="h-full w-full object-cover" style={{ ...heroPortraitStyle(base.id, base.heroClass), transform: 'none' }} /><span className="absolute inset-x-0 bottom-0 px-1.5 pb-1 pt-4 bg-gradient-to-t from-black/80 to-transparent text-center"><span className="block text-[10px] font-bold leading-tight" style={{ color: rc }}>{base.name}</span><span className="block text-[7px] uppercase tracking-wide" style={{ color: rc + 'cc' }}>{RARITY_LABEL[base.rarity]}</span></span></div> : <div className="summon-seal-glyph relative"><Sparkles size={28} /><div className="absolute inset-0 anim-pulse-ring rounded-full border border-violet-400/50" /></div>}
              </div>
            );
          })}
        </div>
        </div>
        <div className="mt-5 flex flex-col items-center gap-3">
          {phase === 'ready' ? <button type="button" onClick={reveal} className="summon-break-seal px-7 py-2.5 rounded-full border text-sm font-black uppercase tracking-wider">Break the seal · Reveal {heroes.length}</button> : phase === 'revealing' ? <div className="text-[10px] font-black uppercase tracking-[.3em] text-white">Fate Unbound</div> : <button type="button" onClick={onClose} className="px-6 py-2.5 rounded-full bg-slate-800 border border-white/20 text-slate-200 font-bold text-sm hover:bg-slate-700 transition">Continue</button>}
        </div>
      </div>
      }
      <button type="button" onClick={onClose} className="absolute top-4 right-4 p-2 rounded-full bg-slate-800/80 border border-white/10"><X size={18} className="text-slate-400" /></button>
    </div>
  );
}

export function SummonScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const [results, setResults] = useState<OwnedHero[] | null>(null);
  const [promotionNotice, setPromotionNotice] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [summonNotice, setSummonNotice] = useState('');
  const [summoning, setSummoning] = useState<1 | 10 | 100 | null>(null);
  const cost = summonCostHero();
  const singleHasSpace = state.ownedHeroes.length < MAX_HEROES;
  const tenHasSpace = state.ownedHeroes.length + 10 <= MAX_HEROES;
  const hundredHasSpace = state.ownedHeroes.length + 100 <= MAX_HEROES;
  const canSingle = singleHasSpace && state.hero >= cost;
  const canTen = tenHasSpace && state.hero >= cost * 10;
  const canHundred = hundredHasSpace && state.hero >= cost * 100;
  useEffect(() => {
    if (!game.summonError) return;
    const safeCode = game.summonError.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const message = game.summonError.includes('insufficient_tokens')
      ? 'Not enough $HERO in the server balance'
      : game.summonError.includes('hero_capacity_exceeded')
        ? 'Hero storage does not have enough free slots'
        : game.summonError.includes('save_not_found') || game.summonError.includes('player_not_found')
          ? 'Account save is not synchronized · Refresh the game'
          : `Summon unavailable · No $HERO was spent · Code: ${safeCode || 'network_error'}`;
    setSummonNotice(message);
  }, [game.summonError]);
  const summonError = (required: number) => setSummonNotice(
    state.hero < required
      ? `Not enough $HERO · Need ${formatNum(required - state.hero)} more`
      : 'Summon is temporarily unavailable · No $HERO was spent',
  );
  const doSingle = async () => {
    if (summoning !== null) return;
    if (!canSingle) { summonError(cost); return; }
    setSummoning(1); setSummonNotice('');
    try { const result = await game.summon(); if (result) setResults([result]); else summonError(cost); }
    finally { setSummoning(null); }
  };
  const doTen = async () => {
    if (summoning !== null) return;
    if (!canTen) { summonError(cost * 10); return; }
    setSummoning(10); setSummonNotice('');
    try { const result = await game.summonTen(); if (result.length > 0) setResults(result); else summonError(cost * 10); }
    finally { setSummoning(null); }
  };
  const doHundred = async () => {
    if (summoning !== null) return;
    if (!canHundred) { summonError(cost * 100); return; }
    setSummoning(100); setSummonNotice('');
    try { const result = await game.summonHundred(); if (result.length > 0) setResults(result); else summonError(cost * 100); }
    finally { setSummoning(null); }
  };
  const promoteAll = async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      const summary = await game.promoteAllHeroes();
      setPromotionNotice(summary.length ? summary.map((entry) => `${entry.heroName} +${entry.starsAdded}★`).join(' · ') : 'No eligible duplicate upgrades');
    } finally {
      setPromoting(false);
    }
  };
  const rarities: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];

  return (
    <div className="summon-sanctum relative flex h-full flex-col overflow-y-auto bg-black bg-cover bg-center no-scrollbar" style={{ backgroundImage: "linear-gradient(rgba(3,3,5,.18),rgba(3,3,5,.72)),url('/assets/summon/ritual-sanctum-v1.webp')" }}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(163,74,255,.12),transparent_38%),linear-gradient(90deg,rgba(0,0,0,.55),transparent_30%,transparent_70%,rgba(0,0,0,.55))]" />
      <div className="relative flex min-h-full flex-1 flex-col items-center justify-center px-4 py-5 text-center">
        <div className="summon-portal relative mb-3 grid h-24 w-24 shrink-0 place-items-center rounded-full"><i className="summon-rune-ring" /><i className="summon-rune-ring summon-rune-ring-inner" /><Sparkles size={34} className="relative z-10 text-[#f2c96e] drop-shadow-[0_0_14px_rgba(212,126,255,.9)]" />{Array.from({ length: 8 }, (_, index) => <i key={index} className="summon-portal-mote" style={{ '--mote-index': index } as React.CSSProperties} />)}</div>
        <div className="flex w-full max-w-2xl flex-col items-center rounded-xl border border-[#8c6231]/60 bg-[#08070a]/72 px-6 py-4 shadow-[0_16px_50px_rgba(0,0,0,.65),inset_0_1px_rgba(255,224,165,.08)] backdrop-blur-[2px]">
        <div className="section-kicker">The Obsidian Covenant</div>
        <h2 className="mb-1 mt-1 text-2xl font-black text-white"><span className="text-[#d7a9ff]">Hero</span> Summon</h2>
        <p className="text-slate-400 text-sm max-w-sm mb-1">Summon heroes using $HERO tokens. All heroes are unique and tradeable.</p>
        <p className="mb-4 flex items-center justify-center gap-1 rounded-lg border border-cyan-500/25 bg-cyan-950/15 px-3 py-2 text-[12px] font-black text-cyan-200"><HeroTokenIcon size={15} /> {formatNum(state.hero)} $HERO <span className="font-medium text-slate-500">· {state.summons} summons · {state.ownedHeroes.length}/{MAX_HEROES} heroes</span></p>

        <div className="mb-5 flex min-h-[48px] w-full max-w-xl flex-wrap content-center items-center justify-center gap-1.5 text-[9px]">
          {rarities.map(r => <span key={r} className="px-1.5 py-0.5 rounded-full border font-semibold uppercase tracking-wide" style={{ color: RARITY_COLORS[r], borderColor: RARITY_COLORS[r] + '55', background: RARITY_COLORS[r] + '11' }}>{RARITY_LABEL[r]} {RARITY_WEIGHT[r]}%</span>)}
        </div>

        <div className="mb-4 grid w-full max-w-xl grid-cols-2 gap-1.5 sm:grid-cols-4">
          {([
            ['Legendary', game.summonPity.legendary, 100, 'legendary'],
            ['Mythic', game.summonPity.mythic, 500, 'mythic'],
            ['Cosmic', game.summonPity.cosmic, 2500, 'cosmic'],
            ['Divine', game.summonPity.divine, 10000, 'divine'],
          ] as const).map(([label, current, target, rarity]) => (
            <div key={rarity} className="rounded-md border bg-black/35 px-2 py-1.5 text-left" style={{ borderColor: RARITY_COLORS[rarity] + '55' }}>
              <div className="flex items-center justify-between gap-1 text-[8px] font-black uppercase" style={{ color: RARITY_COLORS[rarity] }}><span>{label} Pity</span><span>{current}/{target}</span></div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/60"><div className="h-full rounded-full transition-[width]" style={{ width: `${Math.min(100, current / target * 100)}%`, backgroundColor: RARITY_COLORS[rarity] }} /></div>
              {rarity === 'mythic' && current >= 200 && <div className="mt-1 text-[7px] font-bold uppercase text-red-300">Soft pity active</div>}
            </div>
          ))}
        </div>
        <p className="mb-4 max-w-xl rounded-md border border-violet-500/20 bg-violet-950/20 px-3 py-2 text-[9px] leading-relaxed text-[#aaa0b4]"><strong className="text-violet-200">How Pity works:</strong> counters track summons without that rarity or higher. A qualifying hero resets its counter and all lower counters, then the guarantee starts again. Mythic chance begins increasing after 200 misses. Celestial remains a pure rare roll.</p>

        <div className="flex w-full max-w-sm flex-col gap-2.5">
          {summonNotice && <div role="alert" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-red-700/65 bg-[linear-gradient(135deg,rgba(75,16,22,.92),rgba(20,8,12,.96))] px-3 py-2.5 text-left shadow-[inset_0_1px_rgba(255,255,255,.06),0_8px_22px_rgba(0,0,0,.35)]"><AlertTriangle size={17} className="shrink-0 text-red-300" /><span className="flex-1 text-[11px] font-bold text-red-100">{summonNotice}</span><button type="button" onClick={() => setSummonNotice('')} aria-label="Dismiss Summon message" className="rounded p-1 text-red-300 hover:bg-white/10"><X size={14} /></button></div>}
          <button type="button" onClick={doSingle} disabled={!canSingle || summoning !== null || promoting} className="flex h-[46px] items-center justify-between rounded-xl border border-purple-500/40 bg-gradient-to-r from-purple-600/30 to-blue-600/30 px-5 transition hover:from-purple-600/40 hover:to-blue-600/40 disabled:opacity-40">
            <span className="flex items-center gap-2 text-white font-bold text-sm"><Sparkles size={16} className="text-purple-300" /> {!singleHasSpace ? 'Hero storage full' : state.hero < cost ? `Need ${formatNum(cost - state.hero)} more $HERO` : summoning === 1 ? 'Summoning…' : 'Summon x1'}</span>
            <span className="flex items-center gap-1 text-cyan-300 text-sm font-bold"><HeroTokenIcon size={13} /> {cost}</span>
          </button>
          <button type="button" onClick={doTen} disabled={!canTen || summoning !== null || promoting} className="anim-glow flex h-[46px] items-center justify-between rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-600/30 to-purple-600/30 px-5 transition hover:from-amber-600/40 hover:to-purple-600/40 disabled:opacity-40" style={{ '--glow': 'rgba(245,158,11,0.4)' } as React.CSSProperties}>
            <span className="flex items-center gap-2 text-white font-bold text-sm"><Sparkles size={16} className="text-amber-300" /> {!tenHasSpace ? 'Need 10 free slots' : state.hero < cost * 10 ? `Need ${formatNum(cost * 10 - state.hero)} more $HERO` : summoning === 10 ? 'Summoning…' : 'Summon x10'}</span>
            <span className="flex items-center gap-1 text-cyan-300 text-sm font-bold"><HeroTokenIcon size={13} /> {cost * 10}</span>
          </button>
          <button type="button" onClick={doHundred} disabled={!canHundred || summoning !== null || promoting} className="anim-glow flex h-[46px] items-center justify-between rounded-xl border border-fuchsia-500/40 bg-gradient-to-r from-fuchsia-600/30 to-cyan-600/30 px-5 transition hover:from-fuchsia-600/40 hover:to-cyan-600/40 disabled:opacity-40" style={{ '--glow': 'rgba(217,70,239,0.4)' } as React.CSSProperties}>
            <span className="flex items-center gap-2 text-white font-bold text-sm"><Sparkles size={16} className="text-fuchsia-300" /> {!hundredHasSpace ? 'Need 100 free slots' : state.hero < cost * 100 ? `Need ${formatNum(cost * 100 - state.hero)} more $HERO` : summoning === 100 ? 'Summoning…' : 'Summon x100'}</span>
            <span className="flex items-center gap-1 text-cyan-300 text-sm font-bold"><HeroTokenIcon size={13} /> {cost * 100}</span>
          </button>
          <div className="mt-2 h-px bg-gradient-to-r from-transparent via-[#8c6231]/65 to-transparent" />
          <button type="button" disabled={promoting || summoning !== null} onClick={() => void promoteAll()} className="game-control flex h-[46px] items-center justify-center gap-1.5 px-3 text-[9px] font-black uppercase disabled:opacity-55"><Sparkles size={13} className="text-amber-300" /> {promoting ? 'Promoting heroes…' : 'Promote all heroes · Free space for Summon'}</button>
        </div>
        {promotionNotice && <div role="status" className="mt-2 flex max-w-sm items-start gap-2 rounded border border-violet-500/50 bg-violet-950/55 px-3 py-2 text-[10px] font-bold text-violet-100"><span className="flex-1">{promotionNotice}</span><button type="button" onClick={() => setPromotionNotice('')} aria-label="Dismiss promotion result"><X size={13} /></button></div>}
        <p className="mt-4 text-[10px] text-[#7f7887]">Earn $HERO by winning battles in locations.</p>
        </div>
      </div>
      {results && <SummonResult heroes={results} onClose={() => setResults(null)} />}
    </div>
  );
}
