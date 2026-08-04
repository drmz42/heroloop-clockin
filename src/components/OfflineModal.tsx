import { CheckCircle2, Coins, X, Package, Star } from 'lucide-react';
import { formatNum } from '@/game/state';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';

export function OfflineModal({
  gold, seconds, tokens, chests, xp, onClose,
}: {
  gold: number; seconds: number; tokens?: number; chests?: number; xp?: number; onClose: () => void;
}) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/75 p-4 backdrop-blur-[5px] anim-fade" style={{ zIndex: 9999 }}>
      <div className="offline-vault relative w-full max-w-[400px] overflow-visible rounded-xl p-4 text-center anim-slide-up" style={{ zIndex: 9999 }}>
        <span className="offline-coin-cloud offline-coin-cloud-left" aria-hidden="true">● ● ●</span>
        <span className="offline-coin-cloud offline-coin-cloud-right" aria-hidden="true">● ●</span>
        <button onClick={onClose} className="absolute -top-2 -right-2 p-1.5 bg-px-panel border-2 border-px-border"><X size={16} className="text-px-text" /></button>

        <h3 className="mb-1 font-pixel text-base text-gold-glow">WHILE YOU WERE AWAY</h3>
        <p className="mb-2 font-vt text-sm text-px-dim">
          Your hero fought for <span className="font-bold text-px-text">{timeStr}</span>.
        </p>
        <div className="offline-afk-total mb-3">
          <span>+{formatNum(tokens ?? 0)}</span> <HeroTokenIcon size={15} /> $HERO
        </div>
        <div className="mb-2 grid grid-cols-2 gap-2">
          {[
            { icon: <Coins size={16} />, value: `+${formatNum(gold)}`, label: 'Gold' },
            { icon: <Star size={16} />, value: `+${formatNum(xp ?? 0)}`, label: 'Account XP' },
            { icon: <Package size={16} />, value: `+${formatNum(chests ?? 0)}`, label: 'Chests' },
          ].map((reward) => (
            <div key={reward.label} className="offline-reward-tile flex min-h-[54px] items-center gap-2 px-3 py-2 text-left">
              <span className="text-px-bright">{reward.icon}</span>
              <div><div className="font-vt text-lg font-bold tabular-nums text-px-bright">{reward.value}</div><div className="text-[10px] text-px-dim">{reward.label}</div></div>
            </div>
          ))}
        </div>

        <p className="mb-3 text-[10px] font-bold text-emerald-300"><CheckCircle2 size={12} className="mr-1 inline" />Already added to your balance</p>
        <button onClick={onClose} className="w-full px-btn py-2 text-sm font-bold">CLAIM</button>
      </div>
    </div>
  );
}
