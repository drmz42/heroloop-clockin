import { Coins, X, Package, Star } from 'lucide-react';
import { formatNum } from '@/game/state';

export function OfflineModal({
  gold, seconds, chests, xp, onClose,
}: {
  gold: number; seconds: number; chests?: number; xp?: number; onClose: () => void;
}) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/90 p-4 anim-fade" style={{ zIndex: 9999 }}>
      <div className="relative w-full max-w-sm px-panel-raised p-5 text-center anim-slide-up" style={{ zIndex: 9999 }}>
        <button onClick={onClose} className="absolute -top-2 -right-2 p-1.5 bg-px-panel border-2 border-px-border"><X size={16} className="text-px-text" /></button>

        <div className="text-4xl mb-2">🏰</div>
        <h3 className="font-vt text-2xl font-bold text-gold-glow mb-1">Welcome Back!</h3>
        <p className="font-vt text-px-dim text-sm mb-3">
          Heroes fought for <span className="text-px-text font-bold">{timeStr}</span> while you were away.
        </p>

        {/* Gold — always shown */}
        <div className="px-panel p-3 mb-2 border-2 border-px-gold">
          <div className="flex items-center justify-center gap-2">
            <Coins size={28} className="text-px-bright" />
            <span className="font-vt text-4xl font-bold text-px-bright tabular-nums">+{formatNum(gold)}</span>
          </div>
          <div className="font-vt text-sm text-px-dim mt-0.5 uppercase tracking-wide">Gold Earned</div>
        </div>

        {/* XP — always shown */}
        <div className={`px-panel p-2.5 mb-2 border-2 ${(xp ?? 0) > 0 ? 'border-emerald-500 bg-emerald-900/20' : 'border-px-border opacity-50'}`}>
          <div className="flex items-center justify-center gap-2">
            <Star size={20} className={(xp ?? 0) > 0 ? 'text-emerald-400' : 'text-px-dim'} />
            <span className="font-vt text-2xl font-bold tabular-nums" style={{ color: (xp ?? 0) > 0 ? '#4ade80' : '#5c3f08' }}>
              {(xp ?? 0) > 0 ? `+${formatNum(xp!)}` : '+0'}
            </span>
          </div>
          <div className="font-vt text-xs text-px-dim">Account XP</div>
        </div>

        {/* Chests — always shown */}
        <div className={`px-panel p-2.5 mb-3 border-2 ${(chests ?? 0) > 0 ? 'border-amber-500 bg-amber-900/20' : 'border-px-border opacity-50'}`}>
          <div className="flex items-center justify-center gap-2">
            <Package size={20} className={(chests ?? 0) > 0 ? 'text-amber-300' : 'text-px-dim'} />
            <span className="font-vt text-2xl font-bold tabular-nums" style={{ color: (chests ?? 0) > 0 ? '#fbbf24' : '#5c3f08' }}>
              {(chests ?? 0) > 0 ? `+${chests}` : '+0'}
            </span>
          </div>
          <div className="font-vt text-xs text-px-dim">Chests Banked · 500 max</div>
        </div>

        <button onClick={onClose} className="w-full py-3 px-btn text-lg font-bold">
          Collect
        </button>
      </div>
    </div>
  );
}
