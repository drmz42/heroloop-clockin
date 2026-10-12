import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CalendarDays, Check, ChevronRight, Crown, Flame, Gem, Hourglass, Lock, ScrollText, Skull, Swords, X } from 'lucide-react';
import { GoldIcon } from '@/components/GoldIcon';
import { SkrPurchaseButton } from '@/components/SkrPurchaseButton';
import { SkrUsd } from '@/components/SkrUsd';
import { formatNum } from '@/game/state';
import { skrPrice, useSkrRate } from '@/game/skrPurchase';
import { passQuestsReady, passReady, type EventReward, type EventTab, type PassTier, type PassTrack, type SeekerEventsApi } from '@/game/useSeekerEvents';
import './SeekerEvents.css';

const TABS: Array<[EventTab, string, typeof CalendarDays]> = [['calendar', 'Calendar', CalendarDays], ['weekly', 'Weekly Event', Swords], ['pass', 'Battle Pass', Crown]];
const TRACKS: Array<{ id: PassTrack; title: string; price: string; Icon: typeof Skull }> = [
  { id: 'free', title: 'Free', price: '', Icon: Skull },
  { id: 'premium', title: 'Empowered', price: '$4.99', Icon: Gem },
  { id: 'collector', title: 'Collector', price: '$14.99', Icon: Crown },
];

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

type RewardKind = 'gold' | 'scrolls' | 'chests' | 'boss_keys';
const ART: Record<Exclude<RewardKind, 'gold'>, string> = {
  scrolls: '/assets/ui/summon-scroll-v1.webp', chests: '/assets/ui/chest-ceremony-v1.webp', boss_keys: '/assets/ui/boss-key-v2.webp',
};
// Weekly multipliers for days checked in a row (server: seeker_events migration).
const WEEK_MULTIPLIER = [1, 1.5, 2, 3];
const LABEL: Record<RewardKind, string> = { gold: 'Gold', scrolls: 'Summon Scrolls', chests: 'Chests', boss_keys: 'Boss Keys' };
function rewardParts(reward: EventReward): Array<[RewardKind, number]> {
  return (['boss_keys', 'scrolls', 'chests', 'gold'] as RewardKind[]).filter((kind) => reward[kind] > 0).map((kind) => [kind, reward[kind]]);
}

/** One reward socket: art, amount, and claimed / ready / locked state. */
function RewardTile({ kind, amount, state = '' }: { kind: RewardKind; amount: number; state?: string }) {
  return <span className={`ev-tile ev-tile-${kind} ${state}`} title={`${formatNum(amount)} ${LABEL[kind]}`}>
    {kind === 'gold' ? <GoldIcon size={32} stack /> : <img src={ART[kind]} alt="" draggable={false} />}
    <b>{short(amount)}</b>
    {state.includes('is-locked') && <Lock className="ev-tile-lock" size={11} aria-label="Locked" />}
    {state.includes('is-claimed') && <Check className="ev-tile-check" size={14} aria-label="Claimed" />}
  </span>;
}

export function RewardChips({ reward }: { reward: EventReward }) {
  return <span className="ev-chips">{rewardParts(reward).map(([kind, amount]) => <span key={kind}>
    {kind === 'gold' ? <GoldIcon size={13} /> : <img src={ART[kind]} alt="" />}{short(amount)}</span>)}</span>;
}

/** Ember sparks drifting up behind an Events surface (CSS animates them; hidden without motion). */
function Embers({ count = 14 }: { count?: number }) {
  return <span className="ev-embers" aria-hidden="true">{Array.from({ length: count }, (_, index) => <i key={index} />)}</span>;
}

