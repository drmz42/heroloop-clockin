import { defineConfig, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { makeQaGameState } from './qa/gameState';
import { compressBuildImages, readAssetVersions, versionAssetUrls, UNREFERENCED_SOURCE_IMAGES } from './scripts/compress-build-images.mjs';

function qaEndpoint() {
  return {
    name: 'heroloop-local-qa',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: (handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/__qa/state') return next();

        const remoteAddress = req.socket.remoteAddress ?? '';
        const isLoopback = remoteAddress === '::1'
          || remoteAddress.startsWith('127.')
          || remoteAddress.startsWith('::ffff:127.');
        const secret = process.env.HEROLOOP_QA_SECRET ?? '';
        const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
        const secretBytes = Buffer.from(secret);
        const suppliedBytes = Buffer.from(supplied);
        const qaIsIsolated = process.env.VITE_ENABLE_TOKENOMICS === 'false';
        const authorized = qaIsIsolated
          && isLoopback
          && secretBytes.length >= 32
          && secretBytes.length === suppliedBytes.length
          && timingSafeEqual(secretBytes, suppliedBytes);

        if (!authorized) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        res.statusCode = 200;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(makeQaGameState()));
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const hackathon = ['staging2', 'seeker'].includes(mode);
  let buildOutputDir = fileURLToPath(new URL('./dist', import.meta.url));
  const assetVersions = hackathon
    ? readAssetVersions(fileURLToPath(new URL('./public', import.meta.url)), { exclude: UNREFERENCED_SOURCE_IMAGES })
    : null;
  return {
  define: { __HL_ASSET_VERSIONS__: JSON.stringify(assetVersions) },
  envDir: process.env.HEROLOOP_SKIP_ENV_FILES === 'true' ? '/tmp/heroloop-no-env-files' : undefined,
  plugins: [
    ...(['staging2', 'seeker'].includes(mode) ? [{
      name: 'heroloop-skr-presentation',
      enforce: 'pre' as const,
      transformIndexHtml(html: string) { return html.replace(/\$HERO\b/gi, '$SKR'); },
      transform(code: string, id: string) {
        if (!/\/(?:src|test\/landing4)\/.*\.[jt]sx?(?:\?|$)/.test(id)) return null;
        // Currency copy/assets only. Never rename saved fields or API actions.
        // Legacy currency amounts are not SKR quotes. Native SKR copy stays intact.
        const presentation = code.replace(/\$\{[^{}]*\}\s+\$HERO\b/gi, 'Price unavailable');
        const marketCopy = id.includes('/screens/MarketplaceScreen.')
          ? presentation.replaceAll('{row.price}', "{'—'}").replaceAll('formatNum(game.state.hero)', "'—'") : presentation;
        return { code: marketCopy.replace(/\$HERO\b/gi, '$SKR')
          .replaceAll('HERO...p7Xq9M', 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3')
          .replaceAll('$SKR rewards are currently simulated', 'SKR rewards are not available yet')
          .replaceAll('Earn $SKR by winning battles in locations.', 'SKR rewards are not available yet.')
          .replaceAll('Unlock Earn Mode with a Founder Pack', 'Built for Solana Seeker')
          .replaceAll('Unlock Earn Mode with a paid pack.', 'SKR rewards are not available yet.')
          .replaceAll('Earn Mode Unlocked', 'SKR rewards unavailable')
          .replaceAll('+2% Ordinary Earn Weight', 'SKR reward bonuses unavailable')
          .replaceAll('+5% Ordinary Earn Weight', 'SKR reward bonuses unavailable')
          .replaceAll('Price is {usd(rCost)} · {formatNum(rCost)} $SKR and caps at 5×.', 'SKR reroll pricing is not available yet.'), map: null };
      },
    }] : []),
    ...(assetVersions ? [{
      // Every literal image URL gets its content fingerprint, so a changed image is downloaded once
      // and an unchanged one is served from the phone cache. Dynamic paths use versionedAsset().
      name: 'heroloop-hackathon-asset-versions',
      enforce: 'pre' as const,
      apply: 'build' as const,
      transformIndexHtml(html: string) { return versionAssetUrls(html, assetVersions); },
      transform(code: string, id: string) {
        if (!/\/(?:src|test\/landing4)\/.*\.(?:[jt]sx?|css)(?:\?|$)/.test(id)) return null;
        const versioned = versionAssetUrls(code, assetVersions);
        return versioned === code ? null : { code: versioned, map: null };
      },
    }] : []),
    ...(hackathon ? [{
      // Hackathon builds ship recompressed images; public/assets keeps the web originals.
      name: 'heroloop-hackathon-image-compress',
      apply: 'build' as const,
      configResolved(config: ResolvedConfig) {
        buildOutputDir = resolve(config.root, config.build.outDir);
      },
      async closeBundle() {
        const result = await compressBuildImages(buildOutputDir, {
          unreferenced: UNREFERENCED_SOURCE_IMAGES,
        });
        console.log(`hackathon images: ${result.before} -> ${result.after} bytes, removed ${result.removedBytes} unreferenced bytes`);
      },
    }] : []),
    react(), qaEndpoint(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    allowedHosts: ['.serveousercontent.com'],
  },
  preview: {
    allowedHosts: ['a240afbe538feb86-45-66-228-118.serveousercontent.com'],
  },
};
});
