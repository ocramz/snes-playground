// Steps the hole intro (and, with --outro, a hole-out) frame by frame through
// the debug hook and saves screenshots at chosen frames of the recording, for a
// side-by-side look with the game's own frames (tools/ppu_render.py on the c1n
// run: the intro's frame t is game frame 2169 + t, the hole-out's 3121 + t).
//   node test/e2e/intro.mjs out_dir [--outro] [--hio]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? '../build/web-test/intro';
const outro = process.argv.includes('--outro');
const hio = process.argv.includes('--hio');
mkdirSync(out, { recursive: true });
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234']
  .map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 256, height: 224 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/?debug');
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__kdc && window.__kdc.cut);
// stop the clock: from here the frames are stepped by hand
await page.evaluate(() => { window.__kdc.scene.pause(); window.__kdc.restart(); }); // the intro again from frame 0
const pad = { left: false, right: false, up: false, down: false, a: false, b: false, y: false };
const step = (n) => page.evaluate(([n, pad]) => { const s = window.__kdc; for (let i = 0; i < n; i++) s.stepOnce(pad); s.render(); }, [n, pad]);
const at = () => page.evaluate(() => (window.__kdc.cut ? window.__kdc.cut.t : -1));
const shoot = async (want, name) => {
  const t = await at();
  if (want > t) await step(want - t);
  await page.waitForTimeout(80);
  await page.screenshot({ path: join(out, name) });
  console.log(name, 't =', await at(), 'stage', await page.evaluate(() => window.__kdc.sim.stage));
};

if (!outro) {
  // frames that the c1n snapshots have (game frame = 2169 + t, every third frame from 2110)
  for (const t of [34, 64, 91, 106, 127, 160]) await shoot(t + 1, `intro_${2169 + t}.png`);
} else {
  await step(200); // through the intro
  await page.evaluate((hio) => {
    // take two enemies, put the ball on the cup, as test/e2e/cup.mjs does
    const s = window.__kdc;
    const m = s.sim;
    m.stage = 'roll';
    m.takeEnemy(m.enemies[0].idx);
    m.takeEnemy(m.enemies[1].idx);
    m.events.length = 0;
    s.onCup(2); s.onEnemy(0); s.onEnemy(1);
    const e = m.enemies.find((q) => q.cup);
    m.ball.place(m, e.col, 0x8000, e.row, 0x8000);
    m.strokes = hio ? 1 : 3;
    m.stage = 'roll';
  }, hio);
  for (let i = 0; i < 400 && !(await page.evaluate(() => !!window.__kdc.cut)); i++) await step(1);
  const marks = hio ? [3, 100, 240, 570, 610, 660, 700, 760] : [3, 60, 220, 250, 290, 320, 360, 420];
  for (const t of marks) await shoot(t + 1, `outro${hio ? 'Hio' : ''}_${3121 + t}.png`);
}
await browser.close();
