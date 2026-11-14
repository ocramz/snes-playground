// Drives the dev server in headless Chromium and saves screenshots.
//   node test/e2e/shoot.mjs out_dir [url]
// Uses the Chromium that Playwright already cached (no download).
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
const page = await browser.newPage({ viewport: { width: 768, height: 672 } });
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, '01_title.png') });
await page.keyboard.press('Enter');
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, '02_hole.png') });
await browser.close();
console.log('done', exe ? 'ok' : 'no chromium');
