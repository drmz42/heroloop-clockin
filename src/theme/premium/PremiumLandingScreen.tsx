// Premium public landing built from Figma "HL-LANDING-2 / MAKET 5 — Mobile" (node 2086:3).
// Artwork is the Founder-approved Figma raster set; frames, text and layout stay code-native.
// Classic fallback: test/landing4/Landing4Screen.tsx (selected by src/theme/uiTheme.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGame } from '@/game/useGame';
import { Onboarding } from '@/screens/LandingScreen';
import { setUiTheme } from '@/theme/uiTheme';
import './premium-landing.css';
import heroHost from './assets/hero-host.webp';
import logo from './assets/logo-heroloop.webp';
import playArt from './assets/btn-play.webp';
import coreLoop from './assets/core-loop.webp';
import classWarrior from './assets/class-warrior.webp';
import classMage from './assets/class-mage.webp';
import classAssassin from './assets/class-assassin.webp';
import classDruid from './assets/class-druid.webp';
import classCrossbowman from './assets/class-crossbowman.webp';
import worldRegions from './assets/world-regions.webp';
import worldDungeons from './assets/world-dungeons.webp';
import worldBosses from './assets/world-epicbosses.webp';
import worldSeasons from './assets/world-seasonscompetitions.webp';
import packFree from './assets/pack-free.webp';
import packStarter from './assets/pack-starter.webp';
import packScout from './assets/pack-scout.webp';
import packVeteran from './assets/pack-veteran.webp';
import packElite from './assets/pack-elite.webp';
import packFounder from './assets/pack-founder.webp';
import buyFree from './assets/btn-pack-free.webp';
import buyStarter from './assets/btn-pack-starter.webp';
import buyScout from './assets/btn-pack-scout.webp';
import buyVeteran from './assets/btn-pack-veteran.webp';
import buyElite from './assets/btn-pack-elite.webp';
import buyFounder from './assets/btn-pack-founder.webp';
import connectWalletArt from './assets/btn-connect-wallet.webp';
import banner from './assets/banner.webp';
import iconAppStore from './assets/icon-appstore.svg';
import iconGooglePlay from './assets/icon-googleplay.svg';
import iconSteam from './assets/icon-steam.svg';
import iconTelegram from './assets/icon-telegram.svg';

type Pack = { id: string; name: string; price: string; art: string; buy: string; buyLabel: string; features: Array<string | { note: string }> };

// Pack copy mirrors the Figma design; it is presentation only and grants nothing.
const PACKS: Pack[] = [
  { id: 'free', name: 'FREE', price: '$0', art: packFree, buy: buyFree, buyLabel: 'Play free', features: ['1 Selectable Starter Hero', 'Starting Gold', '10 Health Potions', 'Free Mode', 'Start Playing Instantly'] },
  { id: 'starter', name: 'STARTER', price: '$2', art: packStarter, buy: buyStarter, buyLabel: 'Get Starter', features: ['Earn Mode Unlocked', '20 Uncommon Founder Gear Chests', '2 Heroes', 'Starting Gold', 'Health Potions', 'Starter Resources'] },
  { id: 'scout', name: 'SCOUT', price: '$5', art: packScout, buy: buyScout, buyLabel: 'Get Scout', features: ['Earn Mode Unlocked', '20 Rare Founder Gear Chests', '2 Heroes', 'More Starting Gold', 'Health Potions', 'Enhanced Starter Resources'] },
  { id: 'veteran', name: 'VETERAN', price: '$10', art: packVeteran, buy: buyVeteran, buyLabel: 'Get Veteran', features: ['Earn Mode Unlocked', 'Marketplace Access', '3 Heroes', '30 Epic Founder Gear Chests', 'Starting Gold', 'Health Potions', '1× Boost Pack', { note: '3 × 24h activations' }, '+50% XP & Gold while active'] },
  { id: 'elite', name: 'ELITE', price: '$49', art: packElite, buy: buyElite, buyLabel: 'Get Elite', features: ['Earn Mode Unlocked', 'Marketplace Access', '30 Legendary Founder Gear Chests', '750 Summon Scrolls', 'Starting Gold', 'Health Potions', '2× Boost Packs', '25 Active Market Listings', 'Private Community Access', 'Elite Founder Frame', '+2% Ordinary Earn Weight'] },
  { id: 'founder', name: 'FOUNDER', price: '$99', art: packFounder, buy: buyFounder, buyLabel: 'Get Founder', features: ['Earn Mode Unlocked', 'Marketplace Access', '30 Mythic Founder Gear Chests', '3,000 Summon Scrolls', 'Starting Gold', 'Health Potions', '3× Boost Packs', '50 Active Market Listings', 'Private Community Access', 'Founder Frame', 'Founder Sigil', '+5% Ordinary Earn Weight'] },
];

