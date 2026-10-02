import { isolatedHackathon } from '@/game/editionStorage';
import { useMemo, useState } from 'react';
import { Axe, ChevronDown, Clock3, Crosshair, Dumbbell, Info, LockKeyhole, Shield, ShieldCheck, Sparkles, Swords, Target, UserRoundPlus, X } from 'lucide-react';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { CLASS_LABEL, HERO_MAP, RARITY_COLORS, RARITY_INDEX } from '@/game/heroes';
import { buildLocation, latestTokenLocation, teamPower } from '@/game/engine';
import { heroXpForLevel, trainingTokenPenalty, TRAINING_BOOST_COSTS, TRAINING_SLOT_COSTS } from '@/game/state';
import type { HeroClass, TrainingBoostKey } from '@/game/types';
import type { useGame } from '@/game/useGame';
import { groupNumber } from '@/game/numberFormat';

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
  const locationId = latestTokenLocation(state.accountLevel, state.highestLocation);
  const baseXpPerHour = Math.floor(buildLocation(locationId, 1).xpReward * 300 * 1.6);
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

  return (
    <div className="training-camp-screen min-h-full p-4 text-[#ddd4c2] sm:p-5">
      <header className="relative z-10 flex flex-wrap items-end justify-between gap-3">
        <div><div className="section-kicker">Training Grounds</div><h2 className="font-vt text-3xl font-black text-[#f5d88b]">Ironkeep War Camp</h2><p className="mt-1 text-xs text-[#aaa08c]">Prepare reserve heroes at 160% solo XP from Location {locationId}.</p></div>
        <div className={`training-status-row ${activeBoost ? 'training-status-boosted' : ''}`}>
          <span className="training-status-metric"><Swords size={19} /><span><strong>{groupNumber(xpPerHour)} XP/h</strong><small>{activeBoost ? `${baseXpPerHour.toLocaleString()} base × ${state.trainingCamp.boostMultiplier}` : 'Current training speed'}</small></span></span>
          <span className="training-status-metric"><ShieldCheck size={19} /><span><strong>{trainingHeroCount}/{state.trainingCamp.unlockedSlots} training</strong><small>{state.trainingCamp.unlockedSlots - trainingHeroCount} posts available</small></span></span>
          <span className="training-status-metric"><Clock3 size={19} /><span><strong>{activeBoost ? `${state.trainingCamp.boostMultiplier}× ACTIVE` : 'Normal speed'}</strong><small className="tabular-nums">{activeBoost ? `${boostTime} remaining` : 'No active boost'}</small></span></span>
        </div>
      </header>

      <aside className="training-guide relative z-10 mt-4 grid gap-3 p-3 lg:grid-cols-[minmax(260px,1fr)_minmax(420px,1.5fr)]">
        <div className="flex gap-3"><Info size={19} className="mt-0.5 shrink-0 text-amber-300" /><div><strong className="block text-xs uppercase tracking-[.14em] text-[#f2d48a]">Camp orders</strong><p className="mt-1 text-[11px] leading-5 text-[#b8ad99]">Training continues offline, stops at Account Level and gives no Gold, loot, chests or $HERO. Speed boosts multiply training XP.</p></div></div>
        {!isolatedHackathon && <div className="hl-hero-only"><div className="flex items-center justify-between gap-2"><strong className="text-xs uppercase tracking-[.14em] text-[#f2d48a]">$HERO mining penalty</strong><span className="text-xs font-black text-rose-300">Current −{currentPenalty}%</span></div><div className="mt-2 grid grid-cols-5 gap-1.5">{[10, 25, 50, 75, 90].map((value, index) => { const count = index + 1; const active = trainingHeroCount === count || (count === 5 && trainingHeroCount >= 5); return <div key={count} className={`training-penalty-step ${active ? 'training-penalty-active' : ''}`}><span>{count === 5 ? '5+' : count} hero{count > 1 ? 'es' : ''}</span><strong>−{value}%</strong></div>; })}</div><p className="mt-2 text-[10px] text-[#928673]">Only token mining is reduced. Battle rewards and quests stay unchanged.</p></div>}
      </aside>

      <div className="training-main-grid relative z-10 mt-4">
      <section className="training-yard p-3">
        <div className="mb-3 flex items-center justify-between gap-3"><div><div className="section-kicker">Training posts</div><p className="mt-1 text-[10px] text-[#8f846f]">Choose an empty post, then assign a reserve hero below.</p></div><div className="flex items-center gap-2 text-[10px] font-bold text-[#9e927d]"><Target size={15} className="text-amber-400" /> Live drills</div></div>
        <div className="training-post-grid grid grid-cols-2 gap-2.5 sm:grid-cols-5">
          {state.trainingCamp.heroUids.map((uid, index) => {
            const hero = uid ? state.ownedHeroes.find((owned) => owned.uid === uid) : null;
            const base = hero ? HERO_MAP[hero.heroId] : null;
            const unlocked = index < state.trainingCamp.unlockedSlots;
            const isNextLocked = index === state.trainingCamp.unlockedSlots;
            const drill = base ? CLASS_DRILLS[base.heroClass] : null;
            const DrillIcon = drill?.Icon ?? Target;
            const selected = selectedSlot === index;
            return (
              <article key={index} className={`training-post ${unlocked ? 'training-post-open' : 'training-post-locked'} ${selected ? 'training-post-selected' : ''}`}>
                <div className="training-post-head"><span>POST {String(index + 1).padStart(2, '0')}</span><span>{unlocked ? 'READY' : 'LOCKED'}</span></div>
                {hero && base ? <>
                  <div className="training-apparatus"><DrillIcon size={24} /><span>{drill?.label}</span></div>
                  <div className="training-hero-stage"><HeroPortrait heroClass={base.heroClass} heroId={base.id} rarity={base.rarity} color={base.color} size={46} badge={hero.level} className="training-hero-portrait" /><span className="training-spark training-spark-a" /><span className="training-spark training-spark-b" /><span className="training-spark training-spark-c" /></div>
                  <div className="mt-1 flex items-center justify-between gap-1"><strong className="min-w-0 truncate text-[10px]" style={{ color: RARITY_COLORS[base.rarity] }}>{base.name}</strong><button type="button" className="training-icon-button" onClick={() => { void game.setTrainingHero(index, null); }} aria-label={`Remove ${base.name}`}><X size={11} /></button></div>
                  <div className="training-xp-track"><span style={{ width: `${hero.level >= state.accountLevel ? 100 : Math.min(100, hero.xp / heroXpForLevel(hero.level) * 100)}%` }} /></div>
                  <div className="mt-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 text-[8px] font-bold text-[#8e836f]"><span className="min-w-0 truncate">{hero.level >= state.accountLevel ? 'LEVEL CAPPED' : 'TRAINING'}</span><span className="whitespace-nowrap text-right">{teamPower([hero], state.inventory)} PWR</span></div>
                </> : unlocked ? <button type="button" onClick={() => setSelectedSlot(index)} className="training-empty-post"><span className="training-dummy"><span className="training-dummy-head" /><span className="training-dummy-body" /><span className="training-dummy-arms" /></span><UserRoundPlus size={17} /><strong>{selected ? 'SELECT HERO BELOW' : 'ASSIGN HERO'}</strong><small>Combat dummy ready</small></button> : <div className="training-locked-post"><LockKeyhole size={25} /><span>{isNextLocked ? 'NEXT POST' : 'LOCKED'}</span>{isNextLocked && <button type="button" onClick={() => game.unlockTrainingSlot()} className="game-control training-unlock-button"><HeroTokenIcon size={11} /> Unlock {TRAINING_SLOT_COSTS[index]}</button>}</div>}
              </article>
            );
          })}
        </div>
      </section>

      <section className="training-section training-boost-panel p-3">
        <div className="mb-2 flex items-center justify-between"><div><div className="section-kicker">Drill intensity</div><p className="mt-1 text-[10px] text-[#8f846f]">Speed boost</p></div><Dumbbell size={17} className="text-[#c99b4d]" /></div>
        <div className="grid gap-1.5">{TRAINING_BOOSTS.map(({ key, multiplier, hours }) => {
          const cost = TRAINING_BOOST_COSTS[key];
          const isActive = activeBoost && state.trainingCamp.activeBoostKey === key;
          const queuedCount = state.trainingCamp.boostQueue.filter((entry) => entry.key === key).length;
          return <button key={key} type="button" onClick={() => game.buyTrainingBoost(multiplier, hours)} className={`training-boost-button ${isActive ? 'training-boost-active' : ''}`}><span className="training-boost-main"><Dumbbell size={14} /><span><strong>{multiplier * 100}%</strong><small>{hours}h</small></span><em><HeroTokenIcon size={9} /> {cost}</em></span>{isActive && <span className="training-boost-status"><strong>ACTIVE</strong><time>{boostTime}</time></span>}{queuedCount > 0 && <span className="training-boost-queued">QUEUED ×{queuedCount}</span>}</button>;
        })}</div>
      </section>
      </div>

      <section className="training-section relative z-10 mt-4 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3"><div><div className="section-kicker">Reserve roster</div><p className="mt-1 text-[10px] text-[#8f846f]">{assignmentSlot >= 0 ? `Click an available hero to send them to Post ${assignmentSlot + 1}.` : 'Unlock or clear a post, then click an available hero to begin training.'}</p></div><div className="training-filter-bar flex flex-wrap gap-1.5"><label className="training-select"><ChevronDown size={12} /><select value={classFilter} onChange={(event) => setClassFilter(event.target.value as 'all' | HeroClass)}><option value="all">All Classes</option>{(Object.keys(CLASS_LABEL) as HeroClass[]).map((heroClass) => <option key={heroClass} value={heroClass}>{CLASS_LABEL[heroClass]}</option>)}</select></label>{SORTS.map((option) => <button type="button" key={option.id} onClick={() => setSort(option.id)} className={`training-sort-button ${sort === option.id ? 'training-sort-active' : ''}`}>{option.label}</button>)}</div></div>
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">{sortedHeroes.map((hero) => { const base = HERO_MAP[hero.heroId]; if (!base) return null; const inTeam = state.team.includes(hero.uid); const training = state.trainingCamp.heroUids.includes(hero.uid); const capped = hero.level >= state.accountLevel; const disabled = inTeam || training || capped || assignmentSlot < 0; const assign = () => { void game.setTrainingHero(assignmentSlot, hero.uid).then((accepted) => { if (accepted) setSelectedSlot(null); }); }; return <button type="button" disabled={disabled} key={hero.uid} onClick={assign} className={`training-roster-card ${disabled ? 'opacity-45' : ''}`}><span className="training-roster-portrait"><HeroPortrait heroClass={base.heroClass} heroId={base.id} rarity={base.rarity} color={base.color} size={80} badge={hero.level} className="pointer-events-none mx-auto" />{inTeam && <span className="training-in-formation-badge">IN FORMATION</span>}</span><strong style={{ color: RARITY_COLORS[base.rarity] }}>{base.name}</strong><span>{hero.stars}★ · {teamPower([hero], state.inventory)} PWR</span><small>{inTeam ? 'IN FORMATION' : training ? 'TRAINING' : capped ? 'LEVEL CAPPED' : CLASS_LABEL[base.heroClass]}</small></button>; })}</div>
      </section>
    </div>
  );
}
