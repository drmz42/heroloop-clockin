import { versionedAsset } from './assetVersion';

const ENEMY_ART: Record<string, string> = {
  goblin: '/assets/enemies/v4/goblin.png', skeleton: '/assets/enemies/v4/skeleton.png',
  bat: '/assets/enemies/v4/bat.png', slime: '/assets/enemies/v4/slime.png',
  wolf: '/assets/enemies/v4/wolf.png', ghost: '/assets/enemies/v4/ghost.png',
  spider: '/assets/enemies/v4/spider.png', orc: '/assets/enemies/v4/orc.png',
  'boss-ogre': '/assets/enemies/v4/boss-ogre.png', 'boss-lich': '/assets/enemies/v4/boss-lich.png',
  'boss-dragon': '/assets/enemies/v4/boss-dragon.png', 'boss-titan': '/assets/enemies/v4/boss-titan.png',
};

const ITEM_ATLAS_IDS = [
  'w-rusty','w-shortbow','w-oakstaff','w-steel','w-elvenbow','w-arcane','w-shadow','w-blazing',
  'w-starcall','w-voidstaff','w-soulblade','w-worldbreak','w-relicblade','w-cursed','w-cosmic','w-divine',
  'h-leather','h-iron','h-magehood','h-shadowcowl','h-dragonscale','h-voidtiara','h-relichelm','h-divinecrown',
  'a-cloth','a-chain','a-ember','a-voidshroud','a-celestial','a-relicplate','a-divine','g-thin',
  'g-iron','g-shadowclaws','g-storm','g-divine','b-worn','b-wind','b-shadowstep','b-void',
  'b-divine','r-copper','r-gold','r-emerald','r-voidseal','r-signet','r-cosmos','r-divine',
  'am-tooth','am-jade','am-eye','am-soulstone','am-worldheart','am-divine',
  'potion-xs','potion-sm','potion-md','potion-lg','potion-xl','potion-xxl',
];

const ITEM_ATLAS_INDEX = new Map(ITEM_ATLAS_IDS.map((id, index) => [id, index]));
const PRODUCT_RARITIES = '(common|uncommon|rare|epic|legendary|mythic|cosmic|divine|celestial|cursed|immortal|god)';
const OFFHAND_ART: Record<string, string> = {
  mage: 'spellbook', assassin: 'throwing-set', warrior: 'shield', druid: 'totem', crossbowman: 'quiver',
};

function productItemPath(itemId: string): string | null {
  let match = itemId.match(new RegExp(`^weapon-(mage|assassin|warrior|druid|crossbowman)-${PRODUCT_RARITIES}$`));
  if (match) return `/assets/items/v4/${match[1]}-${match[2]}.png`;
  match = itemId.match(new RegExp(`^offhand-(mage|assassin|warrior|druid|crossbowman)-${PRODUCT_RARITIES}$`));
  if (match) return `/assets/items/v4/${OFFHAND_ART[match[1]]}-${match[2]}.png`;
  match = itemId.match(new RegExp(`^(helmet|armor|gloves|boots|ring|amulet)-${PRODUCT_RARITIES}$`));
  return match ? `/assets/items/v4/${match[1]}-${match[2]}.png` : null;
}

const ENDGAME_ROLE_ART: Record<NonNullable<import('./types').CombatUnit['role']>, string> = {
  tank: ENEMY_ART['boss-titan'], striker: ENEMY_ART.orc, skirmisher: ENEMY_ART.bat,
  support: ENEMY_ART.ghost, caster: ENEMY_ART['boss-lich'],
};

export function enemyArtSrc(unitUid: string, role?: import('./types').CombatUnit['role']): string | null {
  const id = unitUid.replace(/^e\d+-/, '');
  const bossBase = id.match(/^(boss-(?:ogre|lich|dragon|titan))/)?.[1];
  return ENEMY_ART[id] ?? (bossBase ? ENEMY_ART[bossBase] : null) ?? (id.startsWith('endgame-') && role ? ENDGAME_ROLE_ART[role] : null) ?? null;
}

export function itemArtSrc(itemId: string): string | null {
  const productPath = productItemPath(itemId);
  if (productPath) return versionedAsset(productPath);
  return ITEM_ATLAS_INDEX.has(itemId) ? '/assets/items/item-atlas-v2.webp' : null;
}

export function itemArtStyle(itemId: string): Record<string, string> | null {
  if (productItemPath(itemId)) return { inset: '0', width: '100%', height: '100%', objectFit: 'contain' };
  const index = ITEM_ATLAS_INDEX.get(itemId);
  if (index === undefined) return null;
  const col = index % 8;
  const row = Math.floor(index / 8);
  return {
    width: '966.154%',
    height: '966.154%',
    maxWidth: 'none',
    left: `${-((13 + col * 149) / 130) * 100}%`,
    top: `${-((13 + row * 149) / 130) * 100}%`,
  };
}

// Full-body battle figures on transparent backgrounds (2.5D, heroes face right, enemies face left).
const ENEMY_FIGURES = new Set(['goblin', 'skeleton', 'bat', 'slime', 'wolf', 'ghost', 'spider', 'orc', 'boss-ogre', 'boss-lich', 'boss-dragon', 'boss-titan']);
const ENDGAME_ROLE_FIGURE: Record<NonNullable<import('./types').CombatUnit['role']>, string> = {
  tank: 'boss-titan', striker: 'orc', skirmisher: 'bat', support: 'ghost', caster: 'boss-lich',
};

export function heroFigureSrc(heroClass: import('./types').HeroClass): string {
  return versionedAsset(`/assets/figures/${heroClass}.webp`);
}

export function enemyFigureSrc(unitUid: string, role?: import('./types').CombatUnit['role']): string | null {
  const id = unitUid.replace(/^e\d+-/, '');
  const base = ENEMY_FIGURES.has(id) ? id : id.match(/^(boss-(?:ogre|lich|dragon|titan))/)?.[1] ?? (id.startsWith('endgame-') && role ? ENDGAME_ROLE_FIGURE[role] : null);
  return base ? versionedAsset(`/assets/figures/${base}.webp`) : null;
}
