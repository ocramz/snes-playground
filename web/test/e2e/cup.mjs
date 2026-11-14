// Takes two enemies through the debug hook, drops the ball on the cup and
// follows the hole-out (the star exit, about 7 s) to the result card.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248','chromium-1234'].map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 512, height: 448 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/?debug&nointro');
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
await page.evaluate(() => {
  const s = window.__kdc;
  const m = s.sim;
  m.stage = 'roll';
  m.takeEnemy(m.enemies[0].idx);
  m.takeEnemy(m.enemies[1].idx);          // the third becomes the cup
  m.events.length = 0;
  s.onCup(2); s.onEnemy(0); s.onEnemy(1);
  const e = m.enemies[2];
  m.ball.place(m, e.col, 0x8000, e.row, 0x8000);
  m.stage = 'roll';
});
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, 'cup_a.png') });
for (let i = 0; i < 48; i++) {
  await page.waitForTimeout(250);
  const t = await page.evaluate(() => {
    const s = window.__kdc;
    if (!s.sys.isActive()) return 'result';
    return `${s.sim.stage} holed=${s.sim.ball.holed} outro=${s.cut ? s.cut.t : '-'}`;
  });
  if (i % 4 === 0) console.log(t);
  if (i === 16) await page.screenshot({ path: join(out, 'cup_b.png') }); // the star rises
}
await page.screenshot({ path: join(out, 'cup_c.png') }); // the result card
await browser.close();
