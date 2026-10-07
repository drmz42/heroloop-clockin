import { useSkrRate } from '@/game/skrPurchase';
import { useEffect, useState } from 'react';
import { X, CalendarDays, Timer, Crown, CheckCircle2, Circle, Gift, Clock3, Layers, Trophy, Zap, ShoppingBag, Wallet, Pickaxe, Send, AtSign } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { GameApi } from '@/game/useGame';
import type { TokenomicsApi } from '@/game/useTokenomics';
import { formatNum } from '@/game/state';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { LinkedAccounts } from '@/components/LinkedAccounts';
import type { SocialLinks } from '@/components/PartnerQuests';
import { isolatedHackathon } from '@/game/editionStorage';
import { SEEKER_SAMPLE_INCOME } from '@/game/seekerSampleIncome';
import { playerSync } from '@/game/backend';
import { skrBoostTasks, type SkrBoostStatus } from '@/game/skrBoost';

type BoostTask = {
  key: string; label: string; icon: React.ReactNode; done: boolean;
  value: number; goal: number; unit: string; progress?: string;
  detail?: string; pending?: boolean;
};

const money = (value: number | undefined | null) => (typeof value === 'number' && Number.isFinite(value) ? formatNum(value) : '—');
const decimals = (value: number | undefined | null, digits = 2) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—');

