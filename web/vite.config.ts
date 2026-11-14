import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// Cross-origin isolation lets onnxruntime-web's WASM backend use threads
// (SharedArrayBuffer) for the hand model of hands.html. Everything both pages
// load is same-origin, so it costs the keyboard page nothing.
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

// The exporter (tools/export_web.py) writes everything ROM-derived to
// ../build/web, which is gitignored. Serving it as the public dir keeps
// `/course.json`, `/sprites.png`, ... working in dev and in `vite build`.
export default defineConfig({
  publicDir: resolve(here, '../build/web'),
  server: { host: '127.0.0.1', port: 5173, headers: isolation },
  preview: { headers: isolation },
  build: {
    chunkSizeWarningLimit: 2000,
    // two pages: the keyboard demo and the hand-gesture one (src/hands/)
    rolldownOptions: { input: { main: resolve(here, 'index.html'), hands: resolve(here, 'hands.html') } },
  },
  // @ocramz/handpose finds its workers, wasm and weights through import.meta.url;
  // pre-bundling would move the modules away from those files
  optimizeDeps: { exclude: ['@ocramz/handpose', 'onnxruntime-web'] },
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
