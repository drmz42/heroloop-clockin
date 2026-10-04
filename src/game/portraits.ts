import type { HeroClass, Rarity } from './types';
import { RARITY_COLORS, RARITY_INDEX } from './heroes';

const HERO_ART: Record<string, string> = {
  ironfoot: '/assets/heroes/ironfoot-v2.webp',
  greenscout: '/assets/heroes/greenscout-v2.webp',
  cutpurse: '/assets/heroes/cutpurse-v2.webp',
  acolyte: '/assets/heroes/acolyte-v2.webp',
  shrubmage: '/assets/heroes/shrubmage-v2.webp',
};

export function heroPortraitSrc(heroId: string, heroClass: HeroClass, rarity: Rarity, color: string): string {
  const classFallback: Record<HeroClass, string> = {
    knight: HERO_ART.ironfoot,
    archer: HERO_ART.greenscout,
    assassin: HERO_ART.cutpurse,
    shepherd: HERO_ART.acolyte,
    druid: HERO_ART.shrubmage,
  };
  if (/^(shepherd|assassin|knight|druid|archer)-(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial|cursed|immortal|god)$/.test(heroId)) return `/assets/heroes/v4/${heroId}.png`;
  return HERO_ART[heroId] ?? classFallback[heroClass] ?? buildHeroSvg(heroClass, rarity, color);
}

export function heroPortraitStyle(heroId: string | undefined, heroClass: HeroClass): Record<string, string> | undefined {
  if (!heroId || !/^(shepherd|assassin|knight|druid|archer)-/.test(heroId)) return undefined;
  void heroClass;
  const isWarrior = heroId.startsWith('knight-');
  return {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    // Hero art is 349x887; a high crop keeps the head clear of the frame's top rim in square and card boxes.
    objectPosition: '50% 9%',
    ...(isWarrior ? { transform: 'scale(0.94)' } : {}),
  };
}

export function buildHeroSvg(heroClass: HeroClass, rarity: Rarity, color: string): string {
  const rc = RARITY_COLORS[rarity];
  const lvl = RARITY_INDEX[rarity]; // 0-11 (legacy Relic shares index 5)

  const defs = `<defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="55%">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#080810" stop-opacity="1"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${rc}" stop-opacity="${0.12 + lvl * 0.07}"/>
      <stop offset="100%" stop-color="${rc}" stop-opacity="0"/>
    </radialGradient>
    ${lvl >= 3 ? `<filter id="bloom"><feGaussianBlur in="SourceGraphic" stdDeviation="${1 + lvl * 0.3}" result="b"/><feComposite in="b" in2="SourceGraphic" operator="over"/></filter>` : ''}
    ${lvl >= 8 ? `<filter id="divine"><feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b"/><feColorMatrix in="b" type="matrix" values="1 0.5 0 0 0  0.5 1 0 0 0  0 0.2 1 0 0  0 0 0 1.5 0" result="c"/><feComposite in="c" in2="SourceGraphic" operator="over"/></filter>` : ''}
  </defs>
  <rect width="100" height="100" rx="12" fill="url(#bg)"/>
  <ellipse cx="50" cy="50" rx="44" ry="44" fill="url(#glow)"/>`;

  const body = buildBody(heroClass, color, rc, lvl);
  const deco = buildRarityDeco(rc, lvl);
  const extras = lvl >= 7 ? buildExtraAura(rc, lvl) : '';

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${defs}${extras}${body}${deco}</svg>`
  )}`;
}

function buildExtraAura(rc: string, lvl: number): string {
  if (lvl < 7) return '';
  const rings = lvl >= 9
    ? `<circle cx="50" cy="50" r="46" fill="none" stroke="${rc}" stroke-width="0.5" opacity="0.4"/>
       <circle cx="50" cy="50" r="42" fill="none" stroke="${rc}" stroke-width="0.3" opacity="0.25"/>`
    : `<circle cx="50" cy="50" r="46" fill="none" stroke="${rc}" stroke-width="0.4" opacity="0.3"/>`;
  const particles = lvl >= 8 ? Array.from({ length: 6 }).map((_, i) => {
    const angle = (i / 6) * Math.PI * 2;
    const x = 50 + Math.cos(angle) * 44;
    const y = 50 + Math.sin(angle) * 44;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${1 + lvl * 0.15}" fill="${rc}" opacity="0.7"/>`;
  }).join('') : '';
  return `${rings}${particles}`;
}

