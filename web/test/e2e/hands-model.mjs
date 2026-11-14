// The real hand model on Chromium's fake camera (a test pattern, no hands): the
// webcam opens, the worker loads the weights, the model gets ready and answers
// frames, and nothing fails to load. Headless has no usable WebGPU, so this is
// the WASM fallback and slow; it checks the plumbing, not the tracking.
//   node test/e2e/hands-model.mjs [url] [timeout_s]
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/hands.html?debug&nointro';
const timeout = Number(process.argv[3] ?? 180) * 1000;
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234']
  .map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 768, height: 672 } });
const problems = [];
page.on('response', (r) => { if (r.status() >= 400) problems.push(`[http] ${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('[handpose]')) console.log(`[console.${m.type()}]`, m.text()); });
await page.goto(url);

const status = () => page.evaluate(() => {
  const c = window.__hands?.control;
  const p = c?.pose;
  return {
    isolated: window.crossOriginIsolated,
    ready: !!p?.ready, backend: p?.backendLabel ?? '', counts: p ? { ...p.counts } : null,
    text: document.getElementById('cam-status')?.textContent ?? '',
  };
});
const t0 = Date.now();
let s = await status();
while (Date.now() - t0 < timeout && !(s.ready && s.counts && s.counts.results >= 3)) {
  await page.waitForTimeout(1000);
  s = await status();
}
await page.screenshot({ path: join('../build/web-test', 'hands_model.png') });
await browser.close();
console.log(JSON.stringify(s, null, 1), `after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
for (const p of problems) console.log(p);
const ok = s.ready && s.counts.results >= 3 && s.counts.errors === 0 && problems.length === 0;
console.log(ok ? 'model ok' : 'model FAILED');
process.exit(ok ? 0 : 1);
