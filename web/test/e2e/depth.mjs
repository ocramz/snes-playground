// The cup is a picture on the floor: Kirby must be drawn over it wherever he
// stands in its cell. Takes two enemies through the debug hook (the third
// becomes the cup), puts the ball at 9 spots in the cup's cell and checks the
// draw order; saves one screenshot with Kirby on the far side of the cup.
//   node test/e2e/depth.mjs [out_dir]       (start `npm run dev` first)
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? '../build/web-test/shots';
mkdirSync(out, { recursive: true });
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234']
  .map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 512, height: 448 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/?debug');
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
await page.evaluate(() => {
  const s = window.__kdc, m = s.sim;
  m.takeEnemy(m.enemies[0].idx);
  m.takeEnemy(m.enemies[1].idx);
  m.events.length = 0;
  s.onEnemy(0); s.onEnemy(1); s.onCup(2);
  m.cupShown = false;
});
let bad = 0;
for (const fy of [0.1, 0.5, 0.9]) {
  for (const fx of [0.1, 0.5, 0.9]) {
    const r = await page.evaluate(([fx, fy]) => {
      const s = window.__kdc, m = s.sim, e = m.enemies[2];
      m.stage = 'aim';
      m.ball.place(m, e.col, Math.floor(fx * 65536), e.row, Math.floor(fy * 65536));
      s.render();
      const v = s.enemies[2];
      return { kirby: s.kirby.depth, cup: v.img.depth, ring: v.ring.depth };
    }, [fx, fy]);
    const ok = r.kirby > r.cup && r.kirby > r.ring;
    if (!ok) bad += 1;
    console.log(ok ? 'ok  ' : 'FAIL', `ball at (${fx}, ${fy}) of the cup cell: kirby ${r.kirby.toFixed(1)} cup ${r.cup} ring ${r.ring}`);
  }
}
await page.evaluate(() => {
  const s = window.__kdc, m = s.sim, e = m.enemies[2];
  m.ball.place(m, e.col, 0x8000, e.row, 0xe000); // the north corner of the cell (+y is up-right)
  const k = m.kirby(); m.camera.snap(k.x, k.yFlip); s.applyCamera(); s.render();
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, 'cup_depth.png') });
await browser.close();
console.log(bad ? `${bad} FAILED` : 'cup stays under Kirby');
process.exit(bad ? 1 : 0);
