// Recompresses images inside a finished build directory. The hackathon
// (staging2/seeker) build runs it on dist only; public/assets keeps the
// original art for the web version. File names and formats never change,
// so every code and CSS reference stays valid.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import sharp from 'sharp';

const MAX_SIDE = 2048;
const encoders = {
  '.png': (image) => image.png({ palette: true, quality: 90, effort: 7, dither: 0.8, compressionLevel: 9 }),
  '.webp': (image) => image.webp({ quality: 86, alphaQuality: 90, effort: 5, smartSubsample: true }),
  '.jpg': (image) => image.jpeg({ quality: 84, mozjpeg: true }),
  '.jpeg': (image) => image.jpeg({ quality: 84, mozjpeg: true }),
};

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

export async function compressBuildImages(outDir, { unreferenced = [] } = {}) {
  sharp.concurrency(1);
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
    const meta = await sharp(input).metadata();
    if ((meta.pages ?? 1) > 1) { after += input.length; continue; }
    let image = sharp(input);
    if (Math.max(meta.width, meta.height) > MAX_SIDE) {
      image = image.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    }
    const output = await encode(image).toBuffer();
    if (output.length < input.length * 0.95) {
      writeFileSync(path, output);
      after += output.length;
    } else {
      after += input.length;
    }
  }
  return { before, after, removedBytes, outDir: relative(process.cwd(), outDir) || '.' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await compressBuildImages(process.argv[2] ?? 'dist');
  console.log(JSON.stringify(result));
}
