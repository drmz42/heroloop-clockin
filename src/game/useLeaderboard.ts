import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { playerSync } from './backend';

export interface RankHero { hero_id: string; level: number; stars: number; }
export interface LeaderRow { player_id: string; username: string; account_level: number; power: number; collection_power: number; total_kills: number; boss_kills: number; online: boolean; lineup: RankHero[]; avatar_hero_id: string; summons: number; total_tokens_earned: number; }
export interface LeaderboardSnapshot { players: LeaderRow[]; me: string; }

// Keep only the current verified session's server response in memory. Opening Ranks
// can render the podium immediately while its existing sync refreshes the standings.
export function useLeaderboard(identity: string | null) {
  const scope = useMemo(() => ({ identity }), [identity]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [cached, setCached] = useState<{ scope: typeof scope; snapshot: LeaderboardSnapshot } | null>(null);
  const inFlight = useRef<{ scope: typeof scope; promise: Promise<void> } | null>(null);

  const refresh = useCallback((): Promise<void> => {
    if (!scope.identity || currentScope.current !== scope) return Promise.resolve();
    if (inFlight.current?.scope === scope) return inFlight.current.promise;
    const promise = playerSync<LeaderboardSnapshot>('leaderboard').then((data) => {
      if (data && currentScope.current === scope) {
        setCached({ scope, snapshot: { players: data.players ?? [], me: data.me ?? '' } });
      }
    }).catch(() => { /* Preserve the last confirmed snapshot on a failed read. */ }).finally(() => {
      if (inFlight.current?.scope === scope) inFlight.current = null;
    });
    inFlight.current = { scope, promise };
    return promise;
  }, [scope]);

  useEffect(() => {
    if (!scope.identity) { setCached(null); return; }
    void refresh();
  }, [refresh, scope]);

  return { snapshot: cached?.scope === scope ? cached.snapshot : null, refresh };
}
