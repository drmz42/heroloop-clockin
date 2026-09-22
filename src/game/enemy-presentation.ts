import type { EnemyRank } from './types';

type SpriteCell = 'nw' | 'ne' | 'sw' | 'se';

export interface EnemyPresentation {
  id: string;
  name: string;
  family: string;
  rank: EnemyRank;
  attackProfile: string;
  color: string;
  sprite: { sheet: string; cell: SpriteCell };
}

const families = [
  ['raiders', 'Raiders', 'raiders-v1.webp', '#a86b45', ['dock-goblin', 'Dock Goblin', 'hook-swing'], ['scrap-slinger', 'Scrap Slinger', 'ranged-volley'], ['mire-hexer', 'Mire Hexer', 'pulse-burst'], ['grizzlehook-dock-tyrant', 'Grizzlehook, Dock Tyrant', 'guard-bash']],
  ['undead', 'Undead', 'undead-v1.webp', '#91a9c9', ['bone-guard', 'Bone Guard', 'guard-bash'], ['wraith', 'Wraith', 'rift-blink'], ['gravecaller', 'Gravecaller', 'pulse-burst'], ['morvane-bell-of-graves', 'Morvane, Bell of Graves', 'soul-toll']],
  ['beasts', 'Beasts', 'beasts-v1.webp', '#8496a2', ['cave-bat', 'Cave Bat', 'pounce'], ['dire-wolf', 'Dire Wolf', 'pounce'], ['giant-spider', 'Giant Spider', 'web-spit'], ['fenrakk-moonfang-alpha', 'Fenrakk, Moonfang Alpha', 'moon-pounce']],
  ['oozes', 'Oozes', 'oozes-v1.webp', '#80b56d', ['toxic-slime', 'Toxic Slime', 'pulse-burst'], ['ember-ooze', 'Ember Ooze', 'ember-spit'], ['astral-ooze', 'Astral Ooze', 'star-pulse'], ['ochre-maw-endless', 'Ochre Maw, the Endless', 'maw-surge']],
  ['warclans', 'Warclans', 'warclans-v1.webp', '#b76b51', ['orc-brute', 'Orc Brute', 'guard-bash'], ['ash-berserker', 'Ash Berserker', 'cleave'], ['frost-troll', 'Frost Troll', 'frost-smash'], ['kharzug-ash-crowned', 'Kharzug, the Ash-Crowned', 'crown-cleave']],
  ['constructs', 'Constructs', 'constructs-v1.webp', '#a98c59', ['rune-golem', 'Rune Golem', 'rune-pulse'], ['bastion-sentinel', 'Bastion Sentinel', 'guard-bash'], ['crucible-colossus', 'Crucible Colossus', 'forge-slam'], ['axiom-9-last-sentinel', 'Axiom-9, Last Sentinel', 'axiom-beam']],
  ['voidborn', 'Voidborn', 'voidborn-v1.webp', '#8c72bd', ['rift-crawler', 'Rift Crawler', 'rift-blink'], ['nullborn', 'Nullborn', 'null-pulse'], ['void-reaper', 'Void Reaper', 'void-cleave'], ['nhal-eater-between-stars', 'Nhal, Eater Between Stars', 'star-rift']],
  ['fallen', 'The Fallen', 'fallen-v1.webp', '#c29476', ['starbound-knight', 'Starbound Knight', 'star-cleave'], ['fallen-seraph', 'Fallen Seraph', 'wing-burst'], ['godshard-horror', 'Godshard Horror', 'shard-pulse'], ['seraphel-fallen-dawn', 'Seraphel, the Fallen Dawn', 'dawn-lance']],
] as const;

const cells: SpriteCell[] = ['nw', 'ne', 'sw', 'se'];
const presentations = new Map<string, EnemyPresentation>();
for (const [, family, sheet, color, ...enemies] of families) {
  enemies.forEach(([id, name, attackProfile], index) => presentations.set(id, {
    id, name, family, attackProfile, color,
    rank: index === 3 ? 'epic' : 'normal',
    sprite: { sheet: `/assets/enemies/catalog/${sheet}`, cell: cells[index] },
  }));
}

const rosters = [
  [['dock-goblin', 'scrap-slinger', 'toxic-slime'], 'grizzlehook-dock-tyrant'],
  [['dire-wolf', 'giant-spider', 'mire-hexer'], 'fenrakk-moonfang-alpha'],
  [['cave-bat', 'wraith', 'bone-guard'], 'morvane-bell-of-graves'],
  [['toxic-slime', 'giant-spider', 'gravecaller'], 'ochre-maw-endless'],
  [['frost-troll', 'dire-wolf', 'wraith'], 'fenrakk-moonfang-alpha'],
  [['ember-ooze', 'ash-berserker', 'orc-brute'], 'kharzug-ash-crowned'],
  [['rune-golem', 'astral-ooze', 'bone-guard'], 'axiom-9-last-sentinel'],
  [['gravecaller', 'orc-brute', 'bastion-sentinel'], 'axiom-9-last-sentinel'],
  [['rift-crawler', 'nullborn', 'void-reaper'], 'nhal-eater-between-stars'],
  [['nullborn', 'void-reaper', 'astral-ooze'], 'nhal-eater-between-stars'],
  [['bastion-sentinel', 'starbound-knight', 'wraith'], 'axiom-9-last-sentinel'],
  [['rift-crawler', 'astral-ooze', 'starbound-knight'], 'nhal-eater-between-stars'],
  [['ash-berserker', 'ember-ooze', 'crucible-colossus'], 'kharzug-ash-crowned'],
  [['mire-hexer', 'giant-spider', 'fallen-seraph'], 'seraphel-fallen-dawn'],
  [['gravecaller', 'bone-guard', 'wraith'], 'morvane-bell-of-graves'],
  [['bastion-sentinel', 'rune-golem', 'crucible-colossus'], 'axiom-9-last-sentinel'],
  [['void-reaper', 'ash-berserker', 'godshard-horror'], 'kharzug-ash-crowned'],
  [['starbound-knight', 'crucible-colossus', 'fallen-seraph'], 'seraphel-fallen-dawn'],
  [['fallen-seraph', 'starbound-knight', 'rift-crawler'], 'seraphel-fallen-dawn'],
  [['godshard-horror', 'void-reaper', 'fallen-seraph'], 'seraphel-fallen-dawn'],
] as const;

function previewRank(seed: number, lane: number): EnemyRank {
  const roll = Math.abs(seed + lane * 29) % 100;
  return roll < 8 ? 'elite' : roll < 28 ? 'veteran' : 'normal';
}

/** Staging2-only identity skin. It never changes the server-issued unit values or outcomes. */
export function staging2EnemyPresentation(locationId: number, lane: number, seed: number, unitUid: string): EnemyPresentation | null {
  if (import.meta.env.MODE !== 'staging2' || !Number.isInteger(locationId) || locationId < 1 || locationId > rosters.length) return null;
  if (unitUid.includes('boss-') || unitUid.includes('dungeon-')) return null;
  const [baseIds, epicId] = rosters[locationId - 1];
  const id = Math.abs(seed + lane * 17) % 13 === 0 ? epicId : baseIds[lane % baseIds.length];
  const presentation = presentations.get(id);
  return presentation ? { ...presentation, rank: presentation.rank === 'epic' ? 'epic' : previewRank(seed, lane) } : null;
}

export function catalogEnemyArt(id?: string): { src: string; cell: SpriteCell } | null {
  const presentation = id ? presentations.get(id) : undefined;
  return presentation ? { src: presentation.sprite.sheet, cell: presentation.sprite.cell } : null;
}
