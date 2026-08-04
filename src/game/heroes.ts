import type { HeroClass, HeroBase, Rarity, Faction } from './types';

// ── 12-tier product rarity system (+ legacy save compatibility) ───────────

export const RARITY_COLORS: Record<Rarity, string> = {
  common:    '#9ca3af',
  uncommon:  '#4ade80',
  rare:      '#3b82f6',
  epic:      '#a855f7',
  legendary: '#f97316',
  mythic:    '#ef4444',
  relic:     '#2dd4bf',
  cursed:    '#9f1239',
  cosmic:    '#7c3aed',
  divine:    '#fbbf24',
  celestial: '#d9fbff',
  immortal:  '#d8dce8',
  god:       '#fff7d6',
};

export const RARITY_GLOW: Record<Rarity, string> = {
  common:    'rgba(156,163,175,0.4)',
  uncommon:  'rgba(74,222,128,0.5)',
  rare:      'rgba(59,130,246,0.6)',
  epic:      'rgba(168,85,247,0.65)',
  legendary: 'rgba(249,115,22,0.7)',
  mythic:    'rgba(239,68,68,0.75)',
  relic:     'rgba(45,212,191,0.7)',
  cursed:    'rgba(159,18,57,0.75)',
  cosmic:    'rgba(124,58,237,0.8)',
  divine:    'rgba(251,191,36,0.9)',
  celestial: 'rgba(217,251,255,0.95)',
  immortal:  'rgba(216,220,232,0.9)',
  god:       'rgba(255,247,214,0.95)',
};

export const RARITY_LABEL: Record<Rarity, string> = {
  common:    'Common',
  uncommon:  'Uncommon',
  rare:      'Rare',
  epic:      'Epic',
  legendary: 'Legendary',
  mythic:    'Mythic',
  relic:     'Relic',
  cursed:    'Cursed',
  cosmic:    'Cosmic',
  divine:    'Divine',
  celestial: 'Celestial',
  immortal:  'Immortal',
  god:       'God',
};

// Server-authoritative hero summon percentages. Keep total at exactly 100.
export const RARITY_WEIGHT: Record<Rarity, number> = {
  common:    55,
  uncommon:  27,
  rare:      12,
  epic:      4,
  legendary: 1.5,
  mythic:    0.4,
  relic:     0,
  cursed:    0,
  cosmic:    0.08,
  divine:    0.018,
  celestial: 0.002,
  immortal:  0,
  god:       0,
};

// Rarity index for comparisons
export const RARITY_INDEX: Record<Rarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
  mythic: 5, relic: 5, cosmic: 6, divine: 7, celestial: 8,
  cursed: 9, immortal: 10, god: 11,
};

export const CLASS_ICON: Record<HeroClass, string> = {
  knight:   '🛡️',
  archer:   '🏹',
  assassin: '🗡️',
  shepherd: '🪄',
  druid:    '🌿',
};

export const CLASS_LABEL: Record<HeroClass, string> = {
  knight:   'Warrior',
  archer:   'Crossbowman',
  assassin: 'Assassin',
  shepherd: 'Mage',
  druid:    'Druid',
};

export const FACTION_COLORS: Record<Faction, string> = {
  light:  '#fbbf24',
  dark:   '#6366f1',
  nature: '#22c55e',
  fire:   '#f97316',
  water:  '#06b6d4',
  void:   '#ec4899',
  cosmic: '#7c3aed',
};

// ── Hero definitions ──────────────────────────────────────────────────────

