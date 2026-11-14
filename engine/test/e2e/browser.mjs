// Shared by the e2e scripts: the cached Chromium of playwright-core, as web/test/e2e uses it.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const URL_BASE = process.env.ENGINE_URL ?? 'http://127.0.0.1:5174/';

export async function launch(extraArgs = []) {
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  const exe = ['chromium-1248', 'chromium-1234']
    .map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
    .find(existsSync);
  return chromium.launch({
    executablePath: exe,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extraArgs],
  });
}

/** A page that records page errors, console errors and failed requests into `problems`. */
export async function openPage(browser, query, viewport = { width: 512, height: 448 }) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  page.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`));
  await page.goto(URL_BASE + query);
  return { page, problems };
}
