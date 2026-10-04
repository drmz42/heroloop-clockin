import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { RarityFx } from '@/components/RarityFx';
import { createPortal } from 'react-dom';
import { ChevronsRight, Sparkles, X } from 'lucide-react';
import { HERO_MAP, RARITY_COLORS, RARITY_INDEX, RARITY_LABEL, CLASS_LABEL } from '@/game/heroes';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import type { HeroBase, OwnedHero, Rarity } from '@/game/types';

// Effect tiers: 0 Common/Uncommon, 1 Rare/Epic, 2 Legendary/Mythic, 3 Cosmic and above.
function summonTier(rarity: Rarity): 0 | 1 | 2 | 3 {
  const index = RARITY_INDEX[rarity] ?? 0;
  return index >= 6 ? 3 : index >= 4 ? 2 : index >= 2 ? 1 : 0;
}

type Pull = { hero: OwnedHero; base: HeroBase; tier: 0 | 1 | 2 | 3; isNew: boolean };
type Phase = 'portal' | 'spotlight' | 'cards' | 'done';

const PORTAL_MS = [1500, 1700, 2300, 2700] as const;
// Only the best few results get a full-screen spotlight; a mass summon never turns into a slideshow.
const MAX_SPOTLIGHTS = 4;
// Big batches flip only the leading cards in 3D; the rest use a cheap opacity/translate entrance.
const FLIP_CARDS = 10;

function vibrate(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern); } catch { /* unsupported */ }
}

