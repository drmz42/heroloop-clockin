import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Gem, Pickaxe, ScrollText, X } from 'lucide-react';
import type { DailyQuest } from '@/game/types';
import { playerSync } from '@/game/backend';
import { groupNumber } from '@/game/numberFormat';

// ── How to play: three code-native infographic slides ──
const STRIKE = 12;
function MiniBoard({ picked = [], strike, flow }: { picked?: number[]; strike?: number; flow?: boolean }) {
  return (
    <div className="mn-mini" aria-hidden="true">
      {Array.from({ length: 25 }, (_, i) => (
        <span key={i} className={`mn-mini-tile${picked.includes(i) ? ' is-picked' : ''}${strike === i ? ' is-strike' : ''}${flow && strike !== i ? ' is-flow' : ''}`}>
          <Gem />
        </span>
      ))}
    </div>
  );
}
const SLIDES = [
  { title: 'Pick your shafts', body: 'Tap one or more of the 25 shafts and choose a stake for each: 0.01, 0.1 or 1 SOL.', art: <MiniBoard picked={[6, 12, 18]} /> },
  { title: 'One shaft strikes', body: 'Every round (about a minute and a half) one shaft strikes at random. Miners on it share the round’s ORE prize — about 1 ORE — by stake.', art: <MiniBoard picked={[6, 12, 18]} strike={STRIKE} /> },
  { title: 'What comes back', body: 'Win or lose, most SOL returns after every round. The difference is the ORE protocol’s cut.', art: (
    <div className="mn-share" aria-hidden="true">
      <span className="mn-share-bar"><i style={{ width: '99%' }} /></span><span>99% + ORE<br />winning shaft</span>
      <span className="mn-share-bar is-rival"><i style={{ width: '89%' }} /></span><span>89%<br />other shafts</span>
    </div>
  ) },
  { title: 'Play the vein', body: 'Fewer rivals on a shaft means a bigger share of its ORE. Each verified round also counts for Mine quests: Gold, Scrolls and Miner ranks.', art: <MiniBoard picked={[2, 9, 21]} strike={9} /> },
];
export function MineTutorial({ onClose }: { onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const slide = SLIDES[index];
  const last = index === SLIDES.length - 1;
  return (
    <div className="mn-tutorial" role="dialog" aria-modal="true" aria-label="How to play the Mine">
      <div className="sc-root sc-panel mn-tutorial-card">
        <button type="button" className="sc-socket mn-close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        <span className="sc-kicker">How to play · {index + 1} / {SLIDES.length}</span>
        <h3 className="mn-tutorial-title">{slide.title}</h3>
        {slide.art}
        <p className="mn-tutorial-body">{slide.body}</p>
        <div className="mn-dots" aria-hidden="true">{SLIDES.map((_, i) => <i key={i} className={i === index ? 'is-on' : ''} />)}</div>
        <div className="mn-row">
          <button type="button" className="sc-plate" disabled={index === 0} onClick={() => setIndex(i => i - 1)}><ChevronLeft size={14} /> Back</button>
          <button type="button" className={last ? 'sc-seal' : 'sc-plate'} onClick={() => (last ? onClose() : setIndex(i => i + 1))}>
            {last ? <><Pickaxe size={14} /> Try it</> : <>Next <ChevronRight size={14} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
// ── Mine quests, claimable in place ──
type MineSummary = { rounds_today: number; rounds_total: number; streak_days: number };
const RANKS = [{ name: 'Bronze', rounds: 50 }, { name: 'Silver', rounds: 250 }, { name: 'Gold', rounds: 1000 }, { name: 'Diamond', rounds: 5000 }];
export function MineQuests({ claim }: { claim?: (id: string) => Promise<boolean> }) {
  const [quests, setQuests] = useState<DailyQuest[]>([]);
  const [mine, setMine] = useState<MineSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const result = await playerSync<{ quests: DailyQuest[]; mine?: MineSummary }>('skr_quest_status');
    if (result?.quests) setQuests(result.quests.filter(q => q.id.startsWith('mine-')));
    if (result?.mine) setMine(result.mine);
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const reached = RANKS.filter(r => (mine?.rounds_total ?? 0) >= r.rounds);
  const next = RANKS.find(r => (mine?.rounds_total ?? 0) < r.rounds);
  const open = quests.filter(q => !q.claimed).slice(0, 4);
  return (
    <section className="sc-panel" aria-label="Mine quests">
      <div className="sc-section-head"><span>Mine quests</span><ScrollText size={15} aria-hidden="true" /></div>
      {mine && (
        <div className="mn-stats">
          <span><b>{mine.rounds_today}</b>today</span>
          <span><b>{mine.streak_days}</b>day streak</span>
          <span><b>{reached.length ? reached[reached.length - 1].name : '—'}</b>{next ? `${next.rounds - mine.rounds_total} to ${next.name}` : 'max rank'}</span>
        </div>
      )}
      <ul>
        {open.map(q => (
          <li key={q.id} className="mn-quest">
            <span className="min-w-0 flex-1">{q.label}<small>{groupNumber(q.reward.gold)} Gold{q.reward.summonScrolls ? ` · ${q.reward.summonScrolls} Scroll${q.reward.summonScrolls > 1 ? 's' : ''}` : ''}</small></span>
            {q.progress >= q.target && claim
              ? <button type="button" className="sc-seal" disabled={busy !== null}
                onClick={async () => { setBusy(q.id); try { await claim(q.id); await refresh(); } finally { setBusy(null); } }}>Claim</button>
              : <span className="tabular-nums" style={{ color: 'var(--sc-brass)' }}>{groupNumber(Math.min(q.progress, q.target))}/{groupNumber(q.target)}</span>}
          </li>
        ))}
        {!open.length && <li className="sc-muted">All Mine quests done for now. Come back tomorrow.</li>}
      </ul>
    </section>
  );
}
