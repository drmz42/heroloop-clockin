import { AsyncActionButton } from '@/components/AsyncActionButton';
import { createPortal } from 'react-dom';
import { isolatedHackathon } from '@/game/editionStorage';
import { isAndroidLayout } from '@/platform/platform';
import { useMemo, useState, type CSSProperties } from 'react';
import { Axe, ChevronDown, Clock3, Crosshair, Dumbbell, Info, LockKeyhole, Shield, ShieldCheck, Sparkles, Swords, Target, UserRoundPlus, X } from 'lucide-react';
import { GameSelect } from '@/components/GameSelect';
import { HeroPortrait } from '@/components/HeroPortrait';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { skrPrice, useSkrRate } from '@/game/skrPurchase';
import { CLASS_LABEL, HERO_MAP, RARITY_COLORS, RARITY_INDEX } from '@/game/heroes';
import { buildLocation, latestTokenLocation, teamPower } from '@/game/engine';
import { heroXpForLevel, trainingTokenPenalty, TRAINING_BOOST_COSTS, TRAINING_SLOT_COSTS } from '@/game/state';
import type { HeroClass, TrainingBoostKey } from '@/game/types';
import type { useGame } from '@/game/useGame';
import { groupNumber } from '@/game/numberFormat';
import '@/theme/scene/scene.css';
import { RarityFx } from '@/components/RarityFx';

type Game = ReturnType<typeof useGame>;
type SortKey = 'stars' | 'level' | 'power' | 'rarity' | 'class';

const CLASS_DRILLS: Record<HeroClass, { label: string; Icon: typeof Swords }> = {
  knight: { label: 'Combat Dummy', Icon: Swords },
  archer: { label: 'Target Range', Icon: Crosshair },
  assassin: { label: 'Reflex Posts', Icon: Axe },
  shepherd: { label: 'Guard Drill', Icon: Shield },
  druid: { label: 'Focus Totem', Icon: Sparkles },
};

const SORTS: Array<{ id: SortKey; label: string }> = [
  { id: 'stars', label: 'Stars' }, { id: 'level', label: 'Level' }, { id: 'power', label: 'Power' },
  { id: 'rarity', label: 'Rarity' }, { id: 'class', label: 'Class' },
];
const TRAINING_BOOSTS = [
  { key: '2x-1h', multiplier: 2, hours: 1 },
  { key: '2x-4h', multiplier: 2, hours: 4 },
  { key: '4x-1h', multiplier: 4, hours: 1 },
  { key: '4x-4h', multiplier: 4, hours: 4 },
] as const satisfies ReadonlyArray<{ key: TrainingBoostKey; multiplier: 2 | 4; hours: 1 | 4 }>;

// Seeker prices: the HERO costs at the server's $0.001 HERO quote (50 HERO = 5 cents).
const usdCents = (heroCost: number) => heroCost / 10;
const usdLabel = (cents: number) => `$${(cents / 100).toFixed(cents % 1 ? 3 : 2)}`;
type SkrTrainingOffer = { product: 'training_slot_unlock' | 'training_boost_buy'; params: Record<string, unknown>; title: string; cents: number };

function formatBoostTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

