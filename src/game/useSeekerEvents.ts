import { useCallback, useEffect, useState } from 'react';
import { playerSync } from './backend';

export type EventReward = { gold: number; scrolls: number; chests: number; boss_keys: number };
export type EventTab = 'calendar' | 'weekly' | 'pass';
export type PassTier = 'premium' | 'collector';
export type PassTrack = 'free' | PassTier;
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
    season: number; starts_at: string; ends_at: string; tiers: PassTier[]; xp: number; level: number;
    xp_per_level: number; max_level: number; prices: { premium: number; collector: number }; daily_resets_at: string;
    rewards: Array<{ level: number; track: PassTrack; reward: EventReward; claimed: boolean }>;
    quests: Array<{ id: string; period: 'daily' | 'season'; label: string; target: number; xp: number; progress: number; claimed: boolean }>;
  };
};

const ERRORS: Record<string, string> = {
  event_already_claimed: 'Already claimed.',
  event_quest_incomplete: 'This quest is not complete yet.',
  event_nothing_to_claim: 'No Pass rewards are ready yet.',
  event_pass_owned: 'You already own this Pass column.',
  chest_capacity_exceeded: 'Your chest queue is full. Open chests first.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  feature_paused: 'Events are paused for maintenance.',
};

/** Ready rewards: today's check-in, finished weekly quests and reached Pass ranks. */
export function readyEventCount(status: SeekerEventStatus | null): number {
  if (!status) return 0;
  const calendar = status.calendar.claimed_today ? 0 : 1;
  const weekly = status.weekly.quests.filter((quest) => !quest.claimed && quest.progress >= quest.target).length;
  return calendar + weekly + (passReady(status) > 0 ? 1 : 0) + passQuestsReady(status);
}
export function passReady(status: SeekerEventStatus): number {
  const { pass } = status;
  return pass.rewards.filter((entry) => !entry.claimed && entry.level <= pass.level
    && (entry.track === 'free' || pass.tiers.includes(entry.track))).length;
}
export function passQuestsReady(status: SeekerEventStatus): number {
  return status.pass.quests.filter((quest) => !quest.claimed && quest.progress >= quest.target).length;
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
  const claim = async (kind: EventTab | 'pass_quest', id = '') => {
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
