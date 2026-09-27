import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Trophy, Crown, Medal, Swords, Skull, ChevronUp, UserRound, Sparkles, Star, Flag } from 'lucide-react';
import { formatNum } from '@/game/state';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HERO_MAP } from '@/game/heroes';
import type { GameApi } from '@/game/useGame';
import { playerSync } from '@/game/backend';
import { teamPower } from '@/game/engine';
import { PlayerReportModal } from '@/components/PlayerReportModal';

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

  return (
    <div className="premium-screen themed-screen themed-screen-ranks flex h-full flex-col overflow-hidden p-2">
      <header className="material-panel shrink-0 overflow-hidden p-3">
        <div className="grid items-center gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex items-center gap-3"><div className="grid h-14 w-14 shrink-0 place-items-center rounded-xl border border-[#9d793f] bg-[radial-gradient(circle,#6f5228,#181710)] shadow-[0_0_22px_rgba(197,145,54,.16)]"><Trophy size={29} className="text-[#efc96f]" /></div><div><div className="section-kicker">Monthly Competition</div><h2 className="mt-0.5 text-2xl font-black text-[#f0e5d2]">HeroLoop Ranks</h2><p className="mt-1 text-xs text-[#9d9689]">Ranked by Level, Kills and Boss Kills. The live server determines final order.</p></div></div>
          <div className="reward-scene flex min-h-[82px] items-center gap-3 px-4 py-3"><span className="reward-object grid h-12 w-12 place-items-center rounded-full border border-[#d2a24b] bg-black/30"><HeroTokenIcon size={34} /></span><div><div className="text-[9px] font-bold uppercase tracking-[.16em] text-[#a99a80]">Monthly $HERO rewards</div><div className="mt-0.5 text-lg font-black text-[#efca74]">Top 100 qualify</div><div className="text-[10px] text-[#aaa295]">Exact pool share is not published yet</div></div></div>
        </div>
      </header>

      <section className="mt-2 grid shrink-0 gap-2 md:grid-cols-[minmax(0,1fr)_310px]">
        <div className="grid grid-cols-3 items-end gap-2">
          {[2, 1, 3].map((rank) => <PodiumCard key={rank} rank={rank} player={board[rank - 1]} />)}
        </div>
        <div className="material-panel p-3"><div className="flex items-center justify-between"><div><div className="section-kicker">Your standing</div><div className="mt-1 text-xl font-black text-[#efc66f]">#{myRank || '—'} <span className="text-sm text-[#d9d0c0]">{state.username || 'Unranked'}</span></div></div><ChevronUp size={24} className="text-[#806c4b]" /></div><div className="mt-2 health-track h-2 overflow-hidden"><div className="h-full bg-[linear-gradient(90deg,#75521e,#d9aa4c)]" style={{ width: `${myRank ? Math.max(8, 100 - Math.min(100, myRank)) : 3}%` }} /></div><div className="mt-2 text-xs text-[#9c9588]">{progressCopy}</div><div className="mt-3 grid grid-cols-4 gap-1"><Metric icon={<Star size={12} />} label="Reward Power" value={myRow ? formatNum(myRow.power) : '—'} /><Metric icon={<Medal size={12} />} label="Collection Power" value={myRow ? formatNum(myRow.collection_power) : '—'} /><Metric icon={<UserRound size={12} />} label="Level" value={state.accountLevel} /><Metric icon={<Swords size={12} />} label="Kills" value={formatNum(state.totalKills)} /><Metric icon={<Skull size={12} />} label="Bosses" value={state.totalBossKills} /><Metric icon={<Sparkles size={12} />} label="Summons" value={formatNum(state.summons)} /><Metric icon={<HeroTokenIcon size={12} />} label="Mined" value={formatNum(state.totalTokensEarned)} /></div></div>
      </section>

      <section className="material-panel mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="grid min-w-[900px] grid-cols-[52px_minmax(300px,1fr)_64px_90px_78px_90px_105px_90px] gap-2 border-b border-[#4d402d] px-3 py-2 text-[9px] font-bold uppercase tracking-wider text-[#8c867b]"><span>Rank</span><span>Player · Active lineup</span><span>Level</span><span>Kills</span><span>Bosses</span><span>Summons</span><span>$HERO mined</span><span>Reward</span></div>
        <div className="game-scrollbar min-h-0 flex-1 overflow-auto p-2">
          {loading && <EmptyState icon={<Sparkles size={22} />} title="Reading the tournament ledger" detail="Live ranks update every 30 seconds." />}
          {!loading && board.length === 0 && <EmptyState icon={<Trophy size={22} />} title="No ranked players yet" detail="Win battles and defeat bosses to claim the first position." />}
          <div className="space-y-1.5">{board.slice(0, 100).map((player, index) => { const rank = index + 1; const isMe = player.player_id === myId; return <div key={player.player_id} className={`leader-row grid min-w-[900px] grid-cols-[52px_minmax(300px,1fr)_64px_90px_78px_90px_105px_90px] items-center gap-2 px-3 py-2 ${isMe ? 'border-[#d0a34f] bg-[#6f5120]/15' : ''}`}><span className={`font-black ${rank <= 3 ? 'text-[#ebc36c]' : 'text-[#918a7e]'}`}>{rank <= 3 ? <Medal size={16} /> : `#${rank}`}</span><RankIdentity player={player} isMe={isMe} onReport={isMe ? undefined : () => setReportTarget({ playerId: player.player_id, username: player.username })} /><b className="text-xs text-[#d0c7b8]">{player.account_level}</b><span className="text-xs tabular-nums text-[#b9b1a4]">{formatNum(player.total_kills)}</span><span className="text-xs tabular-nums text-[#b9b1a4]">{formatNum(player.boss_kills)}</span><span className="text-xs tabular-nums text-[#b9b1a4]">{formatNum(player.summons)}</span><span className="flex items-center gap-1 text-xs tabular-nums text-[#e5bb62]"><HeroTokenIcon size={13} />{formatNum(player.total_tokens_earned)}</span><span className={`text-[10px] font-bold ${rank <= 100 ? 'text-[#e5bb62]' : 'text-[#746f66]'}`}>{rank <= 100 ? 'Pool share' : '—'}</span></div>; })}</div>
        </div>
      </section>
      {reportTarget && <PlayerReportModal target={reportTarget} onClose={() => setReportTarget(null)} />}
    </div>
  );
}

