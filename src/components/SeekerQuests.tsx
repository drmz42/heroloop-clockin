import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { isAndroidLayout } from '@/platform/platform';
import { MINE_OPEN_EVENT } from '@/game/seekerTour';
import { SeekerMinePanel } from './SeekerMinePanel';
import '@/theme/scene/sheets.css';
import { CheckCircle2 } from 'lucide-react';
import type { DailyQuest } from '@/game/types';
import type { SeekerQuestBoard } from '@/game/useSeekerQuests';
import { groupDigits, groupNumber } from '@/game/numberFormat';
import { GoldIcon } from './GoldIcon';
import { SummonScrollArtwork } from './SummonScrollArtwork';
import '@/theme/scene/seeker-panels.css';

const MINER_RANKS = [{ name: 'Bronze', rounds: 50 }, { name: 'Silver', rounds: 250 }, { name: 'Gold', rounds: 1000 }, { name: 'Diamond', rounds: 5000 }];

const prize = (reward: DailyQuest['reward']) => <>
  {reward.gold > 0 && <span className="flex items-center gap-0.5"><GoldIcon size={11} />{groupNumber(reward.gold)}</span>}
  {!!reward.summonScrolls && <span className="flex items-center gap-0.5"><SummonScrollArtwork size={13} />{reward.summonScrolls}</span>}
</>;

/** Lifetime Quest Challenge: every finite lifetime quest claimed fills the bar; each 10% pays a server prize. */
export function SeekerQuestChallenge({ board }: { board: SeekerQuestBoard }) {
  const { challenge, busy, error, collect } = board;
  if (!challenge || challenge.total < 1) return null;
  const percent = Math.min(100, challenge.completed / challenge.total * 100);
  const ready = challenge.steps.filter((step) => !step.claimed && challenge.completed >= step.threshold);
  const next = challenge.steps.find((step) => challenge.completed < step.threshold);
  return <section className="seeker-challenge quest-card mb-2 px-2 py-2" aria-label="Quest Challenge">
    <div className="flex items-baseline gap-2">
      <span className="section-kicker min-w-0 flex-1">Quest Challenge</span>
      <span className="seeker-challenge-count"><b>{challenge.completed}</b>/{challenge.total}</span>
    </div>
    <p className="ui-text-small mt-0.5 text-px-dim">Complete lifetime quests. Every 10% unlocks a prize.</p>
    <div className="seeker-challenge-track mt-2" role="progressbar" aria-label="Lifetime quests completed" aria-valuemin={0} aria-valuemax={challenge.total} aria-valuenow={challenge.completed}>
      <div className="seeker-challenge-fill" style={{ width: `${percent}%` }} />
      {challenge.steps.map((step) => <span key={step.id} aria-hidden="true" className={`seeker-challenge-notch${step.claimed ? ' is-claimed' : challenge.completed >= step.threshold ? ' is-ready' : ''}`} style={{ left: `${step.percent}%` }} />)}
    </div>
    <ol className="seeker-challenge-steps mt-2">
      {challenge.steps.map((step) => {
        const unlocked = challenge.completed >= step.threshold;
        const label = `${step.percent}% prize: ${step.reward.gold ? `${groupNumber(step.reward.gold)} Gold` : ''}${step.reward.gold && step.reward.summonScrolls ? ' and ' : ''}${step.reward.summonScrolls ? `${step.reward.summonScrolls} Summon Scrolls` : ''}`;
        return <li key={step.id}>
          {unlocked && !step.claimed
            ? <button type="button" disabled={busy !== null} onClick={() => void collect(step.id)} aria-label={`Claim ${label}`} className="seeker-challenge-step is-ready"><small>{busy === step.id ? '…' : `${step.percent}%`}</small>{prize(step.reward)}</button>
            : <div aria-label={`${label}${step.claimed ? ', claimed' : `, unlocks at ${step.threshold} quests`}`} className={`seeker-challenge-step${step.claimed ? ' is-claimed' : ''}`}><small>{step.claimed ? <CheckCircle2 size={11} /> : `${step.percent}%`}</small>{prize(step.reward)}</div>}
        </li>;
      })}
    </ol>
    <p className="ui-text-small mt-1 text-px-dim" aria-live="polite">{ready.length ? `${ready.length} ${ready.length === 1 ? 'prize' : 'prizes'} ready to claim` : next ? `Next prize at ${next.threshold} quests` : 'Challenge complete'}</p>
    {error?.id.startsWith('challenge-') && <p role="alert" className="ui-text-small mt-1 text-red-300">{error.message}</p>}
  </section>;
}