const CLASSES = [
  { id: 'warrior', name: 'Warrior', tagline: 'Unbreakable force', art: classWarrior },
  { id: 'mage', name: 'Mage', tagline: 'Masters of the arcane', art: classMage },
  { id: 'assassin', name: 'Assassin', tagline: 'Shadows strike', art: classAssassin },
  { id: 'druid', name: 'Druid', tagline: 'Harmony with nature', art: classDruid },
  { id: 'crossbowman', name: 'Crossbowman', tagline: 'Precision wins', art: classCrossbowman },
];

const WORLD = [
  { id: 'regions', label: '20 Regions — vast lands to explore', art: worldRegions },
  { id: 'dungeons', label: 'Dungeons — hidden depths, greater loot', art: worldDungeons },
  { id: 'bosses', label: 'Epic Bosses — monumental foes await', art: worldBosses },
  { id: 'seasons', label: 'Seasons & Competitions — prove your strength, earn unique rewards', art: worldSeasons },
];

const CORE_LOOP = ['Collect heroes', 'Build your squad', 'Battle automatically', 'Earn loot & XP', 'Grow stronger', 'Ascend to new regions'];

const PLATFORMS = [
  { name: 'App Store', icon: iconAppStore },
  { name: 'Google Play', icon: iconGooglePlay },
  { name: 'Steam', icon: iconSteam },
  { name: 'Telegram Mini App', icon: iconTelegram },
];

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

function SectionHeading({ id, title, subtitle }: { id?: string; title: string; subtitle: string }) {
  return (
    <header className="l5-heading" id={id}>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      <span className="l5-ornament" aria-hidden="true"><i /></span>
    </header>
  );
}

function ArtButton({ art, label, onClick, className = '' }: { art: string; label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`l5-art-button ${className}`} onClick={onClick} aria-label={label}>
      <img src={art} alt="" draggable={false} />
    </button>
  );
}

