import { useMemo, useState } from 'react';
import { Star, Trash2, Lock, Unlock, Search, X, Zap } from 'lucide-react';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HERO_MAP, RARITY_COLORS, RARITY_LABEL, RARITY_INDEX, CLASS_LABEL, CLASS_ICON } from '@/game/heroes';
import { formatNum, starUpCost, STAR_DUPES, heroXpForLevel, heroLevelFromXp } from '@/game/state';
import { heroStats, getEquippedItems } from '@/game/engine';
import type { OwnedHero } from '@/game/types';
import type { GameApi } from '@/game/useGame';

function HeroGridCard({ hero, isInTeam, onToggle, onSelect, respawn, locked }: { hero: OwnedHero; isInTeam: boolean; onToggle: () => void; onSelect: () => void; respawn: number; locked: boolean }) {
  const base = HERO_MAP[hero.heroId]; if (!base) return null;
  const rc = RARITY_COLORS[base.rarity];
  const isDead = respawn > 0;
  return (
    <div className="relative rounded-lg border p-1.5 transition cursor-pointer hover:scale-[1.02]" style={{ borderColor: rc + (isInTeam ? 'aa' : '44'), background: `linear-gradient(160deg, ${rc}12, rgba(10,10,20,0.7))`, boxShadow: isInTeam ? `0 0 10px ${rc}44` : 'none' }} onClick={onSelect}>
      {isInTeam && <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-slate-950 flex items-center justify-center"><Star size={8} className="text-white fill-white" /></div>}
      {locked && <div className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-slate-700 border-2 border-slate-950 flex items-center justify-center"><Lock size={8} className="text-amber-300" /></div>}
      <div className="flex justify-center"><HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={64} onClick={onToggle} active={isInTeam} badge={hero.level} respawn={respawn} /></div>
      <div className="text-center mt-1"><div className="text-[10px] font-bold truncate" style={{ color: rc }}>{base.name}</div><div className="flex items-center justify-center gap-0.5 mt-0.5">{Array.from({ length: 5 }).map((_, i) => <Star key={i} size={7} className={i < hero.stars ? 'text-amber-400 fill-amber-400' : 'text-slate-700'} />)}</div></div>
      {isDead && <div className="text-center text-[9px] text-rose-400 font-bold">{respawn}s</div>}
    </div>
  );
}

function HeroDetailModal({ hero, game, onClose }: { hero: OwnedHero; game: GameApi; onClose: () => void }) {
  const base = HERO_MAP[hero.heroId];
  const items = getEquippedItems(hero, game.state.inventory);
  const stats = heroStats(hero, items);
  if (!base || !stats) return null;
  const rc = RARITY_COLORS[base.rarity];
  const starCost = starUpCost(hero.stars);
  const dupes = game.state.ownedHeroes.filter(h => h.heroId === hero.heroId && h.uid !== hero.uid && !h.locked);
  const xpNeed = heroXpForLevel(hero.level);
  const isInTeam = game.state.team.includes(hero.uid);
  const { level } = heroLevelFromXp(hero.xp + stats.atk); void level;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur p-4 anim-fade" onClick={onClose}>
      <div className="relative w-full max-w-md rounded-2xl border overflow-hidden anim-slide-up max-h-[85vh] flex flex-col" style={{ borderColor: rc + '55', background: `linear-gradient(160deg, ${rc}12, #0a0a14)` }} onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 p-4 border-b border-white/10">
          <HeroPortrait heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={88} active={isInTeam} badge={hero.level} />
          <div className="flex-1 min-w-0">
            <div className="font-bold text-lg" style={{ color: rc }}>{base.name}</div>
            <div className="text-xs text-slate-500">{RARITY_LABEL[base.rarity]} · {CLASS_LABEL[base.heroClass]} {CLASS_ICON[base.heroClass]}</div>
            <div className="flex items-center gap-0.5 mt-1">{Array.from({ length: 5 }).map((_, i) => <Star key={i} size={12} className={i < hero.stars ? 'text-amber-400 fill-amber-400' : 'text-slate-700'} />)}</div>
            <div className="mt-1 h-1.5 rounded-full bg-black/50 overflow-hidden"><div className="h-full bg-emerald-400/70" style={{ width: `${Math.min(100, (hero.xp / xpNeed) * 100)}%` }} /></div>
            <div className="text-[9px] text-slate-500">Lv {hero.level} · {formatNum(hero.xp)}/{formatNum(xpNeed)} XP</div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full bg-slate-800"><X size={16} className="text-slate-400" /></button>
        </div>

        <div className="overflow-y-auto no-scrollbar p-4 space-y-3">
          {/* Stats */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <StatBox label="HP" value={formatNum(stats.hp)} color="text-emerald-300" />
            <StatBox label="ATK" value={formatNum(stats.atk)} color="text-rose-300" />
            <StatBox label="DEF" value={formatNum(stats.def)} color="text-sky-300" />
            <StatBox label="Crit %" value={`${(stats.critChance * 100).toFixed(1)}%`} color="text-amber-300" />
            <StatBox label="Crit Dmg" value={`${(stats.critDamage * 100).toFixed(0)}%`} color="text-orange-300" />
            <StatBox label="Dodge" value={`${(stats.dodge * 100).toFixed(1)}%`} color="text-violet-300" />
            <StatBox label="Atk Spd" value={`+${stats.atkSpeed}`} color="text-cyan-300" />
            <StatBox label="Gold %" value={`+${(stats.goldBonus * 100).toFixed(0)}%`} color="text-amber-300" />
            <StatBox label="XP %" value={`+${(stats.xpBonus * 100).toFixed(0)}%`} color="text-emerald-300" />
          </div>

          {/* Passive + Skill */}
          <div className="rounded-lg bg-white/5 p-2.5"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Passive</div><div className="text-xs mt-0.5" style={{ color: rc }}>{base.passiveName}</div><div className="text-[11px] text-slate-400 italic">{base.passiveDesc}</div></div>
          <div className="rounded-lg bg-white/5 p-2.5"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Skill</div><div className="text-xs mt-0.5" style={{ color: rc }}>{base.skillName}</div><div className="text-[11px] text-slate-400 italic">{base.skillDesc}</div></div>

          {/* Star up */}
          <div className="rounded-lg bg-purple-500/10 border border-purple-500/30 p-3">
            <div className="flex items-center justify-between mb-1"><span className="flex items-center gap-1.5 text-purple-300 text-sm font-semibold"><Star size={13} /> Star Up → {hero.stars + 1}</span><span className="text-purple-200 text-xs">{dupes.length}/{starCost.dupes} dupes · {starCost.hero} $HERO</span></div>
            <button onClick={() => game.starUpHero(hero.uid)} disabled={dupes.length < starCost.dupes || game.state.hero < starCost.hero || hero.stars >= 5} className="w-full py-2 rounded-lg bg-purple-500/20 border border-purple-500/40 text-purple-200 text-xs font-bold hover:bg-purple-500/30 disabled:opacity-40 transition">{hero.stars >= 5 ? 'MAX STARS' : `Consume ${starCost.dupes} duplicates + ${starCost.hero} $HERO`}</button>
            <div className="text-[9px] text-slate-500 mt-1">Path: {STAR_DUPES.slice(1).join(' → ')} duplicates</div>
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <button onClick={() => game.toggleTeamMember(hero.uid)} className={`flex-1 py-2.5 rounded-lg text-xs font-bold transition ${isInTeam ? 'bg-rose-500/15 border border-rose-500/40 text-rose-300' : 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-300'}`}>{isInTeam ? 'Remove from Team' : 'Add to Team'}</button>
            <button onClick={() => game.toggleHeroLock(hero.uid)} className="px-3 rounded-lg bg-slate-800 border border-white/10" title="Lock">{hero.locked ? <Lock size={15} className="text-amber-300" /> : <Unlock size={15} className="text-slate-500" />}</button>
            <button onClick={() => { game.sellHero(hero.uid); onClose(); }} className="px-3 rounded-lg bg-rose-500/10 border border-rose-500/30" title="Sell"><Trash2 size={15} className="text-rose-400" /></button>
          </div>
          <div className="text-[9px] text-slate-600 text-center">Heroes level up automatically from battle XP. No gold needed.</div>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return <div className="rounded-lg bg-white/5 p-2 text-center"><div className="text-[9px] text-slate-500 uppercase">{label}</div><div className={`text-sm font-bold ${color}`}>{value}</div></div>;
}

export function HeroesScreen({ game }: { game: GameApi }) {
  const { state, respawnCountdowns } = game;
  const [sort, setSort] = useState<'rarity' | 'level' | 'power'>('rarity');
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<OwnedHero | null>(null);

  const sorted = useMemo(() => {
    let list = [...state.ownedHeroes];
    if (filter !== 'all') list = list.filter(h => HERO_MAP[h.heroId]?.heroClass === filter);
    if (search) list = list.filter(h => HERO_MAP[h.heroId]?.name.toLowerCase().includes(search.toLowerCase()));
    list.sort((a, b) => {
      if (sort === 'level') return b.level - a.level;
      if (sort === 'rarity') { const ra = RARITY_INDEX[HERO_MAP[a.heroId]?.rarity ?? 'common']; const rb = RARITY_INDEX[HERO_MAP[b.heroId]?.rarity ?? 'common']; return rb - ra || b.stars - a.stars; }
      const sa = heroStats(a, getEquippedItems(a, state.inventory)); const sb = heroStats(b, getEquippedItems(b, state.inventory));
      return ((sb?.atk ?? 0) + (sb?.hp ?? 0) / 10) - ((sa?.atk ?? 0) + (sa?.hp ?? 0) / 10);
    });
    return list;
  }, [state.ownedHeroes, sort, filter, search, state.inventory]);

  const classes = ['all', 'knight', 'archer', 'assassin', 'shepherd', 'druid'];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-white/10 bg-slate-950/60 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-bold text-white">Heroes <span className="text-slate-500 text-sm">({state.ownedHeroes.length})</span></h2>
          <div className="flex items-center gap-1.5"><span className="text-[10px] text-slate-500">Team</span><span className="text-amber-300 font-bold text-sm">{state.team.length}/3</span></div>
        </div>
        <div className="flex items-center gap-2 mb-3">
          {Array.from({ length: 3 }).map((_, i) => {
            const uid = state.team[i]; const hero = uid ? state.ownedHeroes.find(h => h.uid === uid) : null; const base = hero ? HERO_MAP[hero.heroId] : null;
            if (hero && base) return <HeroPortrait key={hero.uid} heroId={base.id} heroClass={base.heroClass} rarity={base.rarity} color={base.color} size={50} active badge={hero.level} respawn={respawnCountdowns[hero.uid] ?? 0} onClick={() => game.toggleTeamMember(hero.uid)} />;
            return <div key={i} className="w-11 h-11 rounded-xl border-2 border-dashed border-white/15 flex items-center justify-center"><Star size={14} className="text-slate-700" /></div>;
          })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[120px]"><Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." className="w-full pl-7 pr-2 py-1.5 rounded-lg bg-slate-800/60 border border-white/10 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-amber-500/40" /></div>
          <div className="flex gap-1">{(['rarity', 'power', 'level'] as const).map(s => <button key={s} onClick={() => setSort(s)} className={`px-2 py-1 rounded text-[9px] font-bold uppercase transition ${sort === s ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-slate-800 text-slate-500 border border-white/5'}`}>{s}</button>)}</div>
        </div>
        <div className="flex gap-1 mt-2 flex-wrap">{classes.map(c => <button key={c} onClick={() => setFilter(c)} className={`px-2 py-0.5 rounded-full text-[9px] font-semibold capitalize transition ${filter === c ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30' : 'bg-slate-800/60 text-slate-500 border border-white/5'}`}>{c === 'all' ? 'All' : CLASS_LABEL[c as keyof typeof CLASS_LABEL]}</button>)}</div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar p-3">
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2">
          {sorted.map(hero => <HeroGridCard key={hero.uid} hero={hero} isInTeam={state.team.includes(hero.uid)} onToggle={() => game.toggleTeamMember(hero.uid)} onSelect={() => setSelected(hero)} respawn={respawnCountdowns[hero.uid] ?? 0} locked={hero.locked ?? false} />)}
        </div>
        {sorted.length === 0 && <div className="text-center text-slate-500 py-12 text-sm">No heroes found. Summon some with $HERO tokens!</div>}
      </div>

      {selected && <HeroDetailModal hero={selected} game={game} onClose={() => setSelected(null)} />}
    </div>
  );
}

void Zap;