/** The Events menu under the top bar's Events plate: three art cards, then the battle row (Dungeons, Boss). */
export function EventMenuCards({ events, onOpen, children }: { events: SeekerEventsApi; onOpen: (tab: EventTab) => void; children?: ReactNode }) {
  const status = events.status;
  const ready = (tab: EventTab) => {
    if (!status) return false;
    if (tab === 'calendar') return !status.calendar.claimed_today;
    if (tab === 'weekly') return status.weekly.quests.some((quest) => !quest.claimed && quest.progress >= quest.target);
    return passReady(status) + passQuestsReady(status) > 0;
  };
  const line = (tab: EventTab) => !status ? 'Loading…' : tab === 'calendar'
    ? `Day ${status.calendar.next_day ?? status.calendar.claimed_days} of 28 · ×${status.calendar.multiplier}`
    : tab === 'weekly' ? `${status.weekly.title} · ${status.weekly.quests.filter((quest) => quest.claimed).length}/${status.weekly.quests.length}`
      : `Level ${status.pass.level} of ${status.pass.max_level}`;
  return <div className="ev-menu" aria-label="Events">
    <Embers count={8} />
    <div className="ev-menu-head"><span className="ev-menu-title">Events</span></div>
    {TABS.map(([tab, title, Icon], index) => <button key={tab} type="button" style={{ '--ev-i': index } as CSSProperties} className={`ev-menu-card ev-art-${tab} ${ready(tab) ? 'is-ready' : ''}`} onClick={() => onOpen(tab)}>
      <i className="ev-seal" aria-hidden="true"><Icon size={17} /></i>
      <span className="ev-menu-text"><strong>{title}</strong><small>{line(tab)}</small></span>
      {ready(tab) ? <b className="ev-ready-pill">Ready</b> : <ChevronRight className="ev-menu-chev" size={18} aria-hidden="true" />}
    </button>)}
    <div style={{ '--ev-i': TABS.length } as CSSProperties} className="ev-menu-card ev-art-worldboss is-soon" aria-disabled="true">
      <i className="ev-seal" aria-hidden="true"><Skull size={17} /></i>
      <span className="ev-menu-text"><strong>World Boss</strong><small>Rally every hero against one titan</small></span>
      <b className="ev-ready-pill ev-soon-pill">Soon</b>
    </div>
    {children && <><div className="ev-menu-sub" aria-hidden="true"><span>Battle</span></div>{children}</>}
  </div>;
}