export function SeekerQuests({ board, onOpenShop, claimQuest, motionOff = false }: {
  board: SeekerQuestBoard;
  onOpenShop: () => void;
  claimQuest: (id: string) => Promise<boolean>;
  motionOff?: boolean;
}) {
  const [mineOpen, setMineOpen] = useState(false);
  useEffect(() => {
    if (!mineOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMineOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mineOpen]);
  const openMine = () => {
    if (isAndroidLayout) window.dispatchEvent(new Event(MINE_OPEN_EVENT));
    else setMineOpen(true);
  };
  const { quests, mine, busy, error, collect } = board;
  const card = (q: DailyQuest) => <div key={q.id} className="quest-card px-2 py-1">
        <div className="ui-text-medium flex items-start gap-1 text-px-text"><span className="min-w-0 flex-1">{groupDigits(q.label)}</span>{q.claimed && <CheckCircle2 size={12} className="shrink-0 text-emerald-400" />}</div>
        <div className="ui-text-small mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[#e7c579]">
          <span className="flex items-center gap-1"><GoldIcon />{groupNumber(q.reward.gold)} Gold</span>
          {!!q.reward.summonScrolls && <span className="flex items-center gap-1"><SummonScrollArtwork size={14} />{q.reward.summonScrolls} Scrolls</span>}
          <span className="ml-auto text-px-dim">{groupNumber(Math.min(q.progress, q.target))}/{groupNumber(q.target)}</span>
        </div>
        <div className="health-track mt-1 h-1 overflow-hidden"><div className="h-full bg-amber-500" style={{ width: `${Math.min(100, q.progress / q.target * 100)}%` }} /></div>
        {!q.claimed && q.progress < q.target && (q.id.startsWith('mine-') || q.id.startsWith('skr-')) && <button type="button" onClick={q.id.startsWith('mine-') ? openMine : onOpenShop} style={{ minHeight: 44 }} className="game-control ui-text-medium mt-1 min-h-11 w-full font-bold">{q.id.startsWith('mine-') ? 'To Mine' : 'To Shop'}</button>}
        {!q.claimed && q.progress >= q.target && <button type="button" disabled={busy !== null} onClick={() => void collect(q.id)} style={{ minHeight: 44 }} className="quest-reward-ready game-control game-primary ui-text-medium mt-1 min-h-11 w-full font-bold disabled:opacity-50">{busy === q.id ? 'Claiming…' : 'Claim reward'}</button>}
      </div>;
  const reached = MINER_RANKS.filter(entry => (mine?.rounds_total ?? 0) >= entry.rounds);
  const rank = reached.length ? reached[reached.length - 1].name : 'Unranked';
  return <>
    {(['daily', 'milestone'] as const).map(kind => <section key={kind} className="mb-2" aria-label={kind === 'daily' ? 'Daily SKR & Market Quests' : 'Lifetime SKR Quests'}>
      <div className="section-kicker mb-1">{kind === 'daily' ? 'Daily SKR & Market Quests' : 'Lifetime SKR Quests'}</div>
      <div className="space-y-1">{quests.filter(q => q.kind === kind && !q.id.startsWith('mine-')).map(card)}</div>
    </section>)}
    <section className="mb-2" aria-label="ORE Mine quests">
      <div className="section-kicker mb-1">ORE Mine Quests</div>
      {mine && <p className="ui-text-small mb-1 text-px-dim">Today {groupNumber(mine.rounds_today)} rounds · Streak {mine.streak_days} {mine.streak_days === 1 ? 'day' : 'days'} · {rank} Miner ({groupNumber(mine.rounds_total)} rounds)</p>}
      <div className="space-y-1">{quests.filter(q => q.id.startsWith('mine-') && q.kind === 'daily').map(card)}</div>
      <div className="section-kicker mb-1 mt-2">Miner Ranks</div>
      <div className="space-y-1">{quests.filter(q => q.id.startsWith('mine-rank-')).map(card)}</div>
      <p className="ui-text-small mt-1 text-px-dim">Only verified rounds count. Rewards are in-game only: Gold and Summon Scrolls, never SOL, SKR or ORE.</p>
    </section>
    {mineOpen && createPortal(<div className="hl-more-sheet mn-sheet" style={{ inset: 0 }} role="dialog" aria-modal="true" aria-label="$ORE Mine">
      <SeekerMinePanel onClose={() => setMineOpen(false)} claimQuest={claimQuest} still={motionOff} />
    </div>, document.body)}
    {error && !error.id.startsWith('challenge-') && <p role="alert" className="ui-text-small mb-2 text-red-300">{error.message}</p>}
  </>;
}
