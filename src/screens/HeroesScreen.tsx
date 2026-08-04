import { useMemo, useState } from 'react';
import { Star, Trash2, Lock, Unlock, Search, X, Sparkles, Users, Swords, Shield } from 'lucide-react';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, RARITY_INDEX, CLASS_LABEL } from '@/game/heroes';
import { formatNum, starUpCost, STAR_DUPES, heroXpForLevel, heroSellValue, MAX_HEROES, MAX_HERO_STARS } from '@/game/state';
import { heroStats, getEquippedItems } from '@/game/engine';
import type { HeroBase, OwnedHero, Rarity } from '@/game/types';
import type { GameApi } from '@/game/useGame';

const FILTER_RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial'];

const STAR_COLORS = ['#fbbf24', '#a855f7', '#ef4444', '#ec4899'];
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

function HeroGridCard({ base, hero, game, selected, selectionMode, selectable, onSelect }: { base: HeroBase; hero: OwnedHero; game: GameApi; selected: boolean; selectionMode: boolean; selectable: boolean; onSelect: () => void }) {
  const rc = RARITY_COLORS[base.rarity];
  const isInTeam = game.state.team.includes(hero.uid);
  const respawn = game.respawnCountdowns[hero.uid] ?? 0;
  const dupes = game.state.ownedHeroes.filter((candidate) => candidate.heroId === hero.heroId && candidate.uid !== hero.uid && candidate.stars === 0 && !candidate.locked && !game.state.team.includes(candidate.uid) && !game.state.trainingCamp.heroUids.includes(candidate.uid)).length;
  const upgradeable = hero.stars < MAX_HERO_STARS && dupes >= starUpCost(hero.stars).dupes;
  const stats = heroStats(hero, getEquippedItems(hero, game.state.inventory));
  const power = stats ? Math.round(stats.atk + stats.hp / 10 + stats.def * 2) : 0;
  return (
    <div role="button" tabIndex={selectable || !selectionMode ? 0 : -1} aria-disabled={selectionMode && !selectable} onClick={() => { if (!selectionMode || selectable) onSelect(); }} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && (!selectionMode || selectable)) onSelect(); }} className={`premium-hero-card rarity-${base.rarity} min-w-0 p-1.5 transition ${selectable || !selectionMode ? 'cursor-pointer' : 'cursor-not-allowed opacity-55'} ${selected ? 'premium-hero-card-selected' : ''}`}>
      {selectionMode && <span className={`absolute right-1.5 top-1.5 z-20 grid h-5 w-5 place-items-center rounded border text-[11px] font-black ${selected ? 'border-red-400 bg-red-600 text-white' : 'border-[#777064] bg-black/70 text-transparent'}`}>✓</span>}
      <div className="relative mx-auto w-fit">
        <HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={80} active={isInTeam} badge={hero.level} respawn={respawn} />
      </div>
      <div className="mt-1.5 truncate text-center text-[11px] font-bold" style={{ color: rc }}>{base.name}</div>
      <div className="mt-0.5 flex items-center justify-between gap-1 text-[8px] uppercase tracking-wide text-[#827d72]"><span>{CLASS_LABEL[base.heroClass]}</span><span style={{ color: rc }}>{RARITY_LABEL[base.rarity]}</span></div>
      <div className="mt-1 flex items-center justify-between border-t border-white/5 pt-1 text-[9px]"><span className="font-bold text-[#ddd4c4]">{formatNum(power)} PWR</span><HeroStars stars={hero.stars} size={7} /></div>
      <div className="pointer-events-none absolute left-1.5 top-1.5 z-10 flex flex-col gap-1">
        {hero.isNew && <StateBadge label="New" tone="gold" />}
        {isInTeam && <StateBadge label="Selected" tone="green" />}
        {upgradeable && <StateBadge label="Upgrade" tone="purple" />}
      </div>
      {hero.locked && !selectionMode && <Lock size={12} className="absolute right-2 top-2 z-10 text-amber-300" />}
    </div>
  );
}