const LEGACY_HEROES: HeroBase[] = [
  // ── COMMON ──
  {
    id: 'ironfoot', name: 'Ironfoot Guard', heroClass: 'knight', rarity: 'common', faction: 'light',
    baseHp: 460, baseAtk: 48, baseDef: 24, baseSpeed: 95, critChance: 0.07, critDamage: 1.5,
    skillName: 'Shield Bash', skillDesc: 'A stunning blow with the shield rim',
    passiveName: 'Fortify', passiveDesc: 'Reduces incoming damage by 5% when HP is below 40%',
    color: '#94a3b8',
  },
  {
    id: 'greenscout', name: 'Greenwood Scout', heroClass: 'archer', rarity: 'common', faction: 'nature',
    baseHp: 340, baseAtk: 66, baseDef: 14, baseSpeed: 115, critChance: 0.14, critDamage: 1.65,
    skillName: 'Quick Shot', skillDesc: 'Fires two rapid arrows',
    passiveName: 'Eagle Eye', passiveDesc: '+8% crit chance on consecutive attacks',
    color: '#86efac',
  },
  {
    id: 'cutpurse', name: 'Street Cutpurse', heroClass: 'assassin', rarity: 'common', faction: 'dark',
    baseHp: 320, baseAtk: 60, baseDef: 12, baseSpeed: 125, critChance: 0.20, critDamage: 1.75,
    skillName: 'Backstab', skillDesc: 'Precise strike at vital points',
    passiveName: 'Shadow Step', passiveDesc: 'First attack each fight always crits',
    color: '#a5b4fc',
  },
  {
    id: 'acolyte', name: 'Temple Acolyte', heroClass: 'shepherd', rarity: 'common', faction: 'light',
    baseHp: 380, baseAtk: 40, baseDef: 16, baseSpeed: 100, critChance: 0.06, critDamage: 1.5,
    skillName: 'Mend', skillDesc: 'Heals the most wounded ally',
    passiveName: 'Steady Blessing', passiveDesc: 'Each attack also heals all allies for 3% of ATK',
    color: '#fde68a',
  },
  {
    id: 'shrubmage', name: 'Shrub Mage', heroClass: 'druid', rarity: 'common', faction: 'nature',
    baseHp: 370, baseAtk: 55, baseDef: 15, baseSpeed: 98, critChance: 0.09, critDamage: 1.55,
    skillName: 'Thorn Lash', skillDesc: 'A whip of living vines',
    passiveName: 'Bark Skin', passiveDesc: 'Regenerates 1% max HP every 3 seconds',
    color: '#a3e635',
  },

  // ── UNCOMMON ──
  {
    id: 'dawnknight', name: 'Dawn Crusader', heroClass: 'knight', rarity: 'uncommon', faction: 'light',
    baseHp: 680, baseAtk: 82, baseDef: 40, baseSpeed: 98, critChance: 0.09, critDamage: 1.6,
    skillName: 'Holy Cleave', skillDesc: 'A radiant slash that scorches evil',
    passiveName: 'Holy Resolve', passiveDesc: 'Immune to the first fatal hit every battle',
    color: '#fcd34d',
  },
  {
    id: 'thornranger', name: 'Thornwood Ranger', heroClass: 'archer', rarity: 'uncommon', faction: 'nature',
    baseHp: 540, baseAtk: 110, baseDef: 22, baseSpeed: 128, critChance: 0.18, critDamage: 1.8,
    skillName: 'Piercing Arrow', skillDesc: 'A thorn-coated armor-piercing shot',
    passiveName: 'Predator Mark', passiveDesc: 'First 3 hits deal 15% bonus damage',
    color: '#4ade80',
  },
  {
    id: 'moonpriest', name: 'Moon Priestess', heroClass: 'shepherd', rarity: 'uncommon', faction: 'light',
    baseHp: 520, baseAtk: 50, baseDef: 24, baseSpeed: 105, critChance: 0.07, critDamage: 1.55,
    skillName: 'Moonlight Mend', skillDesc: 'Moonlight bathes the weakest ally',
    passiveName: 'Lunar Grace', passiveDesc: 'Heals all allies for 5% of ATK on each heal',
    color: '#e0e7ff',
  },
  {
    id: 'grovekeeper', name: 'Grove Keeper', heroClass: 'druid', rarity: 'uncommon', faction: 'nature',
    baseHp: 620, baseAtk: 75, baseDef: 30, baseSpeed: 102, critChance: 0.11, critDamage: 1.6,
    skillName: 'Nature\'s Grasp', skillDesc: 'Roots an enemy, stunning for one turn',
    passiveName: 'Ancient Roots', passiveDesc: 'Regenerates 1.5% max HP every 3 seconds',
    color: '#86efac',
  },

  // ── RARE ──
  {
    id: 'stoneguard', name: 'Stoneguard Captain', heroClass: 'knight', rarity: 'rare', faction: 'nature',
    baseHp: 960, baseAtk: 100, baseDef: 58, baseSpeed: 88, critChance: 0.08, critDamage: 1.55,
    skillName: 'Iron Body', skillDesc: 'Hardens skin, reducing all damage',
    passiveName: 'Taunt', passiveDesc: '30% chance enemies target this hero instead',
    color: '#a3e635',
  },
  {
    id: 'stormsniper', name: 'Stormcaller Sniper', heroClass: 'archer', rarity: 'rare', faction: 'water',
    baseHp: 800, baseAtk: 200, baseDef: 30, baseSpeed: 138, critChance: 0.26, critDamage: 2.0,
    skillName: 'Thunder Shot', skillDesc: 'A lightning-charged devastating shot',
    passiveName: 'Overcharge', passiveDesc: 'Every 5th attack deals double damage',
    color: '#0ea5e9',
  },
  {
    id: 'duskblade', name: 'Dusk Shadowblade', heroClass: 'assassin', rarity: 'rare', faction: 'dark',
    baseHp: 860, baseAtk: 188, baseDef: 28, baseSpeed: 145, critChance: 0.34, critDamage: 2.1,
    skillName: 'Shadow Dance', skillDesc: 'A flurry of unseen lethal cuts',
    passiveName: 'Evasion', passiveDesc: '+12% dodge chance, doubled after a miss',
    color: '#818cf8',
  },
  {
    id: 'irondruid', name: 'Iron Druid', heroClass: 'druid', rarity: 'rare', faction: 'nature',
    baseHp: 900, baseAtk: 115, baseDef: 44, baseSpeed: 105, critChance: 0.12, critDamage: 1.7,
    skillName: 'Bramble Shield', skillDesc: 'Thorns deal damage to all attackers',
    passiveName: 'Wild Regen', passiveDesc: 'Regenerates 2% max HP every 3 seconds',
    color: '#65a30d',
  },

  // ── EPIC ──
  {
    id: 'voidknight', name: 'Void Knight', heroClass: 'knight', rarity: 'epic', faction: 'void',
    baseHp: 1600, baseAtk: 190, baseDef: 85, baseSpeed: 105, critChance: 0.14, critDamage: 1.85,
    skillName: 'Void Smash', skillDesc: 'A blow warped by void energy',
    passiveName: 'Void Shell', passiveDesc: 'Absorbs 8% of incoming damage as HP',
    color: '#818cf8',
  },
  {
    id: 'starfall', name: 'Starfall Marksman', heroClass: 'archer', rarity: 'epic', faction: 'light',
    baseHp: 1200, baseAtk: 310, baseDef: 44, baseSpeed: 148, critChance: 0.32, critDamage: 2.3,
    skillName: 'Starfall Volley', skillDesc: 'A divine rain of celestial arrows',
    passiveName: 'Celestial Sight', passiveDesc: 'Ignores 20% of enemy DEF',
    color: '#fbbf24',
  },
  {
    id: 'deathwhisper', name: 'Deathwhisper', heroClass: 'assassin', rarity: 'epic', faction: 'dark',
    baseHp: 1300, baseAtk: 295, baseDef: 40, baseSpeed: 155, critChance: 0.42, critDamage: 2.4,
    skillName: 'Final Silence', skillDesc: 'A single whispered cut that ends all',
    passiveName: 'Lethal Mark', passiveDesc: 'Crit kills grant +10% ATK for rest of battle',
    color: '#c084fc',
  },
  {
    id: 'solarsage', name: 'Solar Sage', heroClass: 'shepherd', rarity: 'epic', faction: 'fire',
    baseHp: 1100, baseAtk: 145, baseDef: 52, baseSpeed: 110, critChance: 0.10, critDamage: 1.7,
    skillName: 'Solar Blessing', skillDesc: 'A radiant wave of healing fire',
    passiveName: 'Solar Pulse', passiveDesc: 'Heals all allies for 8% of ATK every attack',
    color: '#fb923c',
  },
  {
    id: 'stormdruid', name: 'Stormcaller Druid', heroClass: 'druid', rarity: 'epic', faction: 'water',
    baseHp: 1350, baseAtk: 175, baseDef: 60, baseSpeed: 115, critChance: 0.15, critDamage: 1.8,
    skillName: 'Lightning Grove', skillDesc: 'Summons storm roots that shock all enemies',
    passiveName: 'Thunderbark', passiveDesc: 'Regenerates 2.5% max HP every 3s; storms hit all foes',
    color: '#38bdf8',
  },

  // ── LEGENDARY ──
  {
    id: 'sunpaladin', name: 'Sunforge Paladin', heroClass: 'knight', rarity: 'legendary', faction: 'light',
    baseHp: 2800, baseAtk: 240, baseDef: 112, baseSpeed: 94, critChance: 0.12, critDamage: 1.9,
    skillName: 'Aegis of Dawn', skillDesc: 'A blazing holy shield that guards all allies',
    passiveName: 'Radiant Bulwark', passiveDesc: 'When this hero falls below 25% HP, all allies heal 15%',
    color: '#fde047',
  },
  {
    id: 'eternalbow', name: 'Eternal Bowmaster', heroClass: 'archer', rarity: 'legendary', faction: 'void',
    baseHp: 1900, baseAtk: 420, baseDef: 55, baseSpeed: 162, critChance: 0.40, critDamage: 2.6,
    skillName: 'Eternity Arrow', skillDesc: 'An arrow that pierces the fabric of reality',
    passiveName: 'Time Lock', passiveDesc: '+20% ATK for each enemy eliminated',
    color: '#a78bfa',
  },
  {
    id: 'soulreaper', name: 'The Soulreaper', heroClass: 'assassin', rarity: 'legendary', faction: 'dark',
    baseHp: 2200, baseAtk: 460, baseDef: 78, baseSpeed: 165, critChance: 0.50, critDamage: 2.8,
    skillName: 'Soul Harvest', skillDesc: 'Rips the soul from every fallen foe',
    passiveName: 'Death\'s Hunger', passiveDesc: 'Restores 10% HP on each kill',
    color: '#7c3aed',
  },
  {
    id: 'divinehealer', name: 'Divine Healer', heroClass: 'shepherd', rarity: 'legendary', faction: 'light',
    baseHp: 2000, baseAtk: 200, baseDef: 70, baseSpeed: 118, critChance: 0.09, critDamage: 1.7,
    skillName: 'Divine Restoration', skillDesc: 'A wave of holy light that fully heals the lowest HP ally',
    passiveName: 'Lifebond', passiveDesc: 'Heals all allies for 12% of ATK each attack; self-regen too',
    color: '#fef3c7',
  },
  {
    id: 'worldtree', name: 'World Tree Druid', heroClass: 'druid', rarity: 'legendary', faction: 'nature',
    baseHp: 2600, baseAtk: 280, baseDef: 95, baseSpeed: 112, critChance: 0.18, critDamage: 1.9,
    skillName: 'World Tree Bloom', skillDesc: 'The World Tree roots shatter the battlefield',
    passiveName: 'Eternal Grove', passiveDesc: 'Regen 3% HP / 3s; heals lowest ally for 6% ATK on each regen tick',
    color: '#4ade80',
  },

  // ── MYTHIC ──
  {
    id: 'worldender', name: 'The Worldender', heroClass: 'knight', rarity: 'mythic', faction: 'void',
    baseHp: 3800, baseAtk: 520, baseDef: 140, baseSpeed: 128, critChance: 0.25, critDamage: 2.4,
    skillName: 'End of All Things', skillDesc: 'A blow that tears the world asunder',
    passiveName: 'Unstoppable', passiveDesc: 'Ignores all crowd control; +20% damage when solo',
    color: '#be185d',
  },
  {
    id: 'cosmosarcher', name: 'Cosmos Archer', heroClass: 'archer', rarity: 'mythic', faction: 'cosmic',
    baseHp: 3000, baseAtk: 640, baseDef: 80, baseSpeed: 175, critChance: 0.55, critDamage: 3.0,
    skillName: 'Cosmic Barrage', skillDesc: 'A shower of star-forged arrows',
    passiveName: 'Stellar Fury', passiveDesc: 'Every 4th arrow hits all enemies; crit chance +5% per kill',
    color: '#7c3aed',
  },
  {
    id: 'voidstalker', name: 'The Voidstalker', heroClass: 'assassin', rarity: 'mythic', faction: 'void',
    baseHp: 3200, baseAtk: 590, baseDef: 95, baseSpeed: 180, critChance: 0.60, critDamage: 3.2,
    skillName: 'Void Execution', skillDesc: 'Instantly kills enemies below 25% HP',
    passiveName: 'Shadow Veil', passiveDesc: '+25% dodge; crits restore 8% HP',
    color: '#4c1d95',
  },

  // ── RELIC ──
  {
    id: 'ancientknight', name: 'Ancient Guardian', heroClass: 'knight', rarity: 'relic', faction: 'nature',
    baseHp: 5500, baseAtk: 580, baseDef: 200, baseSpeed: 102, critChance: 0.14, critDamage: 2.2,
    skillName: 'Ancient Bastion', skillDesc: 'Erects an impenetrable stone barrier',
    passiveName: 'Relic Bond', passiveDesc: 'All equipped relic items deal +15% bonus stats',
    color: '#2dd4bf',
  },
  {
    id: 'relicdruid', name: 'Primordial Druid', heroClass: 'druid', rarity: 'relic', faction: 'nature',
    baseHp: 4800, baseAtk: 450, baseDef: 160, baseSpeed: 118, critChance: 0.20, critDamage: 2.1,
    skillName: 'Primordial Bloom', skillDesc: 'The earth itself heals your team',
    passiveName: 'Ancient Roots', passiveDesc: 'Regen 4% HP/3s; on low HP full team heals 20%',
    color: '#0d9488',
  },

  // ── CURSED ──
  {
    id: 'cursedknight', name: 'Cursed Revenant', heroClass: 'knight', rarity: 'cursed', faction: 'dark',
    baseHp: 6000, baseAtk: 720, baseDef: 110, baseSpeed: 132, critChance: 0.30, critDamage: 2.6,
    skillName: 'Cursed Rend', skillDesc: 'A curse-infused slash that weakens foes permanently',
    passiveName: 'Blood Price', passiveDesc: 'Each kill restores 15% HP but costs 2% HP per second',
    color: '#9f1239',
  },
  {
    id: 'cursedarcher', name: 'Hexed Sniper', heroClass: 'archer', rarity: 'cursed', faction: 'dark',
    baseHp: 4200, baseAtk: 800, baseDef: 65, baseSpeed: 168, critChance: 0.50, critDamage: 3.5,
    skillName: 'Doom Arrow', skillDesc: 'A cursed arrow that never misses',
    passiveName: 'Cursed Aim', passiveDesc: 'ATK +40%, but DEF -30%; crits trigger a life drain',
    color: '#7f1d1d',
  },

  // ── COSMIC ──
  {
    id: 'cosmicmage', name: 'Cosmic Sage', heroClass: 'shepherd', rarity: 'cosmic', faction: 'void',
    baseHp: 7000, baseAtk: 900, baseDef: 180, baseSpeed: 145, critChance: 0.35, critDamage: 2.8,
    skillName: 'Cosmic Convergence', skillDesc: 'Channels the universe into a single healing beam',
    passiveName: 'Star Weave', passiveDesc: 'Heals 20% of ATK to all allies per attack; star aura protects all',
    color: '#7c3aed',
  },

  // ── DIVINE ──
  {
    id: 'divine', name: 'The Divinity', heroClass: 'shepherd', rarity: 'divine', faction: 'light',
    baseHp: 12000, baseAtk: 1200, baseDef: 350, baseSpeed: 160, critChance: 0.40, critDamage: 3.0,
    skillName: 'Judgment of Heaven', skillDesc: 'A pillar of divine light smites all enemies',
    passiveName: 'Godform', passiveDesc: 'Cannot be killed while any ally is alive; heals 25% ATK to all per attack',
    color: '#fbbf24',
  },
];