export function TrainingCampScreen({ game }: { game: Game }) {
  const { state } = game;
  const now = game.presentationNow;
  const [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const [sort, setSort] = useState<SortKey>('power');
  const [classFilter, setClassFilter] = useState<'all' | HeroClass>('all');
  const [skrOffer, setSkrOffer] = useState<SkrTrainingOffer | null>(null);
  const skrRate = useSkrRate(isolatedHackathon);
  const skrLabel = (cents: number) => `${usdLabel(cents)} · ${skrRate ? skrPrice(cents, skrRate) : '… SKR'}`;
  const locationId = latestTokenLocation(state.accountLevel, state.highestLocation, state.seekerProgression?.legacyLocationAccess);
  const baseXpPerHour = Math.floor(buildLocation(locationId, 1).xpReward * 300 * 1.6 * .85);
  const trainingHeroCount = state.trainingCamp.heroUids.filter(Boolean).length;
  const currentPenalty = Math.round(trainingTokenPenalty(trainingHeroCount) * 100);
  const firstEmpty = state.trainingCamp.heroUids.findIndex((uid, index) => index < state.trainingCamp.unlockedSlots && !uid);
  const assignmentSlot = selectedSlot !== null && selectedSlot < state.trainingCamp.unlockedSlots && !state.trainingCamp.heroUids[selectedSlot] ? selectedSlot : firstEmpty;
  const activeBoost = state.trainingCamp.boostMultiplier > 1 && state.trainingCamp.boostEndsAt > now;
  const boostTime = formatBoostTime(state.trainingCamp.boostEndsAt - now);
  const xpPerHour = baseXpPerHour * (activeBoost ? state.trainingCamp.boostMultiplier : 1);

  const sortedHeroes = useMemo(() => state.ownedHeroes
    .filter((hero) => classFilter === 'all' || HERO_MAP[hero.heroId]?.heroClass === classFilter)
    .sort((a, b) => {
      const aBase = HERO_MAP[a.heroId]; const bBase = HERO_MAP[b.heroId];
      if (!aBase || !bBase) return 0;
      if (sort === 'stars') return b.stars - a.stars || b.level - a.level;
      if (sort === 'level') return b.level - a.level || b.stars - a.stars;
      if (sort === 'power') return teamPower([b], state.inventory) - teamPower([a], state.inventory);
      if (sort === 'rarity') return RARITY_INDEX[bBase.rarity] - RARITY_INDEX[aBase.rarity];
      return CLASS_LABEL[aBase.heroClass].localeCompare(CLASS_LABEL[bBase.heroClass]) || teamPower([b], state.inventory) - teamPower([a], state.inventory);
    }), [state.ownedHeroes, state.inventory, classFilter, sort]);

  const still = state.battleAnimationMode === 'off';
  return (
    <div className={`sc-root tc-root training-camp-screen${still ? ' sc-still' : ''}`}>
      <section className="sc-stage tc-camp" aria-label="Ironkeep War Camp">
        <div className="sc-stage-art" aria-hidden="true" />
        <div className="sc-glow" aria-hidden="true" />
        {!still && <div className="sc-embers" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>}
        <header className="sc-head"><span className="sc-kicker">Training Grounds</span><h2 className="sc-title">Ironkeep War Camp</h2><p className="sc-lede">Prepare reserve heroes at 160% solo XP from Location {locationId}.</p></header>
        <div className={`tc-plaques${activeBoost ? ' is-boosted' : ''}`}>
          <span className="tc-plaque"><Swords size={16} /><strong>{groupNumber(xpPerHour)} XP/h</strong><small>{activeBoost ? `${baseXpPerHour.toLocaleString()} base × ${state.trainingCamp.boostMultiplier}` : 'Current training speed'}</small></span>
          <span className="tc-plaque"><ShieldCheck size={16} /><strong>{trainingHeroCount}/{state.trainingCamp.unlockedSlots} training</strong><small>{state.trainingCamp.unlockedSlots - trainingHeroCount} posts available</small></span>
          <span className="tc-plaque"><Clock3 size={16} /><strong>{activeBoost ? `${state.trainingCamp.boostMultiplier}× ACTIVE` : 'Normal speed'}</strong><small className="tabular-nums">{activeBoost ? `${boostTime} remaining` : 'No active boost'}</small></span>
        </div>
      </section>

      <div className="sc-body">
      <aside className="tc-orders">
        <p><Info size={14} /><span><b>Camp orders.</b> Training continues offline, stops at Account Level and gives no Gold, loot, chests or $HERO. Speed boosts multiply training XP.</span></p>
        {!isolatedHackathon && <div className="hl-hero-only"><div className="flex items-center justify-between gap-2"><strong className="text-xs uppercase tracking-[.14em] text-[#f2d48a]">$HERO mining penalty</strong><span className="text-xs font-black text-rose-300">Current −{currentPenalty}%</span></div><div className="mt-2 grid grid-cols-5 gap-1.5">{[10, 25, 50, 75, 90].map((value, index) => { const count = index + 1; const active = trainingHeroCount === count || (count === 5 && trainingHeroCount >= 5); return <div key={count} className={`training-penalty-step ${active ? 'training-penalty-active' : ''}`}><span>{count === 5 ? '5+' : count} hero{count > 1 ? 'es' : ''}</span><strong>−{value}%</strong></div>; })}</div><p className="mt-2 text-[10px] text-[#928673]">Only token mining is reduced. Battle rewards and quests stay unchanged.</p></div>}
      </aside>

      <div className="tc-main">
      <section className="sc-panel tc-posts-panel">
        <div className="sc-section-head"><span>Training posts</span><span className="tc-live"><Target size={13} /> Live drills</span></div>
        <p className="sc-muted tc-note">Choose an empty post, then assign a reserve hero below.</p>
        <div className="tc-posts">
          {state.trainingCamp.heroUids.map((uid, index) => {
            const hero = uid ? state.ownedHeroes.find((owned) => owned.uid === uid) : null;
            const base = hero ? HERO_MAP[hero.heroId] : null;
            const unlocked = index < state.trainingCamp.unlockedSlots;
            const isNextLocked = index === state.trainingCamp.unlockedSlots;
            // Android shows two even rows of four (Founder 2026-10-03); posts 9-10 appear only once unlocked.
            if (isAndroidLayout && index >= 8 && !unlocked && !uid) return null;
            const drill = base ? CLASS_DRILLS[base.heroClass] : null;
            const DrillIcon = drill?.Icon ?? Target;
            const selected = selectedSlot === index;
            return (
              <article key={index} className={`tc-post ${unlocked ? 'is-open' : 'is-locked'}${selected ? ' is-selected' : ''}${hero ? ' is-busy' : ''}`} style={base ? { '--tc-color': RARITY_COLORS[base.rarity] } as CSSProperties : undefined}>
                <span className="tc-post-num">Post {index + 1}</span>
                {hero && base ? <>
                  <span className="tc-drill"><DrillIcon size={11} />{drill?.label}</span>
                  <span className="tc-post-hero"><HeroPortrait heroClass={base.heroClass} heroId={base.id} rarity={base.rarity} color={base.color} size={54} badge={hero.level} className="training-hero-portrait" /></span>
                  <strong className="tc-post-name">{base.name}</strong>
                  <span className="tc-xp"><i style={{ width: `${hero.level >= state.accountLevel ? 100 : Math.min(100, hero.xp / heroXpForLevel(hero.level) * 100)}%` }} /></span>
                  <span className="tc-post-meta"><span>{hero.level >= state.accountLevel ? 'LEVEL CAPPED' : 'TRAINING'}</span><span>{teamPower([hero], state.inventory)} PWR</span></span>
                  <AsyncActionButton type="button" pendingLabel="…" className="tc-remove" onClick={() => game.setTrainingHero(index, null)} aria-label={`Remove ${base.name}`}><X size={11} /></AsyncActionButton>
                </> : unlocked ? <button type="button" onClick={() => setSelectedSlot(index)} className="tc-empty"><span className="training-dummy"><span className="training-dummy-head" /><span className="training-dummy-body" /><span className="training-dummy-arms" /></span><UserRoundPlus size={15} /><strong>{selected ? 'SELECT HERO BELOW' : 'ASSIGN HERO'}</strong><small>Combat dummy ready</small></button> : <div className="tc-locked"><LockKeyhole size={20} /><span>{isNextLocked ? 'NEXT POST' : 'LOCKED'}</span>{isNextLocked && (isolatedHackathon
                  ? <button type="button" onClick={() => setSkrOffer({ product: 'training_slot_unlock', params: { unlocked_slots: index }, title: `Unlock Post ${index + 1}`, cents: usdCents(TRAINING_SLOT_COSTS[index]) })} className="sc-seal tc-unlock">Unlock {usdLabel(usdCents(TRAINING_SLOT_COSTS[index]))}</button>
                  : <button type="button" onClick={() => game.unlockTrainingSlot()} className="sc-seal tc-unlock"><HeroTokenIcon size={11} /> Unlock {TRAINING_SLOT_COSTS[index]}</button>)}</div>}
              </article>
            );
          })}
        </div>
      </section>

      <section className="sc-panel tc-boosts">
        <div className="sc-section-head"><span>Drill intensity</span><Dumbbell size={15} /></div>
        <p className="sc-muted tc-note">Speed boost</p>
        <div className="tc-boost-grid">{TRAINING_BOOSTS.map(({ key, multiplier, hours }) => {
          const cost = TRAINING_BOOST_COSTS[key];
          const isActive = activeBoost && state.trainingCamp.activeBoostKey === key;
          const queuedCount = state.trainingCamp.boostQueue.filter((entry) => entry.key === key).length;
          return <button key={key} type="button" aria-pressed={isActive} onClick={() => isolatedHackathon
            ? setSkrOffer({ product: 'training_boost_buy', params: { boost: key }, title: `${multiplier * 100}% speed · ${hours}h`, cents: usdCents(cost) })
            : game.buyTrainingBoost(multiplier, hours)} className="sc-plate tc-boost"><span className="tc-boost-main"><strong>{multiplier * 100}%</strong><small>{hours}h</small><em>{isolatedHackathon ? usdLabel(usdCents(cost)) : <><HeroTokenIcon size={9} /> {cost}</>}</em></span>{isActive && <span className="tc-boost-status">ACTIVE <time>{boostTime}</time></span>}{queuedCount > 0 && <span className="tc-boost-status">QUEUED ×{queuedCount}</span>}</button>;
        })}</div>
        {/* The offer opens as a dialog over the screen: inline under the boosts it rendered below the
            fold on phones, so tapping a post's Unlock looked like nothing happened. */}
        {isolatedHackathon && skrOffer && createPortal(<div className="hl-portal training-skr-overlay fixed inset-0 z-[9999] grid place-items-center bg-black/75 p-3 backdrop-blur-[4px]" onMouseDown={(event) => { if (event.currentTarget === event.target) setSkrOffer(null); }}>
          <section className="px-panel-raised w-full max-w-sm rounded-lg border border-[#8c6231] p-4" role="dialog" aria-modal="true" aria-label="SKR training purchase">
            <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="section-kicker">Training camp</div><strong className="mt-1 block text-base text-[#f2d48a]">{skrOffer.title}</strong><span className="text-xs text-[#b8ad99]">≈ {skrLabel(skrOffer.cents)}</span></div><button type="button" className="game-control grid h-9 w-9 shrink-0 place-items-center" onClick={() => setSkrOffer(null)} aria-label="Close SKR purchase" autoFocus><X size={14} /></button></div>
            <SkrPurchaseButton product={skrOffer.product} params={skrOffer.params} label="Quote in SKR" onDelivered={(result) => { game.applySeekerPurchase(result); setSkrOffer(null); }} />
          </section>
        </div>, document.body)}
      </section>
      </div>

      <section className="sc-panel tc-roster">
        <div className="sc-section-head"><span>Reserve roster</span></div>
        <p className="sc-muted tc-note">{assignmentSlot >= 0 ? `Click an available hero to send them to Post ${assignmentSlot + 1}.` : 'Unlock or clear a post, then click an available hero to begin training.'}</p>
        <div className="tc-filters"><GameSelect ariaLabel="Class" value={classFilter} onChange={setClassFilter} options={[{ value: 'all' as const, label: 'All Classes' }, ...(Object.keys(CLASS_LABEL) as HeroClass[]).map((heroClass) => ({ value: heroClass, label: CLASS_LABEL[heroClass] }))]} className="sc-chip tc-class"><span>{classFilter === 'all' ? 'All Classes' : CLASS_LABEL[classFilter]}</span><ChevronDown size={12} /></GameSelect>{SORTS.map((option) => <button type="button" key={option.id} aria-pressed={sort === option.id} onClick={() => setSort(option.id)} className="sc-chip tc-sort">{option.label}</button>)}</div>
        <ul className="hv-grid tc-roster-grid">{sortedHeroes.map((hero) => { const base = HERO_MAP[hero.heroId]; if (!base) return null; const inTeam = state.team.includes(hero.uid); const training = state.trainingCamp.heroUids.includes(hero.uid); const capped = hero.level >= state.accountLevel; const disabled = inTeam || training || capped || assignmentSlot < 0; const assign = () => game.setTrainingHero(assignmentSlot, hero.uid).then((accepted) => { if (accepted) setSelectedSlot(null); }); return <li key={hero.uid}><AsyncActionButton type="button" disabled={disabled} onClick={assign} className={`hv-card tc-card${RARITY_INDEX[base.rarity] >= RARITY_INDEX.rare ? ' is-rare' : ''}${disabled ? ' is-off' : ''}`} style={{ '--hv-color': RARITY_COLORS[base.rarity] } as CSSProperties}><span className="hv-card-art"><img src={heroPortraitSrc(base.id, base.heroClass, base.rarity, base.color)} alt="" loading="lazy" decoding="async" style={{ ...heroPortraitStyle(base.id, base.heroClass), transform: 'none' }} /><RarityFx rarity={base.rarity} shape="tcg" label={CLASS_LABEL[base.heroClass]} /><span className="hv-card-lv">Lv {hero.level}</span>{(inTeam || training || capped) && <span className="tc-card-state">{inTeam ? 'IN FORMATION' : training ? 'TRAINING' : 'LEVEL CAPPED'}</span>}</span><span className="hv-card-info"><span className="hv-card-name">{base.name}</span><span className="hv-card-row"><span>{teamPower([hero], state.inventory)} PWR</span><span>{hero.stars}★</span></span><span className="tc-card-class">{CLASS_LABEL[base.heroClass]}</span></span></AsyncActionButton></li>; })}</ul>
      </section>
      </div>
    </div>
  );
}