function buildRarityDeco(rc: string, lvl: number): string {
  if (lvl === 0) return `<rect x="12" y="91" width="76" height="2" rx="1" fill="${rc}" opacity="0.3"/>`;
  if (lvl === 1) return `<rect x="10" y="91" width="80" height="2" rx="1" fill="${rc}" opacity="0.6"/>
    <circle cx="50" cy="94" r="2" fill="${rc}" opacity="0.7"/>`;
  if (lvl === 2) return `<rect x="8" y="91" width="84" height="2" rx="1" fill="${rc}" opacity="0.75"/>
    ${[38, 50, 62].map(x => `<circle cx="${x}" cy="94.5" r="2" fill="${rc}" opacity="0.8"/>`).join('')}`;
  if (lvl === 3) return `<rect x="6" y="90" width="88" height="2.5" rx="1.2" fill="${rc}" opacity="0.85"/>
    ${[32, 41, 50, 59, 68].map((x, i) => `<polygon points="${x},96 ${x + 2},${93 - (i === 2 ? 2 : 0)} ${x + 4},96 ${x + 3},98.5 ${x + 1},98.5" fill="${rc}" opacity="${i === 2 ? 1 : 0.65}"/>`).join('')}`;
  if (lvl === 4) return `<rect x="4" y="89" width="92" height="3" rx="1.5" fill="${rc}" opacity="0.9"/>
    ${[26, 34, 42, 50, 58, 66, 74].map((x, i) => `<polygon points="${x},96 ${x + 2},${93 - (i === 3 ? 3 : 0)} ${x + 4},96 ${x + 3},99 ${x + 1},99" fill="${rc}" opacity="${i === 3 ? 1 : 0.7}"/>`).join('')}`;
  // 5+: full ornate border
  const borderOpacity = 0.6 + (lvl - 5) * 0.08;
  const filter = lvl >= 6 ? 'filter="url(#bloom)"' : '';
  const topDeco = lvl >= 7
    ? `<path d="M30 6 Q50 0 70 6" stroke="${rc}" stroke-width="1.5" fill="none" ${filter} opacity="0.8"/>
       <circle cx="50" cy="4" r="${1.5 + (lvl - 7) * 0.6}" fill="${rc}" ${filter} opacity="0.9"/>`
    : '';
  return `
    <rect x="2" y="2" width="96" height="96" rx="11" fill="none" stroke="${rc}" stroke-width="${0.5 + (lvl - 5) * 0.3}" opacity="${borderOpacity}" ${filter}/>
    <rect x="4" y="88" width="92" height="3.5" rx="1.7" fill="${rc}" ${filter} opacity="0.95"/>
    ${Array.from({ length: 9 }).map((_, i) => {
      const x = 14 + i * 9;
      const h = i === 4 ? 8 : 5;
      return `<polygon points="${x},96 ${x + 2},${97 - h} ${x + 4},96 ${x + 3},99.5 ${x + 1},99.5" fill="${rc}" opacity="${i === 4 ? 1 : 0.65}" ${i === 4 ? filter : ''}/>`;
    }).join('')}
    ${topDeco}`;
}

// ── Class body builders ──────────────────────────────────────────────────

