import { useState } from 'react';
import { X, CalendarDays, Timer, TrendingUp, Crown, CheckCircle2, Circle, Coins, Sparkles, Clock3 } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { GameApi } from '@/game/useGame';
import type { TokenomicsApi } from '@/game/useTokenomics';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';

export function BoostMaxModal({ game, tokenomics, onClose }: { game: GameApi; tokenomics: TokenomicsApi; onClose: () => void }) {
  const [updating, setUpdating] = useState(false);
  const boost = tokenomics.status?.boost;
  const active = boost?.active ?? false;
  const tasks = [
    { key: 'days', label: 'Play today', icon: <CalendarDays size={15} />, done: (boost?.login_days ?? 0) >= 1, detail: `${Math.min(boost?.login_days ?? 0, 1)}/1 day` },
    { key: 'online', label: 'Stay online for 1 minute', icon: <Timer size={15} />, done: (boost?.online_seconds ?? 0) >= 60, detail: `${Math.min(Math.floor(boost?.online_seconds ?? 0), 60)}/60 sec` },
    { key: 'earned', label: 'Earn 10 $HERO', icon: <HeroTokenIcon size={15} />, done: (boost?.tokens_earned ?? 0) >= 10, detail: `${Math.min(Math.floor(boost?.tokens_earned ?? 0), 10)}/10` },
    { key: 'spent', label: 'Spend 10 $HERO in game', icon: <HeroTokenIcon size={15} />, done: (boost?.tokens_spent ?? 0) >= 10, detail: `${Math.min(Math.floor(boost?.tokens_spent ?? 0), 10)}/10` },
    { key: 'hold', label: 'Hold 1,000 $HERO', icon: <HeroTokenIcon size={15} />, done: (boost?.token_balance ?? 0) >= 1000, detail: `${Math.min(Math.floor(boost?.token_balance ?? 0), 1000)}/1,000` },
  ];
  const ready = tasks.every((task) => task.done);
  const completedTasks = tasks.filter((task) => task.done).length;
  const progress = Math.round((completedTasks / tasks.length) * 100);
  const status = active ? 'Active' : ready ? 'Available' : 'Unavailable';
  const setActive = async (nextActive: boolean) => {
    setUpdating(true);
    const updated = await tokenomics.setBoostMaxActive(nextActive);
    if (updated) {
      const completed = [updated.login_days >= 1, updated.online_seconds >= 60, updated.tokens_earned >= 10, updated.tokens_spent >= 10, updated.token_balance >= 1000].filter(Boolean).length;
      game.applyServerBoostStatus(updated.active, completed * 20);
    }
    setUpdating(false);
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-3 backdrop-blur-[2px] anim-fade" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="px-panel-raised relative flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl">
        <header className="flex items-start justify-between border-b border-[#5d4a2f] px-4 py-3">
          <div>
            <div className="section-kicker">Acceleration Protocol</div>
            <h2 className={`mt-1 flex items-center gap-2 text-2xl font-black ${active ? 'boost-max-title-active' : 'text-[#f1d188]'}`}><Crown size={23} /> BOOST MAX</h2>
            <p className="mt-1 text-xs text-[#aaa397]">Accelerate token progress and keep offline gains running continuously.</p>
          </div>
          <button type="button" onClick={onClose} className="game-control grid h-9 w-9 place-items-center" aria-label="Close Boost Max"><X size={16} /></button>
        </header>

        <div className="game-scrollbar min-h-0 overflow-y-auto p-4">
          <div className="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
            <section className="reward-scene min-h-[190px] p-4" aria-label="Boost rewards">
              <span className="reward-mote left-[16%] top-[18%]" /><span className="reward-mote right-[18%] top-[29%] [animation-delay:700ms]" /><span className="reward-mote bottom-[20%] left-[35%] [animation-delay:1.4s]" />
              <div className="flex h-24 items-center justify-center gap-3" aria-hidden="true">
                <span className="reward-object grid h-16 w-16 place-items-center rounded-full border border-[#d6a94e] bg-[#17110a]/80"><HeroTokenIcon size={42} /></span>
                <span className="reward-object grid h-11 w-11 place-items-center rounded-full border border-[#b67e29] bg-[#6d4517] text-[#f5cf73] [animation-delay:500ms]"><Coins size={25} /></span>
                <span className="reward-object grid h-10 w-10 place-items-center rounded-full border border-[#6d62a6] bg-[#241d3e] text-[#b9adff] [animation-delay:1s]"><Sparkles size={21} /></span>
              </div>
              <div className="mt-2 text-center">
                <div className="text-[10px] font-bold uppercase tracking-[.18em] text-[#9b907d]">Reward engine</div>
                <div className="mt-1 text-xl font-black text-[#f0c86d]">+100% $HERO</div>
                <div className="mt-1 text-xs text-[#bbb2a2]">Up to 1,000 chests per 24 hours spent online</div>
              </div>
            </section>

            <section className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <StatusTile label="Status" value={status} tone={active ? 'green' : ready ? 'gold' : 'muted'} />
                <StatusTile label="Duration" value={active ? 'Until disabled' : 'Continuous'} tone="gold" />
                <StatusTile label="Cooldown" value="None" tone="muted" />
              </div>
              <div className={`boost-progress-panel stat-tile p-3 ${active ? 'boost-progress-active' : ''}`}>
                <div className="mb-2 flex items-center justify-between gap-3 text-xs font-bold">
                  <span className="flex items-center gap-1.5 text-[#bcb4a6]"><Crown size={14} /> Activation progress</span>
                  <span className="tabular-nums text-emerald-300">{active ? 'BOOST ACTIVE' : `${completedTasks}/${tasks.length} · ${progress}%`}</span>
                </div>
                <div className="boost-progress-track" role="progressbar" aria-label="Boost Max activation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                  {tasks.map((task, index) => <span key={task.key} className={`boost-progress-segment ${task.done ? 'boost-progress-segment-done' : ''}`}><i>{index + 1}</i></span>)}
                </div>
                <div className="mt-2 text-center text-[9px] font-black uppercase tracking-[.16em] text-[#81796b]">{active ? 'Maximum rewards protocol engaged' : `${tasks.length - completedTasks} task${tasks.length - completedTasks === 1 ? '' : 's'} remaining`}</div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="stat-tile flex items-center gap-2 p-2.5"><TrendingUp size={16} className="text-[#dcb55f]" /><span><b className="block text-[#eee4d2]">Token income</b><span className="text-[#918b80]">+100% on locations</span></span></div>
                <div className="stat-tile flex items-center gap-2 p-2.5"><Clock3 size={16} className="text-[#9f91d7]" /><span><b className="block text-[#eee4d2]">Offline cap</b><span className="text-[#918b80]">8h cap removed</span></span></div>
              </div>
            </section>
          </div>

          <section className="mt-3 grid gap-2 sm:grid-cols-2">
            {tasks.map((task) => (
              <div key={task.key} className={`stat-tile flex min-h-14 items-center gap-2.5 p-2.5 ${task.done ? 'border-emerald-800/70' : ''}`}>
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg border ${task.done ? 'border-emerald-700/60 bg-emerald-950/35 text-emerald-300' : 'border-[#51442f] bg-black/20 text-[#a79b86]'}`}>{task.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-bold text-[#e3dccf]">{task.label}</div>
                  {!task.done && <div className="mt-1 text-[10px] tabular-nums text-[#8f887b]">{task.detail}</div>}
                </div>
                {task.done ? <CheckCircle2 size={18} className="text-emerald-400" /> : <Circle size={17} className="text-[#625b50]" />}
              </div>
            ))}
          </section>
        </div>

        <footer className="flex gap-2 border-t border-[#5d4a2f] bg-black/20 p-3">
          {active && <button type="button" disabled={updating} onClick={() => void setActive(false)} className="game-control px-4 text-xs font-bold disabled:opacity-40">Disable</button>}
          <button type="button" disabled={updating || !ready || active} onClick={() => void setActive(true)} className={`game-control flex flex-1 items-center justify-center gap-2 px-4 font-black disabled:cursor-not-allowed disabled:opacity-45 ${active ? 'boost-max-active' : ready ? 'boost-max-ready' : ''}`}><Crown size={17} /> {updating ? 'Updating…' : active ? 'Boost Max Active' : ready ? 'Activate Boost Max' : `${progress}% Complete`}</button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function StatusTile({ label, value, tone }: { label: string; value: string; tone: 'green' | 'gold' | 'muted' }) {
  const color = tone === 'green' ? 'text-emerald-300' : tone === 'gold' ? 'text-[#e6bc63]' : 'text-[#a29b8e]';
  return <div className="stat-tile p-2 text-center"><div className="text-[9px] uppercase tracking-wider text-[#777268]">{label}</div><div className={`mt-0.5 text-xs font-bold ${color}`}>{value}</div></div>;
}
