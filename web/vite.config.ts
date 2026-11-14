import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// The exporter (tools/export_web.py) writes everything ROM-derived to
// ../build/web, which is gitignored. Serving it as the public dir keeps
// `/course.json`, `/sprites.png`, ... working in dev and in `vite build`.
export default defineConfig({
  publicDir: resolve(here, '../build/web'),
  server: { host: '127.0.0.1', port: 5173 },
  build: { chunkSizeWarningLimit: 2000 },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