function buildBody(cls: HeroClass, c: string, rc: string, lvl: number): string {
  switch (cls) {
    case 'knight':   return buildKnight(c, rc, lvl);
    case 'archer':   return buildArcher(c, rc, lvl);
    case 'assassin': return buildAssassin(c, rc, lvl);
    case 'shepherd': return buildShepherd(c, rc, lvl);
    case 'druid':    return buildDruid(c, rc, lvl);
  }
}

function face(c: string, lvl: number): string {
  const glow = lvl >= 5 ? 'filter="url(#bloom)"' : '';
  const eyeCol = lvl >= 4 ? c : '#e2e8f0';
  return `
    <ellipse cx="44" cy="43" rx="2.8" ry="3.2" fill="${eyeCol}" opacity="0.95" ${glow}/>
    <ellipse cx="56" cy="43" rx="2.8" ry="3.2" fill="${eyeCol}" opacity="0.95" ${glow}/>
    <ellipse cx="44" cy="43.5" rx="1.6" ry="1.8" fill="#0a0a14"/>
    <ellipse cx="56" cy="43.5" rx="1.6" ry="1.8" fill="#0a0a14"/>
    ${lvl >= 3 ? `<ellipse cx="44" cy="43" rx="0.8" ry="0.9" fill="${c}" opacity="0.9"/>
      <ellipse cx="56" cy="43" rx="0.8" ry="0.9" fill="${c}" opacity="0.9"/>` : ''}`;
}

function buildKnight(c: string, rc: string, lvl: number): string {
  const f = lvl >= 6 ? 'filter="url(#bloom)"' : '';
  const helm = `
    <path d="M32 25 Q50 ${10 - lvl * 0.8} 68 25 L68 40 Q50 34 32 40 Z" fill="${lvl >= 2 ? rc : c}" opacity="${0.75 + lvl * 0.02}"/>
    ${lvl >= 3 ? `<path d="M40 27 L60 27" stroke="#fff" stroke-width="0.8" opacity="0.3"/>` : ''}
    ${lvl >= 4 ? `<path d="M50 ${12 - lvl * 0.8} L50 ${6 - lvl * 0.6}" stroke="${rc}" stroke-width="2" ${f}/>
      <circle cx="50" cy="${5 - lvl * 0.6}" r="${2 + lvl * 0.3}" fill="${rc}" ${f}/>` : ''}`;
  const plate = `
    <rect x="${28 - lvl}" y="54" width="${44 + lvl * 2}" height="30" rx="5" fill="${c}" opacity="${0.7 + lvl * 0.02}"/>
    <line x1="50" y1="54" x2="50" y2="84" stroke="${rc}" stroke-width="1.2" opacity="0.4"/>
    <line x1="${28 - lvl}" y1="68" x2="${72 + lvl}" y2="68" stroke="${rc}" stroke-width="0.8" opacity="0.3"/>
    ${lvl >= 2 ? `<circle cx="50" cy="67" r="${3 + lvl * 0.4}" fill="${rc}" opacity="0.6" ${f}/>` : ''}
    ${lvl >= 4 ? `<path d="M${32 - lvl} 56 L${26 - lvl} 52 M${68 + lvl} 56 L${74 + lvl} 52" stroke="${rc}" stroke-width="2" opacity="0.8"/>` : ''}`;
  const shield = `
    <path d="M70 38 L82 43 L82 65 Q82 76 70 80 Q58 76 58 65 L58 43 Z" fill="${c}" opacity="${0.75 + lvl * 0.02}"/>
    <path d="M70 40 L80 45 L80 64 Q80 74 70 78 Q60 74 60 64 L60 45 Z" fill="${rc}" opacity="${0.18 + lvl * 0.07}"/>
    ${lvl >= 3 ? `<circle cx="70" cy="59" r="${2.5 + lvl * 0.5}" fill="${rc}" opacity="0.7" ${f}/>` : ''}`;
  return `${helm}${face(c, lvl)}${plate}${shield}`;
}

