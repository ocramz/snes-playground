import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

// The level editor as a static site (docs/editor.md "The site"): editor.html
// alone, with relative URLs (base './'), so the folder works served from any
// path (a GitHub Pages project site included). Its public files are the
// trimmed copy tools/stage_editor_site.py makes of build/engine (the rules,
// the sprites, the course art, the sounds and the songs a level plays);
// Vite's own chunks go to js/, apart from them. `make editor-site` runs the
// staging, this build, and renames the page to index.html.
export default defineConfig({
  root: here,
  base: './',
  publicDir: resolve(here, '../build/editor-site-public'),
  build: {
    outDir: resolve(here, '../build/editor-site'),
    emptyOutDir: true,
    assetsDir: 'js',
    chunkSizeWarningLimit: 2000,
    rolldownOptions: { input: { editor: resolve(here, 'editor.html') } },
  },
  worker: { format: 'es' },
});
