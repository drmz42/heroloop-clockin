import { useCallback, useEffect, useState } from 'react';
import type { DailyQuest } from './types';
import { playerSync } from './backend';

export type MineSummary = { rounds_today: number; rounds_total: number; streak_days: number };
export type ChallengeStep = { id: string; step: number; percent: number; threshold: number; reward: DailyQuest['reward']; claimed: boolean };
export type Challenge = { completed: number; total: number; steps: ChallengeStep[] };

/** One poll of `skr_quest_status` shared by the challenge bar at the top and the quest cards below. */
export function useSeekerQuests(enabled: boolean, claim: (id: string) => Promise<boolean>, revision: string) {
  const [quests, setQuests] = useState<DailyQuest[]>([]);
  const [mine, setMine] = useState<MineSummary | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const refresh = useCallback(async () => {
    const result = await playerSync<{ quests: DailyQuest[]; mine?: MineSummary; challenge?: Challenge }>('skr_quest_status');
    if (result?.quests) setQuests(result.quests);
    if (result?.mine) setMine(result.mine);
    if (result?.challenge) setChallenge(result.challenge);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    // Quest progress also reloads on every revision change; the timer only catches server-side changes.
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [enabled, refresh]);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh, revision]);
  const collect = async (id: string) => {
    if (busy) return;
    setBusy(id); setError(null);
    try {
      if (!await claim(id)) setError({ id, message: 'The reward could not be claimed. Refresh and try again.' });
      await refresh();
    } finally { setBusy(null); }
  };
  return { quests, mine, challenge, busy, error, collect };
}
export type SeekerQuestBoard = ReturnType<typeof useSeekerQuests>;
