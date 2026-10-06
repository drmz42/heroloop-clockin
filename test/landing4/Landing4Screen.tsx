/* eslint-disable */
// @ts-nocheck — preserved Qwen reference implementation with a typed game bridge.
import { isolatedHackathon } from '@/game/editionStorage';
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useGame } from "@/game/useGame";
import { Onboarding } from "@/screens/LandingScreen";
import { webGameEntryAllowed } from "@/platform/platform";

const IMG = {
  warrior: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/12d0a236b-ea80-464e-856f-68b5e921c507.png",
  assassin: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/115ca2137-6bd7-4968-9cc0-db521f697564.png",
  crossbowman: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/11c5b5aed-e0b9-490b-826f-b60c2e7cb16e.png",
  druid: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/10d17c65d-5f30-44af-ad55-cd855f49b8d1.png",
  mage: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/148aad9bf-fe53-45be-9639-b203fd909515.png",
  hero: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/1e38ff02e-0818-495c-bc05-99ad2bedc11c.png",
  battle: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/154c5634f-663a-41bf-8b4f-a7fb20076891.png",
  chest: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/1dca871af-b40d-4c1e-9491-b6b0aba82350.png",
  ranks: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/117583e2c-fa7d-47e3-84d9-2708d0038336.png",
  final: "https://image.qwenlm.ai/public_source/9544dfa5-1389-46dc-8251-0b19cf331428/180cdd57b-8f52-40f4-8a45-f8d5a7526a7a.png",
  token: "/assets/landing4/coin.webp",
};

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function ItemDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="g-steel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9aa4b4" /><stop offset=".5" stopColor="#565f72" /><stop offset="1" stopColor="#262d3c" />
        </linearGradient>
        <linearGradient id="g-steel2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b7589" /><stop offset="1" stopColor="#1b212e" />
        </linearGradient>
        <linearGradient id="g-goldm" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b08f52" /><stop offset=".55" stopColor="#7a5e2c" /><stop offset="1" stopColor="#3c2d10" />
        </linearGradient>
        <linearGradient id="g-leather" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#52402a" /><stop offset="1" stopColor="#1d150c" />
        </linearGradient>
        <linearGradient id="g-gemv" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7c6cad" /><stop offset="1" stopColor="#281d52" />
        </linearGradient>
        <linearGradient id="g-gemc" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5f8d9e" /><stop offset="1" stopColor="#123846" />
        </linearGradient>
        <radialGradient id="g-coin" cx=".38" cy=".32" r=".85">
          <stop offset="0" stopColor="#b08f52" /><stop offset=".55" stopColor="#7a5e2c" /><stop offset="1" stopColor="#3c2d10" />
        </radialGradient>
        <linearGradient id="g-wood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4a3220" /><stop offset="1" stopColor="#1d140c" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function HeroToken({ size = 48, className = "" }) {
  return <img className={className} src={IMG.token} width={size} height={size} alt="$HERO token" />;
}

const IcoCoins = () => (
  <svg viewBox="0 0 48 48">
    <circle cx="15" cy="29" r="10" fill="url(#g-coin)" stroke="#2b210b" strokeWidth="1.4" />
    <circle cx="15" cy="29" r="6.4" fill="none" stroke="rgba(43,33,11,.6)" strokeWidth="1.2" />
    <circle cx="33" cy="31" r="10" fill="url(#g-coin)" stroke="#2b210b" strokeWidth="1.4" />
    <circle cx="33" cy="31" r="6.4" fill="none" stroke="rgba(43,33,11,.6)" strokeWidth="1.2" />
    <path d="M33 27 l3.4 4 -3.4 4 -3.4 -4 Z" fill="rgba(43,33,11,.75)" />
    <circle cx="24" cy="17" r="10" fill="url(#g-coin)" stroke="#2b210b" strokeWidth="1.4" />
    <circle cx="24" cy="17" r="6.4" fill="none" stroke="rgba(43,33,11,.6)" strokeWidth="1.2" />
    <path d="M24 13 l3.4 4 -3.4 4 -3.4 -4 Z" fill="rgba(43,33,11,.75)" />
  </svg>
);
const IcoShards = () => (
  <svg viewBox="0 0 48 48">
    <path d="M24 3 L31 19 L24 45 L17 19 Z" fill="url(#g-gemc)" stroke="rgba(95,141,158,.34)" strokeWidth="1" />
    <path d="M24 3 L27.6 19 L24 45 Z" fill="rgba(255,255,255,.12)" />
    <path d="M10 17 L14 25 L10 36 L6.6 25 Z" fill="url(#g-gemc)" opacity=".55" />
    <path d="M38 12 L41.4 20 L38 30 L34.6 20 Z" fill="url(#g-gemc)" opacity=".4" />
  </svg>
);
const IcoChest = () => (
  <svg viewBox="0 0 48 48">
    <path d="M6 22 h36 v17 a3 3 0 0 1 -3 3 h-30 a3 3 0 0 1 -3 -3 Z" fill="url(#g-wood)" stroke="#1a110a" strokeWidth="1.3" />
    <path d="M4 22 L8 12 h32 l4 10 Z" fill="url(#g-wood)" stroke="#1a110a" strokeWidth="1.3" />
    <path d="M8 12 h32" stroke="url(#g-goldm)" strokeWidth="2" />
    <rect x="6" y="22" width="36" height="2.4" fill="url(#g-goldm)" />
    <rect x="6" y="36" width="36" height="2" fill="url(#g-goldm)" opacity=".8" />
    <rect x="22" y="22" width="4" height="17" fill="url(#g-goldm)" opacity=".9" />
    <rect x="20.5" y="26" width="7" height="7" rx="1" fill="url(#g-goldm)" stroke="#2b210b" strokeWidth=".8" />
    <circle cx="24" cy="29.5" r="1.3" fill="#1a110a" />
    <path d="M10 22 h28 v-2 a8 8 0 0 0 -28 0 Z" fill="rgba(255,220,140,.55)" />
    <path d="M14 22 l2 -5 M22 22 l1 -7 M30 22 l-1 -6 M36 22 l-2 -4" stroke="rgba(255,230,170,.7)" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);
const IcoKey = () => (
  <svg viewBox="0 0 48 48">
    <circle cx="14" cy="16" r="9" fill="url(#g-goldm)" stroke="#2b210b" strokeWidth="1.4" />
    <circle cx="14" cy="16" r="4.4" fill="#0a0d14" stroke="#2b210b" strokeWidth="1" />
    <circle cx="14" cy="16" r="2" fill="url(#g-gemv)" />
    <path d="M5 12 a9 9 0 0 1 18 0" fill="none" stroke="rgba(255,230,170,.45)" strokeWidth="1.4" />
    <rect x="22" y="14.5" width="22" height="3.2" rx="1" fill="url(#g-goldm)" stroke="#2b210b" strokeWidth=".8" />
    <rect x="34" y="17.7" width="3" height="5.5" rx=".6" fill="url(#g-goldm)" stroke="#2b210b" strokeWidth=".6" />
    <rect x="39" y="17.7" width="3" height="7.5" rx=".6" fill="url(#g-goldm)" stroke="#2b210b" strokeWidth=".6" />
    <rect x="21" y="13" width="3" height="6" rx=".6" fill="url(#g-goldm)" stroke="#2b210b" strokeWidth=".6" />
    <path d="M12.2 14.2 l1.8 1.8 -1.8 1.8 -1.8 -1.8 Z" fill="rgba(255,255,255,.6)" />
  </svg>
);
const IcoBlade = () => (
  <svg viewBox="0 0 48 48">
    <path d="M24 3 L29 11 L26.5 31 H21.5 L19 11 Z" fill="url(#g-steel)" stroke="#141926" strokeWidth="1" />
    <path d="M24 3 L26.5 31 H24 Z" fill="rgba(255,255,255,.13)" />
    <rect x="13" y="31" width="22" height="4.6" rx="2" fill="url(#g-goldm)" stroke="#2b210b" strokeWidth=".8" />
    <rect x="21.5" y="35.6" width="5" height="8" rx="1.6" fill="url(#g-leather)" />
    <circle cx="24" cy="45.4" r="2.6" fill="url(#g-goldm)" />
  </svg>
);

const Diamond = ({ size = 10, color = "currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
    <path d="M5 0 L10 5 L5 10 L0 5 Z" fill={color} />
  </svg>
);
const IconSword = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M14.5 3.5 21 3l-.5 6.5L9 21l-3-3L17.5 6.5" /><path d="M3 21l3-3M5 16l3 3" />
  </svg>
);
const IconCoin = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
    <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9M9.5 9.5h3.2a1.8 1.8 0 0 1 0 3.6H9.5h3.4a1.8 1.8 0 0 1 0 3.6H9.5" strokeLinecap="round" />
  </svg>
);
const IconAnvil = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" {...p}>
    <path d="M3 8h11a4 4 0 0 1-4 4H8l-1 3h8l1 3H6l1-3" /><path d="M14 8h5l-2 4" strokeLinecap="round" />
  </svg>
);
const IconLoop = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" /><path d="M20 4v4h-4" /><path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" /><path d="M4 20v-4h4" />
  </svg>
);
const IconCrown = (p) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M3 7l4 4 5-7 5 7 4-4-2 12H5z" /></svg>
);
const IconChevron = (p) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);

function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll("[data-reveal]"));
    if (reducedMotion()) { els.forEach((e) => e.classList.add("revealed")); return; }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((en) => {
        if (en.isIntersecting) { en.target.classList.add("revealed"); io.unobserve(en.target); }
      }),
      { threshold: 0.16, rootMargin: "0px 0px -8% 0px" }
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);
}

function useParallax() {
  useEffect(() => {
    if (reducedMotion()) return;
    const els = Array.from(document.querySelectorAll("[data-plx]"));
    if (!els.length) return;
    let ticking = false;
    const update = () => {
      for (const el of els) {
        const host = el.parentElement;
        if (!host) continue;
        const r = host.getBoundingClientRect();
        const sp = parseFloat(el.dataset.plx) || 0.1;
        const off = (r.top + r.height / 2 - window.innerHeight / 2) * -sp;
        el.style.transform = `translate3d(0, ${off.toFixed(1)}px, 0)`;
      }
      ticking = false;
    };
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); };
  }, []);
}

const Kicker = ({ children }) => (
  <span className="hl-kicker" data-reveal>
    <Diamond size={6} /> <span>{children}</span>
  </span>
);

