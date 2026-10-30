import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server carries the Luminal relay at /luminal (Luminal does not allow calls from a page).
function luminalRelay(): Plugin {
  return {
    name: 'luminal-relay',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/luminal/')) return next();
        try {
          // @ts-expect-error plain JS module shared with the published relay
          const { nodeRelay } = await import('./scripts/serve.mjs');
          await nodeRelay(req, res, '/luminal');
        } catch (err) {
          res.statusCode = 502;
          res.end(String(err));
        }
      });
    },
  };
}

// `base` is relative so the built site works from GitHub Pages (/living-stills/) or any sub-path.
export default defineConfig({
  base: './',
  plugins: [react(), luminalRelay()],
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: { environment: 'node', testTimeout: 60000 },
});
