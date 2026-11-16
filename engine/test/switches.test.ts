/**
 * The switches and the swirls (sim/switches.ts, systems/switches.ts) against
 * the recordings of test/switch-scenarios.ts, on the game's iterations from
 * the poke (the frame helper's calls, iters_<name>.json; the engine's
 * `run.iters`), as the copy abilities' sounds are compared:
 *
 * - `$6A2A`, `$6A2C` and `$69CA` (trace_flow.py `togon`, `swlatch`,
 *   `wateroff`), written in the step: an event's iteration is the helper
 *   call that ends its body (`bodyOf`).
 * - the threads' writes, in the helper call itself (the one before
 *   `bodyOf`): objects 117 and 118's colours (CGRAM 78 and 94, `sw117`,
 *   `sw118`) and object 127's uploads (the records `$84:DC80` + 9 x i,
 *   iters' `uploads`). Their phase at the hole's start is the load's, which
 *   the engine does not reproduce, so each object is set to the game's
 *   state at the poke and must follow it from there.
 * - Kirby's state `$D7D4` in the water switch's two scenarios: the squash
 *   of a hard landing, held through the block.
 * - the block: 64 iterations of `waterSwitch`, one dissolve step each.
 */
import { describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { haveRules, haveRomTest, loadFlow, loadRomHole, loadTables, loadTrace } from './fixtures';
import { runFlowScript } from './flow-harness';
import { bodyOf, loadIters } from './demo-harness';
import { SWITCH_SCENARIOS } from './switch-scenarios';
import { Switches } from '../src/core/traits/switches';
import { BallWork } from '../src/core/traits/ball';
import { Pose } from '../src/core/traits/pose';
import { Stall } from '../src/core/traits/stall';
import { activePlayer } from '../src/core/traits/player';
import { swirlDisc } from '../src/core/sim/switches';
import { RomRules } from '../src/core/rules';
import { emptyWork } from '../src/core/traits/ball';
import type { Ctx } from '../src/core/sim/context';
import { applyDissolve, dissolveMap, waterShown } from '../src/game/features/layers/dissolve';

interface Sample {
  toggleOn: number;
  latch: number;
  waterOff: number;
  c117: number;
  c118: number;
  anims: number[];
  pose: number;
  stall: string;
  step: number;
}

const RECORDS = 0xdc80;
const RECORD_SIZE = 9;

describe.skipIf(!haveRules || !haveRomTest)('the switches vs the recorded game', () => {
  const rules = haveRules ? new RomRules(loadTables()) : null;
  const colour = (table: string, base: number, set: number): number => rules!.table(table)[(base + set) * 4 + 2];
  /** CGRAM 78: object 117's set by $6A2A (on: sets 0-1, off: 2-3). */
  const c117 = (on: number, set: number): number => colour('toggleSwitchColours', on !== 0 ? 0 : 2, set);
  /** CGRAM 94: object 118's set by $69CA (off: sets 0-1, on: 2-3). */
  const c118 = (off: number, set: number): number => colour('waterSwitchColours', off !== 0 ? 0 : 2, set);

  for (const s of SWITCH_SCENARIOS) {
    it.skipIf(!loadTrace(s.name) || !loadRomHole(s.hole) || !loadIters(s.name)?.uploads)(`${s.name}`, () => {
      const iters = loadIters(s.name)!;
      const flow = loadFlow(s.name)!;
      const b0 = bodyOf(iters.entries, s.from, 200);
      const kTo = bodyOf(iters.entries, s.to, 200) - b0;
      const body = (f: number, ln: number): number => bodyOf(iters.entries, f, ln) - b0;
      const thread = (f: number, ln: number): number => body(f, ln) - 1;

      // the game's timelines: [tick, value], in order
      const flowOf = (k: string, at: (f: number, ln: number) => number): Array<[number, number]> =>
        flow.events.filter((e) => e[1] === k).map((e) => [at(e[0], e[3] ?? 0), Number(e[2])]);
      const toggleOn = flowOf('togon', body);
      const latch = flowOf('swlatch', body);
      const waterOff = flowOf('wateroff', body);
      const pose = flowOf('state', body);
      const g117 = flowOf('sw117', thread);
      const g118 = flowOf('sw118', thread);
      const uploads: Array<[number, number, number]> = iters.uploads!
        .filter((u) => u[3] === '$84:DBF5' || u[3] === '$84:DC41')
        .map((u) => {
          const i = (u[2] - RECORDS) / RECORD_SIZE;
          return [thread(u[0], u[1]), Math.floor(i / 10), i % 10];
        });
      const at = (l: Array<[number, number]>, t: number): number | undefined => {
        let v: number | undefined;
        for (const [k, x] of l) if (k <= t) v = x;
        return v;
      };

      // the threads set to the game's state at tick 0 (the poke's)
      const has = { toggle: false, water: false };
      const align = (world: World): void => {
        const sw = world.get(Switches)!;
        has.toggle = sw.toggle !== null; // CGRAM 78 / 94 are others' on the holes without the switch
        has.water = sw.water !== null;
        const w = activePlayer(world).get(BallWork)!;
        const setColours = (c: NonNullable<typeof sw.toggle>, l: Array<[number, number]>, of: (on: number, set: number) => number, on: number): void => {
          const last = [...l].reverse().find(([k]) => k <= 0);
          if (!last) return;
          const set = [0, 1].find((x) => of(on, x) === last[1]);
          if (set === undefined) return;
          c.on = on;
          c.shown = set;
          c.next = set ^ 1;
          c.wait = 4 + last[0];
        };
        if (sw.toggle) setColours(sw.toggle, g117, c117, w.toggleOn);
        if (sw.water) setColours(sw.water, g118, c118, w.waterOff);
        for (const a of sw.anims) {
          const last = [...uploads].reverse().find(([k, list]) => k <= 0 && list === a.list);
          if (!last) continue;
          a.frame = last[2];
          a.wait = ((a.pair & 1) === 0 ? 4 : 6) + last[0];
        }
      };

      const samples = new Map<number, Sample>();
      const run = runFlowScript(s.name, s.to - s.offset + 20, {
        hole: s.hole, offset: s.offset, pokes: true,
        until: (world, gameFrame) => {
          if (gameFrame === s.from) align(world);
          const e = activePlayer(world);
          const w = e.get(BallWork)!;
          const sw = world.get(Switches)!;
          samples.set(gameFrame, {
            toggleOn: w.toggleOn,
            latch: w.switchLatch,
            waterOff: w.waterOff,
            c117: sw.toggle && sw.toggle.shown >= 0 ? c117(sw.toggle.on, sw.toggle.shown) : -1,
            c118: sw.water && sw.water.shown >= 0 ? c118(sw.water.on, sw.water.shown) : -1,
            anims: sw.anims.map((a) => a.frame),
            pose: e.get(Pose)!.state,
            stall: world.get(Stall)!.kind,
            step: sw.dissolve.step,
          });
          return false;
        },
      });
      try {
        const e0 = run.iters[s.from - s.offset - 1];
        // the engine's state at the end of each tick (its last frame)
        const byTick = new Map<number, Sample>();
        for (const [gameFrame, smp] of samples) {
          const k = run.iters[gameFrame - s.offset - 1] - e0;
          if (k >= 1 && k <= kTo) byTick.set(k, smp);
        }
        const bad: string[] = [];
        const check = (what: string, l: Array<[number, number]>, get: (x: Sample) => number, from = 1): void => {
          for (let t = from; t <= kTo; t++) {
            const want = at(l, t);
            const got = byTick.get(t);
            if (want === undefined || got === undefined) continue;
            if (get(got) !== want) {
              bad.push(`${what} at +${t}: game ${want}, engine ${get(got)}`);
              return;
            }
          }
        };
        check('$6A2A', toggleOn, (x) => x.toggleOn);
        check('$6A2C', latch, (x) => x.latch);
        check('$69CA', waterOff, (x) => x.waterOff);
        if (has.toggle) check('object 117', g117, (x) => x.c117);
        if (has.water) check('object 118', g118, (x) => x.c118);
        const lists = new Set(uploads.map((u) => u[1]));
        for (const list of lists) {
          const l = uploads.filter((u) => u[1] === list).map((u): [number, number] => [u[0], u[2]]);
          check(`object 127 (list ${list})`, l, (x) => x.anims[list] ?? -2);
        }
        if (s.name.startsWith('web_sw_water')) check('$D7D4', pose, (x) => x.pose);
        expect(bad).toEqual([]);

        // the block: 64 iterations, one dissolve step each, the last resuming the step
        if (s.name.startsWith('web_sw_water')) {
          const ticks = [...byTick.entries()].sort((a, b) => a[0] - b[0]);
          const blocked = ticks.filter(([, x]) => x.stall === 'waterSwitch');
          // the request's F (step 0), idle F+1..F+63 (steps 1-63); F+64 the last step and the resumed step
          expect(blocked.length).toBe(64);
          const first = blocked[0][0];
          expect(blocked.map(([k, x]) => [k - first, x.step])).toEqual(blocked.map((_, i) => [i, i]));
          expect(byTick.get(first + 64)).toMatchObject({ step: 64, stall: 'none' });
        }
      } finally {
        run.world.destroy();
      }
    });
  }
});

describe.skipIf(!haveRules)('the swirls\' disc and push', () => {
  const rules = haveRules ? new RomRules(loadTables()) : null;
  const ctx = (): Ctx => ({ rules: rules!, course: {} } as unknown as Ctx);
  const at = (xf: number, yf: number) => Object.assign(emptyWork(), { xf, yf });

  it('the disc $88:9190: the centre and the rim, and a fraction of 0 past its last row', () => {
    expect(swirlDisc(ctx(), at(0x8000, 0x8000))).toEqual({ inside: true, byte: 0xff });
    expect(swirlDisc(ctx(), at(0x8000, 0x0900)).inside).toBe(true); // |dy| $7700: row 59, the rim
    expect(swirlDisc(ctx(), at(0x8000, 0x0700)).inside).toBe(false); // |dy| $7900: row 60
    expect(swirlDisc(ctx(), at(0x0900, 0x0900)).inside).toBe(false); // a corner
    // row 64 (yf 0) reads the bytes after the bitmap
    expect(swirlDisc(ctx(), at(0x8000, 0x0000)).byte).toBe(rules!.table('toggleDisc')[512]);
  });
});

describe('the water\'s dissolve as the view draws it (features/layers/dissolve.ts)', () => {
  // two water pixels (steps 0 and 63) and a dry one, 3 x 1
  const map = dissolveMap(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 63, 0, 0, 255]), 3);
  const orig = new Uint8ClampedArray([1, 2, 3, 200, 9, 9, 9, 50, 4, 5, 6, 255]);

  it('reads the map\'s water pixels and their box', () => {
    expect([...map.index]).toEqual([0, 2]);
    expect([...map.step]).toEqual([0, 63]);
    expect([map.x0, map.y0, map.x1, map.y1]).toEqual([0, 0, 2, 0]);
  });

  it('a pixel comes once its step is done, and goes the same way; the others are left alone', () => {
    const out = new Uint8ClampedArray(orig);
    const alpha = (): number[] => [out[3], out[7], out[11]];
    applyDissolve(map, orig, out, 0, true);
    expect(alpha()).toEqual([0, 50, 0]);
    applyDissolve(map, orig, out, 1, true);
    expect(alpha()).toEqual([200, 50, 0]);
    applyDissolve(map, orig, out, 64, true);
    expect(alpha()).toEqual([200, 50, 255]);
    applyDissolve(map, orig, out, 1, false);
    expect(alpha()).toEqual([0, 50, 255]);
    applyDissolve(map, orig, out, 64, false);
    expect(alpha()).toEqual([0, 50, 0]);
    expect(waterShown(63, 63, true)).toBe(false);
  });
});
