import { isolatedHackathon } from '@/game/editionStorage';
import { SeekerPromoteAll } from '@/components/SeekerPromoteAll';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { SkrUsd } from '@/components/SkrUsd';
import { skrPrice, useSkrRate } from '@/game/skrPurchase';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Star, Lock, Unlock, Trash2, Search, X, Sparkles, Users, Swords, Shield, AlertTriangle, UserPlus, Gem, ChevronsUp, Zap } from 'lucide-react';
import { GameSelect } from '@/components/GameSelect';
import { heroPortraitSrc, heroThumbSrc, heroPortraitStyle } from '@/game/portraits';
import '@/theme/scene/scene.css';
import { RarityFx } from '@/components/RarityFx';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, RARITY_INDEX, CLASS_LABEL } from '@/game/heroes';
import { formatNum, starUpCost, heroXpForLevel, heroCapacityUpgradeCost, MAX_HERO_CAPACITY, MAX_HERO_STARS } from '@/game/state';
import { heroStats, getEquippedItems, teamPower as calculateTeamPower } from '@/game/engine';
import { COMBAT_EFFECTS_V2_PREVIEW, COMBAT_EFFECTS_V2_PRODUCTION_ACTIVE } from '@/game/combat-effects-v2-ui.mjs';
import type { HeroBase, OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';
import { isAndroidLayout } from '@/platform/platform';
import { formatUtcTime } from '@/game/numberFormat';

const FILTER_RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];
const INACTIVE_COMBAT_LABEL = 'Coming soon — not active in combat';
const CLASS_TRAITS: Record<HeroBase['heroClass'], { effect: string; active: boolean }> = {
  knight: { effect: '+15% max HP in server-settled normal combat', active: true },
  assassin: { effect: '+5 percentage points Dodge in server-settled normal combat', active: true },
  druid: { effect: '+10% max HP and restores 1.2% max HP every 3 seconds in server-settled normal combat', active: true },
  shepherd: { effect: '+10% damage in server-settled normal combat', active: true },
  archer: { effect: '+8% attack speed in server-settled normal combat', active: true },
};

const STAR_COLORS = ['#fbbf24', '#a855f7', '#ef4444', '#ec4899'];
const RELEASE_ERROR_MESSAGES: Record<string, string> = {
  state_unavailable: 'Release is unavailable right now. Try again shortly.',
  state_conflict: 'Your save changed while releasing. Review the hero and try again.',
  hero_not_found: 'That hero no longer exists in your roster.',
  last_hero: 'You cannot release your last owned hero.',
  hero_locked: 'Unlock this hero before releasing it.',
  hero_in_team: 'Remove this hero from the active team before releasing it.',
  hero_in_training: 'Remove this hero from Training Camp before releasing it.',
  hero_has_equipment: 'Unequip this hero before releasing it.',
  hero_in_market: 'Cancel this hero\'s Marketplace listing before releasing it.',
  hero_in_active_encounter: 'Complete or abandon the active encounter before releasing this hero.',
};
const RELEASE_FALLBACK_MESSAGE = 'Release could not be completed. Your hero is unchanged.';
const formatUsdCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;
// Hackathon prices read in SKR at the live rate; the exact amount is quoted before payment.
const skrCost = (cents: number, rate: string | null) => rate ? skrPrice(cents, rate) : '… SKR';
function HeroStars({ stars, size }: { stars: number; size: number }) {
  const clamped = Math.max(0, Math.min(MAX_HERO_STARS, stars));
  const tier = clamped === 0 ? 0 : Math.floor((clamped - 1) / 5);
  const currentCount = clamped === 0 ? 0 : ((clamped - 1) % 5) + 1;
  return <span className="flex gap-px" aria-label={`${clamped} of ${MAX_HERO_STARS} hero stars`}>{Array.from({ length: 5 }, (_, index) => {
    const slotTier = index < currentCount ? tier : tier - 1;
    const color = slotTier >= 0 ? STAR_COLORS[slotTier] : undefined;
    return <Star key={index} size={size} style={color ? { color, fill: color } : undefined} className={color ? '' : 'text-[#4f4b43]'} />;
  })}</span>;
}

