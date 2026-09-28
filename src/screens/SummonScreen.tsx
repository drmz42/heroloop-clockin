import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, Info, Sparkles, Target, X } from 'lucide-react';
import { HERO_MAP, RARITY_COLORS, RARITY_GLOW, RARITY_INDEX, RARITY_LABEL, RARITY_WEIGHT } from '@/game/heroes';
import { formatNum } from '@/game/state';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import type { OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';

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

export function SummonScreen({ game, rarityCapacity = {} }: {
  game: GameApi;
  rarityCapacity?: { divine?: boolean; celestial?: boolean };
}) {
  const { state } = game;
  const [results, setResults] = useState<OwnedHero[] | null>(null);
  const [promotionNotice, setPromotionNotice] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [summonNotice, setSummonNotice] = useState('');
  const [summoning, setSummoning] = useState<1 | 10 | 100 | null>(null);
  const [focusRarity, setFocusRarity] = useState<Rarity>('common');
  const [focusSaving, setFocusSaving] = useState(false);
  const [showFocus, setShowFocus] = useState(false);
  const [showPityInfo, setShowPityInfo] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'paid' | 'scroll'>('paid');
  const heroPriceLabel = (count: 1 | 10 | 100) => `${formatNum(count * 20)} $HERO`;
  const singleHasSpace = state.ownedHeroes.length < state.heroCapacity;
  const tenHasSpace = state.ownedHeroes.length + 10 <= state.heroCapacity;
  const hundredHasSpace = state.ownedHeroes.length + 100 <= state.heroCapacity;
  const canPay = (count: 1 | 10 | 100) => paymentMethod === 'paid' || state.summonScrolls >= count;
  const canSingle = singleHasSpace && canPay(1);
  const canTen = tenHasSpace && canPay(10);
  const canHundred = hundredHasSpace && canPay(100);
  useEffect(() => {
    if (!game.summonError) return;
    const safeCode = game.summonError.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const message = game.summonError.includes('insufficient_tokens')
      ? 'Not enough $HERO in the server balance'
      : game.summonError.includes('resource_insufficient_balance')
        ? 'Not enough Summon Scrolls'
        : game.summonError.includes('quote_expired') || game.summonError.includes('quote_mismatch') || game.summonError.includes('state_conflict')
          ? 'The quote expired or your account changed · Please try again'
          : game.summonError.includes('dex_quote_unavailable')
            ? 'Paid Summon is temporarily unavailable · No $HERO was spent'
      : game.summonError.includes('hero_capacity_exceeded')
        ? 'Hero storage does not have enough free slots'
        : game.summonError.includes('save_not_found') || game.summonError.includes('player_not_found')
          ? 'Account save is not synchronized · Refresh the game'
          : `Summon unavailable · No $HERO was spent · Code: ${safeCode || 'network_error'}`;
    setSummonNotice(message);
  }, [game.summonError]);
  const unavailableMessage = (count: 1 | 10 | 100) => setSummonNotice(
    state.ownedHeroes.length + count > state.heroCapacity
      ? `Need ${count} free Hero ${count === 1 ? 'slot' : 'slots'}`
      : `Not enough Summon Scrolls · Need ${count - state.summonScrolls} more`,
  );
  const beginSummon = async (count: 1 | 10 | 100) => {
    if (summoning !== null) return;
    if (state.ownedHeroes.length + count > state.heroCapacity || !canPay(count)) { unavailableMessage(count); return; }
    setSummoning(count); setSummonNotice('');
    try {
      let quoteId: string | null = null;
      if (paymentMethod === 'paid') {
        const quote = await game.quoteHeroSummon(count);
        if (!quote.ok) {
          setSummonNotice(quote.error === 'dex_quote_unavailable'
            ? 'Paid Summon is temporarily unavailable · No $HERO was spent'
            : 'Paid Summon quote unavailable · No $HERO was spent');
          return;
        }
        quoteId = quote.quote.quoteId;
      }
      const result = await game.summonHeroes(count, paymentMethod, quoteId);
      if (result.length > 0) setResults(result);
      else setSummonNotice('Summon is temporarily unavailable · Nothing was spent');
    } finally { setSummoning(null); }
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
  const focusCandidates = [...new Set(state.ownedHeroes
    .filter((hero) => HERO_MAP[hero.heroId]?.rarity === focusRarity)
    .map((hero) => hero.heroId))]
    .map((heroId) => HERO_MAP[heroId])
    .filter((hero) => Boolean(hero));
  const selectedFocus = game.ascensionFocus[focusRarity] ?? null;
  const changeFocus = async (heroId: string | null) => {
    if (focusSaving || summoning !== null) return;
    setFocusSaving(true); setSummonNotice('');
    try {
      const saved = await game.setHeroAscensionFocus(focusRarity, heroId);
      if (!saved) setSummonNotice('Ascension Focus was not changed · No Summon was spent');
    } finally { setFocusSaving(false); }
  };

  return (
    <div className="summon-sanctum relative flex h-full flex-col overflow-y-auto bg-black bg-cover bg-center no-scrollbar" style={{ backgroundImage: "linear-gradient(rgba(3,3,5,.18),rgba(3,3,5,.72)),url('/assets/summon/ritual-sanctum-v1.webp')" }}>
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(163,74,255,.12),transparent_38%),linear-gradient(90deg,rgba(0,0,0,.55),transparent_30%,transparent_70%,rgba(0,0,0,.55))]" />
      <div className="summon-layout relative mx-auto grid min-h-full w-full max-w-[1040px] flex-1 items-center gap-4 px-4 py-5">
      <main className="flex min-w-0 flex-col items-center justify-center text-center">
        <div className="summon-portal relative mb-3 grid h-24 w-24 shrink-0 place-items-center rounded-full"><i className="summon-rune-ring" /><i className="summon-rune-ring summon-rune-ring-inner" /><Sparkles size={34} className="relative z-10 text-[#f2c96e] drop-shadow-[0_0_14px_rgba(212,126,255,.9)]" />{Array.from({ length: 8 }, (_, index) => <i key={index} className="summon-portal-mote" style={{ '--mote-index': index } as React.CSSProperties} />)}</div>
        <div className="flex w-full max-w-2xl flex-col items-center rounded-xl border border-[#8c6231]/60 bg-[#08070a]/72 px-6 py-4 shadow-[0_16px_50px_rgba(0,0,0,.65),inset_0_1px_rgba(255,224,165,.08)] backdrop-blur-[2px]">
        <div className="section-kicker">The Obsidian Covenant</div>
        <h2 className="mb-1 mt-1 text-2xl font-black text-white"><span className="text-[#d7a9ff]">Hero</span> Summon</h2>
        <p className="text-slate-400 text-sm max-w-sm mb-1">Summon heroes using $HERO tokens. All heroes are unique and tradeable.</p>
        <section className="mb-2 w-full max-w-xl rounded-lg border border-violet-500/30 bg-black/45 text-left">
          <button type="button" onClick={() => setShowFocus((value) => !value)} aria-expanded={showFocus} className="flex min-h-10 w-full items-center gap-2 px-3 py-2"><Target size={13} className="text-violet-300" /><span className="text-[10px] font-black uppercase tracking-wide text-violet-200">Ascension Focus</span><span className="min-w-0 flex-1 truncate text-right text-[9px] text-[#9b8ea2]">{selectedFocus ? HERO_MAP[selectedFocus]?.name ?? 'Selected' : 'Off'}</span><ChevronDown size={13} className={`text-[#87788e] transition-transform ${showFocus ? 'rotate-180' : ''}`} /></button>
          {showFocus && <div className="border-t border-violet-500/20 px-2.5 pb-2.5">
          <div className="mt-2 text-right text-[8px] font-bold uppercase text-emerald-300">Rarity chance unchanged</div>
          <div className="mt-2 flex flex-wrap gap-1">{rarities.map((rarity) => <button key={rarity} type="button" onClick={() => setFocusRarity(rarity)} className={`rounded border px-1.5 py-1 text-[7px] font-black uppercase ${focusRarity === rarity ? 'bg-white/10' : 'bg-black/30 opacity-70'}`} style={{ color: RARITY_COLORS[rarity], borderColor: RARITY_COLORS[rarity] + '66' }}>{RARITY_LABEL[rarity]}</button>)}</div>
          <div className="mt-2 flex min-h-10 flex-wrap items-center gap-1.5">
            <button type="button" disabled={focusSaving || summoning !== null} onClick={() => void changeFocus(null)} className={`rounded-md border px-2 py-2 text-[8px] font-black uppercase ${selectedFocus === null ? 'border-violet-300 bg-violet-900/45 text-violet-100' : 'border-white/10 text-slate-500'}`}>Off</button>
            {focusCandidates.map((hero) => {
              if (!hero) return null;
              const selected = selectedFocus === hero.id;
              return <button key={hero.id} type="button" disabled={focusSaving || summoning !== null} onClick={() => void changeFocus(hero.id)} className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-[8px] font-bold ${selected ? 'bg-violet-900/50' : 'bg-black/25'}`} style={{ borderColor: selected ? RARITY_COLORS[focusRarity] : '#ffffff1a', color: selected ? RARITY_COLORS[focusRarity] : '#aaa0b4' }}><span className="relative h-7 w-7 shrink-0 overflow-hidden rounded"><img src={heroPortraitSrc(hero.id, hero.heroClass, hero.rarity, hero.color)} alt="" className="h-full w-full object-cover" style={heroPortraitStyle(hero.id, hero.heroClass)} /></span><span>{hero.name}{selected ? ' · Focused' : ''}</span></button>;
            })}
            {focusCandidates.length === 0 && <span className="text-[9px] text-slate-500">Obtain a {RARITY_LABEL[focusRarity]} hero to unlock its Focus.</span>}
          </div>
          <p className="mt-2 text-[8px] leading-relaxed text-[#8f8798]">The server locks one owned identity for this rarity when an x1/x10/x100 batch begins. Focus changes identity only, never rarity, Pity or batch size.</p>
          </div>}
        </section>

        <div className="mb-1 flex w-full max-w-xl items-center justify-between"><span className="text-[9px] font-black uppercase tracking-[.14em] text-[#9d8ca6]">Pity progress</span><button type="button" onClick={() => setShowPityInfo((value) => !value)} aria-expanded={showPityInfo} className="game-control flex h-7 items-center gap-1 px-2 text-[8px] font-black"><Info size={11} /> Pity info</button></div>
        <div className="mb-2 grid w-full max-w-xl grid-cols-3 gap-1 sm:grid-cols-5">
          {([
            ['Legendary', game.summonPity.legendary, 150, 'legendary'],
            ['Mythic', game.summonPity.mythic, 500, 'mythic'],
            ['Cosmic', game.summonPity.cosmic, 2000, 'cosmic'],
            ['Divine', game.summonPity.divine, 5000, 'divine'],
            ['Celestial', game.summonPity.celestial, 20000, 'celestial'],
          ] as const).map(([label, current, target, rarity]) => (
            <div key={rarity} className="rounded-md border bg-black/35 px-1.5 py-1 text-left" style={{ borderColor: RARITY_COLORS[rarity] + '55' }}>
              <div className="grid min-w-0 gap-0.5 font-black uppercase" style={{ color: RARITY_COLORS[rarity] }}><span className="min-h-[16px] whitespace-normal text-[7px] leading-2">{label} Pity</span><span className="whitespace-nowrap text-right text-[7px] tabular-nums tracking-[-.04em]">{current}/{target}</span></div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-black/60"><div className="h-full rounded-full transition-[width]" style={{ width: `${Math.min(100, current / target * 100)}%`, backgroundColor: RARITY_COLORS[rarity] }} /></div>
              {rarity === 'mythic' && current >= 250 && <div className="mt-1 text-[7px] font-bold uppercase text-red-300">Soft pity +0.0015 pp / miss</div>}
            </div>
          ))}
        </div>
        {showPityInfo && <p className="mb-2 max-w-xl rounded-md border border-violet-500/20 bg-violet-950/20 px-3 py-2 text-[9px] leading-relaxed text-[#aaa0b4]"><strong className="text-violet-200">How Pity works:</strong> counters track misses for that rarity or higher. Guarantees are 150 / 500 / 2,000 / 5,000 / 20,000. Mythic+ gains 0.0015 percentage point per miss on rolls 251–499, taken from Common.</p>}

        <div className="flex w-full max-w-sm flex-col gap-2.5">
          {summonNotice && <div role="alert" aria-live="polite" className="flex items-center gap-2 rounded-lg border border-red-700/65 bg-[linear-gradient(135deg,rgba(75,16,22,.92),rgba(20,8,12,.96))] px-3 py-2.5 text-left shadow-[inset_0_1px_rgba(255,255,255,.06),0_8px_22px_rgba(0,0,0,.35)]"><AlertTriangle size={17} className="shrink-0 text-red-300" /><span className="flex-1 text-[11px] font-bold text-red-100">{summonNotice}</span><button type="button" onClick={() => setSummonNotice('')} aria-label="Dismiss Summon message" className="rounded p-1 text-red-300 hover:bg-white/10"><X size={14} /></button></div>}
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-violet-500/25 bg-black/40 p-1" aria-label="Summon payment method">
            <button type="button" onClick={() => setPaymentMethod('paid')} aria-pressed={paymentMethod === 'paid'} disabled={summoning !== null} className={`min-h-11 rounded-md px-2 text-[10px] font-black uppercase ${paymentMethod === 'paid' ? 'bg-violet-800/65 text-violet-100' : 'text-slate-500'}`}>Test · $HERO</button>
            <button type="button" onClick={() => setPaymentMethod('scroll')} aria-pressed={paymentMethod === 'scroll'} disabled={summoning !== null} className={`flex min-h-11 items-center justify-center gap-1 rounded-md px-2 text-[10px] font-black uppercase ${paymentMethod === 'scroll' ? 'bg-amber-800/55 text-amber-100' : 'text-slate-500'}`}><SummonScrollArtwork size={25} /> Scrolls · {formatNum(state.summonScrolls)}</button>
          </div>
          <button type="button" onClick={() => void beginSummon(1)} disabled={!canSingle || summoning !== null || promoting} className="flex h-[46px] items-center justify-between rounded-xl border border-purple-500/40 bg-gradient-to-r from-purple-600/30 to-blue-600/30 px-5 transition hover:from-purple-600/40 hover:to-blue-600/40 disabled:opacity-40">
            <span className="flex items-center gap-2 text-white font-bold text-sm"><Sparkles size={16} className="text-purple-300" /> {!singleHasSpace ? 'Hero storage full' : !canPay(1) ? 'Need 1 Summon Scroll' : summoning === 1 ? 'Preparing…' : 'Summon x1'}</span>
            <span className="flex items-center gap-1 text-sm font-bold text-cyan-300">{paymentMethod === 'paid' ? heroPriceLabel(1) : <><SummonScrollArtwork size={18} />1 Scroll</>}</span>
          </button>
          <button type="button" onClick={() => void beginSummon(10)} disabled={!canTen || summoning !== null || promoting} className="anim-glow flex h-[46px] items-center justify-between rounded-xl border border-amber-500/40 bg-gradient-to-r from-amber-600/30 to-purple-600/30 px-5 transition hover:from-amber-600/40 hover:to-purple-600/40 disabled:opacity-40" style={{ '--glow': 'rgba(245,158,11,0.4)' } as React.CSSProperties}>
            <span className="flex items-center gap-2 text-white font-bold text-sm"><Sparkles size={16} className="text-amber-300" /> {!tenHasSpace ? 'Need 10 free slots' : !canPay(10) ? `Need ${10 - state.summonScrolls} more Scrolls` : summoning === 10 ? 'Preparing…' : 'Summon x10'}</span>
            <span className="flex items-center gap-1 text-sm font-bold text-cyan-300">{paymentMethod === 'paid' ? heroPriceLabel(10) : <><SummonScrollArtwork size={18} />10 Scrolls</>}</span>
          </button>
          <button type="button" onClick={() => void beginSummon(100)} disabled={!canHundred || summoning !== null || promoting} className="anim-glow flex h-[46px] items-center justify-between rounded-xl border border-fuchsia-500/40 bg-gradient-to-r from-fuchsia-600/30 to-cyan-600/30 px-5 transition hover:from-fuchsia-600/40 hover:to-cyan-600/40 disabled:opacity-40" style={{ '--glow': 'rgba(217,70,239,0.4)' } as React.CSSProperties}>
            <span className="flex items-center gap-2 text-white font-bold text-sm"><Sparkles size={16} className="text-fuchsia-300" /> {!hundredHasSpace ? 'Need 100 free slots' : !canPay(100) ? `Need ${100 - state.summonScrolls} more Scrolls` : summoning === 100 ? 'Preparing…' : 'Summon x100'}</span>
            <span className="flex items-center gap-1 text-sm font-bold text-cyan-300">{paymentMethod === 'paid' ? heroPriceLabel(100) : <><SummonScrollArtwork size={18} />100 Scrolls</>}</span>
          </button>
          <div className="mt-2 h-px bg-gradient-to-r from-transparent via-[#8c6231]/65 to-transparent" />
          <button type="button" disabled={promoting || summoning !== null} onClick={() => void promoteAll()} className="game-control flex h-[46px] items-center justify-center gap-1.5 px-3 text-[9px] font-black uppercase disabled:opacity-55"><Sparkles size={13} className="text-amber-300" /> {promoting ? 'Promoting heroes…' : 'Promote all heroes · Free space for Summon'}</button>
        </div>
        {promotionNotice && <div role="status" className="mt-2 flex max-w-sm items-start gap-2 rounded border border-violet-500/50 bg-violet-950/55 px-3 py-2 text-[10px] font-bold text-violet-100"><span className="flex-1">{promotionNotice}</span><button type="button" onClick={() => setPromotionNotice('')} aria-label="Dismiss promotion result"><X size={13} /></button></div>}
        <p className="mt-4 text-[10px] text-[#7f7887]">Earn $HERO by winning battles in locations.</p>
        </div>
      </main>
      <aside className="summon-side-panel self-center rounded-xl border border-[#6b536f] bg-[#08070a]/88 p-3 text-left shadow-[0_18px_45px_rgba(0,0,0,.65),inset_0_1px_rgba(255,224,165,.06)] backdrop-blur-[2px]" aria-label="Summon account and rates">
        <div className="section-kicker mb-2">Summon account</div>
        <div className="rounded-lg border border-cyan-500/25 bg-cyan-950/15 px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-sm font-black text-cyan-200"><HeroTokenIcon size={16} /> {formatNum(state.hero)} $HERO</span>
          <span className="mt-1 block text-[9px] font-medium text-slate-500">{state.summons} summons · {state.ownedHeroes.length}/{state.heroCapacity} heroes</span>
        </div>
        <div className="mb-1 mt-3 text-[9px] font-black uppercase tracking-[.14em] text-[#ad9ab5]">Base summon rates</div>
        <div className="summon-rate-panel grid gap-1">
          {rarities.map(r => { const unavailable = (r === 'divine' || r === 'celestial') && rarityCapacity[r] === false; return <span key={r} className={`flex items-center justify-between rounded-md border px-2 py-1 text-[9px] font-semibold uppercase tracking-wide ${unavailable ? 'opacity-50' : ''}`} style={{ color: RARITY_COLORS[r], borderColor: RARITY_COLORS[r] + '55', background: RARITY_COLORS[r] + '11' }}><span>{RARITY_LABEL[r]}{unavailable ? ' · Full' : ''}</span><b className="tabular-nums">{RARITY_WEIGHT[r]}%</b></span>; })}
        </div>
        <p className="mt-2 text-[8px] leading-3 text-[#786f7e]">Pity adjustments are shown in the main panel.</p>
      </aside>
      </div>
      {results && <SummonResult heroes={results} onClose={() => setResults(null)} />}
    </div>
  );
}
