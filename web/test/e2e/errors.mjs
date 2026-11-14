// Loads the page and reports failed requests, page errors and audio decoding.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248','chromium-1234'].map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 512, height: 448 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
page.on('requestfailed', (r) => console.log('[failed]', r.url()));
await page.goto(process.argv[2] ?? 'http://127.0.0.1:5173/?debug&nointro');
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
console.log(await page.evaluate(() => { const a = window.__kdc?.audio; return a ? { buffers: [...a.buffers.keys()], ctx: a.ctx?.state, music: !!a.music } : 'no audio'; }));
await browser.close();