function HeroGridCard({ base, hero, game, onSelect }: { base: HeroBase; hero: OwnedHero; game: GameApi; onSelect: () => void }) {
  const rc = RARITY_COLORS[base.rarity];
  const isInTeam = game.state.team.includes(hero.uid);
  const isTraining = game.state.trainingCamp.heroUids.includes(hero.uid);
  const respawn = game.respawnCountdowns[hero.uid] ?? 0;
  const dupes = game.state.ownedHeroes.filter((candidate) => candidate.heroId === hero.heroId && candidate.uid !== hero.uid && candidate.stars === 0 && !candidate.locked && !game.state.team.includes(candidate.uid) && !game.state.trainingCamp.heroUids.includes(candidate.uid)).length;
  const starCost = starUpCost(hero.stars, base.rarity);
  const upgradeable = hero.stars < MAX_HERO_STARS && dupes >= starCost.dupes && (isolatedHackathon || game.state.hero >= starCost.hero);
  const stats = heroStats(hero, getEquippedItems(hero, game.state.inventory));
  const power = stats ? Math.round(stats.atk + stats.hp / 10 + stats.def * 2) : 0;
  return (
    <li>
      <button type="button" onClick={onSelect} aria-label={`${base.name}, ${RARITY_LABEL[base.rarity]}, level ${hero.level}${isTraining ? ", unavailable: Training Camp" : ""}`} className={`hv-card${RARITY_INDEX[base.rarity] >= RARITY_INDEX.rare ? ' is-rare' : ''}${isInTeam ? ' is-team' : ''}`} style={{ '--hv-color': rc } as React.CSSProperties}>
        <span className="hv-card-art">
          <img src={heroThumbSrc(base.id, base.heroClass, base.rarity, base.color)} alt="" loading="lazy" decoding="async" style={{ ...heroPortraitStyle(base.id, base.heroClass), transform: 'none' }} />
          <RarityFx rarity={base.rarity} shape="tcg" label={CLASS_LABEL[base.heroClass]} />
          <span className="hv-card-lv">Lv {hero.level}</span>
          {respawn > 0 && <span className="hv-card-dead">Fallen<br />{respawn}s</span>}
          <span className="hv-card-status">
            {isTraining && <StateBadge label="Unavailable" tone="red" />}
            {isInTeam && <StateBadge label="Selected" tone="green" />}
          </span>
          <span className="hv-card-badges">
            {hero.isNew && <StateBadge label="New" tone="gold" />}
            {upgradeable && <StateBadge label="Upgrade" tone="purple" />}
          </span>
          {hero.locked && <Lock size={12} className="hv-card-lock" />}
        </span>
        <span className="hv-card-info">
          <span className="hv-card-name">{base.name}</span>
          <span className="hv-card-row"><span>{formatNum(power)} PWR</span><HeroStars stars={hero.stars} size={7} /></span>
          {hero.stars < MAX_HERO_STARS && dupes > 0 && <span className="hv-card-copies">{dupes}/{starCost.dupes} copies{!isolatedHackathon && <> · {formatNum(starCost.hero)} $HERO</>}</span>}
        </span>
      </button>
    </li>
  );
}

function StateBadge({ label, tone }: { label: string; tone: 'gold' | 'green' | 'purple' | 'red' }) {
  return <span className={`hv-badge hv-badge--${tone}`}>{label}</span>;
}