function HeroCard({ img, name, cls, rarity, power, pips, atk, def, hp, role, delay = 0 }) {
  const rarClass = rarity === "Legendary" ? "rar-leg" : rarity === "Epic" ? "rar-epi" : "rar-rar";
  return (
    <article className={`hl-card ${rarClass}`} data-reveal style={{ transitionDelay: `${delay}ms` }}>
      <span className="hl-card-aura" aria-hidden="true" />
      <div className="hl-card-img">
        <img src={img} alt={`${name}, ${cls}`} loading="lazy" />
        <span className="hl-shine" />
        <span className="hl-rar">{rarity}</span>
      </div>
      <div className="hl-card-meta">
        <h3>{name}</h3>
        <div className="hl-card-row">
          <span className="hl-class">{cls}</span>
          <span className="hl-power"><Diamond size={7} /> {power}</span>
        </div>
        <span className="hl-pips" aria-label={`${pips} of 5 ascension pips`}>
          {Array.from({ length: 5 }).map((_, i) => (<i key={i} className={i < pips ? "on" : ""} />))}
        </span>
        <div className="hl-stats">
          <span><i>ATK</i><b>{atk}</b></span>
          <span><i>DEF</i><b>{def}</b></span>
          <span><i>HP</i><b>{hp}</b></span>
        </div>
        <p className="hl-role">{role}</p>
      </div>
    </article>
  );
}

function Nav({ onPlay }) {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 36);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const go = (id) => (e) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
  };
  return (
    <header className={`hl-nav ${solid ? "hl-nav--solid" : ""}`}>
      <a href="#top" className="hl-brand" onClick={go("top")}>
        <img className="hl-brand-mark" src="/assets/brand/heroloop-emblem.png" alt="" width={30} height={31} draggable={false} />
        <span className="hl-brand-text">HEROLOOP</span>
      </a>
      <nav className="hl-nav-links" aria-label="Sections">
        <a href="#heroes" onClick={go("heroes")}>Heroes</a>
        <a href="#battle" onClick={go("battle")}>Battle</a>
        <a href="#rewards" onClick={go("rewards")}>Rewards</a>
        <a href="#ranks" onClick={go("ranks")}>Ranks</a>
      </nav>
      <button className="hl-pill" onClick={onPlay}>
        <HeroToken size={15} /> PLAY
      </button>
    </header>
  );
}

