import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is relative so the built site works from GitHub Pages (/living-stills/) or any sub-path.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: { environment: 'node', testTimeout: 60000 },
});
