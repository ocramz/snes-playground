import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { DIR, baseZ, edgeLevel, quadrant, stepAcross, surfaceZ } from '../src/core/terrain';
import { haveRomTest, haveRules, loadGolden, loadRomCourse, loadTables } from './fixtures';

const haveAll = haveRules && haveRomTest;

describe.skipIf(!haveRules)('quadrant ($81:9479)', () => {
  it('splits the cell by both diagonals, N E S W order', () => {
    expect(quadrant(0, 0)).toBe(0); // x+y < 1, x >= y -> N
    expect(quadrant(0x8000, 0x8000)).toBe(1); // x+y = 1, x >= y -> E
    expect(quadrant(0x8000, 0xffff)).toBe(2); // x+y >= 1, x < y -> S
    expect(quadrant(0, 0xffff)).toBe(3); // x+y < 1, x < y -> W
    expect(quadrant(0xffff, 0)).toBe(0); // x+y < 1, x >= y -> N
    expect(quadrant(0xffff, 0xffff)).toBe(1); // x+y >= 1 -> E
  });
});

describe.skipIf(!haveRules)('surfaceZ, documented numbers (docs/terrain.md)', () => {
  const rules = new RomRules(loadTables());

  it('a gap reports ground Z 0 and stops nothing', () => {
    expect(surfaceZ(rules, 0, 0, 0, 0)).toBe(0);
    expect(surfaceZ(rules, 0, 5, 0x8000, 0x8000)).toBe(0);
  });

  it('a flat cell tops out one step above its base ($81:9534)', () => {
    expect(surfaceZ(rules, 1, 0, 0, 0)).toBe(0x5a82);
    expect(surfaceZ(rules, 1, 0, 0xffff, 0xffff)).toBe(0x5a82);
    expect(surfaceZ(rules, 1, 2, 0x8000, 0x8000)).toBe(3 * 0x5a82);
  });

  it('the $06 ramp at elevation 1 descends ~2.0 -> ~1.0 steps in +y', () => {
    // hole 0 cell (5,0). The doc's probe prints 1.999 at y=0: the ramp tops
    // out at ramp[0xFFFF >> 7], one table step under a full $5A82.
    expect(surfaceZ(rules, 0x06, 1, 0x8000, 0)).toBe(0x5a82 + rules.ramp(0xffff >> 7));
    const low = surfaceZ(rules, 0x06, 1, 0x8000, 0xffff);
    expect(low).toBe(0x5a82 + rules.ramp(0)); // ~1.001 steps, flush-ish with the interior
  });

  it('edge levels are 2 x elevation + the edge byte, half steps ($81:925E)', () => {
    expect(edgeLevel(rules, 1, 3, DIR.N)).toBe(2 * 3 + 2);
    // the $06 ramp: edges 2 1 0 1
    expect([DIR.N, DIR.E, DIR.S, DIR.W].map((d) => edgeLevel(rules, 0x06, 1, d))).toEqual([4, 3, 2, 3]);
  });

  it('stepAcross: zero is flush, positive a step up, negative a drop', () => {
    // flat elevation 0 -> flat elevation 1: a one-step (2 half steps) wall
    expect(stepAcross(rules, 1, 0, 1, 1, DIR.N)).toBe(2);
    // and back down: a drop
    expect(stepAcross(rules, 1, 1, 1, 0, DIR.S)).toBe(-2);
    // the ramp joins its lower neighbour flush (hole 0: (5,1) N into (5,0))
    expect(stepAcross(rules, 1, 0, 0x06, 1, DIR.N)).toBe(0);
  });
});

describe.skipIf(!haveAll)('surfaceZ against the golden fixture (tools/terrain.py)', () => {
  it('matches Tables.surface_z on every cell x fraction^2 of hole 0', () => {
    const rules = new RomRules(loadTables());
    const course = loadRomCourse();
    const golden = loadGolden();
    expect([course.w, course.h]).toEqual([golden.w, golden.h]);
    const fracs = golden.fracs;
    let i = 0;
    let checked = 0;
    for (let cell = 0; cell < golden.w * golden.h; cell++) {
      const shape = course.shape[cell];
      const elev = course.elev[cell];
      for (const yf of fracs) {
        for (const xf of fracs) {
          const got = surfaceZ(rules, shape, elev, xf, yf);
          const want = golden.z[i++];
          if (got !== want) {
            const x = cell % golden.w;
            const y = Math.floor(cell / golden.w);
            throw new Error(
              `cell (${x},${y}) shape $${shape.toString(16)} elev ${elev} ` +
              `at ($${xf.toString(16)},$${yf.toString(16)}): golden ${want}, port ${got}`,
            );
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(golden.z.length);
  });

  it('baseZ reads Z(h) = h x $5A82 as a 32-bit value', () => {
    const rules = new RomRules(loadTables());
    expect(baseZ(rules, 0)).toBe(0);
    expect(baseZ(rules, 15)).toBe(15 * 0x5a82);
  });
});
