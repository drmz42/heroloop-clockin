import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { makeQaGameState } from './qa/gameState';

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
export default defineConfig({
  envDir: process.env.HEROLOOP_SKIP_ENV_FILES === 'true' ? '/tmp/heroloop-no-env-files' : undefined,
  plugins: [react(), qaEndpoint()],
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
});
