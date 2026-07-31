import { Coins, Zap, Shield } from 'lucide-react';
import { formatNum, accountXpForLevel } from '@/game/state';

export function TopBar({
  gold, hero, accountLevel, accountXp, totalTokens,
}: {
  gold: number; hero: number;
  accountLevel: number; accountXp: number;
  totalTokens: number;
}) {
  const need = accountXpForLevel(accountLevel);
  const pct = Math.min(100, (accountXp / need) * 100);

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-slate-950/90 border-b border-white/10 shrink-0">
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-700 flex items-center justify-center border border-violet-400/50">
          <Shield size={14} className="text-violet-100" />
        </div>
        <div className="hidden sm:block">
          <div className="text-[9px] text-slate-500 leading-none">HeroLoop</div>
          <div className="text-xs font-bold text-violet-300 leading-tight">Lv {accountLevel}</div>
        </div>
        <div className="hidden md:block w-20">
          <div className="h-1 rounded-full bg-black/50 overflow-hidden">
            <div className="h-full bg-violet-400" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 ml-auto">
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <Coins size={14} className="text-amber-400" />
          <span className="text-amber-300 font-bold text-sm tabular-nums">{formatNum(gold)}</span>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-violet-500/10 border border-violet-500/30" title="$HERO Token">
          <Zap size={14} className="text-violet-300" />
          <span className="text-violet-200 font-bold text-sm tabular-nums">{formatNum(hero)}</span>
        </div>
        {totalTokens > 0 && <span className="hidden xl:inline text-[9px] text-slate-600">Total earned: {formatNum(totalTokens)}</span>}
      </div>
    </div>
  );
}
