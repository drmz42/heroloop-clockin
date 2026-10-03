import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { DailyQuest } from '@/game/types';
import { playerSync } from '@/game/backend';
import { groupDigits, groupNumber } from '@/game/numberFormat';
import { GoldIcon } from './GoldIcon';
import { SummonScrollArtwork } from './SummonScrollArtwork';

export function SeekerQuests({ claim, revision }: { claim: (id: string) => Promise<boolean>; revision: number }) {
  const [quests, setQuests] = useState<DailyQuest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const result = await playerSync<{ quests: DailyQuest[] }>('skr_quest_status');
    if (result?.quests) setQuests(result.quests);
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
  return <>
    {(['daily', 'milestone'] as const).map(kind => <section key={kind} className="mb-2" aria-label={kind === 'daily' ? 'Daily SKR & Market Quests' : 'Lifetime SKR Quests'}>
      <div className="section-kicker mb-1">{kind === 'daily' ? 'Daily SKR & Market Quests' : 'Lifetime SKR Quests'}</div>
      <div className="space-y-1">{quests.filter(q => q.kind === kind).map(q => <div key={q.id} className="quest-card px-2 py-1">
        <div className="ui-text-medium flex items-start gap-1 text-px-text"><span className="min-w-0 flex-1">{groupDigits(q.label)}</span>{q.claimed && <CheckCircle2 size={12} className="shrink-0 text-emerald-400" />}</div>
        <div className="ui-text-small mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[#e7c579]">
          <span className="flex items-center gap-1"><GoldIcon />{groupNumber(q.reward.gold)} Gold</span>
          {!!q.reward.summonScrolls && <span className="flex items-center gap-1"><SummonScrollArtwork size={14} />{q.reward.summonScrolls} Scrolls</span>}
          <span className="ml-auto text-px-dim">{groupNumber(Math.min(q.progress, q.target))}/{groupNumber(q.target)}</span>
        </div>
        <div className="health-track mt-1 h-1 overflow-hidden"><div className="h-full bg-amber-500" style={{ width: `${Math.min(100, q.progress / q.target * 100)}%` }} /></div>
        {!q.claimed && q.progress >= q.target && <button type="button" disabled={busy !== null} onClick={() => void collect(q.id)} style={{ minHeight: 44 }} className="quest-reward-ready game-control game-primary ui-text-medium mt-1 min-h-11 w-full font-bold disabled:opacity-50">{busy === q.id ? 'Claiming…' : 'Claim reward'}</button>}
      </div>)}</div>
    </section>)}
    <section className="mb-2" aria-label="ORE mining quests coming soon">
      <div className="section-kicker mb-1">ORE Mining · Coming soon</div>
      <p className="ui-text-small text-px-dim">Daily goals: 1 / 3 / 5 verified mining rounds. Rewards: 250 / 750 / 1 500 Gold; 1 Scroll at 5 rounds. Available after ORE mining is connected.</p>
    </section>
    {error && <p role="alert" className="ui-text-small mb-2 text-red-300">{error}</p>}
  </>;
}
