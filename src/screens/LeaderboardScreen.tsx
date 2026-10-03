import { isolatedHackathon } from '@/game/editionStorage';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Trophy, Crown, Medal, Swords, Skull, ChevronUp, UserRound, Sparkles, Star, Flag } from 'lucide-react';
import { formatNum } from '@/game/state';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HERO_MAP } from '@/game/heroes';
import type { GameApi } from '@/game/useGame';
import { playerSync } from '@/game/backend';
import { teamPower } from '@/game/engine';
import { PlayerReportModal } from '@/components/PlayerReportModal';
import { isAndroidLayout } from '@/platform/platform';
import '@/theme/scene/scene.css';

interface RankHero { hero_id: string; level: number; stars: number; }
interface LeaderRow { player_id: string; username: string; account_level: number; power: number; collection_power: number; total_kills: number; boss_kills: number; online: boolean; lineup: RankHero[]; avatar_hero_id: string; summons: number; total_tokens_earned: number; }

export function LeaderboardScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const [board, setBoard] = useState<LeaderRow[]>([]);
  const [myId, setMyId] = useState('');
  const [loading, setLoading] = useState(true);
  const [reportTarget, setReportTarget] = useState<{ playerId: string; username: string } | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        await playerSync('sync', {
          power: teamPower(state.ownedHeroes, state.inventory), account_level: state.accountLevel,
          username: state.username, total_kills: state.totalKills, boss_kills: state.totalBossKills,
          chests_opened: state.session.chestsOpened, heroes_owned: state.ownedHeroes.length,
          highest_location: state.highestLocation,
          lineup: state.team.map((uid) => state.ownedHeroes.find((hero) => hero.uid === uid)).filter((hero) => Boolean(hero)).map((hero) => ({ hero_id: hero!.heroId, level: hero!.level, stars: hero!.stars })),
          avatar_hero_id: state.avatarHeroId, summons: state.summons, total_tokens_earned: state.totalTokensEarned,
        });
        const data = await playerSync<{ players: LeaderRow[]; me: string }>('leaderboard');
        if (data) { setBoard(data.players ?? []); setMyId(data.me ?? ''); }
      } finally { setLoading(false); }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [state.ownedHeroes, state.inventory, state.accountLevel, state.username, state.totalKills, state.totalBossKills, state.session.chestsOpened, state.highestLocation, state.avatarHeroId, state.summons, state.totalTokensEarned, state.team]);

  const myRank = board.findIndex((player) => player.player_id === myId) + 1;
  const myRow = myId ? board.find((player) => player.player_id === myId) : undefined;
  const progressCopy = useMemo(() => {
    if (!myRank) return 'Complete battles to enter the ranking';
    if (myRank === 1) return 'Current monthly leader';
    if (myRank <= 3) return `${myRank - 1} position${myRank > 2 ? 's' : ''} to #1`;
    if (myRank <= 100) return `${myRank - 3} positions to the Top 3`;
    return `${myRank - 100} positions to monthly reward eligibility`;
  }, [myRank]);

  const still = state.battleAnimationMode === 'off';
  return (
    <div className={`sc-root rk-root${still ? ' sc-still' : ''}`}>
      <section className="sc-stage rk-hall" aria-label="Hall of Ranks">
        <div className="sc-stage-art" aria-hidden="true" />
        <div className="sc-glow" aria-hidden="true" />
        {!still && <div className="sc-embers" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6].map((i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>}
        <header className="sc-head"><span className="sc-kicker">Monthly Competition</span><h2 className="sc-title">HeroLoop Ranks</h2><p className="sc-lede">Ranked by Level, Kills and Boss Kills. The live server determines final order.</p></header>
        <div className="rk-podium">{[2, 1, 3].map((rank) => <PodiumCard key={rank} rank={rank} player={board[rank - 1]} />)}</div>
        <div className="rk-reward"><HeroTokenIcon size={26} /><span><small>Monthly {isolatedHackathon ? 'SKR' : '$HERO'} rewards</small><b>{isolatedHackathon ? 'Coming soon' : 'Top 100 qualify'}</b><em>{isolatedHackathon ? 'SKR rewards and pool verification are not connected yet' : 'Exact pool share is not published yet'}</em></span></div>
      </section>

      <div className="sc-body">
      <section className="sc-panel rk-standing">
        <div className="sc-section-head"><span>Your standing</span><ChevronUp size={18} /></div>
        <div className="rk-me"><b>#{myRank || '—'}</b><span>{state.username || 'Unranked'}</span></div>
        <div className="rk-track"><i style={{ width: `${myRank ? Math.max(8, 100 - Math.min(100, myRank)) : 3}%` }} /></div>
        <p className="sc-muted rk-progress">{progressCopy}</p>
        <div className="rk-metrics"><Metric icon={<Star size={12} />} label="Reward Power" value={myRow ? formatNum(myRow.power) : '—'} /><Metric icon={<Medal size={12} />} label="Collection Power" value={myRow ? formatNum(myRow.collection_power) : '—'} /><Metric icon={<UserRound size={12} />} label="Level" value={state.accountLevel} /><Metric icon={<Swords size={12} />} label="Kills" value={formatNum(state.totalKills)} /><Metric icon={<Skull size={12} />} label="Bosses" value={state.totalBossKills} /><Metric icon={<Sparkles size={12} />} label="Summons" value={formatNum(state.summons)} /><Metric icon={<HeroTokenIcon size={12} />} label="Mined" value={formatNum(state.totalTokensEarned)} /></div>
      </section>

      <section className="sc-panel rk-table">
        <div className="sc-section-head"><span>Top 100</span></div>
        <div className="rank-scroll game-scrollbar overflow-x-auto" tabIndex={0} aria-label="Rankings: scroll horizontally for all statistics">
          {!isAndroidLayout && <div className="leader-head grid min-w-[900px] grid-cols-[52px_minmax(300px,1fr)_64px_90px_78px_90px_105px_90px] gap-2 border-b border-[#4d402d] px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-[#8c867b]"><span>Rank</span><span>Player · Active lineup</span><span>Level</span><span>Kills</span><span>Bosses</span><span>Summons</span><span>{isolatedHackathon ? 'SKR mined' : '$HERO mined'}</span><span>Reward</span></div>}
          {loading && <EmptyState icon={<Sparkles size={22} />} title="Reading the tournament ledger" detail="Live ranks update every 30 seconds." />}
          {!loading && board.length === 0 && <EmptyState icon={<Trophy size={22} />} title="No ranked players yet" detail="Win battles and defeat bosses to claim the first position." />}
          {isAndroidLayout ? <div className="rank-cards">{board.slice(0, 100).map((player, index) => <RankCard key={player.player_id} rank={index + 1} player={player} isMe={player.player_id === myId} onReport={player.player_id === myId ? undefined : () => setReportTarget({ playerId: player.player_id, username: player.username })} />)}</div> : <div className="space-y-1.5">{board.slice(0, 100).map((player, index) => { const rank = index + 1; const isMe = player.player_id === myId; return <div key={player.player_id} className={`leader-row grid min-w-[900px] grid-cols-[52px_minmax(300px,1fr)_64px_90px_78px_90px_105px_90px] items-center gap-2 px-3 py-2 ${isMe ? 'border-[#d0a34f] bg-[#6f5120]/15' : ''}`}><span className={`font-black ${rank <= 3 ? 'text-[#ebc36c]' : 'text-[#918a7e]'}`}>#{rank}</span><RankIdentity player={player} isMe={isMe} onReport={isMe ? undefined : () => setReportTarget({ playerId: player.player_id, username: player.username })} /><b className="text-xs text-[#d0c7b8]">{player.account_level}</b><span className="text-xs tabular-nums text-[#b9b1a4]">{formatNum(player.total_kills)}</span><span className="text-xs tabular-nums text-[#b9b1a4]">{formatNum(player.boss_kills)}</span><span className="text-xs tabular-nums text-[#b9b1a4]">{formatNum(player.summons)}</span><span className="flex items-center gap-1 text-xs tabular-nums text-[#e5bb62]"><HeroTokenIcon size={13} />{isolatedHackathon ? '—' : formatNum(player.total_tokens_earned)}</span><span className={`text-[10px] font-bold ${rank <= 100 ? 'text-[#e5bb62]' : 'text-[#746f66]'}`}>{rank <= 100 ? 'Pool share' : '—'}</span></div>; })}</div>}
        </div>
      </section>
      </div>
      {reportTarget && <PlayerReportModal target={reportTarget} onClose={() => setReportTarget(null)} />}
    </div>
  );
}

function RankIdentity({ player, isMe, onReport }: { player: LeaderRow; isMe: boolean; onReport?: () => void }) {
  const lineup = Array.isArray(player.lineup) ? player.lineup : [];
  const avatar = HERO_MAP[player.avatar_hero_id] ?? HERO_MAP[lineup[0]?.hero_id];
  return <span className="flex min-w-0 items-center gap-2">{avatar ? <span className="rank-avatar"><HeroPortrait heroId={avatar.id} heroClass={avatar.heroClass} rarity={avatar.rarity} color={avatar.color} size={48} /></span> : <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-[#725a35] bg-black/35 text-xs font-black">{player.username.slice(0, 2).toUpperCase()}</span>}<span className="min-w-0 flex-1"><b className={`block truncate text-xs ${isMe ? 'text-[#f2ca72]' : 'text-[#e4ddcf]'}`}>{player.username}</b><span className="text-[9px] text-[#7f796f]">Reward Power {formatNum(player.power)} · Collection Power {formatNum(player.collection_power)} {player.online && <i className="not-italic text-emerald-400">● online</i>}</span></span>{onReport && <button type="button" onClick={onReport} className="game-control grid h-8 w-8 shrink-0 place-items-center text-[#8f877a] hover:text-[#e5bb62]" aria-label={`Report ${player.username}`} title="Report player"><Flag size={13} /></button>}<span className="flex shrink-0 gap-1">{lineup.map((entry, index) => { const hero = HERO_MAP[entry.hero_id]; return hero ? <span key={`${entry.hero_id}-${index}`} className="text-center"><HeroPortrait heroId={hero.id} heroClass={hero.heroClass} rarity={hero.rarity} color={hero.color} size={30} badge={entry.level} /><span className="mt-0.5 flex items-center justify-center gap-0.5 text-[8px] font-black text-[#efc65d]"><Star size={8} fill="currentColor" />{entry.stars}</span></span> : null; })}</span></span>;
}

// Phone ranking: one card per player instead of a 900px table, so the name, avatar and the
// whole active lineup stay readable without horizontal scrolling.
function RankCard({ rank, player, isMe, onReport }: { rank: number; player: LeaderRow; isMe: boolean; onReport?: () => void }) {
  const lineup = Array.isArray(player.lineup) ? player.lineup : [];
  const avatar = HERO_MAP[player.avatar_hero_id] ?? HERO_MAP[lineup[0]?.hero_id];
  const stats: [ReactNode, string, string][] = [
    [<Swords key="k" size={11} />, 'Kills', formatNum(player.total_kills)],
    [<Skull key="b" size={11} />, 'Bosses', formatNum(player.boss_kills)],
    [<Sparkles key="s" size={11} />, 'Summons', formatNum(player.summons)],
    [<HeroTokenIcon key="t" size={11} />, isolatedHackathon ? 'SKR' : '$HERO', isolatedHackathon ? '—' : formatNum(player.total_tokens_earned)],
  ];
  return <article className={`rank-card ${rank <= 3 ? `rank-card-top rank-card-top-${rank}` : ''} ${isMe ? 'rank-card-me' : ''}`}>
    <div className="rank-card-head">
      <span className="rank-card-rank">#{rank}</span>
      {avatar ? <span className="rank-avatar"><HeroPortrait heroId={avatar.id} heroClass={avatar.heroClass} rarity={avatar.rarity} color={avatar.color} size={44} /></span> : <span className="rank-avatar rank-avatar-initials">{player.username.slice(0, 2).toUpperCase()}</span>}
      <span className="rank-card-id">
        <b className={isMe ? 'text-[#f2ca72]' : 'text-[#ece4d4]'}>{player.username}</b>
        <span>Lv {player.account_level}{player.online && <i className="not-italic text-emerald-400"> · ● online</i>}</span>
        <span>Power {formatNum(player.power)} · Collection {formatNum(player.collection_power)}</span>
      </span>
      {onReport && <button type="button" onClick={onReport} className="game-control rank-card-report grid shrink-0 place-items-center text-[#8f877a] hover:text-[#e5bb62]" aria-label={`Report ${player.username}`} title="Report player"><Flag size={13} /></button>}
    </div>
    {lineup.length > 0 && <div className="rank-card-lineup" aria-label="Active lineup">{lineup.map((entry, index) => { const hero = HERO_MAP[entry.hero_id]; return hero ? <span key={`${entry.hero_id}-${index}`} className="rank-card-hero"><HeroPortrait heroId={hero.id} heroClass={hero.heroClass} rarity={hero.rarity} color={hero.color} size={44} /><span className="rank-card-hero-meta"><b>Lv {entry.level}</b><span><Star size={8} fill="currentColor" />{entry.stars}</span></span></span> : null; })}</div>}
    <div className="rank-card-stats">{stats.map(([icon, label, value]) => <span key={label}><small>{icon}{label}</small><b>{value}</b></span>)}</div>
  </article>;
}

function PodiumCard({ rank, player }: { rank: number; player?: LeaderRow }) {
  const lineup = player && Array.isArray(player.lineup) ? player.lineup : [];
  const avatar = player ? HERO_MAP[player.avatar_hero_id] ?? HERO_MAP[lineup[0]?.hero_id] : undefined;
  return <div className={`rk-seat rk-seat-${rank}`}>
    <span className="rk-seat-crest">{rank === 1 ? <Crown size={16} /> : <Medal size={14} />}</span>
    <span className="rk-seat-hero">{avatar ? <HeroPortrait heroId={avatar.id} heroClass={avatar.heroClass} rarity={avatar.rarity} color={avatar.color} size={rank === 1 ? 74 : 60} /> : <span className="rk-seat-empty">{player ? player.username.slice(0, 2).toUpperCase() : '?'}</span>}</span>
    <span className="rk-seat-plinth"><b>{player?.username ?? `Rank ${rank} open`}</b><small>#{rank} · {player ? `Lv ${player.account_level}` : 'Unclaimed'}</small></span>
  </div>;
}
function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) { return <div className="rk-metric"><span>{icon}{label}</span><b>{value}</b></div>; }
function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="mx-auto my-12 max-w-sm text-center text-[#887f70]"><span className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-[#55452e] bg-black/25">{icon}</span><div className="mt-2 font-bold text-[#d4cabb]">{title}</div><div className="mt-1 text-xs">{detail}</div></div>; }
