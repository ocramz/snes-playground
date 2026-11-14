// The camera against what the real game's camera did on web_flow (hole 1: an aim
// sweep, a grounder, the roll), recorded by tools/snesstep/trace_flow.py:
// `$38AC/$38AE` and the aim camera's target `$6AAA/$6AAC`, per frame.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bareWorld, haveAssets, loadRom, readJson } from '../../../test/load';
import { Camera, SHOT_VIEW_X, SHOT_VIEW_Y } from '../camera';
import { computeGuide } from '../guide';
import { HoleSim, SPIN_READY, emptyPad, type Pad } from '../hole';

const flowPath = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../build/web-test/flow_web_flow.json');
const haveFlow = existsSync(flowPath);
const H = 456;

interface Flow { events: [number, string, number][] }

function series(flow: Flow): (name: string, f: number) => number {
  const by: Record<string, [number, number][]> = {};
  for (const [f, n, v] of flow.events) (by[n] ??= []).push([f, v]);
  return (name, f) => {
    let v = 0;
    for (const [fr, x] of by[name] ?? []) { if (fr <= f) v = x; else break; }
    return v;
  };
}

describe('Camera.pan', () => {
  it('steps like $81:BA8A: up to 10 px in x and 5 in y, (|d| >> 3) + 1', () => {
    const c = new Camera(H);
    c.x = 192; c.y = 304;
    // focus (408, 147): camera x target 280, y target 259
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < 12; i++) { c.pan(408, 147); xs.push(c.x); ys.push(c.y); }
    expect(xs.slice(0, 4)).toEqual([202, 212, 221, 229]);
    expect(ys.slice(0, 4)).toEqual([299, 294, 289, 285]);
    for (let i = 0; i < 40; i++) c.pan(408, 147);
    expect([c.x, c.y]).toEqual([280, 259]);
    expect(c.pan(408, 147)).toBe(true); // already there
  });
});

