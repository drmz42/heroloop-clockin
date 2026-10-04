import { Mail, Rocket, UserRound, Wallet } from 'lucide-react';
import type { CSSProperties } from 'react';
import { heroPortraitSrc, heroPortraitStyle } from '@/game/portraits';
import { HeroTokenIcon } from '@/components/HeroTokenIcon';
import { COMMANDER_OPEN_EVENT, TeamPowerReadout } from '@/components/GameProgressBar';
import { SkrBalance } from '@/components/GameNavBar';
import { shortWalletAddress } from '@/components/walletAddress';
import { HERO_MAP, RARITY_COLORS } from '@/game/heroes';
import { groupNumber } from '@/game/numberFormat';
import '@/theme/scene/topbar.css';
import { RarityFx } from '@/components/RarityFx';

// Android top bar, two rows (Founder 2026-10-03, restyled v2 the same day): a stone resource ledger with
// the emblem, Gold, SKR and Team Power; then Commander, Boost Max, wallet and Mailbox as one row of plates.
// It replaces the web progress bar and command bar on the phone layout.
// Full Gold up to a billion; beyond that the number would not fit a phone cell, so it goes compact.
const formatGold = (gold: number) => gold >= 1_000_000_000
  ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(gold)
  : groupNumber(Math.floor(gold));

export function AndroidTopBar({ power, identity, gold, commander, boostActive, walletAddress, mailCount, onLogo, onTokens, onBoost, onWallet, onMail }: {
  power: number; identity: string; gold: number;
  commander: { heroId: string; level: number };
  boostActive: boolean; walletAddress: string | null; mailCount: number;
  onLogo: () => void; onTokens: () => void; onBoost: () => void; onWallet: () => void; onMail: () => void;
}) {
  const avatar = HERO_MAP[commander.heroId];
  return <header className="game-progress-bar hl-topbar tb-bar" aria-label="Account and resources">
    <div className="tb-row tb-ledger">
      <button type="button" onClick={onLogo} className="tb-logo" aria-label="Open Play screen">
        <img src="/assets/brand/heroloop-emblem.png" alt="HeroLoop" width={154} height={160} />
      </button>
      <div className="tb-cell tb-gold" title={`${groupNumber(Math.floor(gold))} Gold`}>
        <span className="tb-cap">Gold</span>
        <span className="tb-val"><span className="tb-coin" aria-hidden="true" /><span>{formatGold(gold)}</span></span>
      </div>
      <button type="button" onClick={onTokens} className="tb-cell tb-skr" aria-label="Open Rewards and Tokenomics" title="Rewards & Tokenomics">
        <span className="tb-cap">SKR</span>
        <span className="tb-val"><HeroTokenIcon size={13} /><SkrBalance /></span>
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
      <button type="button" onClick={onWallet} className="tb-plate tb-wallet" aria-label={walletAddress ? `Open wallet ${shortWalletAddress(walletAddress)}` : 'Open account'} title={walletAddress ?? 'Account'}>
        {walletAddress ? <Wallet size={15} aria-hidden="true" /> : <UserRound size={15} aria-hidden="true" />}
        <span>{walletAddress ? shortWalletAddress(walletAddress) : 'Account'}</span>
      </button>
      <button type="button" onClick={onMail} className="tb-plate tb-mail" title="Mailbox" aria-label={mailCount > 0 ? `Mailbox, ${mailCount} waiting` : 'Mailbox'}>
        <Mail size={16} aria-hidden="true" />
        {mailCount > 0 && <span className="tb-badge">{mailCount}</span>}
      </button>
    </div>
  </header>;
}
