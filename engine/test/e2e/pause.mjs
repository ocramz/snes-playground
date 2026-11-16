// The aim's other inputs in the browser (port_v2 phase 7): on course 1 hole 1,
// frozen and stepped with pads through the debug hook, the idle timer's score
// panel, the pause menu (Start, the cursor, B closes it), the spin preset (B
// held with Left), the look (Y with Right: the camera moves, the arrows), an
// L snap, and QUIT back to the menu. Screenshots in build/engine-test/pause/.
//   cd engine && npm run dev     (then, elsewhere)   node test/e2e/pause.mjs
import { mkdirSync } from 'node:fs';
import { launch, openPage } from './browser.mjs';

const OUT = new URL('../../../build/engine-test/pause/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PAD = { B: 0x8000, Y: 0x4000, START: 0x1000, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100, A: 0x80, L: 0x20 };

const browser = await launch();
const { page, problems } = await openPage(browser, '?course=1&nointro&debug');
const fail = [];
const until = (fn, what, timeout = 15000) =>
  page.waitForFunction(fn, null, { timeout }).catch(() => fail.push(`timed out waiting for ${what}`));
const step = (pad, n = 1) => page.evaluate(([p, k]) => window.__engine.step(p, k), [pad, n]);
const ui = () => page.evaluate(() => window.__engine.aimUi());
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });

await until(() => window.__engine && window.__engine.phase() === 'Aim', 'the aim stage');
await page.evaluate(() => window.__engine.freeze());
await step(0, 100);
if ((await ui()).panel !== 1) fail.push('the score panel did not show after 90 quiet iterations');
await shot('idle');

await step(PAD.START); await step(0, 2);
if ((await ui()).pause !== 1) fail.push('Start did not open the pause menu');
if ((await ui()).panel !== 0) fail.push('the pause did not hide the score panel');
await step(PAD.DOWN); await step(0, 2);
if ((await ui()).cursor !== 1) fail.push('Down did not move the cursor');
await shot('pause');
await step(PAD.B); await step(0, 2);
if ((await ui()).pause !== 0) fail.push('B did not close the pause menu');

await step(PAD.B, 3); await step(PAD.B | PAD.LEFT, 14);
const preset = await ui();
if (preset.preset !== 1) fail.push('B held did not start the preset');
await shot('preset');
await step(0, 3);
if ((await ui()).preset !== 0) fail.push('releasing B did not end the preset');

await step(PAD.Y | PAD.RIGHT, 24);
const look = await ui();
if (look.look !== 1) fail.push('Y with Right did not start the look');
await shot('look');
await step(0, 120);
if ((await ui()).look !== 0) fail.push('the look did not end after the pan back');

const before = (await ui()).aim;
await step(PAD.L); await step(0, 8);
const after = (await ui()).aim;
if (after % 45 !== 0 || after === before) fail.push(`L did not snap the aim (${before} -> ${after})`);

await step(PAD.START); await step(0, 2);
await step(PAD.DOWN); await step(0, 2);
await step(PAD.DOWN); await step(0, 2);
await step(PAD.A);
await page.evaluate(() => window.__engine.freeze(false));
await page.waitForTimeout(800);
await shot('quit');
await browser.close();

const all = [...problems, ...fail];
console.log(`preset ${JSON.stringify(preset)}; look ${JSON.stringify(look)}; aim ${before} -> ${after}`);
if (all.length) {
  console.log(all.join('\n'));
  process.exit(1);
}
console.log('pause: ok');
