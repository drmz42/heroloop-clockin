// Premium public landing built from Figma "HL-LANDING-2 / MAKET 5": Mobile (node 2086:3) and, from 1200 px, Desktop (node 2081:2).
// Artwork is the Founder-approved Figma raster set; frames, text and layout stay code-native.
// Classic fallback: test/landing4/Landing4Screen.tsx (selected by src/theme/uiTheme.ts).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import banner from './assets/banner.webp';

type Pack = { id: string; name: string; price: string; art: string; buy: string; buyLabel: string; referrals: number; features: Array<string | { note: string }> };

// Pack copy and referral milestones mirror the Figma design; they are presentation only and grant nothing.
const PACKS: Pack[] = [
  { id: 'free', name: 'FREE', price: '$0', art: packFree, buy: buyFree, buyLabel: 'Play free', referrals: 0, features: ['1 Selectable Starter Hero', 'Starting Gold', '10 Health Potions', 'Free Mode', 'Start Playing Instantly'] },
  { id: 'starter', name: 'STARTER', price: '$2', art: packStarter, buy: buyStarter, buyLabel: 'Get Starter', referrals: 3, features: ['Earn Mode Unlocked', '20 Uncommon Founder Gear Chests', '2 Heroes', 'Starting Gold', 'Health Potions', 'Starter Resources'] },
  { id: 'scout', name: 'SCOUT', price: '$5', art: packScout, buy: buyScout, buyLabel: 'Get Scout', referrals: 5, features: ['Earn Mode Unlocked', '20 Rare Founder Gear Chests', '2 Heroes', 'More Starting Gold', 'Health Potions', 'Enhanced Starter Resources'] },
  { id: 'veteran', name: 'VETERAN', price: '$10', art: packVeteran, buy: buyVeteran, buyLabel: 'Get Veteran', referrals: 10, features: ['Earn Mode Unlocked', 'Marketplace Access', '3 Heroes', '30 Epic Founder Gear Chests', 'Starting Gold', 'Health Potions', '1× Boost Pack', { note: '3 × 24h activations' }, '+50% XP & Gold while active'] },
  { id: 'elite', name: 'ELITE', price: '$49', art: packElite, buy: buyElite, buyLabel: 'Get Elite', referrals: 25, features: ['Earn Mode Unlocked', 'Marketplace Access', '30 Legendary Founder Gear Chests', '750 Summon Scrolls', 'Starting Gold', 'Health Potions', '2× Boost Packs', '25 Active Market Listings', 'Private Community Access', 'Elite Founder Frame', '+2% Ordinary Earn Weight'] },
  { id: 'founder', name: 'FOUNDER', price: '$99', art: packFounder, buy: buyFounder, buyLabel: 'Get Founder', referrals: 50, features: ['Earn Mode Unlocked', 'Marketplace Access', '30 Mythic Founder Gear Chests', '3,000 Summon Scrolls', 'Starting Gold', 'Health Potions', '3× Boost Packs', '50 Active Market Listings', 'Private Community Access', 'Founder Frame', 'Founder Sigil', '+5% Ordinary Earn Weight'] },
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
  { name: 'App Store', glyph: '◆' },
  { name: 'Google Play', glyph: '▣' },
  { name: 'Steam', glyph: '●' },
  { name: 'Telegram Mini App', glyph: '➤' },
];

// Valid referrals shown on the landing: the player's invite list, or `?refs=N` to preview the fill on this design lab.
function referralCount(invited: number) {
  const preview = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('refs') : null;
  const value = preview !== null && /^\d{1,3}$/.test(preview) ? Number(preview) : invited;
  return Math.max(0, Math.min(PACKS[PACKS.length - 1].referrals, value));
}

// Share of the rail from this pack's milestone to the next one that the count has covered.
function railFill(count: number, index: number) {
  const next = PACKS[index + 1];
  if (!next) return 0;
  const from = PACKS[index].referrals;
  return Math.max(0, Math.min(1, (count - from) / (next.referrals - from)));
}

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

export function ArtButton({ art, label, onClick, className = '' }: { art: string; label: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`l5-art-button ${className}`} onClick={onClick} aria-label={label}>
      <img src={art} alt="" draggable={false} />
    </button>
  );
}

