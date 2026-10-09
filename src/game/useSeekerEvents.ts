import { useCallback, useEffect, useState } from 'react';
import { playerSync } from './backend';

export type EventReward = { gold: number; scrolls: number; chests: number; boss_keys: number };
export type EventTab = 'calendar' | 'weekly' | 'pass';
export type PassTier = 'premium' | 'collector';
export type SeekerEventStatus = {
  server_time: string;
  calendar: {
    cycle: number; claimed_days: number; claimed_today: boolean; next_day: number | null; streak: number;
    streak_lost: boolean; multiplier: number; resets_at: string;
    days: Array<{ day: number; marked: boolean; reward: EventReward }>;
  };
  weekly: {
    theme: number; title: string; starts_at: string; ends_at: string;
    quests: Array<{ id: string; label: string; target: number; progress: number; reward: EventReward; claimed: boolean }>;
  };
  pass: {
    season: number; starts_at: string; ends_at: string; tier: PassTier | null; xp: number; rank: number;
    xp_per_rank: number; max_rank: number; prices: { premium: number; collector: number };
    rewards: Array<{ rank: number; track: 'free' | 'premium'; reward: EventReward; claimed: boolean }>;
  };
};

const ERRORS: Record<string, string> = {
  event_already_claimed: 'Already claimed.',
  event_quest_incomplete: 'This quest is not complete yet.',
  event_nothing_to_claim: 'No Pass rewards are ready yet.',
  chest_capacity_exceeded: 'Your chest queue is full. Open chests first.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  feature_paused: 'Events are paused for maintenance.',
};

/** Ready rewards: today's check-in, finished weekly quests and reached Pass ranks. */
export function readyEventCount(status: SeekerEventStatus | null): number {
  if (!status) return 0;
  const calendar = status.calendar.claimed_today ? 0 : 1;
  const weekly = status.weekly.quests.filter((quest) => !quest.claimed && quest.progress >= quest.target).length;
  const pass = status.pass.rewards.some((entry) => !entry.claimed && entry.rank <= status.pass.rank
    && (entry.track === 'free' || status.pass.tier !== null)) ? 1 : 0;
  return calendar + weekly + pass;
}

/** One poll of `seeker_event_status`; claims hydrate the server save they return. */
export function useSeekerEvents(enabled: boolean, onState: (state: unknown, revision: number) => void) {
  const [status, setStatus] = useState<SeekerEventStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    const result = await playerSync<SeekerEventStatus>('seeker_event_status');
    if (result?.calendar) setStatus(result);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);
  const claim = async (kind: EventTab, id = '') => {
    if (busy) return null;
    setBusy(`${kind}:${id}`); setMessage('');
    let error = '';
    try {
      const result = await playerSync<{ reward: EventReward; state: unknown; revision: number }>('seeker_event_claim',
        { kind, id, idempotency_key: crypto.randomUUID() }, (code) => { error = code; });
      if (result?.state) onState(result.state, result.revision);
      else setMessage(ERRORS[error] ?? 'The reward could not be claimed. Try again.');
      await refresh();
      return result?.reward ?? null;
    } finally { setBusy(null); }
  };
  return { status, busy, message, refresh, claim };
}
export type SeekerEventsApi = ReturnType<typeof useSeekerEvents>;
