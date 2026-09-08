import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Star, Lock, Unlock, Trash2, Search, X, Sparkles, Users, Swords, Shield, AlertTriangle, UserPlus } from 'lucide-react';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, RARITY_INDEX, CLASS_LABEL } from '@/game/heroes';
import { formatNum, starUpCost, heroXpForLevel, heroCapacityUpgradeCost, MAX_HERO_CAPACITY, MAX_HERO_STARS } from '@/game/state';
import { heroStats, getEquippedItems, teamPower as calculateTeamPower } from '@/game/engine';
import { COMBAT_EFFECTS_V2_PREVIEW, COMBAT_EFFECTS_V2_PRODUCTION_ACTIVE } from '@/game/combat-effects-v2-ui.mjs';
import type { HeroBase, OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';

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

function HeroGridCard({ base, hero, game, selected, onSelect }: { base: HeroBase; hero: OwnedHero; game: GameApi; selected: boolean; onSelect: () => void }) {
  const rc = RARITY_COLORS[base.rarity];
  const isInTeam = game.state.team.includes(hero.uid);
  const respawn = game.respawnCountdowns[hero.uid] ?? 0;
  const dupes = game.state.ownedHeroes.filter((candidate) => candidate.heroId === hero.heroId && candidate.uid !== hero.uid && candidate.stars === 0 && !candidate.locked && !game.state.team.includes(candidate.uid) && !game.state.trainingCamp.heroUids.includes(candidate.uid)).length;
  const starCost = starUpCost(hero.stars, base.rarity);
  const upgradeable = hero.stars < MAX_HERO_STARS && dupes >= starCost.dupes && game.state.hero >= starCost.hero;
  const stats = heroStats(hero, getEquippedItems(hero, game.state.inventory));
  const power = stats ? Math.round(stats.atk + stats.hp / 10 + stats.def * 2) : 0;
  return (
    <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(); }} className={`premium-hero-card rarity-${base.rarity} min-w-0 p-1.5 transition cursor-pointer ${selected ? 'premium-hero-card-selected' : ''} ${isInTeam ? 'premium-hero-card-active-team' : ''}`}>
      <div className="relative mx-auto w-fit">
        <HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={80} active={isInTeam} badge={hero.level} respawn={respawn} />
      </div>
      <div className="mt-1.5 truncate text-center text-[11px] font-bold" style={{ color: rc }}>{base.name}</div>
      <div className="mt-0.5 flex items-center justify-between gap-1 text-[8px] uppercase tracking-wide text-[#827d72]"><span>{CLASS_LABEL[base.heroClass]}</span><span style={{ color: rc }}>{RARITY_LABEL[base.rarity]}</span></div>
      <div className="mt-1 flex items-center justify-between border-t border-white/5 pt-1 text-[9px]"><span className="font-bold text-[#ddd4c4]">{formatNum(power)} PWR</span><HeroStars stars={hero.stars} size={7} /></div>
      {hero.stars < MAX_HERO_STARS && <div className="mt-1 truncate border-t border-white/5 pt-1 text-center text-[8px] font-bold text-violet-200">{dupes}/{starCost.dupes} copies · {formatNum(starCost.hero)} $HERO</div>}
      <div className="pointer-events-none absolute left-1.5 top-1.5 z-10 flex flex-col gap-1">
        {hero.isNew && <StateBadge label="New" tone="gold" />}
        {isInTeam && <StateBadge label="Selected" tone="green" />}
        {upgradeable && <StateBadge label="Upgrade" tone="purple" />}
      </div>
      {hero.locked && <Lock size={12} className="absolute right-2 top-2 z-10 text-amber-300" />}
    </div>
  );
}