function PackCarousel({ onChoose, referrals }: { onChoose: () => void; referrals: number }) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = useCallback(() => {
    const el = track.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>('.l5-pack-col');
    if (!card) return;
    const step = card.offsetWidth + 12;
    setActive(Math.max(0, Math.min(PACKS.length - 1, Math.round(el.scrollLeft / step))));
  }, []);

  const goTo = (index: number) => {
    const el = track.current;
    const card = el?.querySelectorAll<HTMLElement>('.l5-pack-col')[index];
    if (!el || !card) return;
    el.scrollTo({ left: card.offsetLeft - el.offsetLeft - 16, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  return (
    <>
      <div className="l5-pack-track" ref={track} onScroll={onScroll} role="list" aria-label="Founder packs">
        {PACKS.map((pack, index) => (
          <div key={pack.id} className="l5-pack-col" role="listitem">
          <article className={`l5-pack l5-pack--${pack.id}`} aria-label={`${pack.name} pack, ${pack.price}`}>
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
          <p className={`l5-milestone${referrals >= pack.referrals ? ' is-reached' : ''}`} style={{ '--l5-fill': railFill(referrals, index) } as React.CSSProperties} aria-label={`${pack.referrals} referrals unlock the ${pack.name} pack${referrals >= pack.referrals ? ', reached' : ''}`}><i aria-hidden="true" />{pack.referrals}</p>
          </div>
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

export default function PremiumLandingView({ onPlay, referralTotal = 0, onClassic, children }: { onPlay: () => void; referralTotal?: number; onClassic?: () => void; children?: ReactNode }) {
  const referrals = referralCount(referralTotal);
  const goal = PACKS.find((pack) => pack.referrals > referrals) ?? PACKS[PACKS.length - 1];
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);

  const play = useCallback(() => { setMenuOpen(false); onPlay(); }, [onPlay]);
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
          <button type="button" className="l5-nav-play" onClick={play}>Play for free</button>
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
            <p className="l5-body">Build your squad. Battle automatically.<br />Claim loot. Grow stronger.<span className="l5-desk"> Enter deeper regions.</span></p>
            <div className="l5-hero-cta">
              <ArtButton art={playArt} label="Play" onClick={play} className="l5-play" />
              <button type="button" className="l5-ghost" onClick={go('packs')}>Founder Packs</button>
            </div>
            <p className="l5-micro">Free to play · Unlock Earn Mode with a Founder Pack</p>
          </div>
          <p className="l5-hero-aside" aria-hidden="true">Five heroes<br />Endless<br />Possibilities</p>
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
          <PackCarousel onChoose={play} referrals={referrals} />
        </section>

        <section className="l5-strip l5-referral" id="referral" aria-labelledby="l5-referral-title">
          <div className="l5-ref-copy">
            <h3 id="l5-referral-title">Invite friends. Unlock free packs.</h3>
            <p>Connect your wallet, invite friends, and unlock Founder Packs for free.</p>
          </div>
          <div className="l5-ref-center">
            <div className="l5-ref-row">
              <button type="button" className="l5-btn l5-ref-connect" onClick={play}>Connect wallet</button>
              <div className="l5-ref-url" aria-label="Your referral link">https://heroloop.xyz/ref/YOURCODE</div>
              <button type="button" className="l5-btn l5-ref-copy-btn" onClick={play}>Copy</button>
              <button type="button" className="l5-btn l5-ref-share" onClick={play}>Share</button>
            </div>
            <p className="l5-ref-status">Your Referrals: {referrals} / {goal.referrals} ({goal.name.charAt(0)}{goal.name.slice(1).toLowerCase()} Pack)</p>
            <div className="l5-track" role="progressbar" aria-valuemin={0} aria-valuemax={goal.referrals} aria-valuenow={referrals} aria-label="Referral progress"><span style={{ width: `${Math.min(100, (referrals / goal.referrals) * 100)}%` }} /></div>
          </div>
          <ul className="l5-notes">
            <li>Earn 5% of valid referred players’ reward earnings</li>
            <li>Rewards accumulate in Pending</li>
            <li>Claim unlocks after your first real purchase of $2+</li>
          </ul>
        </section>

        <section className="l5-strip l5-platforms" aria-labelledby="l5-platforms-title">
          <div className="l5-plat-copy">
            <h3 id="l5-platforms-title">Play anywhere soon</h3>
            <p>Same adventure. More places.</p>
          </div>
          <ul>
            {PLATFORMS.map((platform) => (
              <li key={platform.name}>
                <i aria-hidden="true">{platform.glyph}</i>
                <span><b>{platform.name}</b><small>Soon</small></span>
              </li>
            ))}
          </ul>
        </section>

        <section className="l5-final" aria-labelledby="l5-final-title">
          <div className="l5-final-art" style={{ backgroundImage: `url(${heroHost})` }} aria-hidden="true" />
          <img className="l5-banner l5-banner--left" src={banner} alt="" aria-hidden="true" />
          <img className="l5-banner l5-banner--right" src={banner} alt="" aria-hidden="true" />
          <i className="l5-hairline" aria-hidden="true" />
          <p className="l5-final-eyebrow">Beta live</p>
          <h2 id="l5-final-title">The endless loop{' '}<br />awaits</h2>
          <p className="l5-final-sub">Build your squad. Claim your place.</p>
          <ArtButton art={playArt} label="Play" onClick={play} className="l5-play" />
          <p className="l5-final-free">Free to play</p>
          <p className="l5-final-support">Play free. Unlock Earn Mode with a paid pack.</p>
        </section>
      </main>

      <footer className="l5-footer">
        <div className="l5-footer-brand">
          <strong>HEROLOOP</strong>
          <span className="l5-footer-sub">AFK dark-fantasy loot RPG</span>
        </div>
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
        <p className="l5-legal"><span>© 2026 HeroLoop. All rights reserved.</span><br /><span>Beta — features &amp; economy may change.</span></p>
        {onClassic && <button type="button" className="l5-theme-switch" onClick={onClassic}>Switch to classic design</button>}
      </footer>

      {children}
    </div>
  );
}
