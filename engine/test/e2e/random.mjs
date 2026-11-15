// random.html in a browser (plans/random_holes.md "Verification"): generates
// the course of one seed, checks a reload gives the same holes, plays a shot
// on the first hole, and saves screenshots to build/engine-test/random/.
//   cd engine && npm run dev     (then, elsewhere)   node test/e2e/random.mjs
// Exits 1 on a page error, a console error, a failed request, a course that
// was not generated, a seed that gave other holes, or a ball that did not move.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage } from './browser.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../build/engine-test/random');
mkdirSync(out, { recursive: true });
const query = 'random.html?seed=42&difficulty=normal&nointro&debug';
const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
const fail = [];

async function generated() {
  const { page, problems } = await openPage(browser, query);
  await page.waitForFunction(() => window.__random && window.__random.holes, null, { timeout: 90000 })
    .catch(() => fail.push('the course was not generated in 90 s'));
  const holes = await page.evaluate(() => JSON.stringify(window.__random?.holes?.map((h) => h.json) ?? null));
  return { page, problems, holes };
}

const first = await generated();
await first.page.screenshot({ path: join(out, 'menu.png') });
const again = await generated();
if (again.holes !== first.holes) fail.push('the same seed gave other holes');
await again.page.close();

const { page, problems } = first;
const until = (fn, what, timeout = 15000) =>
  page.waitForFunction(fn, null, { timeout }).catch(() => fail.push(`timed out waiting for ${what}`));
await page.keyboard.press('Enter');
await until(() => window.__engine && window.__engine.phase() === 'Aim', 'the aim stage');
await page.waitForTimeout(500);
await page.screenshot({ path: join(out, 'hole1.png') });
const before = await page.evaluate(() => window.__engine.kirby());
await page.keyboard.press('z');
await until(() => window.__engine.phase() === 'Spin', 'the spin stage');
await page.waitForTimeout(900);
await page.keyboard.press('z');
await until(() => window.__engine.phase() === 'Power', 'the power stage');
await page.waitForTimeout(400);
await page.keyboard.press('z');
await until(() => window.__engine.phase() === 'Rolling', 'the roll');
await page.waitForTimeout(1500);
await page.screenshot({ path: join(out, 'roll.png') });
const after = await page.evaluate(() => ({ kirby: window.__engine.kirby(), phase: window.__engine.phase() }));
if (!before || !after.kirby) fail.push('no Kirby view');
else if (before.x === after.kirby.x && before.y === after.kirby.y) fail.push(`the ball did not move (${before.x}, ${before.y})`);
const pars = await page.evaluate(() => window.__random.holes.map((h) => h.par).join(' '));
await browser.close();

const all = [...first.problems, ...again.problems, ...problems.filter((p) => !first.problems.includes(p)), ...fail];
console.log(`seed 42: pars ${pars}; kirby ${JSON.stringify(before)} -> ${JSON.stringify(after.kirby)}, phase ${after.phase}`);
console.log(`screenshots in ${out}`);
if (all.length) {
  console.log([...new Set(all)].join('\n'));
  process.exit(1);
}
console.log('random ok');
