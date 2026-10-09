import { useEffect, useState } from 'react';
import { CalendarDays, Crown, Flame, Lock, Package, Swords, X } from 'lucide-react';
import { BossKeyIcon } from '@/components/BossKeyIcon';
import { GoldIcon } from '@/components/GoldIcon';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { SkrUsd } from '@/components/SkrUsd';
import { SummonScrollArtwork } from '@/components/SummonScrollArtwork';
import { formatNum } from '@/game/state';
import { skrPrice, useSkrRate } from '@/game/skrPurchase';
import { type EventReward, type EventTab, type PassTier, type SeekerEventsApi } from '@/game/useSeekerEvents';
import './SeekerEvents.css';

const TABS: Array<[EventTab, string]> = [['calendar', 'Calendar'], ['weekly', 'Weekly Event'], ['pass', 'Premium Pass']];

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);
  return now;
}
function left(until: string, now: number) {
  const minutes = Math.max(0, Math.floor((Date.parse(until) - now) / 60_000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes % 60}m`;
}

const short = (n: number) => n >= 1000 ? `${Number((n / 1000).toFixed(n % 1000 ? 1 : 0))}k` : String(n);

export function RewardChips({ reward, compact = false }: { reward: EventReward; compact?: boolean }) {
  const size = compact ? 14 : 18;
  return <span className={`ev-chips ${compact ? 'is-compact' : ''}`}>
    {reward.gold > 0 && <span><GoldIcon size={size - 2} />{compact ? short(reward.gold) : formatNum(reward.gold)}</span>}
    {reward.scrolls > 0 && <span><SummonScrollArtwork size={size} />{reward.scrolls}</span>}
    {reward.chests > 0 && <span><Package size={size - 4} aria-hidden="true" />{reward.chests}</span>}
    {reward.boss_keys > 0 && <span><BossKeyIcon size={size} />{reward.boss_keys}</span>}
  </span>;
}

/** Three entry cards inside the battle burger; each opens the Events sheet on its tab. */
export function EventMenuCards({ events, onOpen }: { events: SeekerEventsApi; onOpen: (tab: EventTab) => void }) {
  const status = events.status;
  const weeklyDone = status?.weekly.quests.filter((quest) => quest.claimed).length ?? 0;
  const ready = (tab: EventTab) => {
    if (!status) return false;
    if (tab === 'calendar') return !status.calendar.claimed_today;
    if (tab === 'weekly') return status.weekly.quests.some((quest) => !quest.claimed && quest.progress >= quest.target);
    return status.pass.rewards.some((entry) => !entry.claimed && entry.rank <= status.pass.rank && (entry.track === 'free' || status.pass.tier !== null));
  };
  const cards: Array<[EventTab, typeof CalendarDays, string, string]> = [
    ['calendar', CalendarDays, 'Calendar', status ? `Day ${status.calendar.next_day ?? status.calendar.claimed_days}/28 · ×${status.calendar.multiplier}` : 'Daily check-in'],
    ['weekly', Swords, 'Weekly Event', status ? `${status.weekly.title} · ${weeklyDone}/${status.weekly.quests.length}` : 'Friday quests'],
    ['pass', Crown, 'Premium Pass', status ? `Rank ${status.pass.rank}/${status.pass.max_rank}` : '40 ranks'],
  ];
  return <div className="ev-menu" aria-label="Events">
    <div className="ev-menu-kicker">Events</div>
    {cards.map(([tab, Icon, title, line]) => <button key={tab} type="button" className={`ev-menu-card ev-art-${tab}`} onClick={() => onOpen(tab)}>
      <i aria-hidden="true"><Icon size={17} /></i>
      <span><strong>{title}</strong><small>{line}</small></span>
      {ready(tab) && <b className="ev-dot" aria-label="Reward ready" />}
    </button>)}
  </div>;
}


export function SeekerEventsSheet({ events, tab, onTab, onClose, onState }: {
  events: SeekerEventsApi; tab: EventTab; onTab: (tab: EventTab) => void; onClose: () => void;
  onState: (state: unknown, revision: number) => void;
}) {
  const now = useNow();
  const status = events.status;
  useEffect(() => { void events.refresh(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <div className="hl-more-sheet mo-sheet ev-sheet" role="dialog" aria-modal="true" aria-label="Events" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <div className="mo-panel ev-panel">
      <div className="mo-head"><span className="mo-title">Events</span><button type="button" className="mo-close" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
      <div className="ev-tabs" role="tablist">
        {TABS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => onTab(id)}>{label}</button>)}
      </div>
      {events.message && <p role="status" className="ev-message">{events.message}</p>}
      {!status ? <p className="ev-muted">Loading…</p>
        : tab === 'calendar' ? <CalendarTab events={events} now={now} />
          : tab === 'weekly' ? <WeeklyTab events={events} now={now} />
            : <PassTab events={events} now={now} onState={onState} />}
    </div>
  </div>;
}

function CalendarTab({ events, now }: { events: SeekerEventsApi; now: number }) {
  const c = events.status!.calendar;
  const premium = events.status!.pass.tier !== null;
  const shownDone = c.claimed_days;
  return <section className="ev-section">
    <div className="ev-hero">
      <div><span className="ev-kicker">Login calendar · cycle {c.cycle}</span><strong>Day {c.next_day ?? c.claimed_days} of 28</strong>
        <small><Flame size={13} aria-hidden="true" /> Streak {c.streak} · ×{c.multiplier} rewards</small></div>
      <div className="ev-timer">{c.claimed_today ? <>Next in<b>{left(c.resets_at, now)}</b></> : <>Ends in<b>{left(c.resets_at, now)}</b></>}</div>
    </div>
    {c.streak_lost && <p className="ev-warn">You missed a day. Calendar progress is kept, but the multiplier restarts at ×1.</p>}
    <p className="ev-muted">Week 1 ×1 · Week 2 ×1.5 · Week 3 ×2 · Week 4 ×3 in a row. <Crown size={11} aria-hidden="true" /> days are doubled with a Premium Pass.</p>
    <ol className="ev-grid">
      {c.days.map((entry) => {
        const done = entry.day <= shownDone;
        const today = entry.day === c.next_day;
        return <li key={entry.day} className={`${done ? 'is-done' : ''} ${today ? 'is-today' : ''} ${entry.day % 7 === 0 ? 'is-big' : ''}`}>
          <span className="ev-day">{entry.day}{entry.marked && <Crown size={10} className={premium ? 'is-on' : ''} aria-label="Premium doubles" />}</span>
          <RewardChips reward={entry.reward} compact />
        </li>;
      })}
    </ol>
    <button type="button" className="game-control game-primary ev-claim" disabled={c.claimed_today || events.busy !== null} onClick={() => void events.claim('calendar')}>
      {c.claimed_today ? 'Checked in today' : events.busy ? 'Claiming…' : `Check in · Day ${c.next_day}`}
    </button>
  </section>;
}

function WeeklyTab({ events, now }: { events: SeekerEventsApi; now: number }) {
  const w = events.status!.weekly;
  return <section className="ev-section">
    <div className="ev-hero ev-hero-weekly">
      <div><span className="ev-kicker">Weekly Event</span><strong>{w.title}</strong><small>New quests every Friday 01:00 UTC</small></div>
      <div className="ev-timer">Ends in<b>{left(w.ends_at, now)}</b></div>
    </div>
    <div className="ev-quests">
      {w.quests.map((quest) => {
        const done = quest.progress >= quest.target;
        return <article key={quest.id} className={`ev-quest ${quest.claimed ? 'is-claimed' : done ? 'is-ready' : ''}`}>
          <div className="ev-quest-top"><strong>{quest.label}</strong><RewardChips reward={quest.reward} compact /></div>
          <div className="ev-bar" aria-label={`${quest.progress} of ${quest.target}`}><i style={{ width: `${Math.min(100, quest.progress / quest.target * 100)}%` }} /></div>
          <div className="ev-quest-foot"><small>{formatNum(quest.progress)} / {formatNum(quest.target)}</small>
            <button type="button" className="game-control ev-small" disabled={!done || quest.claimed || events.busy !== null} onClick={() => void events.claim('weekly', quest.id)}>
              {quest.claimed ? 'Claimed' : done ? 'Claim' : 'In progress'}</button></div>
        </article>;
      })}
    </div>
  </section>;
}

function PassTab({ events, now, onState }: { events: SeekerEventsApi; now: number; onState: (state: unknown, revision: number) => void }) {
  const p = events.status!.pass;
  const rate = useSkrRate(true);
  const into = p.rank >= p.max_rank ? p.xp_per_rank : p.xp - p.rank * p.xp_per_rank;
  const readyCount = p.rewards.filter((entry) => !entry.claimed && entry.rank <= p.rank && (entry.track === 'free' || p.tier !== null)).length;
  const ranks = Array.from({ length: p.max_rank }, (_, index) => index + 1);
  const delivered = (result: Record<string, unknown>) => {
    if (result.state && typeof result.revision === 'number') onState(result.state, result.revision);
    void events.refresh();
  };
  const buy = (tier: PassTier, title: string, perks: string) => <article className={`ev-buy ev-buy-${tier}`}>
    <strong>{title}</strong><small>{perks}</small>
    <p className="ev-price">{skrPrice(p.prices[tier], rate)}<SkrUsd cents={p.prices[tier]} /></p>
    <SkrPurchaseButton product="event_pass_buy" params={{ tier }} label={`Buy ${title}`} onDelivered={delivered} />
  </article>;
  return <section className="ev-section">
    <div className="ev-hero ev-hero-pass">
      <div><span className="ev-kicker">Season {p.season} · {p.tier === 'collector' ? 'Collector' : p.tier === 'premium' ? 'Premium' : 'Free'} track</span>
        <strong>Rank {p.rank} / {p.max_rank}</strong>
        <small>{p.rank >= p.max_rank ? 'Max rank reached' : `${formatNum(into)} / ${p.xp_per_rank} Pass XP`}</small></div>
      <div className="ev-timer">Season ends<b>{left(p.ends_at, now)}</b></div>
    </div>
    <div className="ev-bar ev-bar-pass"><i style={{ width: `${Math.min(100, into / p.xp_per_rank * 100)}%` }} /></div>
    <p className="ev-muted">Pass XP: won battles 1 (up to 150 a day), daily quests 20, Boss victories 40, check-ins 50, weekly quests 100.</p>
    {p.tier !== 'collector' && <div className="ev-buys">
      {p.tier === null && buy('premium', 'Premium Pass', 'Premium track · ×2 on crown calendar days')}
      {buy('collector', p.tier === 'premium' ? 'Collector upgrade' : 'Collector Pass', 'Premium + 10 ranks now + 15 Scrolls + 2 Boss Keys')}
    </div>}
    <button type="button" className="game-control game-primary ev-claim" disabled={readyCount === 0 || events.busy !== null} onClick={() => void events.claim('pass')}>
      {events.busy ? 'Claiming…' : readyCount ? `Claim all (${readyCount})` : 'Reach the next rank to claim'}
    </button>
    <div className="ev-track-head"><span>Rank</span><span>Free</span><span><Crown size={12} aria-hidden="true" /> Premium</span></div>
    <ol className="ev-track">
      {ranks.map((rank) => {
        const cell = (track: 'free' | 'premium') => {
          const entry = p.rewards.find((reward) => reward.rank === rank && reward.track === track)!;
          const locked = track === 'premium' && p.tier === null;
          return <div className={`ev-cell ${entry.claimed ? 'is-claimed' : rank <= p.rank && !locked ? 'is-ready' : ''} ${locked ? 'is-locked' : ''}`}>
            <RewardChips reward={entry.reward} compact />{locked && <Lock size={11} aria-label="Premium only" />}
          </div>;
        };
        return <li key={rank} className={rank <= p.rank ? 'is-reached' : ''}><b>{rank}</b>{cell('free')}{cell('premium')}</li>;
      })}
    </ol>
  </section>;
}
