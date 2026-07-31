import { Trophy, Crown, Medal } from 'lucide-react';
import { formatNum } from '@/game/state';
import type { GameApi } from '@/game/useGame';

function generateMockBoard(myName: string, myLevel: number) {
  const names = ['DragonSlayer', 'FrostQueen', 'VoidWalker', 'ShadowKing', 'ThunderGod', 'MysticSage', 'RoyalGuard', 'WindRider', 'IronFist', 'NightBlade', 'StarHunt', 'BloodRaven', 'IceBreaker', 'FlameSeer', 'StormChaser', 'MoonHunter', 'SunStriker', 'DeathRogue', 'LifeSage', 'ChaosRider'];
  const board = names.map((n, i) => ({
    name: n,
    level: Math.max(1, 75 - i * 2 + Math.floor(Math.random() * 3)),
    kills: Math.floor((100000 - i * 5000) * (0.8 + Math.random() * 0.4)),
    bosses: Math.floor((500 - i * 25) * (0.8 + Math.random() * 0.4)),
  }));
  board.push({ name: myName || 'YOU', level: myLevel, kills: 0, bosses: 0 });
  board.sort((a, b) => b.level - a.level || b.kills - a.kills);
  return board.map((p, i) => ({ ...p, rank: i + 1 }));
}

export function LeaderboardScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const board = generateMockBoard(state.username || 'YOU', state.accountLevel);
  const myRank = board.find(p => p.name === (state.username || 'YOU'));

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-4 py-2 border-b-2 border-px-border bg-px-panel shrink-0">
        <h2 className="font-pixel text-sm text-gold-glow flex items-center gap-2"><Trophy size={16} className="text-px-bright" /> LEADERBOARD</h2>
        <p className="font-vt text-px-dim text-xs mt-0.5">Top 100 players earn monthly $HERO rewards. Ranked by level, kills & boss kills.</p>
      </div>

      <div className="px-4 py-2 border-b-2 border-px-border bg-px-panel2 shrink-0">
        <div className="flex items-center justify-between text-xs font-vt">
          <span className="text-px-dim">YOUR RANK</span>
          <span className="text-px-bright font-bold">#{myRank?.rank ?? '—'} · {state.username || 'YOU'} · Lv{state.accountLevel}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto no-scrollbar p-3">
        <div className="space-y-1">
          {board.slice(0, 50).map((p) => {
            const isMe = p.name === (state.username || 'YOU');
            return (
              <div
                key={p.rank}
                className={`flex items-center gap-3 px-3 py-2 border-2 ${isMe ? 'border-px-bright bg-px-gold/10' : 'border-px-border bg-px-panel'}`}
                style={{ boxShadow: '2px 2px 0 #2a1504', transform: isMe ? 'translateX(-2px)' : 'none' }}
              >
                <div className={`w-8 text-center font-pixel text-xs ${p.rank <= 3 ? 'text-px-bright' : 'text-px-dim'}`}>
                  {p.rank <= 3 ? <Crown size={14} className="inline" /> : `#${p.rank}`}
                </div>
                <div className="w-8 h-8 border-2 border-px-border bg-px-panel2 flex items-center justify-center font-pixel text-[8px] text-px-text">{p.name.slice(0, 2).toUpperCase()}</div>
                <div className="flex-1 min-w-0">
                  <div className={`font-vt text-sm font-bold truncate ${isMe ? 'text-px-bright' : 'text-px-text'}`}>{p.name}</div>
                  <div className="font-vt text-[10px] text-px-dim">Lv {p.level} · {formatNum(p.kills)} kills · {p.bosses} bosses</div>
                </div>
                {p.rank <= 3 && <Medal size={14} className={p.rank === 1 ? 'text-px-bright' : p.rank === 2 ? 'text-gray-300' : 'text-orange-700'} />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="px-4 py-2 border-t-2 border-px-border bg-px-panel shrink-0 text-center">
        <span className="font-vt text-px-dim text-xs">Next distribution: end of month · Top 100 share $HERO pool</span>
      </div>
    </div>
  );
}
