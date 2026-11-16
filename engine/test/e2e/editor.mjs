// editor.html in a browser (docs/editor.md "Verification"): the editor opens
// on the default level with a par; a rectangle raised and an enemy painted
// through the UI; the share link plays that level, a shot rolls the ball, and
// Edit brings the same level back to the editor; Play from the editor; QUIT
// from the pause menu and E back to the editor; a damaged link opens the
// editor. With the browser's audio held until a gesture, the share link
// first shows the start screen, and a click (or Enter) unlocks the audio and
// plays the level. Screenshots in build/engine-test/editor/.
//   cd engine && npm run dev     (then, elsewhere)   node test/e2e/editor.mjs
// Against the site build (make editor-site, served under a path):
//   ENGINE_URL=http://127.0.0.1:4173/snes-playground/ EDITOR_PAGE= node test/e2e/editor.mjs
// Exits 1 on a page error, a console error, a failed request or a check that fails.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { URL_BASE, launch } from './browser.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../build/engine-test/editor');
mkdirSync(out, { recursive: true });
const PAGE = process.env.EDITOR_PAGE ?? 'editor.html';
const PAD = { START: 0x1000, DOWN: 0x0400, A: 0x80 };
const browser = await launch(['--autoplay-policy=no-user-gesture-required']);
const fail = [];
const problems = [];

async function open(url) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  page.on('requestfailed', (r) => problems.push(`failed: ${r.url()}`));
  await page.goto(url);
  return page;
}
const until = (page, fn, what, timeout = 20000) =>
  page.waitForFunction(fn, null, { timeout }).then(() => true).catch(() => {
    fail.push(`timed out waiting for ${what}`);
    return false;
  });
/** A layer's byte at (x, y) of the authored JSON (hex rows). */
const cell = (json, layer, x, y) => {
  const v = json[layer][y].split(/\s+/)[x];
  return v === '..' ? 0 : parseInt(v, 16);
};

// --- the editor on the default level ---
const page = await open(`${URL_BASE}${PAGE}?debug&nointro`);
await until(page, () => window.__level && window.__level.mode() === 'edit', 'the editor');
await until(page, () => window.__level.par().kind === 'done', 'the default level\'s par', 40000);
const par0 = await page.evaluate(() => window.__level.par());
if (!par0.ok) fail.push(`no par for the default level: ${JSON.stringify(par0)}`);
await page.screenshot({ path: join(out, 'default.png') });

