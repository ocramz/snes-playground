// Every ROM course in a browser: ?course=N loads course N from the manifest
// when the menu starts (assets/course-loader.ts) and plays its first hole.
// For each of courses 1-8 it checks the hole (ROM index, name, song) and
// saves a screenshot of the aim stage to build/engine-test/courses/; then on
// course 3 hole 2 (index 17: boost and warp panels, three other species) it
// plays a shot. Exits 1 on a page error, a console error, a failed request,
// a wrong hole or a ball that did not move.
//   cd engine && npm run dev     (then, elsewhere)   node test/e2e/courses.mjs
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openPage } from './browser.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../build/engine-test/courses');
mkdirSync(out, { recursive: true });
// $80:C99D's first song of each course (course.json `song`)
const FIRST_SONG = [11, 6, 11, 14, 10, 9, 10, 12];

const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
const fail = [];
const problems = [];

async function boot(query) {
  const opened = await openPage(browser, query);
  const { page } = opened;
  await page.waitForFunction(() => window.__engine && window.__engine.phase() === 'Aim', null, { timeout: 20000 })
    .catch(() => fail.push(`${query}: timed out waiting for the aim stage`));
  return opened;
}

for (let course = 1; course <= 8; course++) {
  const { page, problems: p } = await boot(`?course=${course}&nointro&debug`);
  const hole = await page.evaluate(() => window.__engine?.hole());
  const want = (course - 1) * 8;
  if (!hole || hole.set !== `rom${course}` || hole.rom !== want || hole.song !== FIRST_SONG[course - 1]) {
    fail.push(`course ${course}: got ${JSON.stringify(hole)}, want rom${course} index ${want} song ${FIRST_SONG[course - 1]}`);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `course${course}.png`) });
  problems.push(...p);
  console.log(`course ${course}: ${JSON.stringify(hole)}`);
  await page.close();
}

{
  const { page, problems: p } = await boot('?course=3&hole=2&nointro&debug');
  const hole = await page.evaluate(() => window.__engine?.hole());
  if (!hole || hole.rom !== 17) fail.push(`course 3 hole 2: got ${JSON.stringify(hole)}`);
  const before = await page.evaluate(() => window.__engine.kirby());
  await page.keyboard.press('z');
  await page.waitForFunction(() => window.__engine.phase() === 'Spin', null, { timeout: 15000 }).catch(() => fail.push('no spin stage'));
  await page.waitForTimeout(900);
  await page.keyboard.press('z');
  await page.waitForFunction(() => window.__engine.phase() === 'Power', null, { timeout: 15000 }).catch(() => fail.push('no power stage'));
  await page.waitForTimeout(500);
  await page.keyboard.press('z');
  await page.waitForFunction(() => window.__engine.phase() === 'Rolling', null, { timeout: 15000 }).catch(() => fail.push('no roll'));
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.__engine.kirby());
  if (!before || !after || (before.x === after.x && before.y === after.y)) fail.push('course 3 hole 2: the ball did not move');
  await page.screenshot({ path: join(out, 'hole17-roll.png') });
  problems.push(...p);
}

await browser.close();
const all = [...problems, ...fail];
if (all.length) {
  console.log(all.join('\n'));
  process.exit(1);
}
console.log(`courses ok (screenshots in ${out})`);