function buildArcher(c: string, rc: string, lvl: number): string {
  const f = lvl >= 6 ? 'filter="url(#bloom)"' : '';
  const hood = `
    <path d="M34 42 Q50 ${18 - lvl} 66 42 L64 52 Q50 46 36 52 Z" fill="${c}" opacity="${0.7 + lvl * 0.02}"/>
    ${lvl >= 2 ? `<path d="M38 36 Q50 22 62 36" stroke="${rc}" stroke-width="${1 + lvl * 0.15}" fill="none" opacity="0.7"/>` : ''}
    ${lvl >= 5 ? `<circle cx="50" cy="${16 - lvl * 0.4}" r="${1.5 + lvl * 0.2}" fill="${rc}" ${f}/>` : ''}`;
  const vest = `
    <path d="M32 54 L40 51 L60 51 L68 54 L68 84 Q50 80 32 84 Z" fill="${c}" opacity="${0.6 + lvl * 0.02}"/>
    ${lvl >= 2 ? `<circle cx="50" cy="65" r="${2.5 + lvl * 0.3}" fill="${rc}" opacity="0.6" ${f}/>` : ''}`;
  const bow = `
    <path d="M78 18 Q${90 + lvl} 50 78 82" stroke="${rc}" stroke-width="${2 + lvl * 0.3}" fill="none" opacity="${0.75 + lvl * 0.02}" ${f}/>
    <line x1="78" y1="18" x2="78" y2="82" stroke="${rc}" stroke-width="0.8" opacity="0.5"/>
    ${lvl >= 4 ? `<circle cx="78" cy="50" r="${2.5 + lvl * 0.3}" fill="${rc}" opacity="0.9" ${f}/>` : ''}`;
  return `${hood}${face(c, lvl)}${vest}${bow}`;
}

function buildAssassin(c: string, rc: string, lvl: number): string {
  const f = lvl >= 6 ? 'filter="url(#bloom)"' : '';
  const mask = `
    <path d="M34 38 Q50 ${20 - lvl * 0.5} 66 38 L64 54 Q50 48 36 54 Z" fill="${c}" opacity="0.9"/>
    <rect x="38" y="42" width="24" height="6" rx="3" fill="#0a0a14" opacity="0.85"/>
    ${lvl >= 2 ? `<path d="M38 44 Q50 48 62 44" stroke="${rc}" stroke-width="1" fill="none" opacity="0.7"/>` : ''}
    ${lvl >= 5 ? `<circle cx="50" cy="32" r="${2 + lvl * 0.2}" fill="${rc}" ${f}/>` : ''}`;
  const cloak = `
    <path d="M22 52 L36 48 L64 48 L78 52 L82 88 Q50 84 18 88 Z" fill="${c}" opacity="${0.5 + lvl * 0.02}"/>`;
  const daggers = `
    <rect x="20" y="26" width="3" height="22" rx="1.5" fill="${rc}" opacity="0.85" ${f}/>
    <polygon points="20,26 23,26 21.5,20" fill="${rc}" opacity="0.95" ${f}/>
    <rect x="77" y="30" width="3" height="20" rx="1.5" fill="${rc}" opacity="0.8" ${f}/>
    <polygon points="77,30 80,30 78.5,24" fill="${rc}" opacity="0.95" ${f}/>`;
  return `${mask}${cloak}${daggers}`;
}