function StateBadge({ label, tone }: { label: string; tone: 'gold' | 'green' | 'purple' }) {
  const cls = tone === 'green' ? 'border-emerald-200 bg-emerald-400 text-[#04150d] shadow-[0_0_0_1px_rgba(4,21,13,.9),0_0_12px_rgba(52,211,153,.8)]' : tone === 'purple' ? 'border-violet-500/60 bg-violet-950/85 text-violet-200' : 'border-amber-500/60 bg-[#2a1a08]/90 text-amber-200';
  return <span className={`rounded border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-[.08em] ${cls}`}>{label}</span>;
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
      <div className={`px-panel-raised rarity-${base.rarity} relative flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl`} onClick={(event) => event.stopPropagation()}>
        <header className="flex items-start gap-3 border-b border-[#54442e] p-3">
          <HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={82} active={isInTeam} badge={hero.level} />
          <div className="min-w-0 flex-1"><div className="truncate text-xl font-black" style={{ color: rc }}>{base.name}</div><div className="text-xs text-[#918b80]">{RARITY_LABEL[base.rarity]} · {CLASS_LABEL[base.heroClass]}</div><div className="mt-2 flex items-center gap-2"><span className="rounded-md border border-[#665131] bg-black/25 px-2 py-1 text-sm font-black text-[#f0d08b]">{formatNum(power)} POWER</span><HeroStars stars={hero.stars} size={12} /><span className="text-[9px] text-[#837d72]">{hero.stars}/{MAX_HERO_STARS}</span></div><div className="mt-2 health-track h-2 overflow-hidden"><div className="h-full bg-emerald-600/75" style={{ width: `${Math.min(100, hero.xp / xpNeed * 100)}%` }} /></div><div className="mt-0.5 text-[9px] text-[#837d72]">Lv {hero.level} · {formatNum(hero.xp)}/{formatNum(xpNeed)} XP</div></div>
          <button type="button" onClick={onClose} className="game-control grid h-9 w-9 place-items-center" aria-label="Close hero details"><X size={16} /></button>
        </header>
        <div className="game-scrollbar min-h-0 overflow-y-auto p-3">
          <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6"><StatBox label="HP" value={formatNum(stats.hp)} /><StatBox label="ATK" value={formatNum(stats.atk)} /><StatBox label="DEF" value={formatNum(stats.def)} /><StatBox label="Crit" value={`${(stats.critChance * 100).toFixed(1)}%`} /><StatBox label="Dodge" value={`${(stats.dodge * 100).toFixed(1)}%`} /><StatBox label="Speed" value={`+${stats.atkSpeed}`} /></div>
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
          <section className="mt-2 rounded-lg border border-violet-700/35 bg-violet-950/15 p-2.5"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-xs font-bold text-violet-200"><Sparkles size={13} /> Star Up → {Math.min(MAX_HERO_STARS, hero.stars + 1)}</span><span className="text-right text-[10px] text-violet-300">{dupes.length}/{starCost.dupes} copies · {formatNum(starCost.hero)} $HERO<br /><span className="text-[9px] text-[#a99bb8]">Catalogue {formatUsdCents(starCost.usdCents)}</span></span></div>{hero.stars < MAX_HERO_STARS && <div className="mt-2" aria-label={`${dupes.length} of ${starCost.dupes} required duplicates available`}><div className="h-1.5 overflow-hidden rounded-full bg-black/55"><div className="h-full rounded-full bg-violet-400 transition-[width]" style={{ width: `${Math.min(100, dupes.length / starCost.dupes * 100)}%` }} /></div><div className="mt-1 text-[9px] text-[#9f94aa]">Exact unlocked zero-star copies · existing stars are grandfathered</div></div>}<button type="button" onClick={() => game.starUpHero(hero.uid)} disabled={dupes.length < starCost.dupes || game.state.hero < starCost.hero || hero.stars >= MAX_HERO_STARS} className="game-control mt-2 w-full px-3 text-xs font-bold">{hero.stars >= MAX_HERO_STARS ? 'Maximum ascension reached' : `Upgrade · ${starCost.dupes} copies + ${formatNum(starCost.hero)} $HERO`}</button></section>
          {powerNotice && <div aria-live="polite" className={`anim-banner mt-2 rounded border p-2 text-center text-sm font-black tabular-nums ${powerNotice.added ? 'border-emerald-400/55 bg-emerald-950/55 text-emerald-300' : 'border-red-400/55 bg-red-950/55 text-red-300'}`}>{powerNotice.added ? '+' : '−'}{formatNum(powerNotice.delta)} POWER</div>}
          {teamError && <div className="mt-2 rounded border border-red-500/45 bg-red-950/40 p-2 text-xs text-red-200">{teamError}</div>}
        </div>
        <footer className="border-t border-[#54442e] bg-black/20 p-3">
          <div className="grid grid-cols-[minmax(0,1fr)_92px_minmax(0,1fr)] gap-2"><button type="button" onClick={async () => { const result = await game.toggleTeamMember(hero.uid); const succeeded = result === 'added' || result === 'removed'; setTeamError(result === 'inventory-full' ? 'Cannot remove hero: there is not enough room for equipped items. Free bag slots first.' : result === 'blocked' ? 'Team change is unavailable right now.' : ''); setPowerNotice(succeeded ? { delta: teamPowerDelta, added: result === 'added' } : null); }} aria-label={isInTeam ? 'Remove from Team' : 'Add to Team'} title={isInTeam ? 'Remove from Team' : 'Add to Team'} className={`game-control h-9 min-w-0 truncate px-2 text-[10px] font-black ${isInTeam ? 'game-danger' : 'game-primary'}`}>{isInTeam ? 'Remove' : 'Add to Team'}</button><button type="button" onClick={() => game.toggleHeroLock(hero.uid)} className="game-control flex h-9 items-center justify-center gap-1.5 px-2 text-[10px] font-black" title={hero.locked ? 'Unlock hero' : 'Lock hero'}>{hero.locked ? <Lock size={14} className="shrink-0 text-amber-300" /> : <Unlock size={14} className="shrink-0" />} {hero.locked ? 'UNLOCK' : 'LOCK'}</button><button type="button" onClick={() => { setReleaseOpen(true); setReleaseError(''); }} disabled={releaseBlocked || releaseBusy || isInTeam} className="game-control flex h-9 min-w-0 items-center justify-center gap-1.5 border-red-900/45 bg-red-950/25 px-2 text-[10px] font-black text-red-200/90 disabled:cursor-not-allowed disabled:opacity-45" title={releaseBlocked ? releaseBlockers[0] : 'Permanently release this hero'}><Trash2 size={14} className="shrink-0" /><span className="min-w-0 truncate">Release Hero</span></button></div>
          {releaseBlocked && <p className="mt-1 text-center text-[9px] text-red-200/70">{releaseBlockers.join(' · ')}</p>}
        </footer>
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
  const [promotionNotice, setPromotionNotice] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [capacityBusy, setCapacityBusy] = useState(false);
  const [capacityNotice, setCapacityNotice] = useState('');
  const [capacityNoticeError, setCapacityNoticeError] = useState(false);
  const activeTeamPower = useMemo(() => calculateTeamPower(state.ownedHeroes.filter((hero) => state.team.includes(hero.uid)), state.inventory), [state.team, state.ownedHeroes, state.inventory]);
  const capacityUpgrade = heroCapacityUpgradeCost(state.heroCapacity);

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
  const upgradeCapacity = async () => {
    if (!capacityUpgrade || capacityBusy) return;
    setCapacityBusy(true);
    setCapacityNotice('');
    setCapacityNoticeError(false);
    try {
      const result = await game.upgradeHeroCapacity();
      setCapacityNoticeError(!result.ok);
      setCapacityNotice(result.ok
        ? `Hero capacity expanded to ${capacityUpgrade.nextCapacity} · ${formatNum(result.spent)} $HERO spent`
        : result.error === 'insufficient_tokens'
          ? 'Not enough $HERO for this capacity upgrade'
          : result.error === 'maximum_capacity'
            ? 'Maximum Hero capacity reached'
            : 'Capacity upgrade unavailable · No $HERO was spent');
    } finally {
      setCapacityBusy(false);
    }
  };
  return (
    <div className="premium-screen themed-screen themed-screen-heroes flex h-full flex-col overflow-hidden">
      <header className="material-panel m-2 mb-0 shrink-0 p-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            <div className="section-kicker">Hall of Champions</div>
            <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2"><h2 className="text-xl font-black text-[#eee4d3]">My Heroes <span className="text-sm text-[#8f897e]">{state.ownedHeroes.length}/{state.heroCapacity}</span></h2><button type="button" onClick={() => void upgradeCapacity()} disabled={!capacityUpgrade || capacityBusy || (capacityUpgrade?.hero ?? 0) > state.hero} aria-busy={capacityBusy} className="game-control game-primary flex h-8 items-center gap-1 px-2 text-[8px] font-black uppercase disabled:cursor-not-allowed disabled:opacity-45" aria-label={capacityUpgrade ? `Expand Hero capacity to ${capacityUpgrade.nextCapacity} for ${formatNum(capacityUpgrade.hero)} HERO` : `Maximum Hero capacity ${MAX_HERO_CAPACITY}`} title={capacityUpgrade ? `$${(capacityUpgrade.usdCents / 100).toFixed(2)} catalogue · ${formatNum(capacityUpgrade.hero)} $HERO` : `Maximum capacity ${MAX_HERO_CAPACITY}`}><UserPlus size={12} />{capacityBusy ? 'Expanding…' : capacityUpgrade ? `+100 · ${formatNum(capacityUpgrade.hero)} HERO` : `MAX ${MAX_HERO_CAPACITY}`}</button></div>
            {capacityNotice && <div role={capacityNoticeError ? 'alert' : 'status'} className={`mt-1 text-[10px] font-bold ${capacityNoticeError ? 'text-red-300' : 'text-amber-200'}`}>{capacityNotice}</div>}
            <div className="mt-3 grid grid-cols-2 gap-1 sm:grid-cols-5">
                <label className="relative block h-8"><Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[#736d62]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search heroes" className="game-control h-8 w-full bg-transparent pl-7 pr-2 text-[10px] outline-none" /></label>
                  <Filter value={classFilter} onChange={setClassFilter} label="Class" options={['all', 'knight', 'archer', 'assassin', 'shepherd', 'druid']} />
                  <Filter value={rarityFilter} onChange={setRarityFilter} label="Rarity" options={['all', ...FILTER_RARITIES]} />
                  <Filter value={levelFilter} onChange={(value) => setLevelFilter(value as typeof levelFilter)} label="Level" options={['all', '1-19', '20-39', '40-59', '60-79', '80-99']} />
                  <button type="button" onClick={() => { setClassFilter('all'); setRarityFilter('all'); setLevelFilter('all'); setSearch(''); }} className="game-control h-8 px-2 text-[8px] font-black uppercase"><X size={11} className="mr-1 inline" />Clear filters</button>
                  <button type="button" disabled={promoting} onClick={() => void promoteAll()} className="game-control game-primary flex h-8 w-full items-center justify-center gap-1 px-2 text-[8px] font-black uppercase disabled:opacity-55"><Sparkles size={11} /> {promoting ? 'Promoting…' : 'Promote All'}</button>
                  {(['stars', 'power', 'level'] as const).map((value) => <button type="button" key={value} onClick={() => setSort(value)} className={`game-control h-8 px-2 text-[8px] font-bold uppercase ${sort === value ? 'game-primary' : ''}`}>{value}</button>)}
            </div>
          </div>
          <section className="relative overflow-hidden rounded-xl border border-[#a87b35] bg-[radial-gradient(circle_at_50%_0%,rgba(190,137,55,.2),transparent_58%),linear-gradient(160deg,#211b12,#0c0d0c)] p-3 shadow-[inset_0_1px_rgba(255,226,163,.12),0_8px_25px_rgba(0,0,0,.35)]">
            <Swords size={54} className="absolute -left-3 -top-3 rotate-[-18deg] text-[#8d6a37]/20" />
            <Shield size={58} className="absolute -bottom-4 -right-2 text-[#8d6a37]/20" />
            <div className="relative flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-xs font-black uppercase tracking-[.15em] text-[#efc875]"><Users size={15} /> Active Team</span><div className="flex items-baseline gap-2"><span className="text-[9px] font-bold uppercase tracking-wider text-[#8f887b]">Team Power</span><b className="text-sm tabular-nums text-[#f5d98e]">{formatNum(activeTeamPower)}</b><span className="text-[10px] font-bold text-[#a99a7d]">{state.team.length}/3</span></div></div>
            <div className="relative mt-3 flex min-h-[96px] items-center justify-center gap-4">
              {state.team.map((uid) => { const hero = state.ownedHeroes.find((candidate) => candidate.uid === uid); const base = hero ? HERO_MAP[hero.heroId] : null; return hero && base ? <HeroPortrait key={uid} heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={88} active badge={hero.level} respawn={respawnCountdowns[uid] ?? 0} onClick={() => openHero(hero)} /> : null; })}
              {Array.from({ length: 3 - state.team.length }, (_, index) => <div key={index} className="grid h-[88px] w-[88px] place-items-center rounded-xl border border-dashed border-[#665333] bg-black/20"><Shield size={24} className="text-[#5c4b31]" /></div>)}
            </div>
            <div className="relative mt-1 text-center text-[9px] text-[#8f887b]">Your primary combat formation</div>
          </section>
        </div>
        {promotionNotice && <div className="anim-banner mt-2 flex items-start gap-2 rounded-lg border border-violet-500/45 bg-violet-950/45 px-3 py-2 text-xs font-bold text-violet-200"><span className="flex-1 text-center"><Sparkles size={13} className="mr-1 inline text-amber-300" />{promotionNotice}</span><button type="button" onClick={() => setPromotionNotice('')} aria-label="Dismiss promotion result"><X size={14} /></button></div>}
      </header>
      <div className="game-scrollbar min-h-0 flex-1 overflow-y-auto p-2"><div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">{entries.map(({ base, hero }) => <HeroGridCard key={hero.uid} base={base} hero={hero} game={game} selected={selected?.uid === hero.uid} onSelect={() => openHero(hero)} />)}</div>{entries.length === 0 && <div className="material-panel mx-auto mt-16 max-w-sm p-6 text-center"><Shield className="mx-auto text-[#806b49]" /><div className="mt-2 font-bold text-[#d4c9b7]">No owned heroes match these filters</div><div className="mt-1 text-xs text-[#827c72]">Change class, rarity, level or search.</div></div>}</div>
      {selected && <HeroDetailModal hero={selected} game={game} onClose={() => setSelectedUid(null)} />}
    </div>
  );
}

function Filter({ value, onChange, label, options }: { value: string; onChange: (value: string) => void; label: string; options: string[] }) { return <label className="flex min-w-0 items-stretch"><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="game-control h-8 w-full min-w-0 bg-[#171915] px-2 text-[9px] font-bold capitalize text-[#d1c8b9] outline-none" style={{ colorScheme: 'dark' }}>{options.map((option) => <option key={option} value={option} style={{ backgroundColor: '#171915', color: '#d1c8b9' }}>{option === 'all' ? `All ${label}` : option}</option>)}</select></label>; }
