import { isolatedHackathon } from '@/game/editionStorage';
import { useRef } from 'react';
import { Mail, ChevronLeft, ChevronRight, UserRound, Wallet, Shield, Sparkles, Dumbbell, ShoppingBag, Store, Trophy, UserPlus, Hammer } from 'lucide-react';
import type { Tab } from './TopMenu';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { shortWalletAddress } from '@/components/walletAddress';

const TABS = [
  { id: 'heroes',      label: 'Heroes',   icon: Shield },
  { id: 'summon',      label: 'Summon',   icon: Sparkles },
  { id: 'training',    label: 'Training', icon: Dumbbell },
  { id: 'crafting',    label: 'Crafting', icon: Hammer },
  { id: 'shop',        label: 'Store',    icon: ShoppingBag },
  { id: 'market',      label: 'Market',   icon: Store },
  { id: 'leaderboard', label: 'Ranks',    icon: Trophy },
  { id: 'referrals',   label: 'Refer',    icon: UserPlus },
] satisfies { id: Tab; label: string; icon: typeof Shield }[];

const formatResource = (value: number) => Math.floor(value).toLocaleString('en-US').replace(/,/g, ' ');

export function GameNavBar({
  tab, onChange, gold, hero, mailCount, onMailClick, walletAddress, onWalletClick, onTokensClick,
}: {
  tab: Tab; onChange: (t: Tab) => void;
  gold: number; hero: number; mailCount: number; onMailClick: () => void;
  walletAddress: string | null;
  onWalletClick: () => void;
  onTokensClick: () => void;
}) {
  const navRef = useRef<HTMLDivElement>(null);
  const scrollNav = (direction: -1 | 1) => navRef.current?.scrollBy({ left: direction * 180, behavior: 'smooth' });

  return (
    <div className="game-command-bar flex min-h-[54px] shrink-0 items-center gap-1 border-b px-2.5 py-2 shadow-[0_12px_35px_rgba(0,0,0,.42)] z-40">
      {/* Logo */}
      <button type="button" onClick={() => onChange('main')} className="hl-nav-logo mr-1 flex shrink-0 items-center border-r border-[#59472d] pl-1 pr-3" aria-label="Open Play screen">
        <img src="/assets/brand/heroloop-logo.png" alt="HeroLoop" width={154} height={46} className="h-9 w-auto max-w-[148px] object-contain drop-shadow-[0_0_8px_rgba(226,170,61,.28)]" />
      </button>

      {/* Nav tabs */}
      <div className="hl-nav-tabs flex min-w-0 flex-1 items-center gap-0.5">
        <button type="button" onClick={() => scrollNav(-1)} className="game-nav-control grid h-8 w-7 shrink-0 place-items-center px-0" aria-label="Scroll navigation left"><ChevronLeft size={15} /></button>
        <div ref={navRef} className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
            <button
              type="button"
              key={t.id}
              onClick={() => onChange(t.id)}
              className={`game-nav-control flex items-center gap-1.5 whitespace-nowrap px-3 py-1 font-vt ui-text-medium font-semibold tracking-wide ${tab === t.id ? 'game-nav-control-active' : ''}`}
            >
              <Icon size={14} aria-hidden="true" /> {t.label}
            </button>
            );
          })}
        </div>
        <button type="button" onClick={() => scrollNav(1)} className="game-nav-control grid h-8 w-7 shrink-0 place-items-center px-0" aria-label="Scroll navigation right"><ChevronRight size={15} /></button>
      </div>

      {/* Right side */}
      <div className="hl-nav-right ml-auto flex shrink-0 items-center gap-1.5 border-l border-[#4b3d29] pl-2">
        <button
          type="button"
          onClick={onWalletClick}
          className="game-control flex items-center gap-2 px-3 py-1.5 ui-text-medium font-semibold text-[#c9c3b5]"
          aria-label={walletAddress ? `Open wallet ${shortWalletAddress(walletAddress)}` : 'Open account'}
          title={walletAddress ?? 'Account'}
        >
          {walletAddress
            ? <><Wallet size={16} className="text-[#e0a83c]" /> <span className="hl-nav-wallet-label font-mono ui-text-medium tracking-wide">{shortWalletAddress(walletAddress)}</span></>
            : <><UserRound size={16} /> <span className="hidden xl:inline">Account</span></>}
        </button>
        {/* Mail */}
        <button type="button" onClick={onMailClick} className="game-control relative grid h-9 w-9 place-items-center" title="Mailbox" aria-label={mailCount > 0 ? `Mailbox, ${mailCount} waiting` : 'Mailbox'}>
          <Mail size={16} className="text-px-text" />
          {mailCount > 0 && <span className="absolute -top-1.5 -right-1.5 bg-px-red text-white ui-text-small font-vt font-bold px-0.5 leading-tight">{mailCount}</span>}
        </button>

        {/* Gold */}
        <div className="flex h-8 items-center gap-2 rounded-full border border-[#665026] bg-[linear-gradient(180deg,#15130f_0%,#090908_100%)] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,.05),0_3px_10px_rgba(0,0,0,.3)]">
          <span className="h-3 w-3 shrink-0 rounded-full border border-amber-200/70 bg-[radial-gradient(circle_at_35%_30%,#fff1a5_0%,#e8ad21_38%,#89520a_78%)] shadow-[0_0_7px_rgba(245,184,45,.55)]" aria-hidden="true" />
          <span className="ui-text-medium font-black tabular-nums text-[#ffd95e]">{formatResource(gold)}</span>
          <span className="hl-nav-unit ui-text-small font-bold uppercase tracking-[.12em] text-[#9a8b70]">Gold</span>
        </div>

        {/* $HERO: opens Rewards & Tokenomics */}
        <button
          type="button"
          onClick={onTokensClick}
          className="hl-hero-only flex h-8 items-center gap-2 rounded-full border border-lime-500/40 bg-[linear-gradient(180deg,#12150d_0%,#080a07_100%)] px-3 shadow-[inset_0_1px_0_rgba(255,255,255,.05),0_3px_10px_rgba(0,0,0,.3)] transition hover:border-lime-400/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-300"
          aria-label="Open Rewards and Tokenomics"
          title="Rewards & Tokenomics"
        >
          <HeroTokenIcon size={12} />
          <span className="ui-text-medium font-black tabular-nums text-lime-300">{isolatedHackathon ? '—' : formatResource(hero)}</span>
          <span className="hl-nav-unit ui-text-small font-bold uppercase tracking-[.1em] text-[#7f8a69]">$Hero</span>
        </button>
      </div>
    </div>
  );
}