export function SummonReveal({ heroes, newHeroIds, reducedMotion, onClose, again }: {
  heroes: OwnedHero[];
  newHeroIds: ReadonlySet<string>;
  reducedMotion: boolean;
  onClose: () => void;
  again?: { label: ReactNode; disabled: boolean; onClick: () => void };
}) {
  const pulls = useMemo<Pull[]>(() => heroes
    .map((hero) => {
      const base = HERO_MAP[hero.heroId];
      return base ? { hero, base, tier: summonTier(base.rarity), isNew: newHeroIds.has(hero.heroId) } : null;
    })
    .filter((pull): pull is Pull => pull !== null)
    .sort((a, b) => (RARITY_INDEX[b.base.rarity] ?? 0) - (RARITY_INDEX[a.base.rarity] ?? 0)), [heroes, newHeroIds]);
  const best = pulls[0];
  const bestTier = best?.tier ?? 0;
  const bestColor = best ? RARITY_COLORS[best.base.rarity] : RARITY_COLORS.common;
  const spotlights = useMemo(() => {
    const seen = new Set<string>();
    return pulls.filter((pull) => {
      if (pull.tier < 2 || seen.has(pull.base.id)) return false;
      seen.add(pull.base.id);
      return true;
    }).slice(0, MAX_SPOTLIGHTS);
  }, [pulls]);
  const single = pulls.length === 1;
  const mass = pulls.length > 10;

  const [phase, setPhase] = useState<Phase>(reducedMotion ? 'done' : 'portal');
  const [spotIndex, setSpotIndex] = useState(0);
  const [instant, setInstant] = useState(reducedMotion);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // Decode portraits while the portal plays, so cards never flip onto an empty frame.
  useEffect(() => {
    const sources = [...new Set(pulls.slice(0, 40).map(({ base }) => heroPortraitSrc(base.id, base.heroClass, base.rarity, base.color)))];
    sources.forEach((src) => { const image = new Image(); image.decoding = 'async'; image.src = src; });
  }, [pulls]);

  const toCards = useCallback(() => {
    setPhase('cards');
  }, []);
  const afterPortal = useCallback(() => {
    if (spotlights.length) { setSpotIndex(0); setPhase('spotlight'); } else toCards();
  }, [spotlights.length, toCards]);

  useEffect(() => {
    if (phase !== 'portal') return;
    const timer = window.setTimeout(afterPortal, PORTAL_MS[bestTier]);
    return () => window.clearTimeout(timer);
  }, [phase, afterPortal, bestTier]);

  useEffect(() => {
    if (phase !== 'spotlight') return;
    const pull = spotlights[spotIndex];
    if (pull) vibrate(pull.tier >= 3 ? [40, 60, 90] : 35);
  }, [phase, spotIndex, spotlights]);

  // Card sequence length: the last stagger delay plus one flip.
  const cardsMs = useMemo(() => {
    if (single) return 750;
    const flips = Math.min(pulls.length, FLIP_CARDS);
    const flipEnd = (flips - 1) * 95 + 650;
    const restEnd = mass ? Math.min(pulls.length - FLIP_CARDS, 45) * 14 + FLIP_CARDS * 95 + 420 : 0;
    return Math.max(flipEnd, restEnd);
  }, [mass, pulls.length, single]);

  useEffect(() => {
    if (phase !== 'cards') return;
    const timer = window.setTimeout(() => setPhase('done'), cardsMs);
    return () => window.clearTimeout(timer);
  }, [phase, cardsMs]);

  useEffect(() => { if (phase === 'done') primaryRef.current?.focus({ preventScroll: true }); }, [phase]);

  const nextSpotlight = useCallback(() => {
    if (spotIndex + 1 < spotlights.length) setSpotIndex(spotIndex + 1);
    else { setInstant(true); setPhase('done'); }
  }, [spotIndex, spotlights.length]);

  const skip = useCallback(() => {
    setInstant(true);
    setPhase('done');
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (phase === 'done') onClose(); else skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onClose, skip]);

  const counts = useMemo(() => {
    const map = new Map<Rarity, number>();
    pulls.forEach(({ base }) => map.set(base.rarity, (map.get(base.rarity) ?? 0) + 1));
    return [...map.entries()];
  }, [pulls]);

  const showCards = phase === 'cards' || phase === 'done';
  const spot = phase === 'spotlight' ? spotlights[spotIndex] : undefined;

  if (!best) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Summon results"
      className={`sv-reveal sv-tier-${bestTier}${reducedMotion ? ' sv-still' : ''}`}
      data-phase={phase}
      style={{ '--sv-best': bestColor } as CSSProperties}
    >
      {phase === 'portal' && (
        <button type="button" className="sv-portal" onClick={afterPortal} aria-label="Skip the summon portal">
          <span className="sv-portal-veil" aria-hidden="true" />
          <span className="sv-portal-ring sv-portal-ring--a" aria-hidden="true" />
          <span className="sv-portal-ring sv-portal-ring--b" aria-hidden="true" />
          <span className="sv-portal-beam" aria-hidden="true" />
          <span className="sv-orb" aria-hidden="true">
            <i className="sv-orb-layer sv-orb-layer--base" />
            {bestTier >= 1 && <i className="sv-orb-layer sv-orb-layer--rare" />}
            {bestTier >= 2 && <i className="sv-orb-layer sv-orb-layer--gold" />}
            {bestTier >= 3 && <i className="sv-orb-layer sv-orb-layer--prism" />}
          </span>
          <span className="sv-portal-flash" aria-hidden="true" />
          <span className="sv-portal-copy">
            <b>The Covenant answers</b>
            <small>{single ? 'One soul crosses the veil' : `${pulls.length} souls cross the veil`}</small>
          </span>
        </button>
      )}

      {spot && (
        <button
          key={spot.hero.uid}
          type="button"
          className={`sv-spot sv-spot-tier-${spot.tier}`}
          onClick={nextSpotlight}
          style={{ '--sv-color': RARITY_COLORS[spot.base.rarity] } as CSSProperties}
          aria-label={`${RARITY_LABEL[spot.base.rarity]} ${spot.base.name}. Continue`}
        >
          <span className="sv-spot-rays" aria-hidden="true" />
          {spot.tier >= 3 && <span className="sv-spot-rays sv-spot-rays--counter" aria-hidden="true" />}
          <span className="sv-spot-flash" aria-hidden="true" />
          <span className="sv-spot-motes" aria-hidden="true">{Array.from({ length: 10 }, (_, index) => <i key={index} style={{ '--i': index } as CSSProperties} />)}</span>
          <span className="sv-spot-rarity">{RARITY_LABEL[spot.base.rarity]}</span>
          <span className="sv-spot-portrait">
            <img src={heroPortraitSrc(spot.base.id, spot.base.heroClass, spot.base.rarity, spot.base.color)} alt="" decoding="async" style={{ ...heroPortraitStyle(spot.base.id, spot.base.heroClass), transform: 'none' }} />
            <i className="sv-spot-sheen" aria-hidden="true" />
            <RarityFx rarity={spot.base.rarity} />
          </span>
          <span className="sv-spot-name">{spot.base.name}</span>
          <span className="sv-spot-meta">{CLASS_LABEL[spot.base.heroClass]}{spot.isNew ? <em>New hero</em> : null}</span>
          <span className="sv-spot-hint">{spotlights.length > 1 ? `${spotIndex + 1} / ${spotlights.length} · ` : ''}Tap to continue</span>
        </button>
      )}

      {showCards && (
        <div className={`sv-results${instant ? ' sv-instant' : ''}${mass ? ' sv-mass' : ''}${single ? ' sv-single' : ''}`}>
          <header className="sv-results-head" style={{ color: bestColor }}>
            <span>{single ? RARITY_LABEL[best.base.rarity] : `Summon ×${pulls.length}`}</span>
            <strong>{single ? best.base.name : `Best · ${RARITY_LABEL[best.base.rarity]}`}</strong>
            {!single && (
              <ul className="sv-counts" aria-label="Results by rarity">
                {counts.map(([rarity, count]) => <li key={rarity} style={{ color: RARITY_COLORS[rarity] }}><i aria-hidden="true" />{RARITY_LABEL[rarity]} ×{count}</li>)}
              </ul>
            )}
          </header>
          <div className="sv-grid-scroll">
            <ol className="sv-grid">
              {pulls.map((pull, index) => {
                const color = RARITY_COLORS[pull.base.rarity];
                const flip = !mass || index < FLIP_CARDS;
                const delay = flip ? index * 95 : FLIP_CARDS * 95 + Math.min(index - FLIP_CARDS, 45) * 14;
                return (
                  <li
                    key={pull.hero.uid}
                    className={`sv-card sv-card-tier-${pull.tier} ${flip ? 'sv-card-flip' : 'sv-card-fade'}`}
                    style={{ '--sv-color': color, '--sv-delay': `${delay}ms` } as CSSProperties}
                  >
                    <div className="sv-card-inner">
                      <div className="sv-card-face sv-card-back" aria-hidden="true"><Sparkles size={single ? 34 : 18} /></div>
                      <div className="sv-card-face sv-card-front">
                        <img src={heroPortraitSrc(pull.base.id, pull.base.heroClass, pull.base.rarity, pull.base.color)} alt="" decoding="async" loading={index < 30 ? 'eager' : 'lazy'} style={{ ...heroPortraitStyle(pull.base.id, pull.base.heroClass), transform: 'none' }} />
                        <RarityFx rarity={pull.base.rarity} />
                        {pull.tier >= 1 && <i className="sv-card-shine" aria-hidden="true" />}
                        {pull.isNew && <em className="sv-card-new">New</em>}
                        <span className="sv-card-plate">
                          <b>{pull.base.name}</b>
                          <small>{RARITY_LABEL[pull.base.rarity]}</small>
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          <footer className="sv-results-actions">
            {phase === 'cards'
              ? <button type="button" className="sv-btn sv-btn--ghost" onClick={skip}><ChevronsRight size={16} /> Reveal all</button>
              : <>
                {again && <button type="button" className="sv-btn sv-btn--again" disabled={again.disabled} onClick={again.onClick}>{again.label}</button>}
                <button ref={primaryRef} type="button" className="sv-btn sv-btn--primary" onClick={onClose}>Continue</button>
              </>}
          </footer>
        </div>
      )}

      {phase !== 'done' && phase !== 'cards' && <button type="button" className="sv-skip" onClick={skip}>Skip <ChevronsRight size={14} /></button>}
      {phase === 'done' && <button type="button" className="sv-close" onClick={onClose} aria-label="Close summon results"><X size={18} /></button>}
    </div>,
    document.body,
  );
}
