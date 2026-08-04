import { Mail, ChevronDown, Rocket, Users, WalletCards } from 'lucide-react';
import type { Tab } from './TopMenu';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';

const TABS: { id: Tab; label: string }[] = [
  { id: 'main',        label: 'Play'    },
  { id: 'heroes',      label: 'Heroes'  },
  { id: 'summon',      label: 'Summon'  },
  { id: 'training',    label: 'Training' },
  { id: 'shop',        label: 'Store'   },
  { id: 'market',      label: 'Market'  },
  { id: 'leaderboard', label: 'Ranks'   },
  { id: 'referrals',   label: 'Refer'   },
];

const formatResource = (value: number) => Math.floor(value).toLocaleString('en-US').replace(/,/g, ' ');

export function GameNavBar({
  tab, onChange, gold, hero, username, mailCount, boostActive, onBoostClick, onWalletClick,
}: {
  tab: Tab; onChange: (t: Tab) => void;
  gold: number; hero: number; username: string; mailCount: number;
  boostActive: boolean; onBoostClick: () => void;
  onWalletClick: () => void;
}) {
  return (
    <div className="game-command-bar flex min-h-[54px] shrink-0 items-center gap-1 border-b px-2.5 py-2 shadow-[0_12px_35px_rgba(0,0,0,.42)] z-40">
      {/* Logo */}
      <div className="mr-1 flex shrink-0 items-center border-r border-[#59472d] pl-1 pr-3">
        <img src="/assets/brand/heroloop-logo.png" alt="HeroLoop" width={154} height={46} className="h-9 w-auto max-w-[148px] object-contain drop-shadow-[0_0_8px_rgba(226,170,61,.28)]" />
      </div>

      {/* Nav tabs */}
      <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`game-nav-control whitespace-nowrap px-3 py-1 font-vt text-sm font-semibold tracking-wide ${tab === t.id ? 'game-nav-control-active' : ''}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Right side */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5 border-l border-[#4b3d29] pl-2">
        <button
          onClick={onWalletClick}
          className="game-control flex items-center gap-2 px-3 py-1.5 text-sm font-semibold text-[#c9c3b5]"
        >
          <WalletCards size={16} /> <span className="hidden xl:inline">Wallet</span>
        </button>
        {/* BOOST MAX is always lit */}
        <button
          onClick={onBoostClick}
          className={`game-control flex items-center gap-1.5 px-3 py-1.5 font-vt text-sm font-bold ${boostActive ? 'boost-max-active' : 'boost-max-ready'}`}
          title="Boost your offline earnings to 24/7"
        >
          <Rocket size={15} /> <span>{boostActive ? 'BOOST ON' : 'BOOST MAX'}</span>
        </button>

        {/* Mail */}
        <button className="game-control relative grid h-9 w-9 place-items-center" title="Mailbox">
          <Mail size={16} className="text-px-text" />
          {mailCount > 0 && <span className="absolute -top-1.5 -right-1.5 bg-px-red text-white text-[9px] font-vt font-bold px-0.5 leading-tight">{mailCount}</span>}
        </button>

        {/* Gold */}
        <div className="flex h-8 items-center gap-2 rounded-full border border-[#665026] bg-[linear-gradient(180deg,#15130f_0%,#090908_100%)] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,.05),0_3px_10px_rgba(0,0,0,.3)]">
          <span className="h-3 w-3 shrink-0 rounded-full border border-amber-200/70 bg-[radial-gradient(circle_at_35%_30%,#fff1a5_0%,#e8ad21_38%,#89520a_78%)] shadow-[0_0_7px_rgba(245,184,45,.55)]" aria-hidden="true" />
          <span className="text-sm font-black tabular-nums text-[#ffd95e]">{formatResource(gold)}</span>
          <span className="text-[9px] font-bold uppercase tracking-[.12em] text-[#9a8b70]">Gold</span>
        </div>

        {/* $HERO */}
        <div className="flex h-8 items-center gap-2 rounded-full border border-lime-500/40 bg-[linear-gradient(180deg,#12150d_0%,#080a07_100%)] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,.05),0_3px_10px_rgba(0,0,0,.3)]">
          <HeroTokenIcon size={12} />
          <span className="text-sm font-black tabular-nums text-lime-300">{formatResource(hero)}</span>
          <span className="text-[9px] font-bold uppercase tracking-[.1em] text-[#7f8a69]">$Hero</span>
        </div>

        {/* Username */}
        <button className="game-control hidden items-center gap-1.5 px-2.5 py-1 lg:flex">
          <Users size={14} className="text-px-dim" />
          <span className="text-px-text font-vt text-base font-bold">{username || 'player'}</span>
          <ChevronDown size={12} className="text-px-dim" />
        </button>
      </div>
    </div>
  );
}
