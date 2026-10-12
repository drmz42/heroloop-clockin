import { Flame, Mail, Rocket, UserRound, Wallet } from 'lucide-react';
import type { CSSProperties } from 'react';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { GoldIcon } from '@/components/GoldIcon';
import { COMMANDER_OPEN_EVENT, TeamPowerReadout } from '@/components/GameProgressBar';
import { SkrBalance } from '@/components/GameNavBar';
import { shortWalletAddress } from '@/components/walletAddress';
import { HERO_MAP, RARITY_COLORS } from '@/game/heroes';
import { compactNumber, groupNumber } from '@/game/numberFormat';
import '@/theme/scene/topbar.css';
import { RarityFx } from '@/components/RarityFx';

// Android top bar, two rows (Founder 2026-10-03, restyled v2 the same day): a stone resource ledger with
// the emblem, Gold, SKR and Team Power; then Commander, Boost Max, wallet and Mailbox as one row of plates.
// Seeker (Founder 2026-10-09): the Events plate takes the wallet's place and opens the former battle burger
// (Events, Dungeons, Boss); the wallet moved to the top of More.
// It replaces the web progress bar and command bar on the phone layout.

export function AndroidTopBar({ power, identity, gold, commander, boostActive, walletAddress, mailCount, onLogo, onTokens, onBoost, onWallet, onMail, events }: {
  power: number; identity: string; gold: number;
  commander: { heroId: string; level: number };
  boostActive: boolean; walletAddress: string | null; mailCount: number;
  onLogo: () => void; onTokens: () => void; onBoost: () => void; onWallet: () => void; onMail: () => void;
  events?: { open: boolean; ready: number; onToggle: () => void };
}) {
  const avatar = HERO_MAP[commander.heroId];
  return <header className="game-progress-bar hl-topbar tb-bar" aria-label="Account and resources">
    <div className="tb-row tb-ledger">
      <button type="button" onClick={onLogo} className="tb-logo" aria-label="Open Play screen">
        <img src="/assets/brand/heroloop-emblem.png" alt="HeroLoop" width={154} height={160} />
      </button>
      <div className="tb-cell tb-gold" title={`${groupNumber(Math.floor(gold))} Gold`}>
        <span className="tb-cap">Gold</span>
        <span className="tb-val"><GoldIcon size={14} className="tb-coin" /><span key={compactNumber(Math.floor(gold))} className="tb-num">{compactNumber(Math.floor(gold))}</span></span>
      </div>
      <button type="button" onClick={onTokens} className="tb-cell tb-skr" aria-label="Open Rewards and Tokenomics" title="Rewards & Tokenomics">
        <span className="tb-cap">SKR</span>
        <span className="tb-val"><HeroTokenIcon size={13} /><SkrBalance compact /></span>
      </button>
      <div className="tb-cell tb-power"><TeamPowerReadout power={power} identity={identity} /></div>
    </div>
    <div className="tb-row tb-actions">
      {avatar && <button type="button" className="tb-commander" style={{ '--tb-rarity': RARITY_COLORS[avatar.rarity] } as CSSProperties} onClick={() => window.dispatchEvent(new Event(COMMANDER_OPEN_EVENT))} aria-label={`Commander, level ${commander.level}`}>
        <img src={heroPortraitSrc(avatar.id, avatar.heroClass, avatar.rarity, avatar.color)} alt="" style={{ ...heroPortraitStyle(avatar.id, avatar.heroClass), transform: 'none' }} />
        <RarityFx rarity={avatar.rarity} shape="slot" />
        <b>{commander.level}</b>
      </button>}
      <button type="button" className={`tb-plate tb-boost${boostActive ? ' is-active' : ''}`} onClick={onBoost} aria-label={boostActive ? 'Boost Max active' : 'Open Boost Max'}>
        <Rocket size={15} aria-hidden="true" /><span>{boostActive ? 'Boost on' : 'Boost max'}</span>
      </button>
      {events ? <button type="button" onClick={events.onToggle} className={`tb-plate tb-events${events.open ? ' is-active' : ''}${events.ready > 0 ? ' has-ready' : ''}`} data-guide="boss" aria-haspopup="dialog" aria-expanded={events.open} aria-label={events.ready > 0 ? `Events, ${events.ready} rewards ready` : 'Events'}>
        <Flame size={15} aria-hidden="true" /><span>Events</span>
        {events.ready > 0 && <span className="tb-badge">{events.ready > 99 ? '99+' : events.ready}</span>}
      </button> : <button type="button" onClick={onWallet} className="tb-plate tb-wallet" aria-label={walletAddress ? `Open wallet ${shortWalletAddress(walletAddress)}` : 'Open account'} title={walletAddress ?? 'Account'}>
        {walletAddress ? <Wallet size={15} aria-hidden="true" /> : <UserRound size={15} aria-hidden="true" />}
        <span>{walletAddress ? shortWalletAddress(walletAddress) : 'Account'}</span>
      </button>}
      <button type="button" onClick={onMail} className="tb-plate tb-mail" title="Mailbox" aria-label={mailCount > 0 ? `Mailbox, ${mailCount} waiting` : 'Mailbox'}>
        <Mail size={16} aria-hidden="true" />
        {mailCount > 0 && <span className="tb-badge">{mailCount}</span>}
      </button>
    </div>
  </header>;
}
