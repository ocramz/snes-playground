// The canvas must fit the window at any size, also after the window changes.
//   node test/e2e/viewport.mjs [url]       (start `npm run dev` first)
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/';
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234']
  .map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

let bad = 0;
async function check(page, label) {
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    const c = document.querySelector('canvas').getBoundingClientRect();
    return { l: c.left, t: c.top, r: c.right, b: c.bottom, w: c.width, h: c.height, vw: innerWidth, vh: innerHeight };
  });
  const eps = 0.51;
  const inside = r.l >= -eps && r.t >= -eps && r.r <= r.vw + eps && r.b <= r.vh + eps;
  const centred = Math.abs(r.l - (r.vw - r.r)) <= 1.5 && Math.abs(r.t - (r.vh - r.b)) <= 1.5;
  const zoom = r.w / 256;
  const whole = zoom < 1 || Math.abs(zoom - Math.round(zoom)) < 1e-6;
  const filled = zoom >= 1 ? (r.w + 256 > r.vw || r.h + 224 > r.vh) : true; // no room for the next zoom step
  const ok = inside && centred && whole && filled;
  if (!ok) bad += 1;
  console.log(ok ? 'ok  ' : 'FAIL', label.padEnd(26), `canvas ${r.w.toFixed(0)}x${r.h.toFixed(0)} at ${r.l.toFixed(0)},${r.t.toFixed(0)}  window ${r.vw}x${r.vh}  zoom ${zoom.toFixed(2)}`,
    ok ? '' : `inside=${inside} centred=${centred} whole=${whole} filled=${filled}`);
}

const sizes = [[256, 224], [500, 900], [1366, 657], [1440, 790], [2560, 1300], [200, 150], [768, 400]];
for (const dpr of [1, 2]) {
  for (const [w, h] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    await page.goto(url);
    await page.waitForSelector('canvas');
    await check(page, `load ${w}x${h} @${dpr}x`);
    await ctx.close();
  }
}
// resize after load: big, then a laptop screen, then a narrow side panel
const ctx = await browser.newContext({ viewport: { width: 2560, height: 1300 } });
const page = await ctx.newPage();
await page.goto(url);
await page.waitForSelector('canvas');
await check(page, 'start 2560x1300');
for (const [w, h] of [[1440, 790], [600, 900], [1000, 500], [255, 223], [900, 700]]) {
  await page.setViewportSize({ width: w, height: h });
  await check(page, `resize to ${w}x${h}`);
}
await browser.close();
console.log(bad ? `${bad} FAILED` : 'all fit');
process.exit(bad ? 1 : 0);