function StateBadge({ label, tone }: { label: string; tone: 'gold' | 'green' | 'purple' }) {
  const cls = tone === 'green' ? 'border-emerald-600/60 bg-emerald-950/85 text-emerald-300' : tone === 'purple' ? 'border-violet-500/60 bg-violet-950/85 text-violet-200' : 'border-amber-500/60 bg-[#2a1a08]/90 text-amber-200';
  return <span className={`rounded border px-1 py-0.5 text-[7px] font-black uppercase tracking-wide ${cls}`}>{label}</span>;
}

function HeroDetailModal({ hero, game, onClose }: { hero: OwnedHero; game: GameApi; onClose: () => void }) {
  const [teamError, setTeamError] = useState('');
  const base = HERO_MAP[hero.heroId];
  const items = getEquippedItems(hero, game.state.inventory);
  const stats = heroStats(hero, items);
  if (!base || !stats) return null;
  const rc = RARITY_COLORS[base.rarity];
  const starCost = starUpCost(hero.stars);
  const dupes = game.state.ownedHeroes.filter((candidate) => candidate.heroId === hero.heroId && candidate.uid !== hero.uid && candidate.stars === 0 && !candidate.locked && !game.state.team.includes(candidate.uid) && !game.state.trainingCamp.heroUids.includes(candidate.uid));
  const xpNeed = heroXpForLevel(hero.level);
  const isInTeam = game.state.team.includes(hero.uid);
  const power = Math.round(stats.atk + stats.hp / 10 + stats.def * 2);
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
          <section className="mt-2 grid gap-2 sm:grid-cols-2"><div className="stat-tile p-2.5"><div className="text-[9px] font-bold uppercase tracking-wider text-[#827d72]">Passive</div><div className="mt-0.5 text-xs font-bold" style={{ color: rc }}>{base.passiveName}</div><div className="mt-0.5 text-[10px] text-[#aaa397]">{base.passiveDesc}</div></div><div className="stat-tile p-2.5"><div className="text-[9px] font-bold uppercase tracking-wider text-[#827d72]">Ability</div><div className="mt-0.5 text-xs font-bold" style={{ color: rc }}>{base.skillName}</div><div className="mt-0.5 text-[10px] text-[#aaa397]">{base.skillDesc}</div></div></section>
          <section className="mt-2 rounded-lg border border-violet-700/35 bg-violet-950/15 p-2.5"><div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5 text-xs font-bold text-violet-200"><Sparkles size={13} /> Star Up → {Math.min(MAX_HERO_STARS, hero.stars + 1)}</span><span className="text-[10px] text-violet-300">{dupes.length}/{starCost.dupes} dupes · {starCost.hero} $HERO</span></div><button type="button" onClick={() => game.starUpHero(hero.uid)} disabled={dupes.length < starCost.dupes || hero.stars >= MAX_HERO_STARS} className="game-control mt-2 w-full px-3 text-xs font-bold">{hero.stars >= MAX_HERO_STARS ? 'Maximum ascension reached' : `Upgrade · ${STAR_DUPES[Math.min(hero.stars + 1, STAR_DUPES.length - 1)]} duplicate requirement`}</button></section>
          {teamError && <div className="mt-2 rounded border border-red-500/45 bg-red-950/40 p-2 text-xs text-red-200">{teamError}</div>}
        </div>
        <footer className="grid grid-cols-[minmax(0,1fr)_92px_44px] gap-2 border-t border-[#54442e] bg-black/20 p-3"><button type="button" onClick={() => { const result = game.toggleTeamMember(hero.uid); setTeamError(result === 'inventory-full' ? 'Cannot remove hero: there is not enough room for equipped items. Free bag slots first.' : result === 'blocked' ? 'Team change is unavailable right now.' : ''); }} className={`game-control h-9 px-2 text-[10px] font-black ${isInTeam ? 'game-danger' : 'game-primary'}`}>{isInTeam ? 'Remove from Team' : 'Add to Team'}</button><button type="button" onClick={() => game.toggleHeroLock(hero.uid)} className="game-control flex h-9 items-center justify-center gap-1.5 px-2 text-[10px] font-black" title={hero.locked ? 'Unlock hero' : 'Lock hero'}>{hero.locked ? <Lock size={14} className="text-amber-300" /> : <Unlock size={14} />} {hero.locked ? 'UNLOCK' : 'LOCK'}</button><button type="button" disabled={hero.locked || isInTeam || game.state.ownedHeroes.length <= 1 || (hero.heroId === game.state.avatarHeroId && game.state.ownedHeroes.filter((owned) => owned.heroId === hero.heroId).length <= 1)} onClick={() => { game.sellHero(hero.uid); onClose(); }} className="game-control game-danger h-9 disabled:cursor-not-allowed disabled:opacity-35" title={hero.heroId === game.state.avatarHeroId ? 'Change avatar before selling the last copy' : hero.locked ? 'Unlock before selling' : isInTeam ? 'Remove from team before selling' : 'Sell hero'}><Trash2 size={15} className="mx-auto" /></button></footer>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) { return <div className="stat-tile p-2 text-center"><div className="text-[8px] uppercase tracking-wide text-[#777268]">{label}</div><div className="mt-0.5 text-xs font-bold text-[#e8dfce]">{value}</div></div>; }

