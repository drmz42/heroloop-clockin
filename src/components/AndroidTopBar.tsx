import { Mail, Rocket, UserRound, Wallet } from 'lucide-react';
import { HeroPortrait } from '@/components/HeroPortrait';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { COMMANDER_OPEN_EVENT, TeamPowerReadout } from '@/components/GameProgressBar';
import { SkrBalance } from '@/components/GameNavBar';
import { shortWalletAddress } from '@/components/walletAddress';
import { HERO_MAP } from '@/game/heroes';
import { groupNumber } from '@/game/numberFormat';

// Android top bar, two rows (Founder 2026-10-03): logo, Gold, SKR and Team Power; then Commander,
// Boost Max, wallet and Mailbox. It replaces the web progress bar and command bar on the phone layout.
export function AndroidTopBar({ power, identity, gold, commander, boostActive, walletAddress, mailCount, onLogo, onTokens, onBoost, onWallet, onMail }: {
  power: number; identity: string; gold: number;
  commander: { heroId: string; level: number };
  boostActive: boolean; walletAddress: string | null; mailCount: number;
  onLogo: () => void; onTokens: () => void; onBoost: () => void; onWallet: () => void; onMail: () => void;
}) {
  const avatar = HERO_MAP[commander.heroId];
  return <header className="game-progress-bar hl-topbar" aria-label="Account and resources">
    <div className="hl-topbar-row">
      <button type="button" onClick={onLogo} className="hl-topbar-logo" aria-label="Open Play screen">
        <img src="/assets/brand/heroloop-emblem.png" alt="HeroLoop" width={154} height={160} />
      </button>
      <div className="hl-topbar-pill hl-topbar-gold" title="Gold">
        <span className="hl-topbar-coin" aria-hidden="true" />
        <span className="hl-topbar-value">{groupNumber(Math.floor(gold))}</span>
        <span className="hl-topbar-unit">Gold</span>
      </div>
      <button type="button" onClick={onTokens} className="hl-topbar-pill hl-topbar-skr" aria-label="Open Rewards and Tokenomics" title="Rewards & Tokenomics">
        <HeroTokenIcon size={14} />
        <span className="hl-topbar-value"><SkrBalance /></span>
        <span className="hl-topbar-unit">SKR</span>
      </button>
      <TeamPowerReadout power={power} identity={identity} />
    </div>
    <div className="hl-topbar-row">
      {avatar && <button type="button" className="game-progress-commander" onClick={() => window.dispatchEvent(new Event(COMMANDER_OPEN_EVENT))} aria-label={`Commander, level ${commander.level}`}>
        <HeroPortrait heroId={avatar.id} heroClass={avatar.heroClass} rarity={avatar.rarity} color={avatar.color} size={40} />
        <b>{commander.level}</b>
      </button>}
      <button type="button" className={`game-progress-boost hl-topbar-boost ${boostActive ? 'is-active' : ''}`} onClick={onBoost} aria-label={boostActive ? 'Boost Max active' : 'Open Boost Max'}>
        <Rocket size={17} aria-hidden="true" /><span>{boostActive ? 'Boost on' : 'Boost max'}</span>
      </button>
      <button type="button" onClick={onWallet} className="game-control hl-topbar-wallet" aria-label={walletAddress ? `Open wallet ${shortWalletAddress(walletAddress)}` : 'Open account'} title={walletAddress ?? 'Account'}>
        {walletAddress ? <Wallet size={17} aria-hidden="true" /> : <UserRound size={17} aria-hidden="true" />}
        <span>{walletAddress ? shortWalletAddress(walletAddress) : 'Account'}</span>
      </button>
      <button type="button" onClick={onMail} className="game-control hl-topbar-mail" title="Mailbox" aria-label={mailCount > 0 ? `Mailbox, ${mailCount} waiting` : 'Mailbox'}>
        <Mail size={18} aria-hidden="true" />
        {mailCount > 0 && <span className="hl-topbar-badge">{mailCount}</span>}
      </button>
    </div>
  </header>;
}