function HeroDetailModal({ hero, game, onClose }: { hero: OwnedHero; game: GameApi; onClose: () => void }) {
  const [teamError, setTeamError] = useState('');
  const [powerNotice, setPowerNotice] = useState<{ delta: number; added: boolean } | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [releaseError, setReleaseError] = useState('');
  const releaseDialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!powerNotice) return undefined;
    const timeout = window.setTimeout(() => setPowerNotice(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [powerNotice]);
  useEffect(() => {
    if (!releaseOpen) return undefined;
    releaseDialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !releaseBusy) setReleaseOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [releaseOpen, releaseBusy]);
  const runRelease = useCallback(async () => {
    if (releaseBusy) return;
    setReleaseBusy(true);
    setReleaseError('');
    const result = await game.releaseHero(hero.uid);
    setReleaseBusy(false);
    if (result.ok) {
      onClose();
      return;
    }
    setReleaseError(RELEASE_ERROR_MESSAGES[result.error] ?? RELEASE_FALLBACK_MESSAGE);
  }, [releaseBusy, game, hero.uid, onClose]);
  const base = HERO_MAP[hero.heroId];
  const items = getEquippedItems(hero, game.state.inventory);
  const stats = heroStats(hero, items);
  if (!base || !stats) return null;
  const rc = RARITY_COLORS[base.rarity];
  const starCost = starUpCost(hero.stars, base.rarity);
  const dupes = game.state.ownedHeroes.filter((candidate) => candidate.heroId === hero.heroId && candidate.uid !== hero.uid && candidate.stars === 0 && !candidate.locked && !game.state.team.includes(candidate.uid) && !game.state.trainingCamp.heroUids.includes(candidate.uid));
  const xpNeed = heroXpForLevel(hero.level);
  const isInTeam = game.state.team.includes(hero.uid);
  const power = Math.round(stats.atk + stats.hp / 10 + stats.def * 2);
  const teamPowerDelta = calculateTeamPower([hero], game.state.inventory);
  const classTrait = CLASS_TRAITS[base.heroClass];
  const combatV2 = COMBAT_EFFECTS_V2_PREVIEW[base.heroClass];
  const releaseBlockers = [
    { active: game.state.ownedHeroes.length <= 1, label: 'This is your last owned hero' },
    { active: isInTeam, label: 'Remove from the active team first' },
    { active: game.state.trainingCamp.heroUids.includes(hero.uid), label: 'Remove from Training Camp first' },
    { active: Boolean(hero.locked), label: 'Unlock this hero first' },
    { active: items.length > 0, label: 'Unequip all items first' },
  ].filter((blocker) => blocker.active).map((blocker) => blocker.label);
  const releaseBlocked = releaseBlockers.length > 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-[2px] anim-fade" onClick={onClose}>
      {teamError && (
        <div role="alert" aria-live="assertive" data-team-error-banner className="fixed left-1/2 top-[max(0.75rem,env(safe-area-inset-top))] z-[55] flex w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 items-center gap-2 rounded-lg border border-red-400/60 bg-[#2a0d0d]/95 p-2 pl-3 text-xs font-bold leading-relaxed text-red-100 shadow-[0_12px_36px_rgba(0,0,0,.65)] backdrop-blur-sm" onClick={(event) => event.stopPropagation()}>
          <AlertTriangle size={18} className="shrink-0 text-red-300" aria-hidden="true" />
          <span className="min-w-0 flex-1">{teamError}</span>
          <button type="button" onClick={() => setTeamError('')} className="game-control grid h-11 w-11 shrink-0 place-items-center" aria-label="Dismiss team error"><X size={16} /></button>
        </div>
      )}
      <div className={`hero-detail-panel hv-detail rarity-${base.rarity} relative flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden`} style={{ '--hv-color': rc } as React.CSSProperties} onClick={(event) => event.stopPropagation()}>
        <header className="hv-detail-hero shrink-0">
          <img className="hv-detail-art" src={heroPortraitSrc(base.id, base.heroClass, base.rarity, base.color)} alt="" decoding="async" style={{ ...heroPortraitStyle(base.id, base.heroClass), transform: 'none' }} />
          <div className="hv-detail-copy">
            <span className="hv-detail-rarity">{RARITY_LABEL[base.rarity]} · {CLASS_LABEL[base.heroClass]}</span>
            <h3 className="hv-detail-name">{base.name}</h3>
            {game.state.trainingCamp.heroUids.includes(hero.uid) && <span className="hv-training-unavailable" role="status">Unavailable · Training Camp</span>}
            <div className="hv-detail-power"><b>{formatNum(power)}</b><span>Power</span></div>
            <div className="hv-detail-stars"><HeroStars stars={hero.stars} size={12} /><span>{hero.stars}/{MAX_HERO_STARS}</span></div>
            <div className="hv-detail-xp"><i style={{ width: `${Math.min(100, hero.xp / xpNeed * 100)}%` }} /></div>
            <div className="hv-detail-lv">Lv {hero.level} · {formatNum(hero.xp)}/{formatNum(xpNeed)} XP{isInTeam ? ' · In team' : ''}</div>
          </div>
          <button type="button" onClick={onClose} className="sc-socket hv-detail-close" aria-label="Close hero details"><X size={16} /></button>
        </header>
        <div className="hero-detail-content game-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="p-3">
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6"><StatBox label="HP" value={formatNum(stats.hp)} /><StatBox label="ATK" value={formatNum(stats.atk)} /><StatBox label="DEF" value={formatNum(stats.def)} /><StatBox label="Crit" value={`${(stats.critChance * 100).toFixed(1)}%`} /><StatBox label="Dodge" value={`${(stats.dodge * 100).toFixed(1)}%`} /><StatBox label="Speed" value={`+${stats.atkSpeed}`} /></div>
          <details className="hero-detail-more" open={!isAndroidLayout}><summary className="hero-detail-more-summary">Skills, traits &amp; combat details</summary>
          <section className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="stat-tile p-2.5"><div className="text-[9px] font-bold uppercase tracking-wider text-[#827d72]">Passive</div><div className="mt-0.5 text-xs font-bold" style={{ color: rc }}>{base.passiveName}</div><div className="mt-0.5 text-[10px] text-[#777268]">{base.passiveDesc}</div><div className="mt-1 text-[9px] font-bold text-amber-300">{INACTIVE_COMBAT_LABEL}</div></div>
            <div className="stat-tile p-2.5"><div className="text-[9px] font-bold uppercase tracking-wider text-[#827d72]">Ability</div><div className="mt-0.5 text-xs font-bold" style={{ color: rc }}>{base.skillName}</div><div className="mt-0.5 text-[10px] text-[#777268]">{base.skillDesc}</div><div className="mt-1 text-[9px] font-bold text-amber-300">{INACTIVE_COMBAT_LABEL}</div></div>
          </section>
          <section className="stat-tile mt-2 p-2.5"><div className="flex items-center justify-between gap-2"><div className="text-[9px] font-bold uppercase tracking-wider text-[#827d72]">Class Trait · {CLASS_LABEL[base.heroClass]}</div><span className={`rounded border px-1.5 py-0.5 text-[8px] font-black uppercase ${classTrait.active ? 'border-emerald-500/40 bg-emerald-950/35 text-emerald-300' : 'border-slate-600/50 bg-slate-950/30 text-slate-400'}`}>{classTrait.active ? 'Active · normal combat' : 'Unavailable'}</span></div><div className="mt-1 text-[10px] text-[#aaa397]">{classTrait.effect}</div></section>
          <section className="mt-2 rounded-lg border border-sky-700/35 bg-sky-950/15 p-2.5" aria-label={`${CLASS_LABEL[base.heroClass]} combat v2 preview`}>
            <div className="flex items-center justify-between gap-2"><div className="text-[9px] font-bold uppercase tracking-wider text-sky-200">Combat v2 preview</div><span className="rounded border border-amber-500/35 bg-amber-950/25 px-1.5 py-0.5 text-[8px] font-black uppercase text-amber-300">{COMBAT_EFFECTS_V2_PRODUCTION_ACTIVE ? 'Active' : 'Staging candidate · Production off'}</span></div>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <div><div className="text-[8px] font-black uppercase tracking-wide text-[#7fa8ba]">Core Trait</div><div className="mt-0.5 text-xs font-bold text-sky-100">{combatV2.core.name}</div><div className="mt-0.5 text-[10px] leading-relaxed text-[#9ba7aa]">{combatV2.core.description}</div></div>
              <div className="border-t border-sky-900/45 pt-2 sm:border-l sm:border-t-0 sm:pl-2 sm:pt-0"><div className="flex items-center justify-between gap-2"><div className="text-[8px] font-black uppercase tracking-wide text-[#7fa8ba]">Team Contribution</div><span className="text-[8px] font-bold uppercase text-sky-300">{combatV2.team.capability}</span></div><div className="mt-0.5 text-xs font-bold text-sky-100">{combatV2.team.name}</div><div className="mt-0.5 text-[10px] leading-relaxed text-[#9ba7aa]">{combatV2.team.description}</div></div>
            </div>
          </section>
          </details>
          {powerNotice && <div aria-live="polite" className={`anim-banner mt-2 rounded border p-2 text-center text-sm font-black tabular-nums ${powerNotice.added ? 'border-emerald-400/55 bg-emerald-950/55 text-emerald-300' : 'border-red-400/55 bg-red-950/55 text-red-300'}`}>{powerNotice.added ? '+' : '−'}{formatNum(powerNotice.delta)} POWER</div>}
        </div>
        <footer className="border-t border-[#54442e] bg-black/20 p-3">
          <div className="grid grid-cols-[minmax(0,1fr)_92px_minmax(0,1fr)] gap-2"><button type="button" onClick={async () => { const result = await game.toggleTeamMember(hero.uid); const succeeded = result === 'added' || result === 'removed'; setTeamError(result === 'inventory-full' ? 'Cannot remove hero: there is not enough room for equipped items. Free bag slots first.' : result === 'blocked' ? (game.state.trainingCamp.heroUids.includes(hero.uid) ? 'This hero is in Training Camp. Remove them from training first, then add them to your team.' : 'Team change is unavailable right now.') : ''); setPowerNotice(succeeded ? { delta: teamPowerDelta, added: result === 'added' } : null); }} aria-label={isInTeam ? 'Remove from Team' : 'Add to Team'} title={isInTeam ? 'Remove from Team' : 'Add to Team'} className={`game-control h-9 min-w-0 truncate px-2 text-[10px] font-black ${isInTeam ? 'game-danger' : 'game-primary'}`}>{isInTeam ? 'Remove' : 'Add to Team'}</button><button type="button" onClick={() => game.toggleHeroLock(hero.uid)} className="game-control flex h-9 items-center justify-center gap-1.5 px-2 text-[10px] font-black" title={hero.locked ? 'Unlock hero' : 'Lock hero'}>{hero.locked ? <Lock size={14} className="shrink-0 text-amber-300" /> : <Unlock size={14} className="shrink-0" />} {hero.locked ? 'UNLOCK' : 'LOCK'}</button><button type="button" onClick={() => { setReleaseOpen(true); setReleaseError(''); }} disabled={releaseBlocked || releaseBusy || isInTeam} className="game-control flex h-9 min-w-0 items-center justify-center gap-1.5 border-red-900/45 bg-red-950/25 px-2 text-[10px] font-black text-red-200/90 disabled:cursor-not-allowed disabled:opacity-45" title={releaseBlocked ? releaseBlockers[0] : 'Permanently release this hero'}><Trash2 size={14} className="shrink-0" /><span className="min-w-0 truncate">Release Hero</span></button></div>
          {releaseBlocked && <p className="mt-1 text-center text-[9px] text-red-200/70">{releaseBlockers.join(' · ')}</p>}
          {isolatedHackathon ? <section className="mt-2"><SeekerPromoteAll game={game} only={hero.uid} /></section> : (<section className="mt-2 rounded-lg border border-violet-700/35 bg-violet-950/15 p-2.5"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-xs font-bold text-violet-200"><Sparkles size={13} /> Star Up → {Math.min(MAX_HERO_STARS, hero.stars + 1)}</span><span className="text-right text-[10px] text-violet-300">{dupes.length}/{starCost.dupes} copies · {formatNum(starCost.hero)} $HERO<br /><span className="text-[9px] text-[#a99bb8]">Catalogue {formatUsdCents(starCost.usdCents)}</span></span></div>{hero.stars < MAX_HERO_STARS && <div className="mt-2" aria-label={`${dupes.length} of ${starCost.dupes} required duplicates available`}><div className="h-1.5 overflow-hidden rounded-full bg-black/55"><div className="h-full rounded-full bg-violet-400 transition-[width]" style={{ width: `${Math.min(100, dupes.length / starCost.dupes * 100)}%` }} /></div><div className="mt-1 text-[9px] text-[#9f94aa]">Exact unlocked zero-star copies · existing stars are grandfathered</div></div>}<button type="button" onClick={() => game.starUpHero(hero.uid)} disabled={dupes.length < starCost.dupes || game.state.hero < starCost.hero || hero.stars >= MAX_HERO_STARS} className="game-control mt-2 w-full px-3 text-xs font-bold">{hero.stars >= MAX_HERO_STARS ? 'Maximum ascension reached' : `Upgrade · ${starCost.dupes} copies + ${formatNum(starCost.hero)} $HERO`}</button></section>)}
        </footer>
        </div>
      </div>
      {releaseOpen && (
        <div role="dialog" aria-modal="true" aria-labelledby="release-confirm-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4 backdrop-blur-[2px] anim-fade" onClick={(event) => { event.stopPropagation(); if (!releaseBusy) setReleaseOpen(false); }}>
          <div ref={releaseDialogRef} tabIndex={-1} className="w-full max-w-sm overflow-hidden rounded-2xl border border-red-900/50 bg-[#17120d] p-4 shadow-[0_20px_60px_rgba(0,0,0,.6)] outline-none" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-start gap-2"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-400" /><div><h2 id="release-confirm-title" className="text-sm font-black text-[#eee4d3]">Release {base.name}?</h2><p className="mt-1 text-xs leading-relaxed text-[#aaa397]"><b className="text-[#d9cfbd]">{base.name}</b> (Lv {hero.level}, {RARITY_LABEL[base.rarity]}) will be permanently removed from your Heroes. This is <b className="text-red-300">irreversible</b> and cannot be undone.</p><p className="mt-1 text-xs leading-relaxed text-[#aaa397]">You receive <b className="text-red-300">no reward</b>: no Gold, $HERO, items, XP, dust, refunds or anything else.</p></div></div>
            {releaseError && <p role="alert" className="mt-2 rounded border border-red-500/45 bg-red-950/40 p-2 text-xs leading-relaxed text-red-200">{releaseError}</p>}
            <div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={() => setReleaseOpen(false)} disabled={releaseBusy} className="game-control h-10 px-3 text-xs font-black disabled:opacity-55">Cancel</button><button type="button" onClick={() => void runRelease()} disabled={releaseBusy} className="game-control game-danger h-10 px-3 text-xs font-black disabled:opacity-55">{releaseBusy ? 'Releasing…' : 'Release'}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) { return <div className="stat-tile p-2 text-center"><div className="text-[8px] uppercase tracking-wide text-[#777268]">{label}</div><div className="mt-0.5 text-xs font-bold text-[#e8dfce]">{value}</div></div>; }

export function HeroesScreen({ game }: { game: GameApi }) {
  const { state, respawnCountdowns } = game;
  const [sort, setSort] = useState<'rarity' | 'stars' | 'level' | 'power'>('rarity');
  const [classFilter, setClassFilter] = useState('all');
  const [rarityFilter, setRarityFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState<'all' | '1-19' | '20-39' | '40-59' | '60-79' | '80-99'>('all');
  const [search, setSearch] = useState('');
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const skrRate = useSkrRate(isolatedHackathon);
  const [promotionNotice, setPromotionNotice] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [capacityBusy, setCapacityBusy] = useState(false);
  const [capacityQuote, setCapacityQuote] = useState<{
    quoteId: string; previousCapacity: number; heroCapacity: number; usdCents: number;
    tokenCost: number; dexSource: string; expiresAt: string;
  } | null>(null);
  const [capacityNotice, setCapacityNotice] = useState('');
  const [capacityNoticeError, setCapacityNoticeError] = useState(false);
  const activeTeamPower = useMemo(() => calculateTeamPower(state.ownedHeroes.filter((hero) => state.team.includes(hero.uid)), state.inventory), [state.team, state.ownedHeroes, state.inventory]);
  const capacityUpgrade = heroCapacityUpgradeCost(state.heroCapacity);
  useEffect(() => {
    if (!capacityQuote) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !capacityBusy) setCapacityQuote(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [capacityQuote, capacityBusy]);

  const entries = useMemo(() => {
    const list = state.ownedHeroes.map((hero) => ({ base: HERO_MAP[hero.heroId], hero })).filter((entry): entry is { base: HeroBase; hero: OwnedHero } => Boolean(entry.base)).filter(({ base, hero }) => {
      if (classFilter !== 'all' && base.heroClass !== classFilter) return false;
      if (rarityFilter !== 'all' && base.rarity !== rarityFilter) return false;
      if (levelFilter !== 'all') {
        const [minimum, maximum] = levelFilter.split('-').map(Number);
        if (hero.level < minimum || hero.level > maximum) return false;
      }
      return !search || base.name.toLowerCase().includes(search.toLowerCase());
    });
    return list.sort((a, b) => {
      if (sort === 'level') return b.hero.level - a.hero.level;
      if (sort === 'stars') return b.hero.stars - a.hero.stars || b.hero.level - a.hero.level;
      if (sort === 'power') { const aStats = heroStats(a.hero, getEquippedItems(a.hero, state.inventory)); const bStats = heroStats(b.hero, getEquippedItems(b.hero, state.inventory)); return ((bStats?.atk ?? 0) + (bStats?.hp ?? 0) / 10) - ((aStats?.atk ?? 0) + (aStats?.hp ?? 0) / 10); }
      return RARITY_INDEX[b.base.rarity] - RARITY_INDEX[a.base.rarity];
    });
  }, [state.ownedHeroes, state.inventory, classFilter, rarityFilter, levelFilter, search, sort]);

  const selected = selectedUid ? state.ownedHeroes.find((hero) => hero.uid === selectedUid) ?? null : null;
  const openHero = (hero: OwnedHero) => { game.markHeroSeen(hero.uid); setSelectedUid(hero.uid); };
  const promoteAll = async () => {
    if (promoting) return;
    setPromoting(true);
    try {
      const summary = await game.promoteAllHeroes();
      setPromotionNotice(summary.length > 0 ? summary.map((entry) => `${entry.heroName} +${entry.starsAdded}★`).join(' · ') : 'No eligible duplicate upgrades');
    } finally {
      setPromoting(false);
    }
  };
  const openCapacityUpgrade = async () => {
    if (!capacityUpgrade || capacityBusy) return;
    setCapacityBusy(true);
    setCapacityNotice('');
    setCapacityNoticeError(false);
    try {
      const result = await game.quoteHeroCapacity();
      if (result.ok) {
        setCapacityQuote(result.quote);
        return;
      }
      setCapacityNoticeError(!result.ok);
      setCapacityNotice(result.error === 'dex_quote_unavailable'
        ? 'DEX price is unavailable · Capacity purchase is safely paused'
        : result.error === 'maximum_capacity'
          ? 'Maximum Hero capacity reached'
          : 'Capacity quote unavailable · No $HERO was spent');
    } finally {
      setCapacityBusy(false);
    }
  };
  const confirmCapacityUpgrade = async () => {
    if (!capacityQuote || capacityBusy) return;
    setCapacityBusy(true);
    setCapacityNotice('');
    try {
      const result = await game.upgradeHeroCapacity(capacityQuote.quoteId);
      setCapacityNoticeError(!result.ok);
      setCapacityNotice(result.ok
        ? `Hero capacity expanded to ${capacityQuote.heroCapacity} · ${formatNum(result.spent)} $HERO spent`
        : result.error === 'insufficient_tokens'
          ? 'Not enough $HERO · No tokens were spent'
          : result.error.includes('expired') || result.error.includes('stale') || result.error === 'state_conflict'
            ? 'The DEX quote expired or your roster changed · Request a new quote'
            : 'Capacity upgrade unavailable · No $HERO was spent');
      if (result.ok) setCapacityQuote(null);
    } finally {
      setCapacityBusy(false);
    }
  };
  const teamHeroes = state.team.map((uid) => state.ownedHeroes.find((candidate) => candidate.uid === uid)).filter((hero): hero is OwnedHero => Boolean(hero));
  const filtersSet = classFilter !== 'all' || rarityFilter !== 'all' || levelFilter !== 'all' || search !== '';
  return (
    <div className={`sc-root hv-root${state.battleAnimationMode === 'off' ? ' sc-still' : ''}`}>
      <section className="sc-stage hv-hall" aria-label="Hall of Champions">
        <div className="sc-stage-art" aria-hidden="true" />
        <div className="sc-glow" aria-hidden="true" />
        <div className="sc-embers" aria-hidden="true">{Array.from({ length: 8 }, (_, index) => <i key={index} style={{ '--i': index } as React.CSSProperties} />)}</div>
        <header className="sc-head heroes-head">
          <span className="sc-kicker">Hall of Champions</span>
          <h2 className="sc-title">My Heroes</h2>
          <div className="hv-head-row">
            <span className="sc-chip"><Users size={12} /> {state.ownedHeroes.length}/{state.heroCapacity}</span>
            {isolatedHackathon ? <SkrPurchaseButton product="hero_capacity_upgrade" params={{previous_capacity:state.heroCapacity}} disabled={!capacityUpgrade} label={capacityUpgrade?<>+100 slots · {skrCost(capacityUpgrade.usdCents, skrRate)}<SkrUsd cents={capacityUpgrade.usdCents} /></>:'Max'} onDelivered={game.applySeekerPurchase}/> : (<button type="button" onClick={() => void openCapacityUpgrade()} disabled={!capacityUpgrade || capacityBusy} aria-busy={capacityBusy} className="sc-seal" aria-label={capacityUpgrade ? `Get DEX quote to expand Hero capacity to ${capacityUpgrade.nextCapacity}; USD catalogue price $${(capacityUpgrade.usdCents / 100).toFixed(2)}` : `Maximum Hero capacity ${MAX_HERO_CAPACITY}`} title={capacityUpgrade ? `USD catalogue $${(capacityUpgrade.usdCents / 100).toFixed(2)} · $HERO amount comes from a fresh DEX quote` : `Maximum capacity ${MAX_HERO_CAPACITY}`}><UserPlus size={12} />{capacityBusy ? 'Getting quote…' : capacityUpgrade ? `+100 slots · $${(capacityUpgrade.usdCents / 100).toFixed(2)}` : `MAX ${MAX_HERO_CAPACITY}`}</button>)}
          </div>
        </header>
        <div className="hv-team" aria-label="Active team">
          {[0, 1, 2].map((slot) => {
            const hero = teamHeroes[slot];
            const base = hero ? HERO_MAP[hero.heroId] : undefined;
            const color = base ? RARITY_COLORS[base.rarity] : undefined;
            return (
              <div key={slot} className="hv-seat" style={color ? { '--hv-color': color } as React.CSSProperties : undefined}>
                {hero && base
                  ? <button type="button" className="hv-card hv-seat-card" onClick={() => openHero(hero)} aria-label={`${base.name}, ${RARITY_LABEL[base.rarity]}, level ${hero.level}`}>
                      <span className="hv-card-art">
                        <img src={heroThumbSrc(base.id, base.heroClass, base.rarity, base.color)} alt="" decoding="async" style={{ ...heroPortraitStyle(base.id, base.heroClass), transform: 'none' }} />
                        <RarityFx rarity={base.rarity} shape="tcg" label={CLASS_LABEL[base.heroClass]} />
                        <span className="hv-card-lv">Lv {hero.level}</span>
                        {(respawnCountdowns[hero.uid] ?? 0) > 0 && <span className="hv-card-dead">Fallen<br />{respawnCountdowns[hero.uid]}s</span>}
                      </span>
                    </button>
                  : <span className="hv-seat-empty" aria-label="Empty team slot"><Shield size={26} /></span>}
                <span className="hv-plinth">{hero && base ? <><b>{base.name}</b><small>{CLASS_LABEL[base.heroClass]}</small></> : <><b>Empty</b><small>Choose a hero</small></>}</span>
              </div>
            );
          })}
        </div>
        <div className="hv-power"><span>Team Power</span><b>{formatNum(activeTeamPower)}</b><span>{state.team.length}/3</span></div>
      </section>

      <div className="sc-body">
        {capacityNotice && <div role={capacityNoticeError ? 'alert' : 'status'} className={`hv-notice${capacityNoticeError ? ' is-error' : ''}`}><span>{capacityNotice}</span><button type="button" onClick={() => setCapacityNotice('')} aria-label="Dismiss capacity message"><X size={13} /></button></div>}
        {isolatedHackathon
          ? <div className="hl-heroes-promote"><SeekerPromoteAll game={game} /></div>
          : <button type="button" disabled={promoting} onClick={() => void promoteAll()} className="sc-seal w-full"><Sparkles size={13} /> {promoting ? 'Promoting…' : 'Promote All'}</button>}
        {promotionNotice && <div className="hv-notice"><span><Sparkles size={13} className="mr-1 inline text-amber-300" />{promotionNotice}</span><button type="button" onClick={() => setPromotionNotice('')} aria-label="Dismiss promotion result"><X size={14} /></button></div>}

        <section className="sc-panel" aria-label="Hero collection">
          <div className="sc-section-head"><span>Collection</span><span className="sc-muted">{entries.length} shown</span></div>
          <div className="hv-tools">
            <label className="hv-search"><Search size={13} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search heroes" aria-label="Search heroes" /></label>
            <div className="hv-filters">
              <Filter value={classFilter} onChange={setClassFilter} label="Class" icon={Swords} options={['all', 'knight', 'archer', 'assassin', 'shepherd', 'druid']} />
              <Filter value={rarityFilter} onChange={setRarityFilter} label="Rarity" icon={Gem} options={['all', ...FILTER_RARITIES]} />
              <Filter value={levelFilter} onChange={(value) => setLevelFilter(value as typeof levelFilter)} label="Level" icon={ChevronsUp} options={['all', '1-19', '20-39', '40-59', '60-79', '80-99']} />
              <button type="button" disabled={!filtersSet} onClick={() => { setClassFilter('all'); setRarityFilter('all'); setLevelFilter('all'); setSearch(''); }} className="sc-chip" aria-label="Clear filters"><X size={12} /></button>
            </div>
            <div className="hv-sort" role="group" aria-label="Sort heroes">
              {(['rarity', 'stars', 'power', 'level'] as const).map((value) => { const Icon = SORT_ICONS[value]; return <button type="button" key={value} onClick={() => setSort(value)} aria-pressed={sort === value} className="sc-chip">{value}<Icon size={10} aria-hidden="true" /></button>; })}
            </div>
          </div>
        </section>

        {entries.length > 0
          ? <ol className="hv-grid hl-hero-grid">{entries.map(({ base, hero }) => <HeroGridCard key={hero.uid} base={base} hero={hero} game={game} onSelect={() => openHero(hero)} />)}</ol>
          : <div className="sc-panel hv-empty"><Shield className="mx-auto text-[#806b49]" /><b>No owned heroes match these filters</b><div className="sc-muted mt-1">Change class, rarity, level or search.</div></div>}
      </div>
      {selected && <HeroDetailModal hero={selected} game={game} onClose={() => setSelectedUid(null)} />}
      {capacityQuote && (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-black/80 p-3 backdrop-blur-sm">
          <section role="dialog" aria-modal="true" aria-labelledby="capacity-quote-title" tabIndex={-1} autoFocus className="material-panel game-scrollbar max-h-[calc(100vh-24px)] w-full max-w-md overflow-y-auto p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div><div className="section-kicker">Permanent storage</div><h3 id="capacity-quote-title" className="mt-1 text-lg font-black text-[#eee4d3]">Expand to {capacityQuote.heroCapacity} Heroes</h3></div>
              <button type="button" onClick={() => setCapacityQuote(null)} disabled={capacityBusy} aria-label="Close capacity quote" className="game-control grid min-h-11 min-w-11 place-items-center"><X size={16} /></button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <StatBox label="Catalogue price" value={`$${(capacityQuote.usdCents / 100).toFixed(2)}`} />
              <StatBox label="Current DEX quote" value={`${formatNum(capacityQuote.tokenCost)} $HERO`} />
            </div>
            <p className="mt-3 text-sm leading-relaxed text-[#aaa397]">The USD price is fixed for this tier. The $HERO amount was calculated by the server from <b className="text-[#e6d5b4]">{capacityQuote.dexSource}</b> and is locked only until {formatUtcTime(capacityQuote.expiresAt)}.</p>
            {capacityQuote.tokenCost > state.hero && <p role="alert" className="mt-2 rounded border border-red-500/45 bg-red-950/35 p-2 text-xs text-red-200">Not enough $HERO · need {formatNum(capacityQuote.tokenCost - state.hero)} more</p>}
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setCapacityQuote(null)} disabled={capacityBusy} className="game-control min-h-11 text-sm font-black">Cancel</button>
              <button type="button" onClick={() => void confirmCapacityUpgrade()} disabled={capacityBusy || capacityQuote.tokenCost > state.hero} aria-busy={capacityBusy} className="game-control game-primary min-h-11 px-3 text-sm font-black disabled:opacity-45">{capacityBusy ? 'Confirming…' : `Pay ${formatNum(capacityQuote.tokenCost)} $HERO`}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

const SORT_ICONS = { rarity: Gem, stars: Star, power: Zap, level: ChevronsUp } as const;

// A small icon follows each filter name (Founder 2026-10-03); tapping opens the themed list, not the platform picker.
function Filter({ value, onChange, label, icon: Icon, options }: { value: string; onChange: (value: string) => void; label: string; icon: typeof Star; options: string[] }) { const text = value === 'all' ? label : value; return <GameSelect ariaLabel={label} value={value} onChange={onChange} options={options.map((option) => ({ value: option, label: option === 'all' ? `All ${label}` : option }))} className={`hv-filter sc-chip${value === 'all' ? '' : ' is-set'}`}><span aria-hidden="true">{text}</span><Icon size={10} aria-hidden="true" /></GameSelect>; }
