// Draws the engine's shot panel alone, at given states, for the pixel comparison
// with the real game's sprites: the engine half of `python3 tools/check_web_ui.py
// --target engine` (which writes the states and compares).
//   node test/e2e/panel.mjs states.json out_dir      (start `npm run dev` first)
// states.json: [{ "name": "f2992", "age": 192, "side": 3, "tb": 6, "meter1": -1, "meter2": -1 }, ...]
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openPage } from './browser.mjs';

const states = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3];
mkdirSync(out, { recursive: true });
const browser = await launch();
const { page, problems } = await openPage(browser, '?debug&nointro', { width: 256, height: 224 });
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForFunction(() => window.__engine && window.__engine.phase() === 'Aim', null, { timeout: 15000 });
await page.evaluate(() => window.__engine.isolatePanel());
for (const st of states) {
  await page.evaluate((st) => {
    window.__engine.panel.update({ x: 128, y: 100, age: st.age, visible: true, side: st.side, topBack: st.tb, meter1: st.meter1, meter2: st.meter2, hp: 4 });
  }, st);
  await page.waitForTimeout(120);
  await page.screenshot({ path: join(out, `panel_${st.name}.png`) });
}
await browser.close();
if (problems.length) console.log(problems.join('\n'));
console.log('wrote', states.length);
