import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, Info, Sparkles, Target, X } from 'lucide-react';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, RARITY_WEIGHT } from '@/game/heroes';
import { formatNum } from '@/game/state';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import type { OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import { lastRetryAfterSeconds } from '@/game/backend';
import { isolatedHackathon } from '@/game/editionStorage';
import { SkrTokenIcon } from '@/components/SkrTokenIcon';
import { SeekerPromoteAll } from '@/components/SeekerPromoteAll';
import { SummonReveal } from '@/components/summon/SummonReveal';
import { quoteSkrPurchase, formatAmountShort, formatMinor, type SkrPurchaseQuote } from '@/game/seekerWallet';
import { useSkrRate, skrPrice, skrError } from '@/game/skrPurchase';
import stoneTexture from '@/theme/premium/assets/panel-stone.webp';
import '@/components/summon/summon-v2.css';

type Batch = 1 | 10 | 100;

// One altar per batch size. The flame is lit while that batch can be paid and stored.
// The pedestal is a carved stone brazier drawn in SVG; gradient ids are scoped by tone
// because each tone is used by exactly one altar.
function AltarStone({ tone, tall }: { tone: 'violet' | 'gold' | 'crimson'; tall: boolean }) {
  const h = tall ? 150 : 136;
  const shaftBottom = h - 24;
  const id = (name: string) => `sv-${tone}-${name}`;
  const ref = (name: string) => `url(#${id(name)})`;
  return (
    <svg className="sv-altar-svg" viewBox={`0 0 120 ${h}`} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id('brass')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6dc9c" />
          <stop offset=".35" stopColor="#b98a45" />
          <stop offset=".7" stopColor="#5e3d16" />
          <stop offset="1" stopColor="#2a1906" />
        </linearGradient>
        <linearGradient id={id('brass-h')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#4a2f10" />
          <stop offset=".22" stopColor="#d9b46c" />
          <stop offset=".5" stopColor="#fbe7b0" />
          <stop offset=".78" stopColor="#d9b46c" />
          <stop offset="1" stopColor="#4a2f10" />
        </linearGradient>
        <linearGradient id={id('stone')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#050403" stopOpacity=".92" />
          <stop offset=".3" stopColor="#2b2420" stopOpacity=".35" />
          <stop offset=".55" stopColor="#3a302a" stopOpacity=".2" />
          <stop offset="1" stopColor="#030202" stopOpacity=".95" />
        </linearGradient>
        <linearGradient id={id('shade')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity=".55" />
          <stop offset=".25" stopColor="#000" stopOpacity="0" />
          <stop offset=".8" stopColor="#000" stopOpacity=".25" />
          <stop offset="1" stopColor="#000" stopOpacity=".75" />
        </linearGradient>
        <radialGradient id={id('coals')} cx=".5" cy=".5" r=".5">
          <stop offset="0" stopColor="#fff6dc" />
          <stop offset=".45" className="sv-stop-tone" />
          <stop offset="1" className="sv-stop-tone" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('sigil')} cx=".5" cy=".5" r=".5">
          <stop offset="0" className="sv-stop-tone" stopOpacity=".55" />
          <stop offset="1" className="sv-stop-tone" stopOpacity="0" />
        </radialGradient>
        <clipPath id={id('shaft')}><path d={`M18 42 H102 L108 ${shaftBottom} H12 Z`} /></clipPath>
      </defs>

      {/* Stepped plinth */}
      <path d={`M0 ${h - 10} H120 V${h} H0 Z`} fill={ref('brass')} />
      <path d={`M1.5 ${h - 8.5} H118.5 V${h - 1} H1.5 Z`} fill="#140e09" />
      <path d={`M6 ${shaftBottom} H114 V${h - 10} H6 Z`} fill={ref('brass-h')} />
      <path d={`M8 ${shaftBottom + 2} H112 V${h - 12} H8 Z`} fill="#1c1510" />
      <path d={`M8 ${shaftBottom + 2} H112 V${h - 12} H8 Z`} fill={ref('stone')} />

      {/* Carved shaft */}
      <g clipPath={ref('shaft')}>
        <rect x="0" y="42" width="120" height={shaftBottom - 42} fill="#211a15" />
        <image href={stoneTexture} x="-20" y="30" width="160" height="160" preserveAspectRatio="xMidYMid slice" opacity=".75" />
        <rect x="0" y="42" width="120" height={shaftBottom - 42} fill={ref('stone')} />
        <rect x="0" y="42" width="120" height={shaftBottom - 42} fill={ref('shade')} />
        <circle className="sv-altar-sigil-glow" cx="60" cy={(42 + shaftBottom) / 2} r="34" fill={ref('sigil')} />
      </g>
      <path d={`M18 42 L12 ${shaftBottom} M102 42 L108 ${shaftBottom}`} stroke="#000" strokeWidth="1.2" />
      <path d={`M26 49 H94 L98.5 ${shaftBottom - 7} H21.5 Z`} fill="none" stroke={ref('brass-h')} strokeWidth=".9" />
      <path d={`M29 52 H91 L95 ${shaftBottom - 10} H25 Z`} fill="none" stroke="rgba(242,204,128,.28)" strokeWidth=".5" />
      <g className="sv-altar-sigil" fill="none" strokeWidth=".7">
        <circle cx="60" cy={(42 + shaftBottom) / 2} r="27" strokeDasharray="1.5 2.5" />
        <circle cx="60" cy={(42 + shaftBottom) / 2} r="23" strokeDasharray="6 2 1 2" />
      </g>
      {[[26, 49], [94, 49], [21.5, shaftBottom - 7], [98.5, shaftBottom - 7]].map(([x, y]) => (
        <path key={`${x}-${y}`} d={`M${x} ${y - 3} L${x + 3} ${y} L${x} ${y + 3} L${x - 3} ${y} Z`} fill={ref('brass-h')} stroke="#1a1006" strokeWidth=".5" />
      ))}

      {/* Capital and cornice */}
      <path d="M14 40 H106 L103 44 H17 Z" fill="#0b0806" />
      <path d="M8 30 H112 L110 40 H10 Z" fill={ref('brass')} />
      <path d="M11 31.5 H109 L107.6 38.5 H12.4 Z" fill="#1d1611" />
      <path d="M11 31.5 H109 L107.6 38.5 H12.4 Z" fill={ref('stone')} />
      <path d="M8 30 H112" stroke="#fbe7b0" strokeWidth=".8" opacity=".85" />
      <path d="M44 35 L60 31.5 L76 35 L60 38.5 Z" fill={ref('brass-h')} stroke="#1a1006" strokeWidth=".5" />

      {/* Brazier: neck, bowl and glowing coals */}
      <path d="M50 22 H70 L73 30 H47 Z" fill={ref('brass')} />
      <path d="M46 24.5 H74" stroke="#2a1906" strokeWidth="1.4" />
      <path d="M46 24 H74" stroke="#f0d394" strokeWidth=".6" />
      <path d="M17 6 Q20 21 46 22.5 H74 Q100 21 103 6 Z" fill={ref('brass')} stroke="#1a1006" strokeWidth=".8" />
      <path d="M24 10 Q30 18 50 19.5 H70 Q90 18 96 10" fill="none" stroke="rgba(255,236,190,.45)" strokeWidth=".7" />
      {[30, 45, 60, 75, 90].map((x) => <circle key={x} cx={x} cy={x === 30 || x === 90 ? 13 : 16.5} r="1.3" fill="#fbe7b0" stroke="#3a240a" strokeWidth=".4" />)}
      <ellipse cx="60" cy="6" rx="43.5" ry="4" fill={ref('brass-h')} stroke="#1a1006" strokeWidth=".7" />
      <ellipse cx="60" cy="6" rx="39" ry="2.6" fill="#0a0604" />
      <ellipse className="sv-altar-coals" cx="60" cy="6" rx="36" ry="2.3" fill={ref('coals')} />
    </svg>
  );
}

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
      aria-busy={busy}
      aria-label={`${title}${status ? ` · ${status}` : ''}`}
      className={`sv-altar sv-altar--${tone}${lit ? ' is-lit' : ''}${busy ? ' is-busy' : ''}`}
    >
      <span className="sv-flame" aria-hidden="true"><i /><i /><i /></span>
      <span className="sv-altar-stone">
        <AltarStone tone={tone} tall={tone === 'gold'} />
        <span className="sv-altar-face">
          <span className="sv-altar-count">×{count}</span>
          <span className="sv-altar-title">{busy ? 'Summoning…' : title}</span>
        </span>
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
  const summonInFlight = useRef(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [focusRarity, setFocusRarity] = useState<Rarity>('common');
  const [focusSaving, setFocusSaving] = useState(false);
  const [showFocus, setShowFocus] = useState(false);
  const [showPityInfo, setShowPityInfo] = useState(false);
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
    if (game.summonError === 'rate_limited') {
      setSummonNotice('Summon limit reached · Please wait before trying again');
      return;
    }
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
  useEffect(() => {
    if (game.summonError === 'rate_limited') setCooldownSeconds(Math.min(300, Math.ceil(lastRetryAfterSeconds())));
  }, [game.summonError]);
  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = window.setTimeout(() => setCooldownSeconds(value => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldownSeconds]);
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
    if (summonInFlight.current || cooldownSeconds > 0) return;
    if (state.ownedHeroes.length + count > state.heroCapacity || !canPay(count)) { unavailableMessage(count); return; }
    summonInFlight.current = true;
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
      else setSummonNotice('Summon could not finish · Refresh to check your heroes before trying again');
    } catch (error) { setSummonNotice(skrError(error)); } finally { summonInFlight.current = false; setSummoning(null); }
  };
  const confirmSkrSummon = async () => {
    if (!pendingQuote || summonInFlight.current || cooldownSeconds > 0) return;
    summonInFlight.current = true;
    setSummoning(pendingQuote.count); setSummonNotice('');
    const ownedBefore = new Set(state.ownedHeroes.map((hero) => hero.heroId));
    try {
      const result = await game.summonHeroes(pendingQuote.count, 'skr', pendingQuote.quote.quote_id);
      if (result.length) { showResults(result, pendingQuote.count, ownedBefore); setPendingQuote(null); }
      else setSummonNotice('Payment could not finish. Retry the same payment or check Wallet history.');
    } catch (error) { setSummonNotice(skrError(error)); }
    finally { summonInFlight.current = false; setSummoning(null); }
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

  const busy = summoning !== null || promoting || pendingQuote !== null || cooldownSeconds > 0;
  const altarStatus = (count: Batch) => cooldownSeconds > 0 ? `Ready in ${cooldownSeconds}s` : !hasSpace(count)
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
    label: <><Sparkles size={15} /> Again ×{resultBatch}</>,
    disabled: busy || !canSummon(resultBatch),
    onClick: () => { setResults(null); void beginSummon(resultBatch); },
  };

  return (
    <div className={`sv-root${results ? ' sv-paused' : ''}${reducedMotion ? ' sv-still' : ''}`}>
      <section className={`sv-temple${summoning !== null ? ' is-summoning' : ''}`} aria-label="Summoning temple" aria-busy={summoning !== null}>
        {summoning !== null && <div className="sv-pending" role="status" aria-live="polite">
          <span className="sv-pending-orb" aria-hidden="true"><Sparkles size={36} /></span>
          <strong>{paymentMethod === 'skr' && !pendingQuote ? 'Preparing your offering…' : `Summoning ×${summoning}…`}</strong>
          <span>{paymentMethod === 'skr' && !pendingQuote ? 'Getting the price · No payment yet' : 'The portal is opening · Waiting for your heroes'}</span>
        </div>}
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
          <div className="sv-quote-actions"><button type="button" disabled={summoning !== null || cooldownSeconds > 0} onClick={() => void confirmSkrSummon()} className="sv-btn sv-btn--primary">{summoning ? 'Summoning…' : 'Pay SKR & summon'}</button><button type="button" disabled={summoning !== null} onClick={() => setPendingQuote(null)} className="sv-btn sv-btn--ghost">Cancel</button></div>
        </div>}

        <section className="sv-shrine" aria-label="Pity progress">
          <div className="sv-section-head"><span className="sv-head-spacer" aria-hidden="true" /><h3 className="sv-head-title">Guarantee Shrine</h3><button type="button" onClick={() => setShowPityInfo((value) => !value)} aria-expanded={showPityInfo} aria-label="Pity info" title="Pity info" className="sv-link"><Info size={15} /></button></div>
          <ol className="sv-pity">
            {pity.map(([label, current, target, rarity]) => (
              <li key={rarity} style={{ '--sv-color': RARITY_COLORS[rarity] } as CSSProperties}>
                <span className="sv-pity-seal" aria-hidden="true">
                  <svg viewBox="0 0 48 48" focusable="false">
                    <circle className="sv-pity-track" cx="24" cy="24" r="20" />
                    <circle className="sv-pity-arc" cx="24" cy="24" r="20" pathLength="100" strokeDasharray={`${Math.min(100, current / target * 100)} 100`} />
                  </svg>
                  <span className="sv-pity-gem" />
                </span>
                <span className="sv-pity-label">{label}</span>
                <span className="sv-pity-count"><b>{current}</b>/{target}</span>
                {rarity === 'mythic' && current >= 250 && <span className="sv-pity-soft">Soft pity</span>}
              </li>
            ))}
          </ol>
          {showPityInfo && <p className="sv-pity-info"><strong>How Pity works:</strong> counters track misses for that rarity or higher. Guarantees are 150 / 500 / 2,000 / 5,000 / 20,000. Mythic+ gains 0.0015 percentage point per miss on rolls 251–499, taken from Common.</p>}
        </section>

        <section id="sv-rates" className="sv-rates" aria-labelledby="sv-rates-title">
          <div className="sv-section-head sv-section-head--stack"><h3 id="sv-rates-title" className="sv-head-title">Summon Chances</h3><span className="sv-muted">{formatNum(state.summons)} summons performed</span></div>
          <ul>
            {rarities.map(r => { const unavailable = (r === 'divine' || r === 'celestial') && rarityCapacity[r] === false; return <li key={r} className={unavailable ? 'is-full' : ''} style={{ '--sv-color': RARITY_COLORS[r] } as CSSProperties}><span className="sv-rate-name"><i aria-hidden="true" />{RARITY_LABEL[r]}{unavailable && <small>Full</small>}</span><b>{RARITY_WEIGHT[r]}%</b></li>; })}
          </ul>
          <p className="sv-rates-note">Base chances before Pity. Guarantees are shown above.</p>
        </section>

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
