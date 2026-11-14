// Draws the shot panel alone, at given states, for pixel comparison with the real
// game's sprites (tools/check_web_ui.py makes the states and does the comparing).
//   node test/e2e/panel.mjs states.json out_dir      (start `npm run dev` first)
// states.json: [{ "name": "f2992", "age": 192, "side": 3, "tb": 6, "meter1": -1, "meter2": -1 }, ...]
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const states = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3];
mkdirSync(out, { recursive: true });
const base = join(homedir(), 'Library/Caches/ms-playwright');
const exe = ['chromium-1248', 'chromium-1234']
  .map((d) => join(base, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find(existsSync);
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 256, height: 224 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/?debug');
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
await page.evaluate(() => {
  const s = window.__kdc;
  s.sys.sceneUpdate = () => {};              // freeze the scene (Phaser calls the copy kept in sys)
  s.children.list.forEach((o) => { if (o !== s.panel.root) o.setVisible(false); });
  s.cameras.main.setBackgroundColor(0x000000);
});
for (const st of states) {
  await page.evaluate((st) => {
    const s = window.__kdc;
    s.panel.update({ x: 128, y: 100, age: st.age, visible: true, side: st.side, topBack: st.tb, meter1: st.meter1, meter2: st.meter2, hp: 4 });
  }, st);
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(out, `panel_${st.name}.png`) });
}
await browser.close();
console.log('wrote', states.length);