describe.skipIf(!haveFlow)('against the recorded camera', () => {
  const flow = readJson<Flow>(flowPath);
  const val = series(flow);

  it('aim stage: the same camera, frame for frame, from the hole start to the first aim turn', () => {
    // while the aim turns the game runs a loop every third frame (it simulates the guide), so
    // only the approach before the first turn is frame exact
    const c = new Camera(H);
    c.x = val('cx38', 2335); c.y = val('cy38', 2335);
    let worst = 0, n = 0;
    // the recorded camera shows each step two frames after the target it used
    for (let f = 2336; f < 2352; f++) {
      c.pan(val('tgtx', f), val('tgty', f));
      worst = Math.max(worst, Math.abs(c.x - val('cx38', f + 2)), Math.abs(c.y - val('cy38', f + 2)));
      n += 1;
    }
    expect(n).toBe(16);
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('the shot view: Kirby plus the quarter offset, the same steps until it arrives', () => {
    // web_flow confirms the aim at 2800 with the aim at 328 degrees: quarter 3
    const aim = val('aim', 2799);
    const q = aim >= 270 ? 3 : aim >= 180 ? 2 : aim >= 90 ? 1 : 0;
    const kx = val('kx', 2799), ky = val('ky', 2799);
    const c = new Camera(H);
    c.x = val('cx38', 2799); c.y = val('cy38', 2799);
    const mine: string[] = [`${c.x},${c.y}`];
    let calls = 0, arrived = false;
    while (!arrived && calls < 60) {
      arrived = c.pan(kx + SHOT_VIEW_X[q], ky + SHOT_VIEW_Y[q]);
      calls += 1;
      mine.push(`${c.x},${c.y}`);
    }
    // every position the real camera passed through is one of mine, in order (the game
    // sometimes takes two steps in a frame, so it skips some)
    const real: string[] = [];
    for (let f = 2800; f < 2830; f++) {
      const p = `${val('cx38', f)},${val('cy38', f)}`;
      if (real[real.length - 1] !== p) real.push(p);
    }
    let at = 0;
    for (const p of real) {
      const i = mine.indexOf(p, at);
      expect(i, `real camera position ${p}`).toBeGreaterThanOrEqual(0);
      at = i;
    }
    // and the curl (state 6) starts on the call that finds the camera already there
    const curl = flow.events.find((e) => e[1] === 'state' && e[2] === 6 && e[0] > 2800)![0];
    expect(Math.abs(2800 + 5 + calls - 1 - curl)).toBeLessThanOrEqual(2);
  });

  it('follows the roll within a few pixels of the real camera', () => {
    const { rom, course } = loadRom();
    const sim = new HoleSim(rom, course);
    const none = emptyPad();
    const step = (pad: Pad): void => sim.tick(pad);
    // the same presses as web_flow: aim 328, A, wait for the panel, A, A at meter 55
    sim.aim = 328; // the sweep ends at 328 degrees on the real game
    for (let i = 0; i < 40; i++) step(none);
    step({ ...none, a: true });
    while (sim.shotAge < SPIN_READY + 2) step(none);
    step({ ...none, a: true });
    while (sim.meter < 54) step(none);
    step({ ...none, a: true });
    while (sim.stage !== 'roll') step(none);
    // align on the launch: 2984 is the first frame of the roll on the real game
    const launch = flow.events.find((e) => e[1] === 'state' && e[2] === 14 && e[0] > 2900)![0];
    let worst = 0;
    const rows: string[] = [];
    for (let i = 0; i < 400 && sim.stage === 'roll'; i++) {
      const f = launch + i;
      const dx = Math.abs(sim.camera.x - val('cx38', f)), dy = Math.abs(sim.camera.y - val('cy38', f));
      worst = Math.max(worst, dx, dy);
      if (i % 40 === 0 || Math.max(dx, dy) > 6) rows.push(`${i}:${dx},${dy}`);
      step(none);
    }
    // report, not a tight bound: the ball's own path matters here
    console.log('follow camera, worst difference', worst, rows.join(' '));
    expect(worst).toBeLessThanOrEqual(8);
  });
});

describe.skipIf(!haveAssets || !haveFlow)('the guide', () => {
  const { rom, course, terrain } = loadRom();
  const flow = readJson<Flow>(flowPath);
  const val = series(flow);
  it('ends where the real game points the aim camera (110 aim angles, 1 px)', () => {
    const world = bareWorld(terrain);
    let n = 0, bad = 0;
    const seen = new Set<number>();
    for (let f = 2340; f < 2680; f++) {
      const a = val('aim', f);
      if (val('aim', f - 1) === a || seen.has(a)) continue;
      seen.add(a);
      const g = computeGuide(rom, world, course.word7, { xc: 6, xf: 0x8000, yc: 3, yf: 0x8000, aim: ((a % 360) + 360) % 360, elevation: 0, side: 6, topBack: 6 });
      const tx = val('tgtx', f + 2), ty = val('tgty', f + 2);
      const dx = Math.floor(g.end.x) - tx, dy = Math.floor(H - g.end.y) - ty;
      n += 1;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) bad += 1;
    }
    expect(n).toBeGreaterThan(100);
    // aims 220-229 end 3-4 px higher than the game's, and aim 256 (off by 20) runs into the
    // pillar, which is only approximated; every other aim is within 1 px
    expect(bad).toBeLessThanOrEqual(5);
  });

  it('a fly shot ends at its first landing: (440, 324) for aim 0 from the tee', () => {
    const world = bareWorld(terrain);
    const g = computeGuide(rom, world, course.word7, { xc: 6, xf: 0x8000, yc: 3, yf: 0x8000, aim: 0, elevation: 60, side: 6, topBack: 6 });
    expect(Math.floor(g.end.x)).toBe(440);
    expect(Math.floor(g.end.y)).toBe(324);
  });
});