function PackCarousel({ onChoose }: { onChoose: () => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>('.l5-pack');
    if (!card) return;
    const step = card.offsetWidth + 12;
    setActive(Math.max(0, Math.min(PACKS.length - 1, Math.round(el.scrollLeft / step))));
  }, []);

  const goTo = (index: number) => {
    const el = track.current;
    const card = el?.querySelectorAll<HTMLElement>('.l5-pack')[index];
    if (!el || !card) return;
    el.scrollTo({ left: card.offsetLeft - el.offsetLeft - 16, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <>
      <div className="l5-pack-track" ref={track} onScroll={onScroll} role="list" aria-label="Founder packs">
        {PACKS.map((pack) => (
          <article key={pack.id} className={`l5-pack l5-pack--${pack.id}`} role="listitem" aria-label={`${pack.name} pack, ${pack.price}`}>
            <img className="l5-pack-art" src={pack.art} alt="" loading="lazy" />
            <div className="l5-pack-price">
              <span>{pack.name}</span>
              <strong>{pack.price}</strong>
            </div>
            <ul className="l5-pack-list">
              {pack.features.map((feature) => typeof feature === 'string'
                ? <li key={feature}>{feature}</li>
                : <li key={feature.note} className="l5-pack-note">{feature.note}</li>)}
            </ul>
            <ArtButton art={pack.buy} label={pack.buyLabel} onClick={onChoose} className="l5-pack-buy" />
          </article>
        ))}
      </div>
      <div className="l5-dots" role="tablist" aria-label="Choose a pack">
        {PACKS.map((pack, index) => (
          <button key={pack.id} type="button" role="tab" aria-selected={index === active} aria-label={`${pack.name} pack`} className={index === active ? 'is-active' : ''} onClick={() => goTo(index)} />
        ))}
      </div>
      <p className="l5-hint">Swipe to compare all 6 packs</p>
    </>
  );
}

export default function PremiumLandingScreen() {
  const game = useGame();
  const [onboarding, setOnboarding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (game.state.walletAddress) window.location.replace('/#game');
  }, [game.state.walletAddress]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);

  const play = useCallback(() => { setMenuOpen(false); setOnboarding(true); }, []);
  const go = (id: string) => () => { setMenuOpen(false); scrollToSection(id); };

  return (
    <div className="l5-root" id="top">
      <nav className="l5-nav" aria-label="HeroLoop">
        <button type="button" className="l5-brand" onClick={go('top')}><i aria-hidden="true" />HEROLOOP</button>
        <div className="l5-nav-links">
          <button type="button" onClick={go('classes')}>Heroes</button>
          <button type="button" onClick={go('world')}>World</button>
          <button type="button" onClick={go('packs')}>Founder Packs</button>
          <button type="button" onClick={go('referral')}>Referrals</button>
          <button type="button" className="l5-nav-play" onClick={play}>Play</button>
        </div>
        <button type="button" className="l5-burger" aria-expanded={menuOpen} aria-controls="l5-menu" aria-label={menuOpen ? 'Close menu' : 'Open menu'} onClick={() => setMenuOpen((open) => !open)}>
          <span /><span /><span />
        </button>
      </nav>
      {menuOpen && (
        <div className="l5-menu" id="l5-menu">
          <button type="button" onClick={go('loop')}>The Core Loop</button>
          <button type="button" onClick={go('classes')}>Hero Classes</button>
          <button type="button" onClick={go('world')}>The World</button>
          <button type="button" onClick={go('packs')}>Founder Packs</button>
          <button type="button" onClick={go('referral')}>Referrals</button>
          <button type="button" className="l5-menu-play" onClick={play}>Play now</button>
        </div>
      )}

      <main>
        <section className="l5-hero" aria-labelledby="l5-hero-title">
          <div className="l5-hero-art" style={{ backgroundImage: `url(${heroHost})` }} aria-hidden="true" />
          <div className="l5-hero-fade" aria-hidden="true" />
          <div className="l5-hero-copy">
            <p className="l5-eyebrow">Collect heroes. Conquer the endless loop.</p>
            <h1 id="l5-hero-title"><img src={logo} alt="HeroLoop" width={1100} height={367} /></h1>
            <p className="l5-tagline">A dark-fantasy AFK RPG</p>
            <p className="l5-body">Build your squad. Battle automatically.<br />Claim loot. Grow stronger.</p>
            <ArtButton art={playArt} label="Play" onClick={play} className="l5-play" />
            <button type="button" className="l5-ghost" onClick={go('packs')}>Founder Packs</button>
            <p className="l5-micro">Free to play · Unlock Earn Mode with a Founder Pack</p>
          </div>
        </section>

        <section className="l5-band l5-band--stone">
          <SectionHeading id="loop" title="The Core Loop" subtitle="Simple to play. Endless to explore." />
          <ol className="l5-loop" aria-label="The core loop">
            {CORE_LOOP.map((step, index) => (
              <li key={step} style={{ '--l5-loop-index': index } as React.CSSProperties}>
                <span className="l5-loop-art" style={{ backgroundImage: `url(${coreLoop})` }} role="img" aria-label={step} />
              </li>
            ))}
          </ol>

          <SectionHeading id="classes" title="Five Hero Classes" subtitle="Different paths. A stronger tomorrow." />
          <div className="l5-classes">
            {CLASSES.map((hero) => <img key={hero.id} src={hero.art} alt={`${hero.name} — ${hero.tagline}`} loading="lazy" className={`l5-class l5-class--${hero.id}`} />)}
          </div>

          <SectionHeading id="world" title="A World That Keeps Moving" subtitle="New challenges. Greater rewards." />
          <div className="l5-world">
            {WORLD.map((entry) => <img key={entry.id} src={entry.art} alt={entry.label} loading="lazy" />)}
          </div>
        </section>

        <section className="l5-band l5-band--vista">
          <SectionHeading id="packs" title="Founder Packs" subtitle="Jump-start your journey. Unlock more." />
          <PackCarousel onChoose={play} />

          <div className="l5-duo">
            <section className="l5-panel l5-referral" id="referral" aria-labelledby="l5-referral-title">
              <i className="l5-hairline" aria-hidden="true" />
              <h3 id="l5-referral-title">Invite friends.<br />Unlock free packs.</h3>
              <p className="l5-panel-body">Connect your wallet, invite friends, and unlock Founder Packs for free.</p>
              <ArtButton art={connectWalletArt} label="Connect wallet" onClick={play} className="l5-connect" />
              <div className="l5-ref-url" aria-label="Your referral link">heroloop.xyz/ref/<em>sign in for your code</em></div>
              <div className="l5-ref-actions">
                <button type="button" className="l5-btn" onClick={play}>Copy</button>
                <button type="button" className="l5-btn" onClick={play}>Share</button>
              </div>
              <p className="l5-ref-status">Your Referrals: 0 / 10 (Veteran Pack)</p>
              <div className="l5-track" role="progressbar" aria-valuemin={0} aria-valuemax={10} aria-valuenow={0} aria-label="Referral progress"><span style={{ width: '0%' }} /></div>
              <ul className="l5-notes">
                <li>Earn 5% of valid referred players’ reward earnings</li>
                <li>Rewards accumulate in Pending</li>
                <li>Claim unlocks after your first real purchase of $2+</li>
              </ul>
            </section>

            <section className="l5-panel l5-platforms" aria-labelledby="l5-platforms-title">
              <h3 id="l5-platforms-title">Play anywhere soon</h3>
              <p className="l5-panel-kicker">Same adventure. More places.</p>
              <ul>
                {PLATFORMS.map((platform) => (
                  <li key={platform.name}>
                    <img src={platform.icon} alt="" width={19} height={19} />
                    <span><b>{platform.name}</b><small>Soon</small></span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </section>

        <section className="l5-final" aria-labelledby="l5-final-title">
          <div className="l5-final-art" style={{ backgroundImage: `url(${heroHost})` }} aria-hidden="true" />
          <img className="l5-banner l5-banner--left" src={banner} alt="" aria-hidden="true" />
          <img className="l5-banner l5-banner--right" src={banner} alt="" aria-hidden="true" />
          <i className="l5-hairline" aria-hidden="true" />
          <p className="l5-final-eyebrow">Beta live</p>
          <h2 id="l5-final-title">The endless loop<br />awaits</h2>
          <p className="l5-final-sub">Build your squad. Claim your place.</p>
          <ArtButton art={playArt} label="Play" onClick={play} className="l5-play" />
          <p className="l5-final-free">Free to play</p>
          <p className="l5-final-support">Play free. Unlock Earn Mode with a paid pack.</p>
        </section>
      </main>

      <footer className="l5-footer">
        <strong>HEROLOOP</strong>
        <span className="l5-footer-sub">AFK dark-fantasy loot RPG</span>
        <nav aria-label="Footer">
          <button type="button" onClick={play}>Play</button>
          <button type="button" onClick={go('classes')}>Heroes</button>
          <button type="button" onClick={play}>Summon</button>
          <button type="button" onClick={go('packs')}>Founder Packs</button>
          <button type="button" onClick={go('referral')}>Referrals</button>
          <button type="button" onClick={play}>Ranks</button>
        </nav>
        <p className="l5-socials">X · Discord · Telegram</p>
        <i className="l5-divider" aria-hidden="true" />
        <p className="l5-legal">© 2026 HeroLoop. All rights reserved.<br />Beta — features &amp; economy may change.</p>
        <button type="button" className="l5-theme-switch" onClick={() => setUiTheme('classic')}>Switch to classic design</button>
      </footer>

      {onboarding && <Onboarding game={game} onAccountReady={() => window.location.replace('/#game')} onClose={() => setOnboarding(false)} />}
    </div>
  );
}
