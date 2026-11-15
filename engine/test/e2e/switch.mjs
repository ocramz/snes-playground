// The switches in a browser (port_v2 phase 6), played frame by frame (the
// debug hook's `step`) from the poked scenarios' input; the browser cannot
// poke, so `placeBall` puts the ball where the .pokes file does:
//
// - course 1 hole 8 (ROM index 7), web_sw_water_drain: the roll onto the
//   water switch $5C, the 64-frame dissolve, the dry pond. Screenshots before
//   the switch, through the dissolve and after it.
// - course 2 hole 3 (ROM index 10), web_sw_switch_roll: the $75 swirls, then
//   the toggles' switch $5B. Screenshots before and after the flip.
//
// To build/engine-test/switch/. Exits 1 on a page error, a console error, a
// failed request, or when the core's switch state is not the game's at those
// frames (the water off at 2527 and the dissolve's steps; $6A2A cleared at 2522).
//   cd engine && npm run dev     (then, elsewhere)   node test/e2e/switch.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage } from './browser.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../../build/engine-test/switch');
mkdirSync(out, { recursive: true });
const inputs = join(here, '../../../tools/snesstep/inputs');
const BITS = { B: 0x8000, Y: 0x4000, SELECT: 0x2000, START: 0x1000, UP: 0x0800, DOWN: 0x0400, LEFT: 0x0200, RIGHT: 0x0100, A: 0x0080, X: 0x0040, L: 0x0020, R: 0x0010 };

function script(name) {
  const entries = readFileSync(join(inputs, `${name}.txt`), 'utf8')
    .split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean)
    .map((l) => { const [f, b, h] = l.split(/\s+/); return { f: +f, bits: b.split('+').reduce((a, n) => a | BITS[n], 0), hold: +(h ?? 1) }; });
  return (g) => entries.reduce((a, e) => (g >= e.f && g < e.f + e.hold ? a | e.bits : a), 0);
}

/** The ball's block as the .pokes file writes it at `frame`. */
function placement(name, frame) {
  const words = {};
  for (const l of readFileSync(join(inputs, `${name}.pokes`), 'utf8').split('\n')) {
    const m = l.match(/^(\d+):\$7E:([0-9A-F]{4})=([0-9A-F]{4})/i);
    if (m && +m[1] === frame) words[m[2].toUpperCase()] = parseInt(m[3], 16);
  }
  return {
    xf: words.D8AA, xc: words.D8AE, yf: words.D8B2, yc: words.D8B6,
    z: ((words.D8BE << 16) | words.D8BA) | 0,
    vx: words.D87A, vy: words.D87E, vz: words.D882, air: words.D8A6,
  };
}

async function play(browser, run) {
  const fail = [];
  const { page, problems } = await openPage(browser, `?course=${run.course}&hole=${run.hole}&nointro&debug`);
  await page.waitForFunction(() => window.__engine && window.__engine.phase() === 'Aim', null, { timeout: 20000 })
    .catch(() => fail.push(`${run.name}: timed out waiting for the aim stage`));
  const hole = await page.evaluate(() => window.__engine.hole());
  if (hole.rom !== run.rom) fail.push(`${run.name}: hole ${JSON.stringify(hole)}`);
  await page.evaluate(() => window.__engine.freeze(true));
  const heldAt = script(run.name);
  let g = await page.evaluate(() => window.__engine.frame()) + 1 + run.offset;
  const poke = placement(run.name, 2468);
  for (const [at, shot] of run.shots) {
    while (g <= at) {
      if (g === 2468) await page.evaluate((p) => window.__engine.placeBall(p), poke);
      const pad = heldAt(g);
      let n = 1;
      while (g + n <= at && g + n !== 2468 && heldAt(g + n) === pad) n++;
      await page.evaluate(([p, k]) => window.__engine.step(p, k), [pad, n]);
      g += n;
    }
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${run.name}_${shot.name}.png`) });
    const s = await page.evaluate(() => window.__engine.switches());
    console.log(`${run.name} ${at} ${shot.name}: ${JSON.stringify({ toggleOn: s.toggleOn, waterOff: s.waterOff, dissolve: s.dissolve })}`);
    const bad = shot.check(s);
    if (bad) fail.push(`${run.name} ${at} ${shot.name}: ${bad}`);
  }
  await page.close();
  return [...problems, ...fail];
}

const RUNS = [
  {
    name: 'web_sw_water_drain', course: 1, hole: 8, rom: 7, offset: 2338,
    shots: [
      [2520, { name: 'before', check: (s) => (s.waterOff === 0 && s.dissolve.step === 64 ? null : 'the water is not on') }],
      [2540, { name: 'dissolving', check: (s) => (s.waterOff === 1 && s.dissolve.step > 0 && s.dissolve.step < 64 ? null : `step ${s.dissolve.step}`) }],
      [2600, { name: 'drained', check: (s) => (s.waterOff === 1 && s.dissolve.step === 64 ? null : `step ${s.dissolve.step}`) }],
      [2720, { name: 'dry-pond', check: () => null }],
    ],
  },
  {
    name: 'web_sw_switch_roll', course: 2, hole: 3, rom: 10, offset: 2333,
    shots: [
      [2500, { name: 'swirl', check: (s) => (s.toggleOn === 1 ? null : 'the swirls are not on') }],
      [2530, { name: 'flipped', check: (s) => (s.toggleOn === 0 ? null : 'the switch did not flip') }],
    ],
  },
];

const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
const all = [];
for (const run of RUNS) all.push(...await play(browser, run));
await browser.close();
if (all.length) {
  console.log(all.join('\n'));
  process.exit(1);
}
console.log(`switch ok (screenshots in ${out})`);
