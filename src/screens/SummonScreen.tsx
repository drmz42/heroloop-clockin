import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, Info, Sparkles, Target, X } from 'lucide-react';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, RARITY_WEIGHT } from '@/game/heroes';
import { formatNum } from '@/game/state';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import type { OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import { isolatedHackathon } from '@/game/editionStorage';
import { SkrTokenIcon } from '@/components/SkrTokenIcon';
import { SeekerPromoteAll } from '@/components/SeekerPromoteAll';
import { SummonReveal } from '@/components/summon/SummonReveal';
import { quoteSkrPurchase, formatAmountShort, formatMinor, type SkrPurchaseQuote } from '@/game/seekerWallet';
import { useSkrRate, skrPrice, skrError } from '@/game/skrPurchase';
import '@/components/summon/summon-v2.css';

type Batch = 1 | 10 | 100;

// One altar per batch size. The flame is lit while that batch can be paid and stored.
function Altar({ count, tone, title, cost, status, lit, busy, disabled, onClick }: {
  count: Batch;
  tone: 'violet' | 'gold' | 'crimson';
  title: string;
  cost: ReactNode;
  status: string | null;
  lit: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${title}${status ? ` · ${status}` : ''}`}
      className={`sv-altar sv-altar--${tone}${lit ? ' is-lit' : ''}${busy ? ' is-busy' : ''}`}
    >
      <span className="sv-flame" aria-hidden="true"><i /><i /><i /></span>
      <span className="sv-altar-bowl" aria-hidden="true" />
      <span className="sv-altar-body">
        <span className="sv-altar-count">×{count}</span>
        <span className="sv-altar-title">{busy ? 'Summoning…' : title}</span>
      </span>
      <span className="sv-altar-cost">{status ?? cost}</span>
    </button>
  );
}

export function SummonScreen({ game, rarityCapacity = {} }: {
  game: GameApi;
  rarityCapacity?: { divine?: boolean; celestial?: boolean };
}) {
  const { state } = game;
  const [results, setResults] = useState<OwnedHero[] | null>(null);
  const [resultBatch, setResultBatch] = useState<Batch>(1);
  const [newHeroIds, setNewHeroIds] = useState<ReadonlySet<string>>(new Set());
  const [promotionNotice, setPromotionNotice] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [summonNotice, setSummonNotice] = useState('');
  const [summoning, setSummoning] = useState<Batch | null>(null);
  const [focusRarity, setFocusRarity] = useState<Rarity>('common');
  const [focusSaving, setFocusSaving] = useState(false);
  const [showFocus, setShowFocus] = useState(false);
  const [showPityInfo, setShowPityInfo] = useState(false);
  const [showRates, setShowRates] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'paid' | 'scroll' | 'skr'>(isolatedHackathon ? 'skr' : 'paid');
  const rate = useSkrRate(isolatedHackathon);
  const [pendingQuote, setPendingQuote] = useState<{ quote: SkrPurchaseQuote; count: Batch } | null>(null);
  const quoteRef = useRef<HTMLDivElement>(null);
  const reducedMotion = state.battleAnimationMode === 'off'
    || (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const heroPriceLabel = (count: Batch) => paymentMethod === 'skr' ? skrPrice(count * 2, rate) : `${formatNum(count * 20)} $HERO`;
  const singleHasSpace = state.ownedHeroes.length < state.heroCapacity;
  const tenHasSpace = state.ownedHeroes.length + 10 <= state.heroCapacity;
  const hundredHasSpace = state.ownedHeroes.length + 100 <= state.heroCapacity;
  const hasSpace = (count: Batch) => count === 1 ? singleHasSpace : count === 10 ? tenHasSpace : hundredHasSpace;
  const canPay = (count: Batch) => paymentMethod !== 'scroll' || state.summonScrolls >= count;
  const canSummon = (count: Batch) => hasSpace(count) && canPay(count);
  useEffect(() => {
    if (!game.summonError) return;
    if (isolatedHackathon && paymentMethod === 'skr') { setSummonNotice(game.summonError); return; }
    const safeCode = game.summonError.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const message = game.summonError.includes('insufficient_tokens')
      ? 'Not enough $HERO in the server balance'
      : game.summonError.includes('resource_insufficient_balance')
        ? 'Not enough Summon Scrolls'
        : game.summonError.includes('quote_expired') || game.summonError.includes('quote_mismatch')
          ? 'The quote expired · Please try again'
          : game.summonError.includes('state_conflict')
          ? 'Your game was still updating · Please try again'
          : game.summonError.includes('dex_quote_unavailable')
            ? 'Paid Summon is temporarily unavailable · No $HERO was spent'
      : game.summonError.includes('hero_capacity_exceeded')
        ? 'Hero storage does not have enough free slots'
        : game.summonError.includes('save_not_found') || game.summonError.includes('player_not_found')
          ? 'Account save is not synchronized · Refresh the game'
          : `Summon unavailable · No $HERO was spent · Code: ${safeCode || 'network_error'}`;
    setSummonNotice(message);
  }, [game.summonError, paymentMethod]);
  useEffect(() => { if (pendingQuote) quoteRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [pendingQuote]);
  const unavailableMessage = (count: Batch) => setSummonNotice(
    state.ownedHeroes.length + count > state.heroCapacity
      ? `Need ${count} free Hero ${count === 1 ? 'slot' : 'slots'}`
      : `Not enough Summon Scrolls · Need ${count - state.summonScrolls} more`,
  );
  const showResults = (heroes: OwnedHero[], count: Batch, ownedBefore: Set<string>) => {
    setNewHeroIds(new Set(heroes.map((hero) => hero.heroId).filter((heroId) => !ownedBefore.has(heroId))));
    setResultBatch(count);
    setResults(heroes);
  };
  const beginSummon = async (count: Batch) => {
    if (summoning !== null) return;
    if (state.ownedHeroes.length + count > state.heroCapacity || !canPay(count)) { unavailableMessage(count); return; }
    setSummoning(count); setSummonNotice('');
    const ownedBefore = new Set(state.ownedHeroes.map((hero) => hero.heroId));
    try {
      if (paymentMethod === 'skr') {
        setPendingQuote({ quote: await quoteSkrPurchase('hero_summon', { count }), count });
        return;
      }
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
      if (result.length > 0) showResults(result, count, ownedBefore);
      else setSummonNotice('Summon is temporarily unavailable · Nothing was spent');
    } catch (error) { setSummonNotice(skrError(error)); } finally { setSummoning(null); }
  };
  const confirmSkrSummon = async () => {
    if (!pendingQuote || summoning !== null) return;
    setSummoning(pendingQuote.count); setSummonNotice('');
    const ownedBefore = new Set(state.ownedHeroes.map((hero) => hero.heroId));
    const result = await game.summonHeroes(pendingQuote.count, 'skr', pendingQuote.quote.quote_id);
    if (result.length) { showResults(result, pendingQuote.count, ownedBefore); setPendingQuote(null); }
    else setSummonNotice('Payment could not finish. Retry the same payment or check Wallet history.');
    setSummoning(null);
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

  const busy = summoning !== null || promoting || pendingQuote !== null;
  const altarStatus = (count: Batch) => !hasSpace(count)
    ? (count === 1 ? 'Hero storage full' : `Need ${count} free slots`)
    : !canPay(count) ? `Need ${count - state.summonScrolls} more Scrolls` : null;
  const altarCost = (count: Batch) => paymentMethod !== 'scroll'
    ? <>{paymentMethod === 'skr' && <SkrTokenIcon size={12} />}{heroPriceLabel(count)}</>
    : <><SummonScrollArtwork size={16} />{count} {count === 1 ? 'Scroll' : 'Scrolls'}</>;
  const pity = ([
    ['Legendary', game.summonPity.legendary, 150, 'legendary'],
    ['Mythic', game.summonPity.mythic, 500, 'mythic'],
    ['Cosmic', game.summonPity.cosmic, 2000, 'cosmic'],
    ['Divine', game.summonPity.divine, 5000, 'divine'],
    ['Celestial', game.summonPity.celestial, 20000, 'celestial'],
  ] as const);
  const again = results && {
    label: <><Sparkles size={15} /> Summon ×{resultBatch} again</>,
    disabled: busy || !canSummon(resultBatch),
    onClick: () => { setResults(null); void beginSummon(resultBatch); },
  };

  return (
    <div className={`sv-root${results ? ' sv-paused' : ''}${reducedMotion ? ' sv-still' : ''}`}>
      <section className={`sv-temple${summoning !== null ? ' is-summoning' : ''}`} aria-label="Summoning temple">
        <div className="sv-temple-art" aria-hidden="true" />
        <div className="sv-temple-glow" aria-hidden="true" />
        <svg className="sv-runes" viewBox="0 0 200 200" aria-hidden="true">
          <circle cx="100" cy="100" r="92" className="sv-runes-outer" />
          <circle cx="100" cy="100" r="80" className="sv-runes-inner" />
        </svg>
        <div className="sv-fog" aria-hidden="true"><i /><i /></div>
        <div className="sv-embers" aria-hidden="true">{Array.from({ length: 9 }, (_, index) => <i key={index} style={{ '--i': index } as CSSProperties} />)}</div>

        <header className="sv-temple-head">
          <span className="sv-kicker">The Obsidian Covenant</span>
          <h2 className="sv-title">Hero Summon</h2>
          <p className="sv-lede">{isolatedHackathon ? 'Offer SKR or Summon Scrolls at an altar. Every hero is unique.' : 'Summon heroes using $HERO tokens. All heroes are unique and tradeable.'}</p>
        </header>
        <div className="sv-temple-chips">
          <span className="sv-chip">{state.ownedHeroes.length}/{state.heroCapacity} heroes</span>
          <button type="button" className="sv-chip sv-chip--button" onClick={() => setShowRates((value) => !value)} aria-expanded={showRates} aria-controls="sv-rates"><Info size={12} /> Rates</button>
        </div>

        <div className="sv-offering" role="group" aria-label="Summon payment method">
          <span className="sv-offering-label">Offering</span>
          {isolatedHackathon
            ? <button type="button" onClick={() => { setPaymentMethod('skr'); setPendingQuote(null); }} aria-pressed={paymentMethod === 'skr'} disabled={summoning !== null} className="sv-offer"><SkrTokenIcon size={14} />SKR</button>
            : <button type="button" onClick={() => setPaymentMethod('paid')} aria-pressed={paymentMethod === 'paid'} disabled={summoning !== null} className="sv-offer"><HeroTokenIcon size={14} />Test · $HERO</button>}
          <button type="button" onClick={() => { setPaymentMethod('scroll'); setPendingQuote(null); }} aria-pressed={paymentMethod === 'scroll'} disabled={summoning !== null} className="sv-offer"><SummonScrollArtwork size={22} /> Scrolls · {formatNum(state.summonScrolls)}</button>
        </div>

        <div className="sv-altars" aria-label="Summon altars">
          <Altar count={1} tone="violet" title="Summon" cost={altarCost(1)} status={altarStatus(1)} lit={canSummon(1)} busy={summoning === 1} disabled={!canSummon(1) || busy} onClick={() => void beginSummon(1)} />
          <Altar count={10} tone="gold" title="Summon" cost={altarCost(10)} status={altarStatus(10)} lit={canSummon(10)} busy={summoning === 10} disabled={!canSummon(10) || busy} onClick={() => void beginSummon(10)} />
          <Altar count={100} tone="crimson" title="Mass Summon" cost={altarCost(100)} status={altarStatus(100)} lit={canSummon(100)} busy={summoning === 100} disabled={!canSummon(100) || busy} onClick={() => void beginSummon(100)} />
        </div>
      </section>

      <div className="sv-panel">
        {summonNotice && <div role="alert" aria-live="polite" className="sv-notice"><AlertTriangle size={17} /><span>{summonNotice}</span><button type="button" onClick={() => setSummonNotice('')} aria-label="Dismiss Summon message"><X size={14} /></button></div>}


        {pendingQuote && <div ref={quoteRef} className="sv-quote" role="region" aria-label="Confirm SKR Summon">
          <p className="sv-quote-title" title={`Exact payment: ${formatMinor(pendingQuote.quote.amount_minor, 'SKR', 6)} SKR`}>Summon ×{pendingQuote.count} · {formatAmountShort(pendingQuote.quote.amount_minor, 'SKR', 'up')} SKR</p>
          <p className="sv-quote-note">Server quote · ${(Number(pendingQuote.quote.usd_cents) / 100).toFixed(2)} · valid until {new Date(pendingQuote.quote.expires_at).toLocaleTimeString()}. No payment until you confirm.</p>
          <div className="sv-quote-actions"><button type="button" disabled={summoning !== null} onClick={() => void confirmSkrSummon()} className="sv-btn sv-btn--primary">{summoning ? 'Summoning…' : 'Pay SKR & summon'}</button><button type="button" disabled={summoning !== null} onClick={() => setPendingQuote(null)} className="sv-btn sv-btn--ghost">Cancel</button></div>
        </div>}

        <section className="sv-shrine" aria-label="Pity progress">
          <div className="sv-section-head"><span>Guarantee shrine</span><button type="button" onClick={() => setShowPityInfo((value) => !value)} aria-expanded={showPityInfo} className="sv-link"><Info size={12} /> Pity info</button></div>
          <ol className="sv-pity">
            {pity.map(([label, current, target, rarity]) => (
              <li key={rarity} style={{ '--sv-color': RARITY_COLORS[rarity], '--sv-fill': `${Math.min(100, current / target * 100)}%` } as CSSProperties}>
                <span className="sv-pity-gem" aria-hidden="true" />
                <span className="sv-pity-label">{label}</span>
                <span className="sv-pity-bar" aria-hidden="true"><i /></span>
                <span className="sv-pity-count">{current}/{target}</span>
                {rarity === 'mythic' && current >= 250 && <span className="sv-pity-soft">Soft pity</span>}
              </li>
            ))}
          </ol>
          {showPityInfo && <p className="sv-pity-info"><strong>How Pity works:</strong> counters track misses for that rarity or higher. Guarantees are 150 / 500 / 2,000 / 5,000 / 20,000. Mythic+ gains 0.0015 percentage point per miss on rolls 251–499, taken from Common.</p>}
        </section>

        {showRates && <section id="sv-rates" className="sv-rates" aria-label="Base summon rates">
          <div className="sv-section-head"><span>Base summon rates</span><span className="sv-muted">{state.summons} summons</span></div>
          <ul>
            {rarities.map(r => { const unavailable = (r === 'divine' || r === 'celestial') && rarityCapacity[r] === false; return <li key={r} className={unavailable ? 'is-full' : ''} style={{ color: RARITY_COLORS[r] }}><span>{RARITY_LABEL[r]}{unavailable ? ' · Full' : ''}</span><b>{RARITY_WEIGHT[r]}%</b></li>; })}
          </ul>
        </section>}

        <div className="sv-promote">
          {isolatedHackathon
            ? <SeekerPromoteAll game={game} />
            : <button type="button" disabled={promoting || summoning !== null} onClick={() => void promoteAll()} className="game-control flex h-[46px] w-full items-center justify-center gap-1.5 px-3 text-[9px] font-black uppercase disabled:opacity-55"><Sparkles size={13} className="text-amber-300" /> {promoting ? 'Promoting heroes…' : 'Promote all heroes · Free space for Summon'}</button>}
          {promotionNotice && <div role="status" className="sv-status"><span>{promotionNotice}</span><button type="button" onClick={() => setPromotionNotice('')} aria-label="Dismiss promotion result"><X size={13} /></button></div>}
        </div>

        {!isolatedHackathon && <>
        <section className="summon-focus w-full rounded-lg border border-violet-500/30 bg-black/45 text-left">
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
        <p className="sv-muted sv-center">Earn $HERO by winning battles in locations. Balance: {formatNum(state.hero)} $HERO</p>
        </>}
      </div>

      {results && <SummonReveal heroes={results} newHeroIds={newHeroIds} reducedMotion={reducedMotion} onClose={() => setResults(null)} again={again ?? undefined} />}
    </div>
  );
}