export function HeroesScreen({ game }: { game: GameApi }) {
  const { state, respawnCountdowns } = game;
  const [sort, setSort] = useState<'rarity' | 'level' | 'power'>('rarity');
  const [classFilter, setClassFilter] = useState('all');
  const [rarityFilter, setRarityFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState<'all' | '1-9' | '10+'>('all');
  const [search, setSearch] = useState('');
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [confirmSale, setConfirmSale] = useState(false);
  const [promotionNotice, setPromotionNotice] = useState('');

  const entries = useMemo(() => {
    const list = state.ownedHeroes.map((hero) => ({ base: HERO_MAP[hero.heroId], hero })).filter((entry): entry is { base: HeroBase; hero: OwnedHero } => Boolean(entry.base)).filter(({ base, hero }) => {
      if (classFilter !== 'all' && base.heroClass !== classFilter) return false;
      if (rarityFilter !== 'all' && base.rarity !== rarityFilter) return false;
      if (levelFilter === '1-9' && hero.level > 9) return false;
      if (levelFilter === '10+' && hero.level < 10) return false;
      return !search || base.name.toLowerCase().includes(search.toLowerCase());
    });
    return list.sort((a, b) => {
      if (sort === 'level') return b.hero.level - a.hero.level;
      if (sort === 'power') { const aStats = heroStats(a.hero, getEquippedItems(a.hero, state.inventory)); const bStats = heroStats(b.hero, getEquippedItems(b.hero, state.inventory)); return ((bStats?.atk ?? 0) + (bStats?.hp ?? 0) / 10) - ((aStats?.atk ?? 0) + (aStats?.hp ?? 0) / 10); }
      return RARITY_INDEX[b.base.rarity] - RARITY_INDEX[a.base.rarity];
    });
  }, [state.ownedHeroes, state.inventory, classFilter, rarityFilter, levelFilter, search, sort]);

  const selected = selectedUid ? state.ownedHeroes.find((hero) => hero.uid === selectedUid) ?? null : null;
  const openHero = (hero: OwnedHero) => { game.markHeroSeen(hero.uid); setSelectedUid(hero.uid); };
  const canSell = (hero: OwnedHero) => !hero.locked && !state.team.includes(hero.uid) && !(hero.heroId === state.avatarHeroId && state.ownedHeroes.filter((owned) => owned.heroId === hero.heroId).length <= 1);
  const toggleSelected = (uid: string) => setSelectedUids((current) => { const next = new Set(current); if (next.has(uid)) next.delete(uid); else next.add(uid); return next; });
  const selectVisible = () => setSelectedUids(new Set(entries.filter(({ hero }) => canSell(hero)).map(({ hero }) => hero.uid)));
  const selectRarity = (rarity: string) => { if (rarity !== 'all') setSelectedUids(new Set(state.ownedHeroes.filter((hero) => HERO_MAP[hero.heroId]?.rarity === rarity && canSell(hero)).map((hero) => hero.uid))); };
  const selectedRefund = state.ownedHeroes.filter((hero) => selectedUids.has(hero.uid)).reduce((total, hero) => { const base = HERO_MAP[hero.heroId]; return total + (base ? heroSellValue(base.rarity, hero.stars) : 0); }, 0);
  const finishSale = () => { game.sellHeroes([...selectedUids]); setSelectedUids(new Set()); setConfirmSale(false); setSelectionMode(false); };
  const promoteAll = async () => {
    const summary = await game.promoteAllHeroes();
    setPromotionNotice(summary.length > 0 ? summary.map((entry) => `${entry.heroName} +${entry.starsAdded}★`).join(' · ') : 'No eligible duplicate upgrades');
    window.setTimeout(() => setPromotionNotice(''), 4200);
  };
  return (
    <div className="premium-screen themed-screen themed-screen-heroes flex h-full flex-col overflow-hidden">
      <header className="material-panel m-2 mb-0 shrink-0 p-3">
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
          <div className="min-w-0">
            <div className="section-kicker">Hall of Champions</div>
            <h2 className="mt-0.5 text-xl font-black text-[#eee4d3]">My Heroes <span className="text-sm text-[#8f897e]">{state.ownedHeroes.length}/{MAX_HEROES}</span></h2>
            <div className="mt-3 flex flex-wrap items-start gap-2">
              <div className="grid w-[200px] shrink-0 grid-rows-2 gap-1.5"><label className="relative block h-[42px]"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#736d62]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search heroes" className="game-control h-[42px] w-full bg-transparent pl-8 pr-2 text-xs outline-none" /></label><button type="button" onClick={() => void promoteAll()} className="game-control game-primary flex h-[42px] w-full items-center justify-center gap-1 px-2 text-[9px] font-black uppercase"><Sparkles size={12} /> Promote All</button></div>
              <div className="grid min-w-[440px] flex-1 grid-rows-2 gap-1.5">
                <div className="grid h-[42px] grid-cols-3 gap-1.5">
                  <Filter value={classFilter} onChange={setClassFilter} label="Class" options={['all', 'knight', 'archer', 'assassin', 'shepherd', 'druid']} />
                  <Filter value={rarityFilter} onChange={setRarityFilter} label="Rarity" options={['all', ...FILTER_RARITIES]} />
                  <Filter value={levelFilter} onChange={(value) => setLevelFilter(value as typeof levelFilter)} label="Level" options={['all', '1-9', '10+']} />
                </div>
                <div className="grid h-[42px] grid-cols-3 gap-1.5">
                  {(['power', 'level'] as const).map((value) => <button type="button" key={value} onClick={() => setSort(value)} className={`game-control h-[42px] px-3 text-[9px] font-bold uppercase ${sort === value ? 'game-primary' : ''}`}>{value}</button>)}
                  <button type="button" onClick={() => { setSelectionMode((value) => !value); setSelectedUids(new Set()); }} className={`game-control h-[42px] px-3 text-[9px] font-black uppercase ${selectionMode ? 'game-primary' : ''}`}>{selectionMode ? 'Cancel selection' : 'Select heroes'}</button>
                </div>
              </div>
            </div>
          </div>
          <section className="relative overflow-hidden rounded-xl border border-[#a87b35] bg-[radial-gradient(circle_at_50%_0%,rgba(190,137,55,.2),transparent_58%),linear-gradient(160deg,#211b12,#0c0d0c)] p-3 shadow-[inset_0_1px_rgba(255,226,163,.12),0_8px_25px_rgba(0,0,0,.35)]">
            <Swords size={54} className="absolute -left-3 -top-3 rotate-[-18deg] text-[#8d6a37]/20" />
            <Shield size={58} className="absolute -bottom-4 -right-2 text-[#8d6a37]/20" />
            <div className="relative flex items-center justify-between"><span className="flex items-center gap-2 text-xs font-black uppercase tracking-[.15em] text-[#efc875]"><Users size={15} /> Active Team</span><b className="text-sm text-[#f5d98e]">{state.team.length}/3</b></div>
            <div className="relative mt-2 flex min-h-[64px] items-center justify-center gap-3">
              {state.team.map((uid) => { const hero = state.ownedHeroes.find((candidate) => candidate.uid === uid); const base = hero ? HERO_MAP[hero.heroId] : null; return hero && base ? <HeroPortrait key={uid} heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={58} active badge={hero.level} respawn={respawnCountdowns[uid] ?? 0} onClick={() => openHero(hero)} /> : null; })}
              {Array.from({ length: 3 - state.team.length }, (_, index) => <div key={index} className="grid h-[58px] w-[58px] place-items-center rounded-lg border border-dashed border-[#665333] bg-black/20"><Shield size={18} className="text-[#5c4b31]" /></div>)}
            </div>
            <div className="relative mt-1 text-center text-[9px] text-[#8f887b]">Your primary combat formation</div>
          </section>
        </div>
        {promotionNotice && <div className="anim-banner mt-2 rounded-lg border border-violet-500/45 bg-violet-950/45 px-3 py-2 text-center text-xs font-bold text-violet-200"><Sparkles size={13} className="mr-1 inline text-amber-300" />{promotionNotice}</div>}
        {selectionMode && <div className="mt-2 flex flex-wrap items-center gap-1.5"><button type="button" onClick={selectVisible} className="game-control px-3 text-[10px] font-bold">All visible</button><Filter value="all" onChange={selectRarity} label="Select rarity" options={['all', ...FILTER_RARITIES]} /><button type="button" onClick={() => setSelectedUids(new Set())} className="game-control px-3 text-[10px] font-bold">Clear</button><button type="button" disabled={selectedUids.size === 0} onClick={() => setConfirmSale(true)} className="game-control game-danger ml-auto px-3 text-[10px] font-black disabled:opacity-35"><Trash2 size={12} className="mr-1 inline" />Sell selected ({selectedUids.size})</button></div>}
      </header>
      <div className="game-scrollbar min-h-0 flex-1 overflow-y-auto p-2"><div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">{entries.map(({ base, hero }) => <HeroGridCard key={hero.uid} base={base} hero={hero} game={game} selected={selectionMode ? selectedUids.has(hero.uid) : selected?.uid === hero.uid} selectionMode={selectionMode} selectable={canSell(hero)} onSelect={() => selectionMode ? toggleSelected(hero.uid) : openHero(hero)} />)}</div>{entries.length === 0 && <div className="material-panel mx-auto mt-16 max-w-sm p-6 text-center"><Shield className="mx-auto text-[#806b49]" /><div className="mt-2 font-bold text-[#d4c9b7]">No owned heroes match these filters</div><div className="mt-1 text-xs text-[#827c72]">Change class, rarity, level or search.</div></div>}</div>
      {selected && <HeroDetailModal hero={selected} game={game} onClose={() => setSelectedUid(null)} />}
      {confirmSale && <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm"><div className="material-panel w-full max-w-sm p-5 text-center"><Trash2 className="mx-auto text-red-400" /><h3 className="mt-2 text-lg font-black text-[#eee4d3]">Sell {selectedUids.size} heroes?</h3><p className="mt-1 text-xs text-[#a49c90]">This cannot be undone. You will receive {formatNum(selectedRefund)} Gold.</p><div className="mt-4 flex gap-2"><button type="button" onClick={() => setConfirmSale(false)} className="game-control flex-1 px-3 text-xs font-bold">Cancel</button><button type="button" onClick={finishSale} className="game-control game-danger flex-1 px-3 text-xs font-black">Confirm sale</button></div></div></div>}
    </div>
  );
}

function Filter({ value, onChange, label, options }: { value: string; onChange: (value: string) => void; label: string; options: string[] }) { return <label className="flex min-w-0 items-stretch"><span className="sr-only">{label}</span><select value={value} onChange={(event) => onChange(event.target.value)} className="game-control h-[42px] w-full min-w-0 bg-[#171915] px-3 text-[10px] font-bold capitalize text-[#d1c8b9] outline-none" style={{ colorScheme: 'dark' }}>{options.map((option) => <option key={option} value={option} style={{ backgroundColor: '#171915', color: '#d1c8b9' }}>{option === 'all' ? `All ${label}` : option}</option>)}</select></label>; }
