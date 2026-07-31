const ENEMY_ART: Record<string, string> = {
  skeleton: '/assets/enemies/skeleton-v2.png',
  bat: '/assets/enemies/cave-bat-v2.png',
  slime: '/assets/enemies/toxic-slime-v2.png',
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

export function enemyArtSrc(unitUid: string): string | null {
  const id = unitUid.replace(/^e\d+-/, '');
  return ENEMY_ART[id] ?? null;
}

export function itemArtSrc(itemId: string): string | null {
  return ITEM_ATLAS_INDEX.has(itemId) ? '/assets/items/item-atlas-v2.png' : null;
}

export function itemArtStyle(itemId: string): Record<string, string> | null {
  const index = ITEM_ATLAS_INDEX.get(itemId);
  if (index === undefined) return null;
  const col = index % 8;
  const row = Math.floor(index / 8);
  return {
    width: '897.143%',
    height: '897.143%',
    maxWidth: 'none',
    left: `${-((8 + col * 149) / 140) * 100}%`,
    top: `${-((8 + row * 149) / 140) * 100}%`,
  };
}
