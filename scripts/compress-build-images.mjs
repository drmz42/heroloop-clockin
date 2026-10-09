// Recompresses images inside a finished build directory. The hackathon
// (staging2/seeker) build runs it on dist only; public/assets keeps the
// original art for the web version. File names and formats never change,
// so every code and CSS reference stays valid.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import sharp from 'sharp';

const MAX_SIDE = 2048;
// Source sheets stay in public/assets; packaged builds omit these unused originals.
// Keep build inputs independent of internal QA and backup inventories.
export const UNREFERENCED_SOURCE_IMAGES = [
  'public/assets/enemies/cave-bat-v2.png',
  'public/assets/enemies/skeleton-v2.png',
  'public/assets/enemies/toxic-slime-v2.png',
  'public/assets/enemies/v4/source-grid.png',
  'public/assets/heroes/v4/source-lineup.png',
  'public/assets/items/item-atlas-v3.png',
  'public/assets/items/rusty-blade-v2.png',
  'public/assets/items/v4/source-grid.png',
];
const encoderSettings = {
  '.png': { palette: true, quality: 90, effort: 7, dither: 0.8, compressionLevel: 9 },
  '.webp': { quality: 86, alphaQuality: 90, effort: 5, smartSubsample: true },
  '.jpg': { quality: 84, mozjpeg: true },
  '.jpeg': { quality: 84, mozjpeg: true },
};
const encoders = Object.fromEntries(Object.entries(encoderSettings).map(([extension, settings]) =>
  [extension, (image) => image[extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1)](settings)]));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Cache is optional, reproducible public output. Read/write failures always
// take the normal encoder path. The envelope commits both key and payload.
function cachedImage(cacheDir, key) {
  try {
    if (!lstatSync(cacheDir).isDirectory()) return null;
    const path = join(cacheDir, `${key}.json`);
    if (!lstatSync(path).isFile()) return null;
    const entry = JSON.parse(readFileSync(path, 'utf8'));
    const output = Buffer.from(entry.output, 'base64');
    return entry.key === key && output.length > 0 && sha256(output) === entry.sha256 ? output : null;
  } catch { return null; }
}

function cacheImage(cacheDir, key, output) {
  let temp;
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    if (!lstatSync(cacheDir).isDirectory()) return;
    temp = join(cacheDir, `.${key}.${process.pid}.${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify({ key, sha256: sha256(output), output: output.toString('base64') }), { flag: 'wx', mode: 0o600 });
    renameSync(temp, join(cacheDir, `${key}.json`));
  } catch { /* Cache loss must not block a release. */ }
  finally { if (temp) { try { unlinkSync(temp); } catch { /* Already renamed or absent. */ } } }
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

// Drops source sheets that no built JS, CSS or HTML file names.
function removeUnreferenced(outDir, files, candidates) {
  const text = files.filter((path) => /\.(?:js|css|html|json|webmanifest)$/.test(path))
    .map((path) => readFileSync(path, 'utf8')).join('\n');
  let removed = 0;
  for (const candidate of candidates) {
    const path = join(outDir, candidate.replace(/^public\//, ''));
    if (!files.includes(path) || text.includes(basename(path))) continue;
    removed += statSync(path).size;
    unlinkSync(path);
  }
  return removed;
}

const IMAGE_PATH = /\/assets\/[A-Za-z0-9_./-]+?\.(?:png|webp|jpe?g|gif|avif)(?:\?v=[A-Za-z0-9_.-]+)?/g;

// Content fingerprint per public image, keyed by its URL path. A changed image gets a new
// ?v= so phones download it once; an unchanged one keeps its URL and stays in the cache.
export function readAssetVersions(publicDir, { exclude = [] } = {}) {
  const skip = new Set(exclude.map((path) => path.replace(/^public/, '')));
  const versions = {};
  for (const path of walk(join(publicDir, 'assets'))) {
    if (!encoders[extname(path).toLowerCase()]) continue;
    const url = `/${relative(publicDir, path).split('\\').join('/')}`;
    if (skip.has(url)) continue;
    versions[url] = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 10);
  }
  return versions;
}

export function versionAssetUrls(code, versions) {
  return code.replace(IMAGE_PATH, (match) => {
    const base = match.split('?')[0];
    return versions[base] ? `${base}?v=${versions[base]}` : match;
  });
}

export async function compressBuildImages(outDir, {
  unreferenced = [], cacheDir = process.env.HEROLOOP_IMAGE_CACHE,
} = {}) {
  sharp.concurrency(2);
  const started = performance.now();
  let cacheHits = 0;
  let cacheMisses = 0;
  const files = walk(outDir);
  const removedBytes = removeUnreferenced(outDir, files, unreferenced);
  let before = 0;
  let after = 0;
  for (const path of files) {
    const encode = encoders[extname(path).toLowerCase()];
    if (!encode) continue;
    let input;
    try { input = readFileSync(path); } catch { continue; }
    before += input.length;
    const extension = extname(path).toLowerCase();
    const key = sha256(JSON.stringify({ version: 1, input: sha256(input), extension,
      settings: encoderSettings[extension], maxSide: MAX_SIDE, versions: sharp.versions,
      concurrency: 2, minimumSaving: 0.05 }));
    const cached = cacheDir ? cachedImage(cacheDir, key) : null;
    if (cached) {
      writeFileSync(path, cached);
      after += cached.length;
      cacheHits += 1;
      continue;
    }
    cacheMisses += 1;
    const meta = await sharp(input).metadata();
    if ((meta.pages ?? 1) > 1) { after += input.length; continue; }
    let image = sharp(input);
    if (Math.max(meta.width, meta.height) > MAX_SIDE) {
      image = image.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    }
    const output = await encode(image).toBuffer();
    const selected = output.length < input.length * 0.95 ? output : input;
    if (selected !== input) writeFileSync(path, selected);
    after += selected.length;
    if (cacheDir) cacheImage(cacheDir, key, selected);
  }
  return { before, after, removedBytes, cacheHits, cacheMisses, elapsedMs: Math.round(performance.now() - started), outDir: relative(process.cwd(), outDir) || '.' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await compressBuildImages(process.argv[2] ?? 'dist');
  console.log(JSON.stringify(result));
}
