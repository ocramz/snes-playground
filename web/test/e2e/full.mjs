// Plays the whole hole in the browser with the shots the headless player found
// (src/sim/__tests__/play.test.ts), using only key presses and the debug hook
// to set aim and meter exactly.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234'].map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 512, height: 448 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/?debug&nointro');
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
const tap = async (key) => { await page.keyboard.down(key); await page.waitForTimeout(60); await page.keyboard.up(key); await page.waitForTimeout(60); };
const stage = () => page.evaluate(() => window.__kdc.sim.stage);
const waitStage = async (st, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await stage()) === st) return true; await page.waitForTimeout(40); } return false; };
const shots = [{ aim: 0, elev: 0, meter: 18 }, { aim: 102, elev: 0, meter: 18 }, { aim: 192, elev: 0, meter: 18 }];
let n = 0;
for (const s of shots) {
  if (!(await waitStage('aim'))) { console.log('never reached aim'); break; }
  await page.evaluate((s) => { const m = window.__kdc.sim; m.aim = s.aim; m.elevation = s.elev; }, s);
  await tap('KeyZ');
  await waitStage('spin');
  // Kirby curls and the panel opens first: the selectors answer 70 frames after the A
  for (let i = 0; i < 400; i++) { const a = await page.evaluate(() => window.__kdc.sim.shotAge); if (a >= 74) break; await page.waitForTimeout(16); }
  await tap('KeyZ');
  await waitStage('power');
  // the meter counts 0..63 at 60 Hz: wait for it to pass the wanted value, then press
  for (let i = 0; i < 400; i++) { const m = await page.evaluate(() => window.__kdc.sim.meter); if (m >= s.meter) break; await page.waitForTimeout(8); }
  await tap('KeyZ');
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `shot${++n}_launch.png`) });
  console.log('shot', n, await page.evaluate(() => { const m = window.__kdc.sim; return `${m.stage} strokes=${m.strokes} hp=${m.hp} stars=${m.stars} frame=${m.frame}`; }));
  for (let i = 0; i < 30; i++) { await page.waitForTimeout(1000); const t = await page.evaluate(() => { const m = window.__kdc.sim; const b = m.ball; return `${m.stage} strokes=${m.strokes} hp=${m.hp} stars=${m.stars} x=${b.xc}:${b.xf.toString(16)} y=${b.yc}:${b.yf.toString(16)} z=${b.z} v=${b.vx},${b.vy},${b.vz} air=${b.air}`; }); if (i % 3 === 0) console.log('  ', t); if (t.startsWith('aim') || t.startsWith('done') || t.startsWith('fail')) break; }
}
const st = await page.evaluate(() => ({ stage: window.__kdc.sim.stage, strokes: window.__kdc.sim.strokes, stars: window.__kdc.sim.stars, hp: window.__kdc.sim.hp }));
console.log('after three shots', st);
await waitStage('done', 25000).catch(() => undefined);
await page.waitForTimeout(1500);
console.log('final', await page.evaluate(() => ({ stage: window.__kdc?.sim.stage, strokes: window.__kdc?.sim.strokes, stars: window.__kdc?.sim.stars })));
await page.screenshot({ path: join(out, 'end.png') });
await browser.close();
