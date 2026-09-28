import { useEffect, useState } from 'react';
import { Rocket } from 'lucide-react';
import type { AccountBonusSnapshot } from '@/game/useGame';

/** Remaining boost time in milliseconds, refreshed every 30 seconds; 0 when inactive. */
export function useBoostRemaining(endsAt: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => { if (document.visibilityState === 'visible') setNow(Date.now()); };
    const timer = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [endsAt]);
  return endsAt === null ? 0 : Math.max(0, endsAt - now);
}

export function formatBoostRemaining(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** Commander tile: account-wide Gold/XP bonuses and the paid boost timer. */
export function RewardBoostTile({ bonus, onOpenShop }: { bonus: AccountBonusSnapshot | null; onOpenShop: () => void }) {
  const remaining = useBoostRemaining(bonus?.boostEndsAt ?? null);
  const active = remaining > 0;
  return (
    <div className={`stat-tile mb-2 px-2 py-1.5 ${active ? 'border-[#b48a43] shadow-[0_0_12px_rgba(225,177,77,.22)]' : ''}`}>
      <div className="flex items-center justify-between ui-text-small font-bold uppercase tracking-[.1em] text-[#8e887b]">
        <span>Account bonuses</span>
        <span className="tabular-nums text-[#d5bd85]">+{Math.round((bonus?.gold ?? 0) * 100)}% G · +{Math.round((bonus?.xp ?? 0) * 100)}% XP</span>
      </div>
      <button
        type="button"
        onClick={onOpenShop}
        className="mt-1 flex min-h-9 w-full items-center gap-1.5 rounded border border-[#4a4032]/70 bg-black/10 px-1.5 py-1 text-left"
        aria-label={active ? `Gold and XP boost active, ${formatBoostRemaining(remaining)} left` : 'Get a Gold and XP boost in the Shop'}
      >
        <Rocket size={13} aria-hidden="true" className={active ? 'text-[#efc760]' : 'text-[#777269]'} />
        <span className="flex-1 truncate ui-text-small font-bold text-[#e8e1d3]">{active ? 'Gold/XP Boost ×2' : 'Gold/XP Boost'}</span>
        <span className={`shrink-0 ui-text-small font-bold tabular-nums ${active ? 'text-[#efc760]' : 'text-[#9b8862]'}`}>
          {active ? `${formatBoostRemaining(remaining)} left` : 'Get'}
        </span>
      </button>
    </div>
  );
}
