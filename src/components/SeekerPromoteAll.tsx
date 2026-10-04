// Seeker Promote All: one button showing stars and Power gained with an explicit Gold cost, then a
// ceremony window listing every promoted hero (Founder 2026-10-03).
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Star } from 'lucide-react';
import { teamPower } from '@/game/engine';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL } from '@/game/heroes';
import { formatNum } from '@/game/state';
import { planSeekerPromotion, type SeekerPromotionStep } from '@/game/seekerPromotion';
import type { GameApi } from '@/game/useGame';

type PromotionResult = SeekerPromotionStep & { powerBefore: number; powerAfter: number };

const FAILURE: Record<string, string> = {
  promotion_quote_changed: 'Heroes or Gold changed. Check the new total and try again.',
  insufficient_duplicates: 'No hero has enough spare copies yet.',
  rate_limited: 'Too many requests. Try again in a moment.',
};

export function SeekerPromoteAll({ game, className = '', only }: { game: GameApi; className?: string; only?: string }) {
  const { state } = game;
  const { ownedHeroes, inventory, team, trainingCamp, gold } = state;
  const plan = useMemo(() => planSeekerPromotion({ ownedHeroes, inventory, team, trainingCamp, gold }, only), [ownedHeroes, inventory, team, trainingCamp, gold, only]);
  const powerGain = plan.steps.reduce((sum, step) => {
    const hero = ownedHeroes.find((owned) => owned.uid === step.uid);
    return hero ? sum + teamPower([{ ...hero, stars: step.to }], inventory) - teamPower([hero], inventory) : sum;
  }, 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ promotions: PromotionResult[]; goldSpent: number; freed: number } | null>(null);

  const promote = async () => {
    if (busy || plan.stars === 0) return;
    setBusy(true); setError('');
    try {
      const outcome = await game.seekerPromoteAll(plan);
      if (outcome.ok) setResult({ promotions: outcome.promotions, goldSpent: outcome.goldSpent, freed: plan.copies });
      else setError(FAILURE[outcome.error] ?? 'Promotion failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return <>
    <button type="button" onClick={() => void promote()} disabled={busy || plan.stars === 0} className={`seeker-promote-all game-control ${className}`}
      aria-label={plan.stars > 0 ? `${only ? 'Star Up' : 'Promote all heroes'}: ${plan.stars} stars, +${powerGain} Power for ${plan.gold} Gold, frees ${plan.copies} slots` : `${only ? 'Star Up' : 'Promote all heroes'}: nothing to promote yet`}>
      <Sparkles size={15} aria-hidden="true" />
      <span className="seeker-promote-all-label">{busy ? 'Promoting…' : only ? 'Star Up' : 'Promote all heroes'}</span>
      {plan.stars > 0
        ? <span className="seeker-promote-all-cost"><b>+{plan.stars}★</b><span aria-hidden="true">·</span><b>+{formatNum(powerGain)} Power</b></span>
        : <span className="seeker-promote-all-cost seeker-promote-all-idle">No spare copies</span>}
    </button>
    {plan.stars > 0 && !busy && <p className="seeker-promote-all-hint">Cost: {formatNum(plan.gold)} Gold · uses {formatNum(plan.copies)} spare zero-star copies · frees {formatNum(plan.copies)} hero slots</p>}
    {error && <p role="alert" className="seeker-promote-all-error">{error}</p>}
    {result && <PromotionCeremony {...result} onClose={() => setResult(null)} />}
  </>;
}

function PromotionCeremony({ promotions, goldSpent, freed, onClose }: { promotions: PromotionResult[]; goldSpent: number; freed: number; onClose: () => void }) {
  const totalPower = promotions.reduce((sum, entry) => sum + entry.powerAfter - entry.powerBefore, 0);
  const totalStars = promotions.reduce((sum, entry) => sum + entry.to - entry.from, 0);
  return createPortal(
    <div className="promo-ceremony" role="dialog" aria-modal="true" aria-labelledby="promo-ceremony-title" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <i className="promo-ceremony-rays" aria-hidden="true" />
      <section className="promo-ceremony-panel">
        <header className="promo-ceremony-head">
          <span className="promo-ceremony-crest" aria-hidden="true"><Star size={30} fill="currentColor" /></span>
          <small>Covenant of stars</small>
          <h2 id="promo-ceremony-title">Heroes ascended</h2>
          <p>+{totalStars}★ across {promotions.length} {promotions.length === 1 ? 'hero' : 'heroes'} · +{formatNum(totalPower)} Power</p>
        </header>
        <ol className="promo-ceremony-list" tabIndex={0} aria-label="Promoted heroes">
          {promotions.map((entry, index) => {
            const hero = HERO_MAP[entry.heroId];
            if (!hero) return null;
            const color = RARITY_COLORS[hero.rarity];
            const delay = Math.min(index, 12) * 90;
            return <li key={entry.uid} className="promo-row" style={{ '--promo-color': color, '--promo-delay': `${delay}ms` } as React.CSSProperties}>
              <span className="promo-row-portrait"><HeroPortrait heroId={hero.id} heroClass={hero.heroClass} rarity={hero.rarity} color={hero.color} size={48} /></span>
              <span className="promo-row-body">
                <b style={{ color }}>{hero.name}</b>
                <small>{RARITY_LABEL[hero.rarity]} · Power {formatNum(entry.powerBefore)} → {formatNum(entry.powerAfter)} (+{formatNum(entry.powerAfter - entry.powerBefore)})</small>
                <span className="promo-row-stars" aria-label={`${entry.from} to ${entry.to} stars`}>
                  <span className="promo-star-old">{entry.from}★</span>
                  <span className="promo-arrow" aria-hidden="true">→</span>
                  <span className="promo-star-new">{entry.to}★</span>
                </span>
              </span>
              <span className="promo-row-gain">+{entry.to - entry.from}<Star size={13} fill="currentColor" aria-hidden="true" /></span>
            </li>;
          })}
        </ol>
        <footer className="promo-ceremony-foot">
          <span>Gold spent: {formatNum(goldSpent)}</span>
          <span>{formatNum(freed)} hero slots freed</span>
        </footer>
        <button type="button" autoFocus onClick={onClose} className="seeker-promote-all promo-ceremony-continue">Continue</button>
      </section>
    </div>,
    document.body,
  );
}