// raise a 2 x 2 rectangle, then paint an enemy, through the UI
const before = await page.evaluate(() => window.__level.json());
await page.click('button[data-tool="select"]');
const a = await page.evaluate(() => window.__level.cellPoint(2, 1));
const b = await page.evaluate(() => window.__level.cellPoint(3, 2));
await page.mouse.move(a.x, a.y);
await page.mouse.down();
await page.mouse.move(b.x, b.y, { steps: 5 });
await page.mouse.up();
const selected = await page.evaluate(() => window.__level.selection().length);
if (selected !== 4) fail.push(`the rectangle selected ${selected} cells, not 4`);
await page.click('button[data-op="raise"]');
await page.click('button[aria-label="enemy $4C"]');
const c = await page.evaluate(() => window.__level.cellPoint(3, 6));
await page.mouse.click(c.x, c.y);
const edited = await page.evaluate(() => window.__level.json());
if (cell(edited, 'elev', 2, 1) !== cell(before, 'elev', 2, 1) + 1) fail.push('Raise did not raise (2, 1)');
if (cell(edited, 'tile', 3, 6) !== 0x4c) fail.push('Paint did not put $4C on (3, 6)');
await until(page, () => window.__level.par().kind === 'done', 'the edited level\'s par', 40000);
await page.waitForTimeout(600); // the iso preview's and the URL's delays
await page.screenshot({ path: join(out, 'edited.png') });
const editHash = await page.evaluate(() => location.hash);
if (!/^#l=[A-Za-z0-9_-]+&edit$/.test(editHash)) fail.push(`the editor's URL is not #l=...&edit: ${editHash}`);

// --- the share link plays the level ---
const shared = await page.evaluate(() => window.__level.shareUrl());
if (shared.includes('&edit') || !shared.includes('#l=')) fail.push(`the share link is not a play link: ${shared}`);
console.log(`share link: ${shared.length} characters`);
const [base, hash] = shared.split('#');
const player = await open(`${base}?debug&nointro#${hash}`);
await until(player, () => window.__engine && window.__engine.phase() === 'Aim', 'the shared level\'s aim');
const playedJson = await player.evaluate(() => window.__level.json());
if (await player.evaluate(() => window.__level.gate())) fail.push('the start screen showed with the audio already allowed');
if (JSON.stringify(playedJson) !== JSON.stringify(edited)) fail.push('the shared link plays another level');
await player.waitForTimeout(500);
await player.screenshot({ path: join(out, 'shared-play.png') });
const k0 = await player.evaluate(() => window.__engine.kirby());
for (const want of ['Spin', 'Power', 'Rolling']) {
  await player.keyboard.press('z');
  await player.waitForFunction((w) => window.__engine.phase() === w, want, { timeout: 8000 })
    .catch(() => fail.push(`timed out waiting for the ${want} stage`));
  await player.waitForTimeout(want === 'Spin' ? 900 : 400);
}
await player.waitForTimeout(1200);
const k1 = await player.evaluate(() => window.__engine.kirby());
if (!k0 || !k1 || (k0.x === k1.x && k0.y === k1.y)) fail.push(`the ball did not move: ${JSON.stringify(k0)} -> ${JSON.stringify(k1)}`);
await player.screenshot({ path: join(out, 'shared-roll.png') });
await player.click('#playbar button:first-child'); // Edit
await until(player, () => window.__level.mode() === 'edit', 'Edit from the play bar');
await until(player, () => location.hash.endsWith('&edit'), 'the editor\'s URL', 5000);
const back = await player.evaluate(() => ({ json: window.__level.json(), hash: location.hash, hidden: document.getElementById('game').hidden }));
if (JSON.stringify(back.json) !== JSON.stringify(edited)) fail.push('Edit did not bring the shared level back');
if (!back.hash.endsWith('&edit')) fail.push(`after Edit the URL is ${back.hash}`);
if (!back.hidden) fail.push('the game is still shown in the editor');
await player.screenshot({ path: join(out, 'shared-edit.png') });
await player.close();

// --- Play from the editor, QUIT, and E back ---
await page.click('text=▶ Play');
await until(page, () => window.__engine && window.__engine.phase() === 'Aim', 'Play from the editor');
const playHash = await page.evaluate(() => location.hash);
if (playHash.includes('&edit')) fail.push(`in play the URL still says edit: ${playHash}`);
await page.evaluate(() => window.__engine.freeze());
const step = (pad, n = 1) => page.evaluate(([p, k]) => window.__engine.step(p, k), [pad, n]);
await step(0, 4);
await step(PAD.START); await step(0, 2);
await step(PAD.DOWN); await step(0, 2);
await step(PAD.DOWN); await step(0, 2);
await step(PAD.A);
await page.evaluate(() => window.__engine.freeze(false));
await page.waitForTimeout(800);
await page.screenshot({ path: join(out, 'menu.png') });
await page.keyboard.press('e');
await until(page, () => window.__level.mode() === 'edit', 'E from the menu');
const again = await page.evaluate(() => window.__level.json());
if (JSON.stringify(again) !== JSON.stringify(edited)) fail.push('back in the editor the level changed');
await page.keyboard.press('Control+z');
const undone = await page.evaluate(() => window.__level.json());
if (cell(undone, 'tile', 3, 6) !== 0) fail.push('the undo history did not survive the play');
await page.close();

// --- the start screen: a browser that holds the audio until a gesture ---
// Chromium's default policy holds the audio until a user activation (measured
// 2026-11-16: --autoplay-policy=user-gesture-required let the context run)
const strict = await launch();
for (const how of ['click', 'Enter']) {
  const p = await strict.newPage({ viewport: { width: 1000, height: 760 } });
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  p.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  await p.goto(`${base}?debug&nointro#${hash}`);
  if (!(await until(p, () => window.__level && window.__level.gate(), `the start screen (${how})`))) continue;
  const held = await p.evaluate(() => ({ audio: window.__level.audio(), engine: !!window.__engine }));
  if (held.audio !== 'suspended') fail.push(`under the start screen the audio is ${held.audio}, not suspended`);
  if (held.engine) fail.push('a hole runs under the start screen');
  if (how === 'click') {
    // ready: the level's name, its picture, the button
    await until(p, () => document.querySelector('.gate-play')?.textContent?.includes('Click to play'), 'the start screen ready');
    const title = await p.evaluate(() => document.querySelector('.gate-title')?.textContent);
    if (title !== edited.name) fail.push(`the start screen names the level ${JSON.stringify(title)}, not ${JSON.stringify(edited.name)}`);
    await p.waitForTimeout(300);
    await p.screenshot({ path: join(out, 'gate.png') });
    await p.click('.gate-play');
  } else {
    // at once, maybe still loading: the key is kept and the level starts when ready
    await p.keyboard.press('Enter');
  }
  await until(p, () => window.__engine && window.__engine.phase() === 'Aim', `the level after the start screen (${how})`);
  const after = await p.evaluate(() => ({ audio: window.__level.audio(), gate: window.__level.gate(), pause: window.__engine.aimUi().pause }));
  if (after.audio !== 'running') fail.push(`after the ${how} the audio is ${after.audio}`);
  if (after.gate) fail.push(`the start screen stayed after the ${how}`);
  if (after.pause) fail.push(`the ${how} reached the hole (the pause menu is open)`);
  console.log(`start screen (${how}): ${JSON.stringify(held)} -> ${JSON.stringify(after)}`);
  await p.close();
}
await strict.close();

// --- a damaged link opens the editor ---
const broken = await open(`${URL_BASE}${PAGE}?debug&nointro#l=not!base64`);
await until(broken, () => window.__level && window.__level.mode() === 'edit', 'the editor after a damaged link');
const toast = await broken.evaluate(() => document.getElementById('toast')?.hidden === false);
if (!toast) fail.push('no message for a damaged link');
await broken.close();
await browser.close();

console.log(`default par ${par0.par}; kirby ${JSON.stringify(k0)} -> ${JSON.stringify(k1)}; screenshots in ${out}`);
const all = [...new Set([...problems, ...fail])];
if (all.length) {
  console.log(all.join('\n'));
  process.exit(1);
}
console.log('editor ok');