export function BoostMaxModal({ game, tokenomics, onClose }: { game: GameApi; tokenomics: TokenomicsApi; onClose: () => void }) {
  const rate = useSkrRate(isolatedHackathon);
  const [updating, setUpdating] = useState(false);
  const [skrStatus, setSkrStatus] = useState<SkrBoostStatus | null>(null);
  const [links, setLinks] = useState<SocialLinks | null>(null);
  useEffect(() => {
    if (!isolatedHackathon) return;
    let cancelled = false;
    void playerSync<SkrBoostStatus>('skr_boost_status').then(result => {
      if (!cancelled) setSkrStatus(result);
    });
    return () => { cancelled = true; };
  }, []);
  const status = isolatedHackathon ? null : tokenomics.status;
  // Seeker shows the shared temporary sample figures (display only); see seekerSampleIncome.ts.
  const sample = isolatedHackathon ? SEEKER_SAMPLE_INCOME : null;
  const unit = isolatedHackathon ? '$SKR' : '$HERO';
  const samplePct = sample ? sample.daily / sample.pool * 100 : 0;
  const boost = status?.boost;
  const active = isolatedHackathon ? false : boost?.active ?? false;
  const heroTasks: BoostTask[] = [
    { key: 'days', label: 'Play today', icon: <CalendarDays size={15} />, done: (boost?.login_days ?? 0) >= 1, value: Math.min(boost?.login_days ?? 0, 1), goal: 1, unit: 'day' },
    { key: 'online', label: 'Stay online for 1 minute', icon: <Timer size={15} />, done: (boost?.online_seconds ?? 0) >= 60, value: Math.min(Math.floor(boost?.online_seconds ?? 0), 60), goal: 60, unit: 'sec' },
    { key: 'earned', label: 'Earn 10 $HERO', icon: <HeroTokenIcon size={15} />, done: (boost?.tokens_earned ?? 0) >= 10, value: Math.min(Math.floor(boost?.tokens_earned ?? 0), 10), goal: 10, unit: '' },
    { key: 'spent', label: 'Spend 10 $HERO in game', icon: <HeroTokenIcon size={15} />, done: (boost?.tokens_spent ?? 0) >= 10, value: Math.min(Math.floor(boost?.tokens_spent ?? 0), 10), goal: 10, unit: '' },
    { key: 'hold', label: 'Hold 1,000 $HERO', icon: <HeroTokenIcon size={15} />, done: (boost?.token_balance ?? 0) >= 1000, value: Math.min(Math.floor(boost?.token_balance ?? 0), 1000), goal: 1000, unit: '' },
  ];
  const tasks: BoostTask[] = isolatedHackathon ? [
    ...skrBoostTasks(skrStatus, rate).map(task => ({ ...task, icon: task.key === 'spend' ? <ShoppingBag size={15} /> : <Wallet size={15} />, value: task.percent, goal: 100, unit: '' })),
    { key: 'ore', label: 'Attempt ORE mining every 7 days', icon: <Pickaxe size={15} />, done: false, value: 0, goal: 1, unit: '', pending: true, progress: 'Weekly', detail: 'One completed mining attempt within the last 7 days. Each new attempt renews the 7-day window; finding ORE is not required.' },
    ...(['telegram', 'x'] as const).map(provider => ({ key: provider, label: provider === 'telegram' ? 'Link Telegram' : 'Link X', icon: provider === 'telegram' ? <Send size={15} /> : <AtSign size={15} />, done: !!links?.[provider], value: links?.[provider] ? 1 : 0, goal: 1, unit: '', progress: links ? 'Not linked' : 'Checking linked accounts…' })),
  ] : heroTasks;
  const requiredTasks = tasks.filter(task => !task.pending);
  const ready = requiredTasks.every(task => task.done) && !isolatedHackathon;
  const completedTasks = requiredTasks.filter(task => task.done).length;
  const progress = Math.round((completedTasks / requiredTasks.length) * 100);
  const stateLabel = active ? 'Active' : ready ? 'Available' : 'Locked';
  const setActive = async (nextActive: boolean) => {
    if (isolatedHackathon) return;
    setUpdating(true);
    const updated = await tokenomics.setBoostMaxActive(nextActive);
    if (updated) {
      const completed = [updated.login_days >= 1, updated.online_seconds >= 60, updated.tokens_earned >= 10, updated.tokens_spent >= 10, updated.token_balance >= 1000].filter(Boolean).length;
      game.applyServerBoostStatus(updated.active, completed * 20);
    }
    setUpdating(false);
  };

  return createPortal(
    <div className="hl-portal fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 p-3 backdrop-blur-[2px] anim-fade" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="px-panel-raised relative flex max-h-[92vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl" role="dialog" aria-modal="true" aria-label="Rewards and Tokenomics">
        <header className="flex items-start justify-between gap-3 border-b border-[#5d4a2f] px-4 py-3">
          <div>
            <div className="section-kicker">{isolatedHackathon ? 'Seeker $SKR rewards' : 'Live server data'}</div>
            <h2 className="mt-1 flex items-center gap-2 text-2xl font-black text-[#f1d188]"><Gift size={22} /> Rewards &amp; Tokenomics</h2>
            <p className="mt-1 text-xs text-[#aaa397]">Shared reward pool, your Boost Max and your standing.</p>
          </div>
          <button type="button" onClick={onClose} className="game-control grid h-9 w-9 place-items-center" aria-label="Close Rewards and Tokenomics"><X size={16} /></button>
        </header>

        <div className="game-scrollbar min-h-0 space-y-3 overflow-y-auto p-4">
          <section className="stat-tile p-4" aria-label="Reward pool">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[.16em] text-[#8f887b]">Reward pool</span>
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" /> Live · shared</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-3xl font-black tabular-nums text-[#f1d188]"><HeroTokenIcon size={26} /> {money(sample?.pool ?? status?.pool_amount)} <span className="text-sm font-bold text-[#8f887b]">{unit}</span></div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <PoolTile label="Emitted / day" value={money(sample?.pool ?? status?.daily_pool)} />
              <PoolTile label="Distributed" value={money(sample?.distributed ?? status?.total_distributed)} />
              <PoolTile label="Your share" value={sample ? `${decimals(samplePct)}%` : status ? `${decimals(status.pool_share_percent)}%` : '—'} />
            </div>
            <p className="mt-3 flex items-start gap-2 text-xs leading-5 text-[#b9b09d]"><Zap size={14} className="mt-0.5 shrink-0 text-[#e0a83c]" /> {isolatedHackathon ? 'Your $SKR income follows your Reward Power and how deep your farming location is. Push deeper and gear up to earn a bigger share of the daily pool.' : 'Income follows your Reward Power and how deep your farming location is. Push deeper and gear up to earn a bigger share.'}</p>
          </section>

          <section className={`stat-tile p-4 ${active ? 'boost-progress-active' : ''}`} aria-label="Boost Max">
            <div className="flex items-start justify-between gap-3">
              <h3 className={`flex items-center gap-2 text-lg font-black ${active ? 'boost-max-title-active' : 'text-[#f1d188]'}`}><Crown size={19} /> Boost Max</h3>
              <div className="rounded-lg border border-[#54462f] bg-black/30 px-2.5 py-1 text-right">
                <div className="text-[9px] font-bold uppercase tracking-wider text-[#8f887b]">Status</div>
                <div className={`text-sm font-black ${active ? 'text-emerald-300' : ready ? 'text-[#f1c862]' : 'text-[#a29b8e]'}`}>{stateLabel}</div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#b9b09d]">
              <span className="flex items-center gap-1.5"><Layers size={13} className="text-[#dcb55f]" /> 2× reward score</span>
              <span className="flex items-center gap-1.5"><Clock3 size={13} className="text-[#9f91d7]" /> No 8h offline cap</span>
            </div>
            <div className="mt-3 flex items-center justify-between text-[11px] font-bold text-[#8f887b]"><span>Activation progress</span><span className="tabular-nums text-emerald-300">{active ? 'ACTIVE' : `${completedTasks}/${requiredTasks.length} · ${progress}%`}</span></div>
            <div className="boost-progress-track mt-1.5" role="progressbar" aria-label="Boost Max activation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              {tasks.map((task, index) => <span key={task.key} className={`boost-progress-segment ${task.done ? 'boost-progress-segment-done' : ''}`}><i>{index + 1}</i></span>)}
            </div>

            <ul className="mt-3 space-y-2">
              {tasks.map((task) => (
                <li key={task.key} className="flex items-center gap-2.5">
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${task.done ? 'border-emerald-700/60 bg-emerald-950/35 text-emerald-300' : 'border-[#51442f] bg-black/20 text-[#a79b86]'}`}>{task.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2 text-xs font-bold text-[#e3dccf]">
                      <span className={isolatedHackathon ? 'min-w-0' : 'truncate'}>{task.label}</span>
                      <span className="shrink-0 tabular-nums text-[10px] text-[#8f887b]">{task.done ? 'Done' : task.progress ? (task.pending ? task.progress : task.key === 'telegram' || task.key === 'x' ? (links ? 'Not linked' : 'Checking…') : skrStatus?.status === 'verified' ? `${Math.round(task.value)}%` : 'Unverified') : `${formatNum(task.value)}/${formatNum(task.goal)}${task.unit ? ` ${task.unit}` : ''}`}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-black/50"><div className={`h-full ${task.done ? 'bg-emerald-400' : 'bg-[#d9a441]'}`} style={{ width: `${Math.round((task.value / task.goal) * 100)}%` }} /></div>
                    {task.detail && <p className="mt-1 text-[10px] font-normal leading-4 text-[#8f887b]">{task.detail}</p>}
                    {task.progress && !task.pending && task.key !== 'telegram' && task.key !== 'x' && <p className="mt-1 text-[10px] text-[#8f887b]">{task.progress}</p>}
                  </div>
                  {task.done ? <CheckCircle2 size={17} className="shrink-0 text-emerald-400" /> : <Circle size={16} className="shrink-0 text-[#625b50]" />}
                </li>
              ))}
            </ul>

            <div className="mt-4 flex gap-2">
              {active && <button type="button" disabled={updating} onClick={() => void setActive(false)} className="game-control px-4 text-xs font-bold disabled:opacity-40">Disable</button>}
              <button type="button" disabled={updating || !ready || active} onClick={() => void setActive(true)} className={`game-control flex flex-1 items-center justify-center gap-2 px-4 font-black disabled:cursor-not-allowed disabled:opacity-45 ${active ? 'boost-max-active' : ready ? 'boost-max-ready' : ''}`}><Crown size={17} /> {updating ? 'Updating…' : active ? 'Boost Max Active' : ready ? 'Activate Boost Max' : `${progress}% Complete`}</button>
            </div>
          </section>

          <LinkedAccounts onLinksChange={isolatedHackathon ? setLinks : undefined} />

          <section className="stat-tile p-4" aria-label="Your standing">
            <h3 className="flex items-center gap-2 text-sm font-black text-[#f1d188]"><Trophy size={16} /> Your standing</h3>
            <dl className="mt-2 divide-y divide-[#3a3122] text-xs">
              <Row label="Reward Power" value={money(sample ? Math.round(game.teamPower()) : status?.my_power)} />
              <Row label="Pool share" value={sample ? `${decimals(samplePct)}%` : status ? `${decimals(status.pool_share_percent)}%` : '—'} />
              <Row label="Estimated per day" value={sample ? `${decimals(sample.daily)} ${unit}` : status ? `${decimals(status.my_daily_share)} $HERO` : '—'} />
              <Row label="Estimated per hour" value={sample ? `${decimals(sample.daily / 24)} ${unit}` : status ? `${decimals(status.my_hourly_share)} $HERO` : '—'} />
              <Row label="Ready to claim" value={sample ? `${decimals(sample.readyToClaim)} ${unit}` : status ? `${decimals(status.pending_tokens)} $HERO` : '—'} />
              <Row label="Total claimed" value={sample ? `${decimals(sample.totalClaimed)} ${unit}` : status ? `${decimals(status.total_claimed)} $HERO` : '—'} />
            </dl>
            <p className="mt-2 text-[11px] leading-5 text-[#8f887b]">Estimates change as other players and Boost Max shift the shared denominator; they are not a guaranteed payout.</p>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PoolTile({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-[#3f3626] bg-black/25 px-2 py-2"><div className="text-[9px] font-bold uppercase tracking-wider text-[#8f887b]">{label}</div><div className="mt-0.5 text-sm font-black tabular-nums text-[#eee4d2]">{value}</div></div>;
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3 py-2"><dt className="text-[#a29b8e]">{label}</dt><dd className="font-bold tabular-nums text-[#eee4d2]">{value}</dd></div>;
}