export function SeekerEventsPage({ events, tab, onTab, onState, onClose }: {
  events: SeekerEventsApi; tab: EventTab; onTab: (tab: EventTab) => void; onState: (state: unknown, revision: number) => void; onClose: () => void;
}) {
  const now = useNow();
  const status = events.status;
  useEffect(() => { void events.refresh(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const dot = (id: EventTab) => !!status && (id === 'calendar' ? !status.calendar.claimed_today
    : id === 'weekly' ? status.weekly.quests.some((quest) => !quest.claimed && quest.progress >= quest.target)
      : passReady(status) + passQuestsReady(status) > 0);
  return <div className={`ev-page ev-page-${tab}`}>
    <div className="ev-page-art" aria-hidden="true" />
    <Embers />
    <header className="ev-page-head"><h2>Events</h2><span className="ev-head-ornament" aria-hidden="true" />
      <button type="button" className="ev-close" onClick={onClose} aria-label="Close Events"><X size={18} /></button></header>
    <nav className="ev-tabs" role="tablist">
      {TABS.map(([id, label, Icon]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => onTab(id)}>
        <Icon size={15} aria-hidden="true" /><span>{id === 'weekly' ? 'Weekly' : label}</span>{dot(id) && <b className="ev-tab-dot" aria-label="Reward ready" />}</button>)}
    </nav>
    {events.message && <p role="status" className="ev-message">{events.message}</p>}
    {!status ? <p className="ev-muted ev-pad">Loading…</p>
      : tab === 'calendar' ? <CalendarTab events={events} now={now} />
        : tab === 'weekly' ? <WeeklyTab events={events} now={now} />
          : <PassTab events={events} now={now} onState={onState} />}
  </div>;
}

function CalendarTab({ events, now }: { events: SeekerEventsApi; now: number }) {
  const c = events.status!.calendar;
  const paid = events.status!.pass.tiers.length > 0;
  return <section className="ev-scroll ev-pad">
    <div className="ev-hero ev-hero-calendar">
      <div><span className="ev-kicker">Login calendar · cycle {c.cycle}</span><strong>Day {c.next_day ?? c.claimed_days} of 28</strong>
        <small><Flame size={13} aria-hidden="true" /> Streak {c.streak} · ×{c.multiplier} rewards</small></div>
      <div className="ev-timer"><Hourglass size={13} aria-hidden="true" /><span>{c.claimed_today ? 'Next in' : 'Ends in'}</span><b>{left(c.resets_at, now)}</b></div>
    </div>
    <button type="button" className="ev-btn ev-btn-primary" disabled={c.claimed_today || events.busy !== null} onClick={() => void events.claim('calendar')}>
      {c.claimed_today ? 'Checked in today' : events.busy ? 'Claiming…' : `Check in · Day ${c.next_day}`}
    </button>
    {c.streak_lost && <p className="ev-warn">You missed a day. Calendar progress is kept, but the multiplier restarts at ×1.</p>}
    <p className="ev-muted">Rewards grow ×1 · ×1.5 · ×2 · ×3 for each week in a row. <Crown size={11} aria-hidden="true" /> Crown days are doubled with any Battle Pass.</p>
    {[0, 1, 2, 3].map((week) => {
      const days = c.days.slice(week * 7, week * 7 + 7);
      const current = days.some((entry) => entry.day === c.next_day);
      return <section key={week} className={`ev-week ${current ? 'is-current' : ''}`} aria-label={`Week ${week + 1}`}>
        <h3 className="ev-week-head"><span>Week {week + 1}</span><b>×{WEEK_MULTIPLIER[week]}</b></h3>
        <ol className="ev-grid">
          {days.map((entry) => {
            const done = entry.day <= c.claimed_days;
            const today = entry.day === c.next_day;
            const [kind, amount] = rewardParts(entry.reward)[0];
            return <li key={entry.day} className={`${done ? 'is-done' : ''} ${today ? 'is-today' : ''} ${entry.day % 7 === 0 ? 'is-big' : ''}`}>
              <span className="ev-day">{entry.day}{entry.marked && <Crown size={10} className={paid ? 'is-on' : ''} aria-label="Battle Pass doubles" />}</span>
              <RewardTile kind={kind} amount={amount} state={done ? 'is-claimed' : today ? 'is-ready' : ''} />
            </li>;
          })}
        </ol>
      </section>;
    })}
  </section>;
}

function QuestRow({ label, progress, target, done, claimed, reward, busy, onClaim }: {
  label: string; progress: number; target: number; done: boolean; claimed: boolean; reward: ReactNode; busy: boolean; onClaim: () => void;
}) {
  return <article className={`ev-quest ${claimed ? 'is-claimed' : done ? 'is-ready' : ''}`}>
    <i className="ev-quest-gem" aria-hidden="true">{claimed && <Check size={11} />}</i>
    <div className="ev-quest-main">
      <strong>{label}</strong>
      <div className="ev-bar"><i style={{ width: `${Math.min(100, progress / target * 100)}%` }} /></div>
      <small>{formatNum(progress)} / {formatNum(target)}</small>
    </div>
    <div className="ev-quest-side">{reward}
      <button type="button" className={`ev-btn ev-btn-small ${done && !claimed ? 'ev-btn-primary' : ''}`} disabled={!done || claimed || busy} onClick={onClaim}>
        {claimed ? 'Done' : done ? 'Claim' : 'In progress'}</button>
    </div>
  </article>;
}

function WeeklyTab({ events, now }: { events: SeekerEventsApi; now: number }) {
  const w = events.status!.weekly;
  return <section className="ev-scroll ev-pad">
    <div className="ev-hero ev-hero-weekly">
      <div><span className="ev-kicker">Weekly Event</span><strong>{w.title}</strong><small>New quests every Friday 01:00 UTC</small></div>
      <div className="ev-timer"><Hourglass size={13} aria-hidden="true" /><span>Ends in</span><b>{left(w.ends_at, now)}</b></div>
    </div>
    <div className="ev-quests">
      {w.quests.map((quest) => <QuestRow key={quest.id} label={quest.label} progress={quest.progress} target={quest.target}
        done={quest.progress >= quest.target} claimed={quest.claimed} busy={events.busy !== null}
        reward={<RewardChips reward={quest.reward} />} onClaim={() => void events.claim('weekly', quest.id)} />)}
    </div>
  </section>;
}

function PassTab({ events, now, onState }: { events: SeekerEventsApi; now: number; onState: (state: unknown, revision: number) => void }) {
  const p = events.status!.pass;
  const rate = useSkrRate(true);
  const [view, setView] = useState<'rewards' | 'quests'>('rewards');
  const [buying, setBuying] = useState<PassTier | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const into = p.level >= p.max_level ? p.xp_per_level : p.xp - p.level * p.xp_per_level;
  const ready = passReady(events.status!);
  const questsReady = passQuestsReady(events.status!);
  const levels = Array.from({ length: p.max_level }, (_, index) => index + 1);
  const byKey = new Map(p.rewards.map((entry) => [`${entry.track}:${entry.level}`, entry]));
  // Open the strip at the player's level, like the in-game Battle Pass track.
  useLayoutEffect(() => {
    const node = strip.current?.querySelector<HTMLElement>(`[data-level="${Math.max(1, p.level)}"]`);
    if (node && strip.current) strip.current.scrollLeft = Math.max(0, node.offsetLeft - strip.current.offsetLeft - 4);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  const delivered = (result: Record<string, unknown>) => {
    if (result.state && typeof result.revision === 'number') onState(result.state, result.revision);
    setBuying(null);
    void events.refresh();
  };
  return <section className="ev-pass">
    <div className="ev-hero ev-hero-pass">
      <div><span className="ev-kicker">Season {p.season}</span><strong>Battle Pass</strong>
        <small><Hourglass size={12} aria-hidden="true" /> Ends in {left(p.ends_at, now)}</small></div>
      <div className="ev-pass-level" aria-label={`Level ${p.level}`}><b>{p.level}</b></div>
    </div>
    <div className="ev-pass-xp"><div className="ev-bar ev-bar-pass"><i style={{ width: `${Math.min(100, into / p.xp_per_level * 100)}%` }} /></div>
      <small>{p.level >= p.max_level ? 'Max level' : `${formatNum(into)} / ${p.xp_per_level} XP · level ${p.level}/${p.max_level}`}</small></div>
    <div className="ev-subtabs" role="tablist">
      <button type="button" role="tab" aria-selected={view === 'rewards'} className={view === 'rewards' ? 'is-active' : ''} onClick={() => setView('rewards')}>Rewards{ready > 0 && <b className="ev-count">{ready}</b>}</button>
      <button type="button" role="tab" aria-selected={view === 'quests'} className={view === 'quests' ? 'is-active' : ''} onClick={() => setView('quests')}>Quests{questsReady > 0 && <b className="ev-count">{questsReady}</b>}</button>
    </div>
    {view === 'rewards' ? <>
      <div className="ev-track-wrap">
        <div className="ev-track-labels">
          {TRACKS.map(({ id, title, price, Icon }) => <div key={id} className={`ev-track-label ev-label-${id} ${id === 'free' || p.tiers.includes(id) ? 'is-owned' : ''}`}>
            <i className="ev-track-seal" aria-hidden="true"><Icon size={13} /></i><strong>{title}</strong>{price && !p.tiers.includes(id as PassTier) && <small>{price}</small>}
            {id !== 'free' && p.tiers.includes(id as PassTier) && <small className="is-on">Active</small>}
          </div>)}
        </div>
        <div className="ev-track" ref={strip}>
          {levels.map((level) => <div key={level} className={`ev-col ${level <= p.level ? 'is-reached' : ''}`} data-level={level}>
            {TRACKS.map(({ id }) => {
              const entry = byKey.get(`${id}:${level}`)!;
              const locked = id !== 'free' && !p.tiers.includes(id as PassTier);
              const state = entry.claimed ? 'is-claimed' : locked ? 'is-locked' : level <= p.level ? 'is-ready' : '';
              return <div key={id} className={`ev-cell ev-cell-${id} ${state}`}>
                {rewardParts(entry.reward).map(([kind, amount]) => <RewardTile key={kind} kind={kind} amount={amount} state={state} />)}
              </div>;
            }).flatMap((cell, index) => index === 0 ? [cell, <div key="level" className="ev-level"><b><span>{level}</span></b></div>] : [cell])}
          </div>)}
        </div>
      </div>
      {buying && <div className="ev-buy" role="dialog" aria-label={`Buy ${buying === 'premium' ? 'Empowered' : 'Collector'} Pass`}>
        <button type="button" className="ev-buy-close" onClick={() => setBuying(null)} aria-label="Close"><X size={16} /></button>
        <strong>{buying === 'premium' ? 'Empowered Pass' : 'Collector Pass'}</strong>
        <small>{buying === 'premium' ? 'Unlocks the Empowered column for this season and doubles crown calendar days.' : 'Unlocks the Collector column for this season and doubles crown calendar days. Bought separately from Empowered.'}</small>
        <p className="ev-price">{skrPrice(p.prices[buying], rate)}<SkrUsd cents={p.prices[buying]} /></p>
        <SkrPurchaseButton product="event_pass_buy" params={{ tier: buying }} label="Get SKR quote" onDelivered={delivered} />
      </div>}
      <div className="ev-pass-bar">
        <button type="button" className="ev-btn ev-btn-primary" disabled={ready === 0 || events.busy !== null} onClick={() => void events.claim('pass')}>
          {events.busy ? 'Claiming…' : ready ? `Claim all (${ready})` : 'Claim all'}</button>
        {(['premium', 'collector'] as PassTier[]).map((tier) => p.tiers.includes(tier)
          ? <span key={tier} className={`ev-owned ev-owned-${tier}`}><Check size={14} aria-hidden="true" />{tier === 'premium' ? 'Empowered' : 'Collector'}</span>
          : <button key={tier} type="button" className={`ev-btn ev-btn-buy ev-buy-${tier}`} onClick={() => setBuying(tier)}>{tier === 'premium' ? '$4.99' : '$14.99'}<small>SKR</small></button>)}
      </div>
    </> : <div className="ev-scroll ev-pad">
      {(['daily', 'season'] as const).map((period) => <div key={period} className="ev-quest-group">
        <h3>{period === 'daily' ? 'Daily quests' : 'Season quests'}<small>{period === 'daily' ? `Reset in ${left(p.daily_resets_at, now)}` : `Ends in ${left(p.ends_at, now)}`}</small></h3>
        {p.quests.filter((quest) => quest.period === period).map((quest) => <QuestRow key={quest.id} label={quest.label} progress={quest.progress}
          target={quest.target} done={quest.progress >= quest.target} claimed={quest.claimed} busy={events.busy !== null}
          reward={<span className="ev-xp">+{formatNum(quest.xp)} XP</span>} onClaim={() => void events.claim('pass_quest', quest.id)} />)}
      </div>)}
      <p className="ev-muted"><ScrollText size={12} aria-hidden="true" /> Battle Pass XP comes only from these quests. {p.xp_per_level} XP per level.</p>
    </div>}
  </section>;
}
