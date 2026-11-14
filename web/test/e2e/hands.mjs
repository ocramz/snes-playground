// The hand-gesture page without a camera: ?fakehands lets window.__hands.set()
// stand in for the model. Grips, tilts, spreads, opens; checks the aim, the
// meter and the stages, then the ratchet (a grip that ends with the hands out of
// view moves the aim but takes no stroke). Saves screenshots on the way.
//   node test/e2e/hands.mjs [out_dir] [url]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? '../build/web-test/hands';
const url = process.argv[3] ?? 'http://127.0.0.1:5173/hands.html?debug&nointro&fakehands';
mkdirSync(out, { recursive: true });
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234']
  .map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 768, height: 672 } });
const problems = [];
page.on('response', (r) => { if (r.status() >= 400) problems.push(`[http] ${r.status()} ${r.url()}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(2000);
await page.screenshot({ path: join(out, '00_title.png') });
await page.keyboard.press('Enter'); // title -> hole
await page.waitForTimeout(1500);

const shot = (name) => page.screenshot({ path: join(out, name) });
/** Both hands on a line through the middle at `deg`, `dist` metres apart. */
const hands = (deg, dist, shape) => page.evaluate(([deg, dist, shape]) => {
  const a = (deg * Math.PI) / 180, hx = (Math.cos(a) * dist) / 2, hy = (Math.sin(a) * dist) / 2;
  window.__hands.set({ x: -hx, y: -hy, shape }, { x: hx, y: hy, shape });
}, [deg, dist, shape]);
const noHands = () => page.evaluate(() => window.__hands.set(null, null));
const read = () => page.evaluate(() => {
  const s = window.__kdc.sim, g = window.__hands.control.state;
  return { stage: s.stage, aim: s.aim, meter: s.meter, strokes: s.strokes, handShot: s.handShot, grip: g.grip, angle: g.angle, gm: g.meter };
});
const waitStage = async (want, ms) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await read();
    if (want.includes(r.stage)) return r;
    await page.waitForTimeout(50);
  }
  return read();
};
const results = [];
const check = (name, ok, got) => { results.push({ name, ok, got }); };

const heading = (await read()).aim;
await hands(0, 0.3, 'fist');
await page.waitForTimeout(400);
let r = await read();
check('two fists grip', r.grip && r.stage === 'aim', r);
await hands(30, 0.4, 'fist');
await page.waitForTimeout(700);
r = await read();
check('tilt +30 turns the aim +30 from the heading', r.aim === (heading + 30) % 360, { heading, ...r });
check('0.4 m is meter 42', r.gm === 42, r);
await shot('10_grip.png');
await hands(30, 0.4, 'open');
r = await waitStage(['curl'], 1000);
check('opening shoots: curl, a hand shot', r.stage === 'curl' && r.handShot && r.meter === 42 && r.strokes === 1, r);
await page.waitForTimeout(250);
await shot('11_curl.png');
await noHands();
r = await waitStage(['roll'], 3000);
check('then the roll', r.stage === 'roll' && r.aim === (heading + 30) % 360, r);
for (let i = 0; i < 4; i++) { await page.waitForTimeout(400); await shot(`2${i}_roll.png`); }
r = await waitStage(['aim', 'done', 'fail'], 20000);
check('back to the aim stage', r.stage === 'aim', r);

// the ratchet: grip, tilt -40, hands out of view -> the aim stays, no stroke
const h2 = r.aim, strokes = r.strokes;
await hands(0, 0.2, 'fist');
await page.waitForTimeout(400);
await hands(-40, 0.2, 'fist');
await page.waitForTimeout(600);
await noHands();
await page.waitForTimeout(900);
r = await read();
check('a grip that ends out of view keeps the aim and takes no stroke',
  !r.grip && r.stage === 'aim' && r.aim === (h2 - 40 + 360) % 360 && r.strokes === strokes, { h2, ...r });
await shot('30_ratchet.png');

// opening with the hands together is not a shot
await hands(0, 0.06, 'fist');
await page.waitForTimeout(400);
await hands(0, 0.06, 'open');
await page.waitForTimeout(400);
r = await read();
check('opening at meter 0 is not a shot', r.stage === 'aim' && r.strokes === strokes, r);

await browser.close();
for (const x of results) console.log(x.ok ? 'ok  ' : 'FAIL', x.name, x.ok ? '' : JSON.stringify(x.got));
for (const p of problems) console.log(p);
const failed = results.filter((x) => !x.ok).length + problems.length;
console.log(failed ? `${failed} problem(s)` : 'all good');
process.exit(failed ? 1 : 0);