function buildShepherd(c: string, rc: string, lvl: number): string {
  const f = lvl >= 6 ? 'filter="url(#bloom)"' : '';
  const halo = lvl >= 1
    ? `<ellipse cx="50" cy="23" rx="${10 + lvl * 1.8}" ry="${3 + lvl * 0.2}" fill="none" stroke="${rc}" stroke-width="${1 + lvl * 0.25}" opacity="${0.5 + lvl * 0.05}" ${f}/>`
    : '';
  const headWrap = `<path d="M35 32 Q50 18 65 32 L64 46 Q50 40 36 46 Z" fill="${c}" opacity="${0.65 + lvl * 0.02}"/>`;
  const robes = `
    <path d="M24 54 Q50 48 76 54 L78 88 Q50 84 22 88 Z" fill="${c}" opacity="${0.55 + lvl * 0.02}"/>
    <path d="M38 56 L36 86 M62 56 L64 86" stroke="${rc}" stroke-width="1" opacity="0.35"/>
    ${lvl >= 3 ? `<circle cx="50" cy="68" r="${2 + lvl * 0.4}" fill="${rc}" opacity="0.5" ${f}/>` : ''}`;
  const staff = `
    <line x1="76" y1="14" x2="72" y2="88" stroke="${rc}" stroke-width="${1.8 + lvl * 0.1}" opacity="${0.7 + lvl * 0.02}" ${f}/>
    <path d="M70 14 L76 8 L82 14 L76 20 Z" fill="${rc}" opacity="0.9" ${f}/>
    ${lvl >= 3 ? `<circle cx="76" cy="14" r="${5 + lvl * 0.6}" fill="${rc}" opacity="0.15" ${f}/>` : ''}`;
  return `${halo}${headWrap}${face(c, lvl)}${robes}${staff}`;
}

function buildDruid(c: string, rc: string, lvl: number): string {
  const f = lvl >= 6 ? 'filter="url(#bloom)"' : '';
  const antlers = `
    <path d="M40 28 L34 16 L30 20 M40 28 L36 18" stroke="${rc}" stroke-width="${1.2 + lvl * 0.1}" fill="none" opacity="${0.7 + lvl * 0.03}" ${f}/>
    <path d="M60 28 L66 16 L70 20 M60 28 L64 18" stroke="${rc}" stroke-width="${1.2 + lvl * 0.1}" fill="none" opacity="${0.7 + lvl * 0.03}" ${f}/>
    ${lvl >= 2 ? `<circle cx="30" cy="20" r="${1.5 + lvl * 0.15}" fill="${rc}" opacity="0.8" ${f}/>
      <circle cx="70" cy="20" r="${1.5 + lvl * 0.15}" fill="${rc}" opacity="0.8" ${f}/>` : ''}`;
  const head = `<path d="M34 38 Q50 22 66 38 L65 50 Q50 46 35 50 Z" fill="${c}" opacity="${0.7 + lvl * 0.02}"/>`;
  const robe = `
    <path d="M22 54 Q50 48 78 54 L80 88 Q50 84 20 88 Z" fill="${c}" opacity="${0.58 + lvl * 0.02}"/>
    ${lvl >= 2 ? `<path d="M36 56 L34 84 M64 56 L66 84" stroke="${rc}" stroke-width="0.8" opacity="0.35"/>` : ''}
    ${lvl >= 4 ? `<path d="M44 56 L42 82 M56 56 L58 82" stroke="${rc}" stroke-width="0.6" opacity="0.25"/>` : ''}`;
  const staff = `
    <line x1="74" y1="12" x2="70" y2="88" stroke="${rc}" stroke-width="${1.8 + lvl * 0.1}" opacity="${0.68 + lvl * 0.02}"/>
    <circle cx="74" cy="12" r="${3 + lvl * 0.5}" fill="${rc}" opacity="0.9" ${f}/>
    ${Array.from({ length: 3 + Math.floor(lvl / 2) }).map((_, i) => {
      const a = (i / (3 + Math.floor(lvl / 2))) * Math.PI * 2;
      const r2 = 5 + lvl * 0.4;
      return `<circle cx="${(74 + Math.cos(a) * r2).toFixed(1)}" cy="${(12 + Math.sin(a) * r2 * 0.5).toFixed(1)}" r="1" fill="${rc}" opacity="0.5"/>`;
    }).join('')}`;
  return `${antlers}${head}${face(c, lvl)}${robe}${staff}`;
}
