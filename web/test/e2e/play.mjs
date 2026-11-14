// Plays a scripted shot in headless Chromium and saves screenshots on the way.
//   node test/e2e/play.mjs out_dir
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? '../build/web-test/shots';
const url = process.argv[3] ?? 'http://127.0.0.1:5173/';
mkdirSync(out, { recursive: true });
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234']
  .map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 512, height: 448 } });
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForTimeout(2000);
await page.keyboard.press('Enter'); // title -> hole
await page.waitForTimeout(800);
const shot = async (name) => page.screenshot({ path: join(out, name) });
const tap = async (key, ms = 90) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); };

await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(450); await page.keyboard.up('ArrowLeft');
await shot('10_aimed.png');
await tap('KeyZ');            // aim -> spin
await page.waitForTimeout(900);   // Kirby curls, the "1" shows (A + 46 frames)
await shot('11_spin_one.png');
await page.waitForTimeout(800);   // the panel is open and answers from A + 70 frames
await shot('11_spin.png');
await tap('KeyZ');            // spin -> power
await page.waitForTimeout(500);
await shot('12_power.png');
await tap('KeyZ');            // shoot
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(350);
  await shot(`2${i}_roll.png`);
}
await browser.close();
console.log('done');
