// The engine in a browser (plans "Verification": the Playwright smoke script):
// boots course 1, plays a shot, and checks that nothing went wrong.
//   cd engine && npm run dev     (then, elsewhere)   npm run e2e
// Exits 1 on a page error, a console error, a failed request, a ball that did
// not move, or the ground's views (tee, cup) not under Kirby.
import { launch, openPage } from './browser.mjs';

const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
const { page, problems } = await openPage(browser, '?nointro&debug');
const fail = [];
const until = (fn, what, timeout = 15000) =>
  page.waitForFunction(fn, null, { timeout }).catch(() => fail.push(`timed out waiting for ${what}`));

await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await until(() => window.__engine && window.__engine.phase() === 'Aim', 'the aim stage');
const before = await page.evaluate(() => window.__engine.kirby());
await page.keyboard.press('z');
await until(() => window.__engine.phase() === 'Spin', 'the spin stage');
await page.waitForTimeout(900);
await page.keyboard.press('z');
await until(() => window.__engine.phase() === 'Power', 'the power stage');
await page.waitForTimeout(300);
await page.keyboard.press('z');
await until(() => window.__engine.phase() === 'Rolling', 'the roll');
await page.waitForTimeout(1500);
const after = await page.evaluate(() => ({ kirby: window.__engine.kirby(), depths: window.__engine.depths(), phase: window.__engine.phase() }));

if (!before || !after.kirby) fail.push('no Kirby view');
else if (before.x === after.kirby.x && before.y === after.kirby.y) fail.push(`the ball did not move (${before.x}, ${before.y})`);
const kirbyDepth = after.kirby?.depth ?? 0;
for (const kind of ['tee', 'cup']) {
  for (const d of after.depths[kind] ?? []) if (d >= kirbyDepth) fail.push(`${kind} depth ${d} not under Kirby's ${kirbyDepth}`);
}
await browser.close();

const all = [...problems, ...fail];
console.log(`kirby ${JSON.stringify(before)} -> ${JSON.stringify(after.kirby)}, phase ${after.phase}`);
if (all.length) {
  console.log(all.join('\n'));
  process.exit(1);
}
console.log('smoke ok');