const CANONICAL_RARITIES: Exclude<Rarity, 'relic' | 'cursed'>[] = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'cosmic', 'divine', 'celestial',
];
const RARITY_SCALE = [1, 1.5, 2.2, 3.2, 4.6, 6.5, 9, 13, 18];
const HERO_ARCHETYPES: Omit<HeroBase, 'id' | 'name' | 'rarity'>[] = [
  { heroClass: 'shepherd', faction: 'water', baseHp: 360, baseAtk: 72, baseDef: 14, baseSpeed: 108, critChance: .12, critDamage: 1.8, skillName: 'Mana Burst', skillDesc: 'Detonates gathered runes around the target', passiveName: 'Arcane Overflow', passiveDesc: 'Every fifth attack releases a second spell', color: '#3b82f6' },
  { heroClass: 'assassin', faction: 'dark', baseHp: 320, baseAtk: 82, baseDef: 12, baseSpeed: 128, critChance: .22, critDamage: 2, skillName: 'Backstab', skillDesc: 'A precise strike from the shadows', passiveName: 'Critical Rhythm', passiveDesc: 'Critical hits briefly increase attack speed', color: '#14b8a6' },
  { heroClass: 'knight', faction: 'fire', baseHp: 520, baseAtk: 55, baseDef: 28, baseSpeed: 92, critChance: .08, critDamage: 1.6, skillName: 'Shield Breaker', skillDesc: 'A crushing sword and shield combination', passiveName: 'Bulwark', passiveDesc: 'Reduces damage while below half health', color: '#ef4444' },
  { heroClass: 'druid', faction: 'nature', baseHp: 430, baseAtk: 62, baseDef: 20, baseSpeed: 102, critChance: .1, critDamage: 1.7, skillName: 'Living Roots', skillDesc: 'Roots the enemy and restores health', passiveName: 'Wild Growth', passiveDesc: 'Regenerates health during sustained combat', color: '#84cc16' },
  { heroClass: 'archer', faction: 'light', baseHp: 350, baseAtk: 68, baseDef: 15, baseSpeed: 122, critChance: .16, critDamage: 1.85, skillName: 'Rapid Bolts', skillDesc: 'Fires a fast mechanical crossbow volley', passiveName: 'Tempo', passiveDesc: 'Consecutive attacks become faster', color: '#f59e0b' },
];
const CANONICAL_CLASS_NAME: Record<HeroClass, string> = {
  shepherd: 'Mage', assassin: 'Assassin', knight: 'Warrior', druid: 'Druid', archer: 'Crossbowman',
};

