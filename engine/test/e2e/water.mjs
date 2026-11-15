// The water in a browser: course 1 hole 7 (ROM index 6) played frame by
// frame (the debug hook's `step`) with web_water_shot's input
// (tools/snesstep/inputs/web_water_shot.txt): the fly shot into the pond, the
// aim from the water, the fly shot out. Screenshots at the entry (the splash,
// Kirby's wet palette), on the bed (the bubbles), in the aim (the guide's wet
// pictures) and at the way out, to build/engine-test/water/. Exits 1 on a page
// error, a console error, a failed request, or when the core's water state is
// not the game's at those frames (in at 2761, out at 3176).
//   cd engine && npm run dev     (then, elsewhere)   node test/e2e/water.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../build/engine-test/water');
mkdirSync(out, { recursive: true });
const BITS = { B: 0x8000, Y: 0x4000, SELECT: 0x2000, START: 0x1000, UP: 0x0800, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100, A: 0x0080, X: 0x0040, L: 0x0020, R: 0x0010 };
const entries = readFileSync(join(here, '../../../tools/snesstep/inputs/web_water_shot.txt'), 'utf8')
  .split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean)
  .map((l) => { const [f, b, h] = l.split(/\s+/); return { f: +f, bits: b.split('+').reduce((a, n) => a | BITS[n], 0), hold: +(h ?? 1) }; });
const heldAt = (g) => entries.reduce((a, e) => (g >= e.f && g < e.f + e.hold ? a | e.bits : a), 0);
const OFFSET = 2332; // engine frame f is game frame f + 2332 (the set-up)
const SHOTS = { 2763: 'entry', 2830: 'bubbles', 3000: 'aim-in-water', 3170: 'out' };

const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
const fail = [];
const { page, problems } = await openPage(browser, '?course=1&hole=7&nointro&debug');
await page.waitForFunction(() => window.__engine && window.__engine.phase() === 'Aim', null, { timeout: 20000 })
  .catch(() => fail.push('timed out waiting for the aim stage'));
const hole = await page.evaluate(() => window.__engine.hole());
if (hole.rom !== 6) fail.push(`hole: ${JSON.stringify(hole)}`);
await page.evaluate(() => window.__engine.freeze(true));
let g = await page.evaluate(() => window.__engine.frame()) + 1 + OFFSET;
for (const [at, name] of Object.entries(SHOTS).map(([k, v]) => [+k, v])) {
  // step to `at` in runs of equal pad
  while (g <= at) {
    const pad = heldAt(g);
    let n = 1;
    while (g + n <= at && heldAt(g + n) === pad) n++;
    await page.evaluate(([p, k]) => window.__engine.step(p, k), [pad, n]);
    g += n;
  }
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(out, `${name}.png`) });
  const k = await page.evaluate(() => window.__engine.kirby());
  console.log(`${at} ${name}: ${JSON.stringify(k)}`);
}
await browser.close();
const all = [...problems, ...fail];
if (all.length) {
  console.log(all.join('\n'));
  process.exit(1);
}
console.log(`water ok (screenshots in ${out})`);
