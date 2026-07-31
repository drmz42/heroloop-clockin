import { Mail, Coins, Zap, ChevronDown, Rocket, Users, WalletCards } from 'lucide-react';
import { formatNum } from '@/game/state';
import type { Tab } from './TopMenu';

const TABS: { id: Tab; label: string }[] = [
  { id: 'main',        label: 'Play'    },
  { id: 'heroes',      label: 'Heroes'  },
  { id: 'summon',      label: 'Summon'  },
  { id: 'shop',        label: 'Store'   },
  { id: 'market',      label: 'Market'  },
  { id: 'leaderboard', label: 'Ranks'   },
  { id: 'referrals',   label: 'Refer'   },
];

export function GameNavBar({
  tab, onChange, gold, hero, username, mailCount, boostActive, onBoostClick, onWalletClick,
}: {
  tab: Tab; onChange: (t: Tab) => void;
  gold: number; hero: number; username: string; mailCount: number;
  boostActive: boolean; onBoostClick: () => void;
  onWalletClick: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 bg-px-panel border-b-2 border-px-border shrink-0 min-h-[44px]">
      {/* Logo */}
      <div className="flex items-center gap-1.5 shrink-0 pl-1 pr-2 border-r-2 border-px-border mr-1">
        <div className="w-8 h-8 bg-px-gold border-2 border-px-bright flex items-center justify-center font-pixel text-[10px] text-px-bg" style={{ boxShadow: '2px 2px 0 #3d2008' }}>H</div>
        <span className="font-vt text-lg text-gold-glow hidden sm:inline font-bold">HeroLoop</span>
      </div>

      {/* Nav tabs */}
      <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`px-2.5 py-1 font-vt text-base font-bold tracking-wide transition-none border-2 whitespace-nowrap ${tab === t.id ? 'px-btn-active bg-px-gold/20 border-px-bright text-px-bright' : 'border-transparent text-px-dim hover:text-px-text hover:bg-px-panel2'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-1.5 ml-auto shrink-0">
        <button
          onClick={onWalletClick}
          className="flex items-center gap-2 rounded-lg border border-violet-400/30 bg-violet-400/[.08] px-3 py-2 text-sm font-semibold text-violet-200 transition hover:border-violet-300/60 hover:bg-violet-400/[.14]"
        >
          <WalletCards size={16} /> <span className="hidden xl:inline">Wallet</span>
        </button>
        {/* BOOST MAX is always lit */}
        <button
          onClick={onBoostClick}
          className={`flex items-center gap-1.5 px-3 py-1.5 border-2 font-vt text-sm font-bold transition-none ${boostActive ? 'border-px-green text-px-green bg-px-green/10 anim-boost-pulse' : 'border-px-gold text-px-bright bg-px-gold/10 anim-boost-shimmer'}`}
          title="Boost your offline earnings to 24/7"
        >
          <Rocket size={15} /> <span>{boostActive ? 'BOOST ON' : 'BOOST MAX'}</span>
        </button>

        {/* Mail */}
        <button className="relative p-1.5 border-2 border-px-border bg-px-panel2 hover:border-px-gold transition-none" title="Mailbox">
          <Mail size={16} className="text-px-text" />
          {mailCount > 0 && <span className="absolute -top-1.5 -right-1.5 bg-px-red text-white text-[9px] font-vt font-bold px-0.5 leading-tight">{mailCount}</span>}
        </button>

        {/* Gold */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 border-2 border-px-gold bg-px-panel2" style={{ boxShadow: '2px 2px 0 #3d2008' }}>
          <Coins size={16} className="text-px-bright" />
          <span className="text-px-bright font-vt text-lg font-bold tabular-nums">{formatNum(gold)}</span>
        </div>

        {/* $HERO */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 border-2 border-purple-500 bg-px-panel2" style={{ boxShadow: '2px 2px 0 #3d2008' }}>
          <Zap size={16} className="text-purple-300" />
          <span className="text-purple-200 font-vt text-lg font-bold tabular-nums">{formatNum(hero)}</span>
        </div>

        {/* Username */}
        <button className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 border-2 border-px-border bg-px-panel2 hover:border-px-gold transition-none">
          <Users size={14} className="text-px-dim" />
          <span className="text-px-text font-vt text-base font-bold">{username || 'player'}</span>
          <ChevronDown size={12} className="text-px-dim" />
        </button>
      </div>
    </div>
  );
}
