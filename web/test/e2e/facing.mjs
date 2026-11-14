// Kirby's pose at 8 aim angles (aim stage), as one picture per angle.
//   node test/e2e/facing.mjs [out_dir]       (start `npm run dev` first)
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? '../build/web-test/shots';
const url = 'http://127.0.0.1:5173/?debug';
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
await page.goto(url);
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
for (let k = 0; k < 8; k++) {
  const aim = k * 45;
  await page.evaluate((a) => { window.__kdc.sim.aim = a; }, aim);
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => ({ f: window.__kdc.sim.facing, a16: window.__kdc.sim.shotAngle16, clip: window.__kdc.pose.clip }));
  console.log(`aim ${aim}: facing ${info.f} angle16 ${info.a16} clip ${info.clip}`);
  await page.screenshot({ path: join(out, `facing_${String(aim).padStart(3, '0')}.png`) });
}
await browser.close();
