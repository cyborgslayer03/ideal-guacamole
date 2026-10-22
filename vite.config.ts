import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 1200 },
  // `npm run hub` serves the Multiverse Hub API on 8787; the dev server forwards /api to it.
  server: { proxy: { '/api': 'http://localhost:8787' } },
  test: { environment: 'node' },
});
