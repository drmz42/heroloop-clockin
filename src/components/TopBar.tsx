import { isolatedHackathon } from '@/game/editionStorage';
import { Shield } from 'lucide-react';
import { accountXpForLevel, accountXpProgress } from '@/game/state';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';

const formatResource = (value: number) => Math.floor(value).toLocaleString('en-US').replace(/,/g, ' ');

export function TopBar({
  gold, hero, accountLevel, accountXp,
}: {
  gold: number; hero: number;
  accountLevel: number; accountXp: number;
  totalTokens: number;
}) {
  const need = accountXpForLevel(accountLevel);
  const pct = Math.min(100, (accountXpProgress(accountXp, accountLevel) / need) * 100);

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

      <div className="ml-auto flex items-center gap-2">
        <div className="flex h-8 items-center gap-2 rounded-full border border-[#665026] bg-[linear-gradient(180deg,#15130f_0%,#090908_100%)] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,.05),0_3px_10px_rgba(0,0,0,.3)]">
          <span className="h-3 w-3 shrink-0 rounded-full border border-amber-200/70 bg-[radial-gradient(circle_at_35%_30%,#fff1a5_0%,#e8ad21_38%,#89520a_78%)] shadow-[0_0_7px_rgba(245,184,45,.55)]" aria-hidden="true" />
          <span className="text-sm font-black tabular-nums text-[#ffd95e]">{formatResource(gold)}</span>
          <span className="text-[9px] font-bold uppercase tracking-[.12em] text-[#9a8b70]">Gold</span>
        </div>
        <div className="flex h-8 items-center gap-2 rounded-full border border-lime-500/40 bg-[linear-gradient(180deg,#12150d_0%,#080a07_100%)] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,.05),0_3px_10px_rgba(0,0,0,.3)]" title="$HERO Token">
          <HeroTokenIcon size={12} />
          <span className="text-sm font-black tabular-nums text-lime-300">{isolatedHackathon ? '—' : formatResource(hero)}</span>
          <span className="text-[9px] font-bold uppercase tracking-[.1em] text-[#7f8a69]">$Hero</span>
        </div>
      </div>
    </div>
  );
}