export const HEROES: HeroBase[] = HERO_ARCHETYPES.flatMap((hero) =>
  CANONICAL_RARITIES.map((rarity, tier) => {
    const scale = RARITY_SCALE[tier];
    const className = CANONICAL_CLASS_NAME[hero.heroClass];
    return {
      ...hero,
      id: `${hero.heroClass}-${rarity}`,
      name: tier === 0 ? className : `${RARITY_LABEL[rarity]} ${className}`,
      rarity,
      baseHp: Math.round(hero.baseHp * scale),
      baseAtk: Math.round(hero.baseAtk * scale),
      baseDef: Math.round(hero.baseDef * scale),
      baseSpeed: Math.round(hero.baseSpeed * (1 + tier * .025)),
    };
  })
);

void LEGACY_HEROES;

export const HERO_MAP: Record<string, HeroBase> = Object.fromEntries(
  [...LEGACY_HEROES, ...HEROES].map((h) => [h.id, h])
);

export function canonicalHeroId(heroId: string): string {
  const hero = HERO_MAP[heroId];
  if (!hero || HEROES.some((candidate) => candidate.id === heroId)) return heroId;
  const rarity = hero.rarity === 'relic' || hero.rarity === 'cursed' ? 'mythic' : hero.rarity;
  return `${hero.heroClass}-${rarity}`;
}
