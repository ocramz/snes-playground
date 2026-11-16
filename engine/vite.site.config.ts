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
//
// The link preview's og:image is the one URL that must be absolute (scrapers
// do not resolve a relative one): with EDITOR_SITE_URL set (the Makefile's
// default is the published site), renderBuiltUrl prefixes it to that image
// alone; the chunks and the assets stay relative.
const siteUrl = process.env.EDITOR_SITE_URL ? process.env.EDITOR_SITE_URL.replace(/\/*$/, '/') : '';

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
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (siteUrl && hostType === 'html' && /^js\/og-[^/]+\.jpg$/.test(filename)) return new URL(filename, siteUrl).href;
      return undefined;
    },
  },
});