function HeroSection({ onStart }) {
  return (
    <section className="hl-sec hl-hero" id="top">
      <div className="hl-hero-bg" data-plx="0.12">
        <img src={IMG.hero} alt="A fellowship of heroes before an ancient glowing portal" />
      </div>
      <div className="hl-hero-vignette" />
      <div className="hl-fog hl-fog--a" />
      <div className="hl-fog hl-fog--b" />
      <div className="hl-rays" />

      <div className="hl-orbs" aria-hidden="true">
        <span className="hl-orb hl-orb1" /><span className="hl-orb hl-orb2" />
        <span className="hl-orb hl-orb3" /><span className="hl-orb hl-orb4" />
      </div>

      <div className="hl-hero-inner">
        <Kicker>{isolatedHackathon ? 'AFK RPG · SKR FEATURES COMING SOON' : 'AFK RPG · EARN $HERO'}</Kicker>
        <h1 className="hl-wordmark" data-reveal>HEROLOOP</h1>
        <p className="hl-hero-tag" data-reveal style={{ transitionDelay: "120ms" }}>
          Summon champions across five classes.<br />Build your squad.
        </p>
        <p className="hl-hero-desc" data-reveal style={{ transitionDelay: "220ms" }}>
          {isolatedHackathon ? 'Defeat powerful bosses, explore upcoming SKR features, and collect' : 'Defeat powerful bosses, earn $HERO while you are away, and collect'}
          heroes and equipment for the player marketplace.
        </p>

        <div className="hl-squad" data-reveal style={{ transitionDelay: "300ms" }}>
          <div className="hl-squad-slots">
            <span className="hl-squad-slot"><img src={IMG.warrior} alt="Tank" /><i>TANK</i></span>
            <span className="hl-squad-slot"><img src={IMG.mage} alt="Damage" /><i>DPS</i></span>
            <span className="hl-squad-slot"><img src={IMG.druid} alt="Healer" /><i>HEAL</i></span>
          </div>
          <div className="hl-squad-copy">
            <strong>SQUAD OF 3.</strong> Your roster holds dozens of heroes — but only three fight at a time.
            Pick a frontline, a damage dealer and a support hero. Every choice reshapes the battle.
          </div>
        </div>

        <div className="hl-hero-cta" data-reveal style={{ transitionDelay: "380ms" }}>
          <button className="hl-btn hl-btn--epic" onClick={onStart}>
            <span>START PLAYING</span>
          </button>
          <span className="hl-hero-note">Free to play · No download required</span>
        </div>
      </div>

      <a href="#heroes" className="hl-scroll" aria-label="Scroll down"
        onClick={(e) => { e.preventDefault(); document.getElementById("heroes")?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" }); }}>
        <span>SCROLL</span>
        <IconChevron width={22} height={22} />
      </a>
      <div className="hl-sec-fade" />
    </section>
  );
}

function HeroesSection() {
  const heroes = [
    { img: IMG.warrior, name: "Aldric the Oathbound", cls: "Warrior", rarity: "Legendary", power: "48,210", pips: 5, atk: 1840, def: 2240, hp: "92.4k", role: "Frontline tank. Absorbs damage and shields the squad with unbreakable resolve." },
    { img: IMG.crossbowman, name: "Vex Ironsight", cls: "Crossbowman", rarity: "Epic", power: "40,120", pips: 4, atk: 2460, def: 1120, hp: "54.8k", role: "Precise ranged striker. Picks off priority targets before they reach the frontline." },
    { img: IMG.mage, name: "Veyran Stormweaver", cls: "Mage", rarity: "Legendary", power: "46,980", pips: 5, atk: 3120, def: 980, hp: "48.2k", role: "Area damage caster. Unleashes arcane storms that shatter entire enemy waves." },
    { img: IMG.assassin, name: "Kael the Silent", cls: "Assassin", rarity: "Epic", power: "41,120", pips: 4, atk: 2780, def: 1040, hp: "52.1k", role: "Burst striker. Slips behind enemy lines to eliminate squishy targets in seconds." },
    { img: IMG.druid, name: "Thorne Wildheart", cls: "Druid", rarity: "Rare", power: "33,760", pips: 3, atk: 1260, def: 1480, hp: "68.4k", role: "Squad healer. Channels nature's essence to restore allies and cleanse debuffs." },
  ];
  return (
    <section className="hl-sec hl-heroes" id="heroes">
      <div className="hl-heroes-bg" />
      <div className="hl-wrap">
        <div className="hl-heroes-head">
          <Kicker>THE COLLECTION</Kicker>
          <h2 className="hl-h2" data-reveal>
            COLLECT <span className="hl-gold">LEGENDARY</span> HEROES
          </h2>
          <p className="hl-lead" data-reveal style={{ transitionDelay: "120ms" }}>
            Summon champions across five classes. Build the right three-hero
            lineup for each region, then develop your roster through nine hero rarities.
          </p>
        </div>

        <div className="hl-gallery" data-reveal style={{ transitionDelay: "160ms" }}>
          {heroes.map((h, i) => (<HeroCard key={h.name} {...h} delay={i * 90} />))}
        </div>
      </div>
    </section>
  );
}

function BattleSection() {
  const steps = [
    { icon: <IconSword width={26} height={26} />, t: "FIGHT", d: "Lead your squad of 3 through auto-battles, regions and powerful bosses." },
    { icon: <HeroToken size={26} />, t: "EARN $HERO", d: isolatedHackathon ? 'SKR payment and reward integration is under development.' : 'Receive your proportional share of the daily token pool, including while you are away.' },
    { icon: <IconAnvil width={26} height={26} />, t: "LOOT & UPGRADE", d: "Open chests, equip gear across 12 item rarities and ascend your heroes." },
    { icon: <IconCoin width={26} height={26} />, t: "TRADE", d: "Build a valuable collection of unique heroes and equipment for the player marketplace." },
  ];
  return (
    <section className="hl-sec hl-battle" id="battle">
      <div className="hl-battle-bg" data-plx="0.1">
        <img src={IMG.battle} alt="Heroes clashing with a horned demon warlord" />
      </div>
      <div className="hl-battle-shade" />
      <div className="hl-wrap hl-battle-wrap">
        <div className="hl-battle-head">
          <Kicker>THE ROAD AHEAD</Kicker>
          <h2 className="hl-h2" data-reveal>BATTLE. EARN. <span className="hl-crimson">ASCEND.</span></h2>
          <p className="hl-lead" data-reveal style={{ transitionDelay: "120ms" }}>
            Push forward through ten regions. Fallen heroes recover, then return to battle.
          </p>
        </div>

        <div className="hl-battle-stage" data-reveal style={{ transitionDelay: "160ms" }}>
          <div className="hl-battle-side hl-battle-side--squad">
            <span className="hl-stage-label">YOUR SQUAD</span>
            <div className="hl-stage-row">
              <span className="hl-stage-hero hl-stage-hero--tank"><img src={IMG.warrior} alt="Tank" /></span>
              <span className="hl-stage-hero hl-stage-hero--dps"><img src={IMG.mage} alt="DPS" /></span>
              <span className="hl-stage-hero hl-stage-hero--heal"><img src={IMG.druid} alt="Healer" /></span>
            </div>
          </div>
          <span className="hl-battle-vs" aria-hidden="true">VS</span>
          <div className="hl-battle-side hl-battle-side--boss">
            <span className="hl-stage-label">BOSS</span>
            <div className="hl-stage-row">
              <span className="hl-stage-boss"><img src={IMG.battle} alt="Boss" /></span>
            </div>
          </div>
        </div>

        <div className="hl-bossbar" data-reveal style={{ transitionDelay: "200ms" }}>
          <div className="hl-bossbar-top">
            <span className="hl-boss-name">ABYSSAL WARLORD · LV 240</span>
            <span className="hl-boss-hp">18%</span>
          </div>
          <div className="hl-bossbar-track"><div className="hl-bossbar-fill" /></div>
        </div>

        <ol className="hl-cycle">
          {steps.map((s, i) => (
            <li className="hl-step" key={s.t} data-reveal style={{ transitionDelay: `${240 + i * 130}ms` }}>
              <span className="hl-step-num">0{i + 1}</span>
              <span className="hl-step-ico">{s.icon}</span>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
              {i < steps.length - 1 && <span className="hl-step-link" aria-hidden="true" />}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function ChestSeal() {
  return (
    <div className="hl-seal" aria-hidden="true">
      <svg viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="29" fill="#090c13" stroke="url(#g-goldm)" strokeWidth="2.6" />
        <circle cx="32" cy="32" r="23.5" fill="none" stroke="rgba(122,94,44,.3)" strokeWidth="1" strokeDasharray="2 4.5" />
        <circle cx="32" cy="23" r="7.5" fill="none" stroke="url(#g-goldm)" strokeWidth="4.4" />
        <rect x="29.8" y="29" width="4.4" height="21" rx="2" fill="url(#g-goldm)" />
        <rect x="34" y="39" width="7" height="4" rx="1.5" fill="url(#g-goldm)" />
        <rect x="34" y="45.5" width="9" height="4" rx="1.5" fill="url(#g-goldm)" />
      </svg>
    </div>
  );
}

function CoinCluster() {
  return (
    <div className="hl-coin-cluster" aria-hidden="true">
      <span className="cc cc1"><IcoCoins /></span>
      <span className="cc cc2"><IcoCoins /></span>
      <span className="cc cc3"><IcoCoins /></span>
      <i className="mote mo1" /><i className="mote mo2" /><i className="mote mo3" />
    </div>
  );
}

function RewardsSection({ onClaim }) {
  const sec = 30245;
  const hh = String(Math.floor(sec / 3600)).padStart(2, "0");
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const ss = String(sec % 60).padStart(2, "0");

  const rewards = [
    { icon: <IcoCoins />, v: "1,245,600", l: "Gold" },
    { icon: <IcoShards />, v: "92,500", l: "Hero XP" },
    { icon: <IcoChest />, v: "145", l: "Treasure Chests" },
    { icon: <HeroToken size={27} />, v: isolatedHackathon ? "—" : "65,400", l: "$HERO" },
  ];

  return (
    <section className="hl-sec hl-rewards" id="rewards">
      <div className="hl-rewards-bg" />
      <div className="hl-wrap hl-rewards-wrap">
        <div className="hl-rewards-art" data-reveal>
          <div className="hl-chest-frame">
            <img src={IMG.chest} alt="An ornate treasure chest overflowing with gold and relics" />
            <span className="hl-chest-glow" />
            <span className="hl-chest-vig" />
          </div>
          <ChestSeal />
          <CoinCluster />
        </div>

        <div className="hl-rewards-panel" data-reveal style={{ transitionDelay: "140ms" }}>
          <div className="hl-panel-head">
            <div>
              <Kicker>AFK CAMPAIGN · CHAPTER XII</Kicker>
              <h2 className="hl-h2 hl-h2--tight">CLAIM REWARDS <span className="hl-gold">WHILE AFK</span></h2>
              <p className="hl-sub">Your heroes keep fighting, even when you are away.</p>
            </div>
            <span className="hl-live"><span className="hl-live-dot" aria-hidden="true" /> Live</span>
          </div>

          <div className="hl-timer">
            <span className="hl-timer-label"><span className="hl-live-dot" aria-hidden="true" /> BATTLE TIME ACCUMULATED</span>
            <div className="hl-timer-clock">
              <span>{hh}<i>h</i></span><span className="hl-colon">:</span>
              <span>{mm}<i>m</i></span><span className="hl-colon">:</span>
              <span>{ss}<i>s</i></span>
            </div>
          </div>

          <ul className="hl-loot">
            {rewards.map((r) => (
              <li className="hl-loot-item" key={r.l}>
                <span className="hl-loot-ico">{r.icon}</span>
                <span className="hl-loot-v">{r.v}</span>
                <span className="hl-loot-l">{r.l}</span>
              </li>
            ))}
          </ul>

          <div className="hl-reward-note" data-reveal style={{ transitionDelay: "200ms" }}>
            <IcoChest />
            <div>
              <b>Treasure Chests</b> drop random gear for your heroes.
              Use <b>Boss Keys</b> to unlock elite encounters with rare loot tables.
            </div>
          </div>

          <div className="hl-equip" hidden>
            <span className="hl-equip-label">EQUIPMENT DROPS</span>
            <div className="hl-slots">
              {[
                { ico: <IcoBlade />, l: "Weapon", r: "leg" },
                { ico: <IcoBlade />, l: "Helm", r: "epi" },
                { ico: <IcoBlade />, l: "Armor", r: "epi" },
                { ico: <IcoBlade />, l: "Gloves", r: "rar" },
                { ico: <IcoBlade />, l: "Boots", r: "rar" },
                { ico: <IcoBlade />, l: "Ring", r: "leg" },
                { ico: <IcoBlade />, l: "Amulet", r: "epi" },
                { ico: <IcoBlade />, l: "Off-Hand", r: "rar" },
              ].map((e) => (
                <div key={e.l} className={`hl-slot rar-${e.r}`} title={e.l}>
                  <span className="hl-slot-ico">{e.ico}</span>
                  <span className="hl-slot-l">{e.l}</span>
                </div>
              ))}
            </div>
          </div>

          <button className="hl-btn hl-btn--epic hl-btn--block" onClick={onClaim}>
            <span>CLAIM REWARDS</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function RanksSection() {
  const top3 = [
    { img: IMG.mage, name: "Veyran", lv: 312, kills: 1842, pos: 2, medal: "silver" },
    { img: IMG.warrior, name: "Aldric", lv: 327, kills: 2104, pos: 1, medal: "gold" },
    { img: IMG.assassin, name: "Kael", lv: 305, kills: 1690, pos: 3, medal: "bronze" },
  ];
  const rows = [
    { r: 4, img: IMG.crossbowman, name: "Vex Ironsight", lv: 298, kills: 1521, tier: "Diamond" },
    { r: 5, img: IMG.druid, name: "Thorne Wildheart", lv: 291, kills: 1402, tier: "Diamond" },
    { r: 6, img: IMG.mage, name: "Seraphine", lv: 287, kills: 1344, tier: "Platinum" },
    { r: 7, img: IMG.warrior, name: "Bjorn Ironfist", lv: 283, kills: 1290, tier: "Platinum" },
  ];
  return (
    <section className="hl-sec hl-ranks" id="ranks">
      <div className="hl-ranks-bg" data-plx="0.08">
        <img src={IMG.ranks} alt="Hall of champions with trophies and a rune tablet" />
      </div>
      <div className="hl-ranks-shade" />
      <div className="hl-wrap hl-ranks-wrap">
        <div className="hl-ranks-head">
          <Kicker>SEASON OF ASCENT</Kicker>
          <h2 className="hl-h2" data-reveal>CLIMB THE <span className="hl-gold">RANKS</span></h2>
          <p className="hl-lead" data-reveal style={{ transitionDelay: "120ms" }}>
            Rise through the leaderboard and earn monthly rewards.
          </p>
        </div>

        <div className="hl-board" data-reveal style={{ transitionDelay: "160ms" }}>
          <i className="hl-bc hl-bc1" /><i className="hl-bc hl-bc2" />
          <i className="hl-bc hl-bc3" /><i className="hl-bc hl-bc4" />

          <div className="hl-podium">
            {top3.map((p) => (
              <div className={`hl-pod hl-pod--${p.pos} hl-pod--${p.medal}`} key={p.pos}>
                <div className="hl-pod-avatar">
                  {p.pos === 1 && <IconCrown className="hl-pod-crown" width={32} height={32} />}
                  <img src={p.img} alt={p.name} />
                  <span className="hl-pod-rank">{p.pos}</span>
                </div>
                <h3>{p.name}</h3>
                <span className="hl-pod-stat">LV {p.lv}</span>
                <span className="hl-pod-stat hl-pod-kills">{p.kills.toLocaleString()} boss kills</span>
              </div>
            ))}
          </div>

          <ul className="hl-board-rows">
            {rows.map((row) => (
              <li className="hl-board-row" key={row.r}>
                <span className="hl-row-rank">{row.r}</span>
                <span className="hl-row-av"><img src={row.img} alt={row.name} /></span>
                <span className="hl-row-name">{row.name}</span>
                <span className="hl-row-metric"><i>LV</i>{row.lv}</span>
                <span className="hl-row-metric"><i>KILLS</i>{row.kills.toLocaleString()}</span>
                <span className={`hl-row-tier tier-${row.tier.toLowerCase()}`}>{row.tier}</span>
              </li>
            ))}
          </ul>

          <div className="hl-board-banner">
            <p className="hl-banner-main">
              Top 100 players earn monthly{" "}
              <span className="hl-hero-inline"><HeroToken size={24} /><span className="hl-gold">$HERO</span></span>{" "}
              rewards.
            </p>
            <p className="hl-banner-sub">Ranked by level, kills and boss kills.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function FinalSection({ onPlay }) {
  return (
    <section className="hl-sec hl-final" id="final">
      <div className="hl-final-bg" data-plx="0.1">
        <img src={IMG.final} alt="Heroes walking toward a glowing golden portal at dawn" />
      </div>
      <div className="hl-final-shade" />
      <div className="hl-fog hl-fog--a" />

      <div className="hl-token-floats" aria-hidden="true">
        <span className="tf tf1"><HeroToken size={74} /></span>
        <span className="tf tf2"><HeroToken size={46} /></span>
        <span className="tf tf3"><HeroToken size={30} /></span>
      </div>

      <div className="hl-final-inner">
        <Kicker>YOUR ADVENTURE AWAITS</Kicker>
        <h2 className="hl-h2 hl-final-h2" data-reveal>YOUR LEGEND <span className="hl-gold">STARTS NOW</span></h2>
        <p className="hl-final-desc" data-reveal style={{ transitionDelay: "120ms" }}>
          Build your squad of 3, defeat powerful enemies and earn $HERO as your collection grows.
        </p>
        <div data-reveal style={{ transitionDelay: "220ms" }}>
          <button className="hl-btn hl-btn--epic hl-btn--huge" onClick={onPlay}>
            <span>START PLAYING</span>
          </button>
        </div>
      </div>

      <footer className="hl-footer">
        <span className="hl-foot-mark"><img src="/assets/brand/heroloop-emblem.png" alt="" width={15} height={16} draggable={false} /> HEROLOOP</span>
        <span className="hl-foot-tag">AFK · GACHA · RPG — your heroes keep fighting.</span>
        <span className="hl-foot-copy">© 2026 HeroLoop. A world that never sleeps.</span>
      </footer>
    </section>
  );
}

function ComingSoonModal({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="hl-modal" role="dialog" aria-modal="true" aria-label="Coming soon" onClick={onClose}>
      <div className="hl-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="hl-modal-ring" aria-hidden="true">
          <HeroToken size={86} />
        </div>
        <h3 className="hl-modal-title">COMING SOON</h3>
        <p className="hl-modal-text">
          The gates of the Loop are almost open. Your legend will begin soon.
        </p>
        <button className="hl-btn hl-btn--ghost" onClick={onClose}>
          <span>RETURN TO THE REALM</span>
        </button>
      </div>
    </div>
  );
}

function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div className="hl-toast" role="status">
      <Diamond size={9} color="#7a5e2c" />
      <span>{msg}</span>
    </div>
  );
}

export default function App() {
  const game = useGame();
  const [modal, setModal] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(0);

  useEffect(() => {
    if (webGameEntryAllowed && game.state.walletAddress) window.location.replace('/#game');
  }, [game.state.walletAddress]);

  useReveal();
  useParallax();

  const startPlaying = useCallback(() => { if (webGameEntryAllowed) setModal(true); }, []);

  const showToast = useCallback((m) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  const onClaim = useCallback(() => {
    showToast("COMING SOON — your rewards await at launch");
    const f = document.querySelector(".hl-chest-frame");
    if (f && !reducedMotion()) {
      f.classList.remove("burst");
      void f.offsetWidth;
      f.classList.add("burst");
    }
  }, [showToast]);

  return (
    <div className="hl-root">
      <style>{CSS}</style>
      <ItemDefs />
      <Nav onPlay={startPlaying} />
      <main>
        <HeroSection onStart={startPlaying} />
        <HeroesSection />
        <BattleSection />
        <RewardsSection onClaim={onClaim} />
        <RanksSection />
        <FinalSection onPlay={startPlaying} />
      </main>
      {modal && <Onboarding game={game} onAccountReady={() => window.location.replace('/#game')} onClose={() => setModal(false)} />}
      <Toast msg={toast} />
    </div>
  );
}

const CSS = `
:root{
  --ink:#050507;
  --bg0:#070709;
  --bg1:#0a0a0d;
  --bg2:#0e0e12;
  --brass:#7a5e2c; --brass-hi:#b08f52; --brass-lo:#3c2d10;
  --gold:#7a5e2c; --gold-hi:#b08f52; --gold-deep:#4a3814;
  --violet-off:#6d4fc0; --violet-off-d:#4a3488;
  --violet:#3f3360; --cyan:#2c5260; --emerald:#2c5d49;
  --emerald-hi:#5fe6a8; --emerald-deep:#173a2c;
  --crimson:#5f2630;
  --ivory:#c2bdb0; --muted:#5d6377;
  --line:rgba(122,94,44,.1);
  --panel:rgba(8,8,11,.88);
  --display:'Cinzel', Georgia, serif;
  --body:'Manrope', system-ui, sans-serif;
}

*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;
  background:var(--ink);
  color:var(--ivory);
  font-family:var(--body);
  -webkit-font-smoothing:antialiased;
  overflow-x:hidden;
}
img{display:block;max-width:100%}
a{color:inherit;text-decoration:none}
button{font-family:inherit}

.hl-root{position:relative;min-height:100vh;background:
  linear-gradient(180deg,#060608 0%, #08080b 42%, #050507 100%);}
.hl-root::before{content:"";position:fixed;inset:0;z-index:70;pointer-events:none;opacity:.05;mix-blend-mode:overlay;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");}
.hl-root::after{content:"";position:fixed;inset:0;z-index:65;pointer-events:none;
  background:radial-gradient(125% 92% at 50% 42%, transparent 44%, rgba(0,0,0,.78) 100%);}

.hl-embers{position:fixed;inset:0;width:100%;height:100%;z-index:60;pointer-events:none;mix-blend-mode:screen;opacity:.32}

.hl-wrap{width:min(1240px,92vw);margin:0 auto;position:relative;z-index:3}
.hl-sec{position:relative;overflow:hidden}
.hl-sec-fade{position:absolute;left:0;right:0;bottom:-1px;height:160px;z-index:4;pointer-events:none;
  background:linear-gradient(180deg,transparent, var(--bg0) 92%);}

[data-reveal]{opacity:0;transform:translateY(28px);transition:opacity .85s cubic-bezier(.2,.7,.2,1), transform .85s cubic-bezier(.2,.7,.2,1)}
[data-reveal].revealed{opacity:1;transform:none}

.hl-kicker{display:inline-flex;align-items:center;gap:.7em;font-weight:700;
  letter-spacing:.34em;text-transform:uppercase;font-size:.66rem;color:var(--brass-hi);
  background:rgba(10,10,14,.72);border:1px solid rgba(122,94,44,.28);
  padding:.62em 1.05em;border-radius:3px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.03), 0 6px 16px -10px rgba(0,0,0,.8)}

.hl-h2{font-family:var(--display);font-weight:700;line-height:1.04;margin:.5em 0 .4em;
  font-size:clamp(2rem,5.2vw,4.2rem);letter-spacing:.02em;color:var(--ivory);
  text-shadow:0 2px 26px rgba(0,0,0,.75)}
.hl-h2--tight{margin-top:.3em}
.hl-gold{color:var(--gold-hi);text-shadow:0 0 12px rgba(122,94,44,.18)}
.hl-crimson{color:var(--crimson);text-shadow:0 0 12px rgba(95,38,48,.22)}
.hl-lead{max-width:46ch;color:var(--muted);font-size:clamp(.98rem,1.4vw,1.15rem);line-height:1.7;margin:0}
.hl-sub{color:var(--muted);margin:.2em 0 0;font-size:1rem}

.hl-btn{position:relative;border:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  font-family:var(--display);font-weight:700;letter-spacing:.2em;color:#1c1306;overflow:hidden;
  background:linear-gradient(180deg,#bd9234,#9c7626 52%,#574215);
  padding:1.05rem 2.4rem;font-size:.92rem;
  clip-path:polygon(14px 0,calc(100% - 14px) 0,100% 14px,100% calc(100% - 14px),calc(100% - 14px) 100%,14px 100%,0 calc(100% - 14px),0 14px);
  box-shadow:4px 4px 0 var(--violet-off), 0 12px 26px -8px rgba(0,0,0,.7);
  transition:transform .14s ease, box-shadow .14s ease, filter .2s ease}
.hl-btn::before{content:"";position:absolute;inset:2px;
  clip-path:polygon(12px 0,calc(100% - 12px) 0,100% 12px,100% calc(100% - 12px),calc(100% - 12px) 100%,12px 100%,0 calc(100% - 12px),0 12px);
  background:linear-gradient(180deg,rgba(255,232,170,.18),transparent 38%);opacity:.5;pointer-events:none}
.hl-btn::after{content:"";position:absolute;top:0;bottom:0;left:-60%;width:40%;
  background:linear-gradient(105deg,transparent,rgba(255,234,190,.32),transparent);transform:skewX(-18deg);
  transition:left .7s ease;pointer-events:none}
.hl-btn:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0 var(--violet-off), 0 16px 30px -8px rgba(0,0,0,.75);filter:brightness(1.04)}
.hl-btn:hover::after{left:135%}
.hl-btn:active{transform:translate(2px,2px);box-shadow:1px 1px 0 var(--violet-off-d), 0 6px 14px -8px rgba(0,0,0,.7)}
.hl-btn span{position:relative;z-index:2}
.hl-btn--huge{padding:1.3rem 3.4rem;font-size:1.05rem}
.hl-btn--block{width:100%}
.hl-btn--ghost{background:linear-gradient(180deg,rgba(16,16,20,.96),rgba(8,8,11,.98));color:var(--brass-hi);
  border:1px solid rgba(122,94,44,.36);box-shadow:3px 3px 0 rgba(74,52,136,.55), 0 10px 22px -10px rgba(0,0,0,.7)}
.hl-btn--ghost::before{opacity:.12}
.hl-btn--ghost:hover{box-shadow:4px 4px 0 var(--violet-off), 0 14px 26px -10px rgba(0,0,0,.75)}

.hl-nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;
  padding:1rem clamp(1rem,4vw,3rem);transition:background .4s ease,border-color .4s ease;
  border-bottom:1px solid transparent}
.hl-nav--solid{background:rgba(4,4,6,.92);backdrop-filter:blur(10px);border-bottom-color:var(--line)}
.hl-brand{display:flex;align-items:center;gap:.65rem}
.hl-brand-mark{display:block;width:30px;height:31px;object-fit:contain;filter:drop-shadow(0 0 6px rgba(201,146,52,.35))}
.hl-brand-text{font-family:var(--display);font-weight:900;letter-spacing:.34em;font-size:1rem;
  background:linear-gradient(180deg,#b08f52,#7a5e2c 55%,#3c2d10);-webkit-background-clip:text;background-clip:text;color:transparent}
.hl-nav-links{display:flex;gap:2rem;font-size:.8rem;letter-spacing:.22em;text-transform:uppercase;font-weight:600;color:var(--muted)}
.hl-nav-links a{position:relative;padding:.4rem 0;transition:color .25s}
.hl-nav-links a::after{content:"";position:absolute;left:0;right:0;bottom:-2px;height:1px;background:var(--brass);
  transform:scaleX(0);transform-origin:left;transition:transform .3s}
.hl-nav-links a:hover{color:var(--ivory)}
.hl-nav-links a:hover::after{transform:scaleX(1)}
.hl-pill{display:inline-flex;align-items:center;gap:.5em;font-family:var(--display);font-weight:700;letter-spacing:.22em;font-size:.72rem;
  color:var(--brass-hi);background:rgba(122,94,44,.06);border:1px solid rgba(122,94,44,.36);padding:.55rem 1.1rem;cursor:pointer;
  clip-path:polygon(8px 0,calc(100% - 8px) 0,100% 8px,100% calc(100% - 8px),calc(100% - 8px) 100%,8px 100%,0 calc(100% - 8px),0 8px);
  transition:background .25s,box-shadow .25s}
.hl-pill:hover{background:rgba(122,94,44,.13);box-shadow:0 0 12px rgba(122,94,44,.14)}

.hl-hero{min-height:100svh;display:flex;align-items:center;padding:7rem 0 5rem}
.hl-hero-bg{position:absolute;inset:-8% 0;z-index:0;will-change:transform}
.hl-hero-bg img{width:100%;height:100%;object-fit:cover;object-position:center 35%;
  filter:brightness(.55) saturate(.7) contrast(1.1)}
.hl-hero-vignette{position:absolute;inset:0;z-index:1;
  background:
    linear-gradient(90deg, rgba(4,4,6,.98) 0%, rgba(4,4,6,.88) 24%, rgba(4,4,6,.35) 50%, rgba(4,4,6,.4) 74%, rgba(4,4,6,.62) 100%),
    radial-gradient(120% 92% at 64% 38%, transparent 22%, rgba(3,3,5,.62) 80%, rgba(3,3,5,.95) 100%),
    linear-gradient(180deg, rgba(3,3,5,.82) 0%, transparent 22%, transparent 48%, rgba(5,5,7,.96) 100%)}
.hl-fog{position:absolute;inset:-25%;z-index:2;pointer-events:none;mix-blend-mode:screen;opacity:.12}
.hl-fog--a{background:radial-gradient(40% 30% at 30% 60%, rgba(44,82,96,.12), transparent 70%),
  radial-gradient(35% 25% at 70% 40%, rgba(63,51,96,.12), transparent 70%);animation:drift 48s ease-in-out infinite alternate}
.hl-fog--b{background:radial-gradient(45% 30% at 60% 70%, rgba(95,38,48,.08), transparent 70%);animation:drift2 56s ease-in-out infinite alternate}
@keyframes drift{from{transform:translate3d(-4%,2%,0)}to{transform:translate3d(5%,-3%,0)}}
@keyframes drift2{from{transform:translate3d(3%,-2%,0)}to{transform:translate3d(-5%,3%,0)}}
.hl-rays{position:absolute;inset:0;z-index:2;pointer-events:none;opacity:.08;mix-blend-mode:screen;
  background:conic-gradient(from 200deg at 78% 18%, transparent 0 12deg, rgba(176,143,82,.08) 14deg, transparent 18deg 30deg, rgba(44,82,96,.06) 32deg, transparent 36deg);
  animation:rayrot 90s linear infinite}
@keyframes rayrot{to{transform:rotate(360deg)}}

.hl-orbs{position:absolute;inset:0;z-index:2;pointer-events:none;overflow:hidden}
.hl-orb{position:absolute;border-radius:50%;filter:blur(40px);opacity:.45;mix-blend-mode:screen;
  animation:orbFloat 14s ease-in-out infinite}
.hl-orb1{width:380px;height:380px;left:6%;top:20%;background:radial-gradient(circle,rgba(109,79,192,.7),transparent 70%);animation-duration:18s}
.hl-orb2{width:260px;height:260px;right:10%;top:18%;background:radial-gradient(circle,rgba(176,143,82,.6),transparent 70%);animation-duration:22s;animation-delay:-6s}
.hl-orb3{width:220px;height:220px;right:30%;bottom:10%;background:radial-gradient(circle,rgba(44,82,96,.55),transparent 70%);animation-duration:26s;animation-delay:-12s}
.hl-orb4{width:180px;height:180px;left:22%;bottom:18%;background:radial-gradient(circle,rgba(95,38,48,.5),transparent 70%);animation-duration:20s;animation-delay:-4s}
@keyframes orbFloat{
  0%,100%{transform:translate(0,0) scale(1)}
  33%{transform:translate(40px,-30px) scale(1.08)}
  66%{transform:translate(-30px,20px) scale(.94)}
}

.hl-hero-inner{position:relative;z-index:5;width:min(1240px,92vw);margin:0 auto;text-align:left}
.hl-wordmark{font-family:var(--display);font-weight:900;margin:.35em 0 .12em;line-height:.92;
  font-size:clamp(3.4rem,12vw,9.2rem);letter-spacing:.06em;
  background:linear-gradient(180deg,#a8884e 0%,#7a5e2c 38%,#3c2d10 56%,#5f481f 74%,#221a0b 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 3px 0 rgba(0,0,0,.65)) drop-shadow(0 0 14px rgba(90,66,24,.15))}
.hl-hero-tag{font-family:var(--display);font-weight:700;font-size:clamp(1.2rem,2.6vw,2.05rem);
  color:var(--ivory);line-height:1.25;margin:.2em 0 .7em;text-shadow:0 2px 20px rgba(0,0,0,.85)}
.hl-hero-desc{max-width:48ch;color:#868c9c;font-size:clamp(.98rem,1.5vw,1.2rem);line-height:1.7;margin:0 0 1.6rem;
  text-shadow:0 2px 14px rgba(0,0,0,.85)}
.hl-hero-cta{display:flex;align-items:center;gap:1.4rem;flex-wrap:wrap}
.hl-hero-note{color:var(--muted);font-size:.78rem;letter-spacing:.12em;text-transform:uppercase}

.hl-squad{display:flex;align-items:center;gap:1.3rem;margin:0 0 1.8rem;max-width:640px;
  padding:1rem 1.3rem;border-radius:8px;
  background:linear-gradient(180deg,rgba(12,12,16,.72),rgba(6,6,9,.8));
  border:1px solid rgba(122,94,44,.2);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.03), 0 12px 28px -14px rgba(0,0,0,.7)}
.hl-squad-slots{display:flex;gap:.5rem;flex-shrink:0}
.hl-squad-slot{position:relative;width:54px;height:54px;border-radius:50%;overflow:hidden;
  border:2px solid var(--brass);box-shadow:0 0 14px rgba(122,94,44,.28), inset 0 0 12px rgba(0,0,0,.6);
  transition:transform .25s ease, box-shadow .25s ease}
.hl-squad-slot img{width:100%;height:100%;object-fit:cover;object-position:top;filter:saturate(.7) brightness(.8)}
.hl-squad-slot i{position:absolute;bottom:-18px;left:50%;transform:translateX(-50%);
  font-style:normal;font-size:.52rem;letter-spacing:.14em;color:var(--brass-hi);font-weight:700}
.hl-squad-slot:hover{transform:translateY(-3px);box-shadow:0 0 18px rgba(122,94,44,.5)}
.hl-squad-copy{color:#98a0b4;font-size:.86rem;line-height:1.55;padding-left:.4rem;margin-top:.4rem}
.hl-squad-copy strong{color:var(--brass-hi);letter-spacing:.08em}

.hl-scroll{position:absolute;left:50%;bottom:1.6rem;transform:translateX(-50%);z-index:6;
  display:flex;flex-direction:column;align-items:center;gap:.4rem;color:var(--brass-hi);
  font-size:.62rem;letter-spacing:.34em;opacity:.6}
.hl-scroll svg{animation:bob 1.8s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(6px)}}

.hl-heroes{padding:6.5rem 0 7.5rem}
.hl-heroes-bg{position:absolute;inset:0;z-index:0;
  background:radial-gradient(80% 60% at 50% 0%, rgba(28,22,48,.14), transparent 70%),
  linear-gradient(180deg,var(--bg0),#070709 60%,var(--bg0))}
.hl-heroes-head{max-width:760px;margin-bottom:2.8rem}
.hl-gallery{display:grid;grid-template-columns:repeat(5,1fr);gap:1.1rem}

.hl-card{position:relative;border-radius:6px;overflow:visible;cursor:pointer;
  background:linear-gradient(180deg,#0d0d12,#070709);
  border:1px solid #18181f;
  transition:transform .4s cubic-bezier(.2,.7,.2,1), box-shadow .4s, border-color .4s;
  --frame:rgba(63,51,96,.5); --frame-hi:#8577a8;
  --aura-r:140; --aura-g:110; --aura-b:200;
  padding:10px}
.hl-card-aura{position:absolute;inset:-18px;z-index:0;border-radius:14px;pointer-events:none;
  background:radial-gradient(ellipse at center, rgba(var(--aura-r),var(--aura-g),var(--aura-b),.3), transparent 65%);
  filter:blur(22px);opacity:.55;transition:opacity .4s ease, transform .4s ease;
  animation:auraPulse 3.6s ease-in-out infinite}
.hl-card:hover .hl-card-aura{opacity:.95;transform:scale(1.04)}
.hl-card:hover{transform:translateY(-8px);border-color:var(--frame);
  box-shadow:0 22px 44px -22px rgba(0,0,0,.92)}
@keyframes auraPulse{
  0%,100%{opacity:.45}
  50%{opacity:.75}
}
.hl-card-img{position:relative;aspect-ratio:3/4;overflow:hidden;border-radius:4px;
  box-shadow:inset 0 -46px 54px -34px rgba(var(--aura-r),var(--aura-g),var(--aura-b),.18),
             inset 0 16px 30px -16px rgba(0,0,0,.92)}
.hl-card-img img{width:100%;height:100%;object-fit:cover;object-position:top center;
  transition:transform .7s cubic-bezier(.2,.7,.2,1), filter .5s ease;
  filter:saturate(.78) contrast(1.08) brightness(.78)}
.hl-card:hover .hl-card-img img{transform:scale(1.06);filter:saturate(.88) contrast(1.08) brightness(.88)}
.hl-card-img::after{content:"";position:absolute;inset:0;
  background:linear-gradient(180deg,transparent 40%, rgba(3,3,5,.65) 74%, rgba(3,3,5,.98) 100%)}
.hl-shine{position:absolute;inset:0;z-index:3;pointer-events:none;
  background:linear-gradient(115deg,transparent 42%,rgba(176,143,82,.14) 50%,transparent 58%);
  transform:translateX(-130%);transition:transform .9s ease}
.hl-card:hover .hl-shine{transform:translateX(130%)}
.rar-leg .hl-shine{animation:legshine 7s ease-in-out infinite}
.rar-leg:hover .hl-shine{animation:none}
@keyframes legshine{0%{transform:translateX(-130%)}55%{transform:translateX(130%)}100%{transform:translateX(130%)}}
.hl-rar{position:absolute;top:.6rem;left:.6rem;z-index:4;font-family:var(--display);font-weight:700;
  font-size:.56rem;letter-spacing:.16em;text-transform:uppercase;padding:.32em .7em;border-radius:3px;
  background:rgba(3,3,5,.85);border:1px solid var(--frame);color:var(--frame-hi);backdrop-filter:blur(4px)}
.hl-card-meta{position:relative;z-index:4;padding:.85rem .4rem .4rem;margin-top:-.8rem}
.hl-card-meta h3{font-family:var(--display);font-weight:700;font-size:.86rem;line-height:1.2;margin:0 0 .4rem;color:var(--ivory);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.1em}
.hl-card-row{display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.hl-class{font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.hl-power{display:inline-flex;align-items:center;gap:.35em;font-weight:700;color:var(--gold-hi);font-size:.72rem}
.hl-pips{display:flex;gap:4px;margin:.5rem 0}
.hl-pips i{width:6px;height:6px;transform:rotate(45deg);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1)}
.hl-pips i.on{background:var(--frame);border-color:var(--frame);box-shadow:0 0 4px rgba(var(--aura-r),var(--aura-g),var(--aura-b),.5)}

.hl-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin:.4rem 0 .55rem;
  padding:.4rem .3rem;border-radius:4px;background:rgba(3,3,5,.6);
  border:1px solid rgba(255,255,255,.04)}
.hl-stats span{display:flex;flex-direction:column;align-items:center;gap:1px}
.hl-stats i{font-style:normal;font-size:.48rem;letter-spacing:.14em;color:var(--muted);text-transform:uppercase}
.hl-stats b{font-weight:700;color:var(--ivory);font-size:.72rem}

.hl-role{font-size:.68rem;line-height:1.4;color:var(--muted);margin:0;
  display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}

.hl-card::before,.hl-card::after{content:"";position:absolute;width:14px;height:14px;z-index:5;border:1.5px solid var(--frame);opacity:.7}
.hl-card::before{top:14px;left:14px;border-right:0;border-bottom:0}
.hl-card::after{top:14px;right:14px;border-left:0;border-bottom:0}

.rar-leg{--frame:#7a5e2c;--frame-hi:#b08f52;border-color:rgba(122,94,44,.28);
  --aura-r:176;--aura-g:143;--aura-b:82}
.rar-epi{--frame:#3f3360;--frame-hi:#8577a8;
  --aura-r:140;--aura-g:110;--aura-b:200}
.rar-rar{--frame:#2c5260;--frame-hi:#7498a6;
  --aura-r:100;--aura-g:160;--aura-b:180}

.hl-battle{padding:8rem 0}
.hl-battle-bg{position:absolute;inset:-12% 0;z-index:0;will-change:transform}
.hl-battle-bg img{width:100%;height:100%;object-fit:cover;object-position:center;
  filter:brightness(.48) saturate(.7) contrast(1.1)}
.hl-battle-shade{position:absolute;inset:0;z-index:1;
  background:linear-gradient(180deg,var(--bg0) 0%, rgba(4,4,6,.58) 22%, rgba(4,4,6,.72) 60%, var(--bg0) 100%),
  radial-gradient(80% 60% at 50% 50%, transparent 26%, rgba(2,2,4,.68) 100%)}
.hl-battle-wrap{z-index:3}
.hl-battle-head{max-width:720px;margin-bottom:2.4rem}

.hl-battle-stage{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:1.4rem;
  margin:0 0 2.4rem;padding:1.4rem 1.6rem;border-radius:12px;
  background:linear-gradient(180deg,rgba(10,10,14,.75),rgba(5,5,7,.85));
  border:1px solid rgba(122,94,44,.2);position:relative;overflow:hidden}
.hl-battle-stage::before{content:"";position:absolute;inset:0;pointer-events:none;
  background:
    radial-gradient(circle at 15% 50%, rgba(44,82,96,.22), transparent 40%),
    radial-gradient(circle at 85% 50%, rgba(95,38,48,.22), transparent 40%)}
.hl-battle-side{position:relative;z-index:2;display:flex;flex-direction:column;align-items:center;gap:.6rem}
.hl-stage-label{font-family:var(--display);font-weight:700;font-size:.7rem;letter-spacing:.28em;
  color:var(--brass-hi);text-transform:uppercase}
.hl-stage-row{display:flex;gap:.7rem;align-items:flex-end}
.hl-stage-hero{position:relative;width:86px;height:86px;border-radius:50%;overflow:hidden;
  border:2px solid var(--brass);box-shadow:0 0 18px rgba(122,94,44,.3), inset 0 0 14px rgba(0,0,0,.6);
  animation:heroFloat 4s ease-in-out infinite}
.hl-stage-hero img{width:100%;height:100%;object-fit:cover;object-position:top;filter:saturate(.8) brightness(.85)}
.hl-stage-hero--tank{border-color:#7498a6;box-shadow:0 0 18px rgba(116,152,166,.35);animation-delay:-.4s}
.hl-stage-hero--dps{border-color:#8577a8;box-shadow:0 0 18px rgba(133,119,168,.35);width:96px;height:96px;animation-delay:-.8s}
.hl-stage-hero--heal{border-color:#4fb48a;box-shadow:0 0 18px rgba(79,180,138,.3);animation-delay:-1.2s}
@keyframes heroFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
.hl-battle-vs{font-family:var(--display);font-weight:900;font-size:2rem;letter-spacing:.08em;
  color:var(--crimson);text-shadow:0 0 18px rgba(95,38,48,.5), 0 0 4px rgba(0,0,0,.8);
  padding:0 .6rem;position:relative;z-index:2}
.hl-stage-boss{position:relative;width:140px;height:140px;border-radius:50%;overflow:hidden;
  border:3px solid var(--crimson);
  box-shadow:0 0 26px rgba(95,38,48,.5), inset 0 0 20px rgba(0,0,0,.7);
  animation:bossPulse 3s ease-in-out infinite}
.hl-stage-boss img{width:100%;height:100%;object-fit:cover;filter:saturate(.8) brightness(.85)}
@keyframes bossPulse{
  0%,100%{box-shadow:0 0 26px rgba(95,38,48,.5), inset 0 0 20px rgba(0,0,0,.7);transform:scale(1)}
  50%{box-shadow:0 0 38px rgba(95,38,48,.75), inset 0 0 20px rgba(0,0,0,.7);transform:scale(1.02)}
}

.hl-bossbar{margin:0 0 3rem;max-width:680px}
.hl-bossbar-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.5rem;
  font-family:var(--display);letter-spacing:.1em}
.hl-boss-name{font-size:.8rem;color:var(--crimson);text-shadow:0 0 10px rgba(95,38,48,.26)}
.hl-boss-hp{font-size:.8rem;color:var(--gold-hi)}
.hl-bossbar-track{height:14px;border-radius:8px;background:rgba(2,2,4,.9);border:1px solid rgba(95,38,48,.28);
  overflow:hidden;box-shadow:inset 0 2px 8px rgba(0,0,0,.8)}
.hl-bossbar-fill{height:100%;width:100%;border-radius:8px;
  background:linear-gradient(90deg,#3c0d15,#5f2630 60%,#7a3d30);box-shadow:0 0 10px rgba(95,38,48,.28)}
.revealed .hl-bossbar-fill,.hl-bossbar.revealed .hl-bossbar-fill{width:18%;transition:width 2.4s cubic-bezier(.3,.7,.2,1) .3s}

.hl-cycle{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:1.4rem}
.hl-step{position:relative;padding:1.6rem 1.3rem;border-radius:8px;
  background:linear-gradient(180deg,rgba(11,11,15,.93),rgba(6,6,8,.96));
  border:1px solid #16161d;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.025), inset 0 -14px 26px -18px rgba(0,0,0,.88);
  transition:transform .35s, border-color .35s, box-shadow .35s}
.hl-step:hover{transform:translateY(-6px);border-color:rgba(122,94,44,.32);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.035), 0 16px 34px -20px rgba(0,0,0,.92)}
.hl-step-num{position:absolute;top:.8rem;right:1rem;font-family:var(--display);font-weight:700;
  font-size:.74rem;color:rgba(122,94,44,.4);letter-spacing:.1em}
.hl-step-ico{display:grid;place-items:center;width:54px;height:54px;border-radius:50%;color:var(--brass-hi);
  background:radial-gradient(circle at 50% 32%, rgba(122,94,44,.1), rgba(122,94,44,.02));
  border:1px solid rgba(122,94,44,.3);box-shadow:inset 0 0 12px rgba(122,94,44,.07);margin-bottom:1rem}
.hl-step h3{font-family:var(--display);font-weight:700;font-size:1rem;letter-spacing:.12em;margin:0 0 .5rem;color:var(--ivory)}
.hl-step p{margin:0;color:var(--muted);font-size:.86rem;line-height:1.55}
.hl-step-link{position:absolute;top:42px;right:-1.05rem;width:1.4rem;height:2px;
  background:linear-gradient(90deg,rgba(122,94,44,.45),transparent)}
.hl-step:last-child .hl-step-link{display:none}

.hl-rewards{padding:8rem 0}
.hl-rewards-bg{position:absolute;inset:0;z-index:0;
  background:radial-gradient(60% 55% at 24% 55%, rgba(74,44,18,.14), transparent 70%),
  radial-gradient(55% 55% at 82% 35%, rgba(28,22,48,.14), transparent 70%),
  linear-gradient(180deg,var(--bg0),#060608,var(--bg0))}
.hl-rewards-wrap{display:grid;grid-template-columns:1.05fr 1fr;gap:3rem;align-items:center}
.hl-rewards-art{position:relative}
.hl-chest-frame{position:relative;border-radius:10px;overflow:hidden;border:1px solid rgba(122,94,44,.22);
  box-shadow:0 30px 70px -28px rgba(0,0,0,.94), 0 0 42px -16px rgba(122,94,44,.22)}
.hl-chest-frame img{width:100%;height:100%;object-fit:cover;aspect-ratio:4/3;
  filter:saturate(.82) contrast(1.05) brightness(.78)}
.hl-chest-glow{position:absolute;inset:0;pointer-events:none;mix-blend-mode:screen;
  background:radial-gradient(46% 42% at 50% 52%, rgba(176,143,82,.24), transparent 70%);
  animation:chestglow 5s ease-in-out infinite}
@keyframes chestglow{0%,100%{opacity:.45}50%{opacity:.82}}
.hl-chest-vig{position:absolute;inset:0;pointer-events:none;
  box-shadow:inset 0 0 100px rgba(2,2,4,.7)}
.hl-chest-frame.burst{animation:burst .6s ease}
@keyframes burst{0%{transform:scale(1)}30%{transform:scale(1.025)}100%{transform:scale(1)}}

.hl-seal{position:absolute;right:16px;bottom:-18px;width:64px;height:64px;z-index:6;transform:rotate(-8deg);
  filter:drop-shadow(0 8px 18px rgba(0,0,0,.8)) drop-shadow(0 0 10px rgba(122,94,44,.22));
  animation:sealbreathe 6s ease-in-out infinite}
@keyframes sealbreathe{0%,100%{filter:drop-shadow(0 8px 18px rgba(0,0,0,.8)) drop-shadow(0 0 7px rgba(122,94,44,.16))}
  50%{filter:drop-shadow(0 8px 18px rgba(0,0,0,.8)) drop-shadow(0 0 16px rgba(122,94,44,.32))}}

.hl-coin-cluster{position:absolute;left:-10px;bottom:-16px;z-index:5;display:flex;align-items:flex-end}
.cc svg{display:block;filter:drop-shadow(0 5px 9px rgba(0,0,0,.75));width:42px;height:42px}
.cc2{margin-left:-16px;margin-bottom:5px;transform:rotate(-13deg)}
.cc2 svg{width:32px;height:32px}
.cc3{margin-left:-14px;margin-bottom:2px;transform:rotate(9deg)}
.cc3 svg{width:24px;height:24px}
.mote{position:absolute;width:6px;height:6px;background:var(--gold-hi);transform:rotate(45deg);
  box-shadow:0 0 8px rgba(176,143,82,.5);animation:motefloat 4.8s ease-in-out infinite;opacity:.8}
.mo1{left:74px;bottom:52px}
.mo2{left:30px;bottom:78px;animation-delay:1.3s;background:#7498a6;box-shadow:0 0 8px rgba(116,152,166,.5)}
.mo3{left:102px;bottom:26px;animation-delay:2.2s;width:4px;height:4px}
@keyframes motefloat{0%,100%{transform:rotate(45deg) translate(0,0);opacity:.7}50%{transform:rotate(45deg) translate(4px,-11px);opacity:.35}}

.hl-rewards-panel{position:relative;padding:2.2rem;border-radius:12px;
  background:linear-gradient(180deg,rgba(11,11,16,.96),rgba(6,6,9,.98));
  border:1px solid rgba(122,94,44,.34);
  box-shadow:0 30px 70px -32px rgba(0,0,0,.94), inset 0 1px 0 rgba(255,255,255,.035), 0 0 0 1px rgba(122,94,44,.06)}
.hl-panel-head{margin-bottom:1.4rem;display:flex;align-items:center;justify-content:space-between;gap:.8rem;flex-wrap:wrap}
.hl-live{display:inline-flex;align-items:center;gap:.4rem;padding:.28rem .6rem;border-radius:999px;
  background:rgba(23,58,44,.4);border:1px solid rgba(95,230,168,.32);
  font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;color:var(--emerald-hi)}
.hl-live-dot{width:6px;height:6px;border-radius:50%;background:var(--emerald-hi);
  box-shadow:0 0 8px rgba(95,230,168,.85);animation:live-pulse 1.6s ease-in-out infinite}
@keyframes live-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.72)}}
.hl-timer{margin:1.2rem 0 1.4rem;padding:1.1rem 1.3rem;border-radius:8px;
  background:radial-gradient(120% 140% at 0% 0%, rgba(44,82,96,.06), transparent 60%),rgba(3,3,5,.74);
  border:1px solid rgba(44,82,96,.18)}
.hl-timer-label{font-size:.64rem;letter-spacing:.3em;text-transform:uppercase;color:var(--cyan);
  display:inline-flex;align-items:center;gap:.5rem}
.hl-timer-clock{display:flex;align-items:baseline;gap:.3rem;margin-top:.35rem;font-family:var(--display);font-weight:700;
  font-size:clamp(1.9rem,4.6vw,2.8rem);color:var(--gold-hi);text-shadow:0 0 12px rgba(122,94,44,.16)}
.hl-timer-clock i{font-style:normal;font-size:.4em;color:var(--muted);margin-left:.1em;letter-spacing:.1em}
.hl-colon{color:var(--gold-deep);animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:.25}}

.hl-loot{list-style:none;margin:0 0 1rem;padding:0;display:grid;grid-template-columns:repeat(4,1fr);gap:.6rem}
.hl-loot-item{display:flex;flex-direction:column;align-items:center;gap:.35rem;padding:.85rem .35rem;border-radius:8px;
  background:linear-gradient(180deg,#0f0d09,#070709);border:1px solid rgba(122,94,44,.22);
  box-shadow:inset 0 2px 8px rgba(0,0,0,.65), inset 0 -1px 0 rgba(255,255,255,.02);
  transition:transform .3s,border-color .3s,box-shadow .3s}
.hl-loot-item:hover{transform:translateY(-4px);border-color:rgba(122,94,44,.52);
  box-shadow:inset 0 2px 8px rgba(0,0,0,.65), 0 10px 22px -14px rgba(122,94,44,.32)}
.hl-loot-ico{display:grid;place-items:center;width:38px;height:38px;
  filter:drop-shadow(0 3px 6px rgba(0,0,0,.7))}
.hl-loot-ico svg{width:30px;height:30px}
.hl-loot-v{font-weight:800;color:var(--gold-hi);font-size:.92rem;text-shadow:0 0 10px rgba(122,94,44,.2)}
.hl-loot-l{font-size:.58rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);text-align:center}

.hl-reward-note{display:flex;align-items:flex-start;gap:.85rem;padding:.9rem 1rem;border-radius:8px;
  background:linear-gradient(180deg,rgba(18,14,8,.7),rgba(10,8,5,.8));
  border:1px solid rgba(122,94,44,.24);margin-bottom:1.2rem;
  box-shadow:inset 0 1px 0 rgba(255,220,140,.05), 0 8px 22px -14px rgba(0,0,0,.7)}
.hl-reward-note svg{width:34px;height:34px;flex-shrink:0;filter:drop-shadow(0 0 10px rgba(176,143,82,.35))}
.hl-reward-note div{font-size:.82rem;color:#a5aab8;line-height:1.5}
.hl-reward-note b{color:var(--gold-hi);font-weight:700}

.hl-equip{margin:0 0 1.5rem}
.hl-equip-label{display:block;font-size:.6rem;letter-spacing:.3em;text-transform:uppercase;color:var(--muted);margin-bottom:.6rem;text-align:center}
.hl-equip-label::before,.hl-equip-label::after{content:"—";color:rgba(122,94,44,.4);margin:0 .6em}
.hl-slots{display:grid;grid-template-columns:repeat(8,1fr);gap:.5rem}
.hl-slot{display:flex;flex-direction:column;align-items:center;gap:.35rem;padding:.55rem .25rem .5rem;border-radius:7px;
  background:linear-gradient(180deg,#0d0d13,#070709);border:1px solid #15151c;position:relative;
  box-shadow:inset 0 3px 9px rgba(0,0,0,.8), inset 0 -1px 0 rgba(255,255,255,.02);
  transition:transform .25s,border-color .25s,box-shadow .25s;
  --frame:rgba(63,51,96,.45); --glow:rgba(63,51,96,.18)}
.hl-slot:hover{transform:translateY(-4px);border-color:var(--frame);
  box-shadow:inset 0 3px 9px rgba(0,0,0,.8), 0 8px 20px -12px var(--glow)}
.hl-slot::after{content:"";position:absolute;top:5px;right:5px;width:5px;height:5px;border-radius:50%;
  background:var(--frame);box-shadow:0 0 5px var(--glow);opacity:.8}
.hl-slot-ico{width:32px;height:32px;display:grid;place-items:center;filter:drop-shadow(0 3px 6px rgba(0,0,0,.75))}
.hl-slot-ico svg{width:30px;height:30px}
.hl-slot-l{font-size:.52rem;letter-spacing:.1em;color:var(--muted);text-transform:uppercase}
.hl-slot.rar-leg{--frame:rgba(122,94,44,.5);--glow:rgba(122,94,44,.2)}
.hl-slot.rar-rar{--frame:rgba(44,82,96,.45);--glow:rgba(44,82,96,.18)}

.hl-ranks{padding:8rem 0}
.hl-ranks-bg{position:absolute;inset:-10% 0;z-index:0;will-change:transform}
.hl-ranks-bg img{width:100%;height:100%;object-fit:cover;object-position:center;
  filter:brightness(.42) saturate(.6) contrast(1.1)}
.hl-ranks-shade{position:absolute;inset:0;z-index:1;
  background:linear-gradient(180deg,var(--bg0),rgba(4,4,6,.8) 30%,rgba(4,4,6,.84) 70%,var(--bg0))}
.hl-ranks-head{max-width:680px;margin:0 auto 3rem;text-align:center}
.hl-ranks-head .hl-kicker{justify-content:center}
.hl-ranks-head .hl-lead{margin-left:auto;margin-right:auto}

.hl-board{position:relative;max-width:920px;margin:0 auto;padding:2.4rem;border-radius:14px;
  background:linear-gradient(180deg,rgba(10,10,14,.95),rgba(5,5,7,.98));
  border:1px solid rgba(122,94,44,.16);
  box-shadow:0 40px 90px -38px rgba(0,0,0,.94), inset 0 1px 0 rgba(255,255,255,.035)}
.hl-bc{position:absolute;width:24px;height:24px;border:2px solid rgba(122,94,44,.36);pointer-events:none}
.hl-bc1{top:10px;left:10px;border-right:0;border-bottom:0}
.hl-bc2{top:10px;right:10px;border-left:0;border-bottom:0}
.hl-bc3{bottom:10px;left:10px;border-right:0;border-top:0}
.hl-bc4{bottom:10px;right:10px;border-left:0;border-top:0}

.hl-podium{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;align-items:end;margin-bottom:2rem}
.hl-pod{display:flex;flex-direction:column;align-items:center;text-align:center;padding:1.2rem .8rem 1.4rem;border-radius:10px;
  background:rgba(3,3,5,.65);border:1px solid #16161d;position:relative;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.025)}
.hl-pod--1{order:2;transform:translateY(-12px);border-color:rgba(122,94,44,.4);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.035), 0 0 24px -14px rgba(122,94,44,.2)}
.hl-pod--2{order:1}
.hl-pod--3{order:3}
.hl-pod-avatar{position:relative;width:96px;height:96px;border-radius:50%;overflow:hidden;margin-bottom:.8rem;
  border:3px solid var(--mc,#454b5c);box-shadow:0 0 14px -9px var(--mc,transparent)}
.hl-pod--1 .hl-pod-avatar{width:118px;height:118px;--mc:#7a5e2c}
.hl-pod--2 .hl-pod-avatar{--mc:#626a80}
.hl-pod--3 .hl-pod-avatar{--mc:#6b4524}
.hl-pod-avatar img{width:100%;height:100%;object-fit:cover;object-position:top;filter:saturate(.75) brightness(.75)}
.hl-pod-rank{position:absolute;bottom:-6px;left:50%;transform:translateX(-50%);width:26px;height:26px;border-radius:50%;
  display:grid;place-items:center;font-family:var(--display);font-weight:700;font-size:.8rem;color:#1c1306;
  background:linear-gradient(180deg,var(--brass-hi),var(--brass));border:2px solid #070709}
.hl-pod--2 .hl-pod-rank{background:linear-gradient(180deg,#aab1c2,#5e667c);color:#12161f}
.hl-pod--3 .hl-pod-rank{background:linear-gradient(180deg,#976738,#523114);color:#ece1d2}
.hl-pod-crown{position:absolute;top:-22px;left:50%;transform:translateX(-50%);color:var(--gold-hi);
  filter:drop-shadow(0 0 6px rgba(122,94,44,.34));z-index:3;animation:crownfloat 3.8s ease-in-out infinite}
@keyframes crownfloat{0%,100%{transform:translateX(-50%) translateY(0)}50%{transform:translateX(-50%) translateY(-4px)}}
.hl-pod h3{font-family:var(--display);font-weight:700;margin:0 0 .3rem;font-size:1.02rem;color:var(--ivory)}
.hl-pod-stat{font-size:.76rem;color:var(--muted)}
.hl-pod-kills{color:var(--gold-hi);font-weight:700}

.hl-board-rows{list-style:none;margin:0 0 1.6rem;padding:0;display:flex;flex-direction:column;gap:.5rem}
.hl-board-row{display:grid;grid-template-columns:34px 40px 1fr auto auto auto;align-items:center;gap:1rem;
  padding:.7rem 1rem;border-radius:8px;background:rgba(3,3,5,.6);border:1px solid transparent;
  transition:background .25s,border-color .25s,transform .25s}
.hl-board-row:hover{background:rgba(13,13,18,.85);border-color:#1d1d26;transform:translateX(4px)}
.hl-row-rank{font-family:var(--display);font-weight:700;color:var(--muted);text-align:center}
.hl-row-av{width:40px;height:40px;border-radius:50%;overflow:hidden;border:1px solid #1d1d26}
.hl-row-av img{width:100%;height:100%;object-fit:cover;object-position:top;filter:saturate(.7) brightness(.7)}
.hl-row-name{font-weight:700;color:var(--ivory)}
.hl-row-metric{font-size:.82rem;color:var(--muted);text-align:right;min-width:74px}
.hl-row-metric i{display:block;font-style:normal;font-size:.56rem;letter-spacing:.16em;color:rgba(93,99,119,.6);text-transform:uppercase}
.hl-row-tier{font-size:.62rem;letter-spacing:.14em;text-transform:uppercase;font-weight:700;padding:.35em .7em;border-radius:4px;
  border:1px solid #1d1d26;color:var(--muted)}
.tier-diamond{color:#7498a6;border-color:rgba(44,82,96,.4)}
.tier-platinum{color:#a4abbc;border-color:rgba(164,171,188,.28)}

.hl-board-banner{text-align:center;padding:1.2rem;border-radius:8px;
  background:radial-gradient(120% 140% at 50% 0%, rgba(122,94,44,.07), transparent 70%),rgba(3,3,5,.65);
  border:1px solid rgba(122,94,44,.2)}
.hl-banner-main{margin:0;font-family:var(--display);font-weight:700;letter-spacing:.04em;color:var(--ivory);font-size:1rem}
.hl-hero-inline{display:inline-flex;align-items:center;gap:.4em;vertical-align:-.35em}
.hl-hero-inline svg{filter:drop-shadow(0 0 7px rgba(122,94,44,.26))}
.hl-banner-sub{margin:.45rem 0 0;color:var(--muted);font-size:.8rem;letter-spacing:.06em}

.hl-final{min-height:100svh;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:8rem 0 0;text-align:center}
.hl-final-bg{position:absolute;inset:-10% 0;z-index:0;will-change:transform}
.hl-final-bg img{width:100%;height:100%;object-fit:cover;object-position:center;
  filter:brightness(.5) saturate(.65) contrast(1.1)}
.hl-final-shade{position:absolute;inset:0;z-index:1;
  background:radial-gradient(80% 70% at 50% 45%, rgba(2,2,4,.5), rgba(2,2,4,.92) 82%),
  linear-gradient(180deg,var(--bg0) 0%, transparent 18%, transparent 64%, var(--ink) 100%)}
.hl-token-floats{position:absolute;inset:0;z-index:2;pointer-events:none}
.tf{position:absolute;filter:drop-shadow(0 10px 24px rgba(0,0,0,.7)) drop-shadow(0 0 13px rgba(122,94,44,.2));
  animation:tokenfloat 8s ease-in-out infinite;opacity:.9}
.tf1{left:7%;bottom:20%}
.tf2{right:8%;top:24%;animation-delay:1.4s;animation-duration:9.5s}
.tf3{right:17%;bottom:28%;animation-delay:2.6s;animation-duration:7s;opacity:.78}
@keyframes tokenfloat{0%,100%{transform:translateY(0) rotate(-4deg)}50%{transform:translateY(-14px) rotate(4deg)}}
.hl-final-inner{position:relative;z-index:3;width:min(820px,90vw)}
.hl-final-h2{font-size:clamp(2.3rem,7vw,5.2rem)}
.hl-final-desc{margin:.4em auto 2.2rem;max-width:46ch;color:#9a9fae;font-size:clamp(.98rem,1.6vw,1.22rem);line-height:1.7;
  text-shadow:0 2px 16px rgba(0,0,0,.85)}

.hl-footer{position:relative;z-index:3;width:100%;margin-top:6rem;padding:1.6rem clamp(1rem,4vw,3rem);
  display:flex;flex-wrap:wrap;gap:1rem 2rem;align-items:center;justify-content:space-between;
  border-top:1px solid var(--line);background:rgba(2,2,4,.75);backdrop-filter:blur(6px);
  font-size:.76rem;color:var(--muted)}
.hl-foot-mark{font-family:var(--display);font-weight:700;letter-spacing:.2em;color:var(--brass-hi);display:inline-flex;align-items:center;gap:.5em}
.hl-foot-tag{letter-spacing:.08em}

.hl-modal{position:fixed;inset:0;z-index:200;display:grid;place-items:center;padding:1.4rem;
  background:rgba(2,2,4,.9);backdrop-filter:blur(8px);animation:fade .3s ease}
@keyframes fade{from{opacity:0}to{opacity:1}}
.hl-modal-card{position:relative;width:min(440px,92vw);text-align:center;padding:2.8rem 2.2rem 2.4rem;border-radius:14px;
  background:linear-gradient(180deg,rgba(12,12,17,.98),rgba(5,5,8,.99));
  border:1px solid rgba(122,94,44,.3);
  box-shadow:0 40px 100px -34px rgba(0,0,0,.94), 0 0 34px -16px rgba(122,94,44,.16);
  animation:pop .4s cubic-bezier(.2,.8,.2,1)}
@keyframes pop{from{transform:translateY(16px) scale(.96);opacity:0}to{transform:none;opacity:1}}
.hl-modal-ring{margin:0 auto 1.3rem;width:86px}
.hl-modal-ring svg{animation:tokenfloat 7s ease-in-out infinite;
  filter:drop-shadow(0 0 15px rgba(122,94,44,.24))}
.hl-modal-title{font-family:var(--display);font-weight:900;letter-spacing:.16em;margin:0 0 .8rem;
  font-size:clamp(1.8rem,5vw,2.5rem);
  background:linear-gradient(180deg,#b08f52,#7a5e2c 52%,#3c2d10);-webkit-background-clip:text;background-clip:text;color:transparent}
.hl-modal-text{color:var(--muted);line-height:1.6;margin:0 0 1.8rem}

.hl-toast{position:fixed;left:50%;bottom:1.6rem;transform:translateX(-50%);z-index:150;
  display:inline-flex;align-items:center;gap:.7em;padding:.85rem 1.4rem;border-radius:8px;
  background:linear-gradient(180deg,rgba(13,13,18,.98),rgba(5,5,8,.99));
  border:1px solid rgba(122,94,44,.36);color:var(--brass-hi);font-weight:600;letter-spacing:.04em;
  box-shadow:3px 3px 0 rgba(74,52,136,.5), 0 18px 40px -20px rgba(0,0,0,.9);
  animation:toastin .35s cubic-bezier(.2,.8,.2,1)}
@keyframes toastin{from{transform:translate(-50%,18px);opacity:0}to{transform:translate(-50%,0);opacity:1}}

@media (max-width:1080px){
  .hl-gallery{gap:.8rem}
  .hl-card-meta h3{font-size:.82rem}
  .hl-role{font-size:.64rem}
}
@media (max-width:980px){
  .hl-nav-links{display:none}
  .hl-rewards-wrap{grid-template-columns:1fr;gap:2.6rem}
  .hl-cycle{grid-template-columns:1fr 1fr}
  .hl-step-link{display:none}
  .hl-squad{flex-direction:column;align-items:flex-start}
}
@media (max-width:860px){
  .hl-gallery{display:flex;gap:.9rem;overflow-x:auto;scroll-snap-type:x mandatory;
    margin:0 -4vw;padding:.2rem 4vw .8rem;-webkit-overflow-scrolling:touch;scrollbar-width:none}
  .hl-gallery::-webkit-scrollbar{display:none}
  .hl-gallery .hl-card{flex:0 0 44%;scroll-snap-align:center}
  .hl-battle-stage{grid-template-columns:1fr;gap:1rem}
  .hl-battle-vs{padding:.3rem 0}
  .hl-stage-boss{width:110px;height:110px}
}
@media (max-width:680px){
  .hl-hero{padding:6.5rem 0 4rem}
  .hl-hero-inner{text-align:center}
  .hl-hero-vignette{background:
    radial-gradient(120% 92% at 50% 38%, transparent 20%, rgba(3,3,5,.82) 80%, rgba(3,3,5,.98) 100%),
    linear-gradient(180deg, rgba(3,3,5,.9) 0%, rgba(3,3,5,.55) 30%, rgba(3,3,5,.55) 50%, rgba(5,5,7,.98) 100%)}
  .hl-squad{margin-left:auto;margin-right:auto;text-align:left}
  .hl-hero-desc{margin-left:auto;margin-right:auto}
  .hl-hero-cta{justify-content:center}
  .hl-h2{font-size:clamp(1.85rem,8vw,2.7rem)}
  .hl-wordmark{font-size:clamp(2.6rem,14vw,4.4rem);letter-spacing:.01em;white-space:nowrap}
  .hl-gallery .hl-card{flex-basis:56%}
  .hl-cycle{grid-template-columns:1fr}
  .hl-loot{grid-template-columns:repeat(3,1fr)}
  .hl-slots{grid-template-columns:repeat(4,1fr)}
  .hl-podium{gap:.5rem}
  .hl-pod-avatar{width:74px;height:74px}
  .hl-pod--1 .hl-pod-avatar{width:90px;height:90px}
  .hl-pod{padding:.9rem .4rem 1rem}
  .hl-pod h3{font-size:.88rem}
  .hl-board-row{grid-template-columns:26px 34px 1fr auto;gap:.6rem;padding:.6rem .7rem}
  .hl-row-metric:nth-of-type(4){display:none}
  .hl-row-tier{display:none}
  .hl-board{padding:1.4rem}
  .hl-rewards-panel{padding:1.5rem}
  .hl-footer{flex-direction:column;align-items:flex-start;gap:.6rem}
  .hl-step{padding:1.3rem 1.1rem}
  .tf{display:none}
  .hl-stage-hero{width:68px;height:68px}
  .hl-stage-hero--dps{width:78px;height:78px}
}
@media (max-width:380px){
  .hl-loot{grid-template-columns:repeat(2,1fr)}
}

.hl-fog--a,.hl-fog--b,.hl-rays,.hl-orb,.hl-scroll svg,.hl-card-aura,.rar-leg .hl-shine,.hl-stage-hero,.hl-stage-boss,.hl-chest-glow,.hl-seal,.mote,.hl-colon,.hl-pod-crown,.tf,.hl-modal-ring svg{animation:none!important}

@media (prefers-reduced-motion: reduce){
  *{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}
  .hl-embers{display:none}
  [data-reveal]{opacity:1;transform:none}
}
`;
