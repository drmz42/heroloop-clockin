import { itemArtSrc } from './art';
import { assetVersions, versionedAsset } from './assetVersion';
import type { GameState } from './types';

// Hackathon builds warm the browser cache before a screen needs its art. URLs carry the
// content fingerprint, so an image already cached from an earlier build is never fetched again.
const CONCURRENCY = 2;
const queued = new Set<string>();
const pending: string[] = [];
let active = 0;

type NetworkInformation = { saveData?: boolean; type?: string };
const connection = (): NetworkInformation | undefined => (navigator as Navigator & { connection?: NetworkInformation }).connection;

function whenIdle(task: () => void) {
  if ('requestIdleCallback' in window) window.requestIdleCallback(task, { timeout: 2000 });
  else setTimeout(task, 200);
}

function pump() {
  while (active < CONCURRENCY && pending.length > 0) {
    const url = pending.shift()!;
    active += 1;
    const image = new Image();
    image.decoding = 'async';
    image.onload = image.onerror = () => {
      active -= 1;
      whenIdle(pump);
    };
    image.src = url;
  }
}

function enqueue(paths: Iterable<string>) {
  if (!assetVersions || connection()?.saveData) return;
  for (const path of paths) {
    const base = path.split('?')[0];
    if (!assetVersions[base] || queued.has(base)) continue;
    queued.add(base);
    pending.push(versionedAsset(base));
  }
  whenIdle(pump);
}

const allPaths = () => Object.keys(assetVersions ?? {});
const under = (...prefixes: string[]) => allPaths().filter((path) => prefixes.some((prefix) => path.startsWith(prefix)));

// All current avatars share five small class portraits. Start these before the idle
// queue, so Ranks does not wait behind locations, enemies, screen art and inventory.
function preloadAvatarImages() {
  if (!assetVersions || connection()?.saveData) return;
  for (const path of under('/assets/heroes/v5/thumb/')) {
    if (queued.has(path)) continue;
    queued.add(path);
    const image = new Image();
    image.decoding = 'async';
    image.fetchPriority = 'high';
    image.src = versionedAsset(path);
  }
}

/** Stage 1, on the entry screen: art the first game screen shows. */
export function preloadEntryImages() {
  preloadAvatarImages();
  enqueue(under('/assets/locations/', '/assets/enemies/v4/', '/assets/ui/', '/assets/brand/'));
}

/** Stages 2 and 3, once the game is shown: the player's own art, then everything else on unmetered networks. */
export function preloadGameImages(state: Pick<GameState, 'ownedHeroes' | 'inventory'>) {
  preloadAvatarImages();
  const heroes = state.ownedHeroes.flatMap((hero) => {
    const heroClass = /^(shepherd|assassin|knight|druid|archer)-/.exec(hero.heroId)?.[1];
    return heroClass ? [`/assets/heroes/v5/thumb/${heroClass}.webp`, `/assets/heroes/v5/${heroClass}.webp`] : [];
  });
  const items = state.inventory.map((item) => itemArtSrc(item.itemId)).filter((path): path is string => Boolean(path));
  enqueue([...under('/assets/screens/'), ...heroes, ...items, ...under('/assets/heroes/', '/assets/summon/').filter((path) => !path.includes('/v4/') && !path.includes('/v6/'))]);
  const type = connection()?.type;
  // Retired v4 and not-yet-active v6 hero art are never shown, so they are not downloaded.
  if (type === undefined || type === 'wifi' || type === 'ethernet') enqueue(allPaths().filter((path) => !path.startsWith('/assets/heroes/v4/') && !path.startsWith('/assets/heroes/v6/')));
}