function RankIdentity({ player, isMe, onReport }: { player: LeaderRow; isMe: boolean; onReport?: () => void }) {
  const lineup = Array.isArray(player.lineup) ? player.lineup : [];
  const avatar = HERO_MAP[player.avatar_hero_id] ?? HERO_MAP[lineup[0]?.hero_id];
  return <span className="flex min-w-0 items-center gap-2">{avatar ? <span className="rank-avatar"><HeroPortrait heroId={avatar.id} heroClass={avatar.heroClass} rarity={avatar.rarity} color={avatar.color} size={48} /></span> : <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-[#725a35] bg-black/35 text-xs font-black">{player.username.slice(0, 2).toUpperCase()}</span>}<span className="min-w-0 flex-1"><b className={`block truncate text-xs ${isMe ? 'text-[#f2ca72]' : 'text-[#e4ddcf]'}`}>{player.username}</b><span className="text-[9px] text-[#7f796f]">Reward Power {formatNum(player.power)} · Collection Power {formatNum(player.collection_power)} {player.online && <i className="not-italic text-emerald-400">● online</i>}</span></span>{onReport && <button type="button" onClick={onReport} className="game-control grid h-8 w-8 shrink-0 place-items-center text-[#8f877a] hover:text-[#e5bb62]" aria-label={`Report ${player.username}`} title="Report player"><Flag size={13} /></button>}<span className="flex shrink-0 gap-1">{lineup.map((entry, index) => { const hero = HERO_MAP[entry.hero_id]; return hero ? <span key={`${entry.hero_id}-${index}`} className="text-center"><HeroPortrait heroId={hero.id} heroClass={hero.heroClass} rarity={hero.rarity} color={hero.color} size={30} badge={entry.level} /><span className="mt-0.5 flex items-center justify-center gap-0.5 text-[8px] font-black text-[#efc65d]"><Star size={8} fill="currentColor" />{entry.stars}</span></span> : null; })}</span></span>;
}

function PodiumCard({ rank, player }: { rank: number; player?: LeaderRow }) { const metal = rank === 1 ? '#e0b85d' : rank === 2 ? '#adb5bd' : '#ad7145'; return <div className={`material-panel p-2 text-center ${rank === 1 ? 'min-h-[112px]' : 'min-h-[96px]'}`} style={{ borderColor: metal }}><div className="mx-auto grid h-8 w-8 place-items-center rounded-full border bg-black/30" style={{ borderColor: metal, color: metal }}>{rank === 1 ? <Crown size={16} /> : <Medal size={15} />}</div><div className="mt-1 truncate text-xs font-black text-[#e8dfd0]">{player?.username ?? `Rank ${rank} open`}</div><div className="mt-0.5 text-[9px]" style={{ color: metal }}>#{rank} · {player ? `Lv ${player.account_level}` : 'Unclaimed'}</div></div>; }
function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string | number }) { return <div className="stat-tile p-1.5 text-center"><span className="flex items-center justify-center gap-1 text-[8px] uppercase text-[#777268]">{icon}{label}</span><b className="mt-0.5 block text-xs text-[#ddd3c2]">{value}</b></div>; }
function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) { return <div className="mx-auto my-12 max-w-sm text-center text-[#887f70]"><span className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-[#55452e] bg-black/25">{icon}</span><div className="mt-2 font-bold text-[#d4cabb]">{title}</div><div className="mt-1 text-xs">{detail}</div></div>; }
