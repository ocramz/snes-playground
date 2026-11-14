import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Everything ROM-derived is generated into ../build/engine by the Makefile
// (rules/tables.json, assets/, rom-test/ fixtures) and is gitignored.
// Serving ../build/engine as the public dir keeps `/rules/tables.json`,
// `/assets/sprites.png`, ... working in dev and in `vite build`.
export default defineConfig({
  publicDir: resolve(here, '../build/engine'),
  server: { host: '127.0.0.1', port: 5174 },
  build: {
    chunkSizeWarningLimit: 2000,
    rolldownOptions: { input: { main: resolve(here, 'index.html') } },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
