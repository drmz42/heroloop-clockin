import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { DailyQuest } from '@/game/types';
import { playerSync } from '@/game/backend';
import { groupDigits, groupNumber } from '@/game/numberFormat';
import { GoldIcon } from './GoldIcon';
import { SummonScrollArtwork } from './SummonScrollArtwork';

type MineSummary = { rounds_today: number; rounds_total: number; streak_days: number };
const MINER_RANKS = [{ name: 'Bronze', rounds: 50 }, { name: 'Silver', rounds: 250 }, { name: 'Gold', rounds: 1000 }, { name: 'Diamond', rounds: 5000 }];

export function SeekerQuests({ claim, revision }: { claim: (id: string) => Promise<boolean>; revision: number }) {
  const [quests, setQuests] = useState<DailyQuest[]>([]);
  const [mine, setMine] = useState<MineSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const result = await playerSync<{ quests: DailyQuest[]; mine?: MineSummary }>('skr_quest_status');
    if (result?.quests) setQuests(result.quests);
    if (result?.mine) setMine(result.mine);
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => { void refresh(); }, [refresh, revision]);
  const collect = async (id: string) => {
    if (busy) return;
    setBusy(id); setError('');
    try {
      if (!await claim(id)) setError('The reward could not be claimed. Refresh and try again.');
      await refresh();
    } finally { setBusy(null); }
  };
  const card = (q: DailyQuest) => <div key={q.id} className="quest-card px-2 py-1">
        <div className="ui-text-medium flex items-start gap-1 text-px-text"><span className="min-w-0 flex-1">{groupDigits(q.label)}</span>{q.claimed && <CheckCircle2 size={12} className="shrink-0 text-emerald-400" />}</div>
        <div className="ui-text-small mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[#e7c579]">
          <span className="flex items-center gap-1"><GoldIcon />{groupNumber(q.reward.gold)} Gold</span>
          {!!q.reward.summonScrolls && <span className="flex items-center gap-1"><SummonScrollArtwork size={14} />{q.reward.summonScrolls} Scrolls</span>}
          <span className="ml-auto text-px-dim">{groupNumber(Math.min(q.progress, q.target))}/{groupNumber(q.target)}</span>
        </div>
        <div className="health-track mt-1 h-1 overflow-hidden"><div className="h-full bg-amber-500" style={{ width: `${Math.min(100, q.progress / q.target * 100)}%` }} /></div>
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
    {error && <p role="alert" className="ui-text-small mb-2 text-red-300">{error}</p>}
  </>;
}
