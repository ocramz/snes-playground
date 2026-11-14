// The first frame of the hole at 1:1, to compare with build/emu/.../f002302.png.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234'].map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 256, height: 224 } });
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
await page.goto('http://127.0.0.1:5173/?nointro');
await page.waitForTimeout(2000);
await page.keyboard.press('Enter');
await page.waitForTimeout(1200);
await page.screenshot({ path: join(out, 'first.png') });
await browser.close();
