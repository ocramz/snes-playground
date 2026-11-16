/**
 * The level editor's corner model (src/core/level/corners.ts): every solid
 * shape is four corner heights whose pairwise sums are $81:9310's edge
 * levels, and `classify` turns the corners back into the shape.
 */
import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables } from './fixtures';
import { classify, cornersOf, rotate, shapeCorners, type Corners } from '../src/core/level/corners';

const SOLID = Array.from({ length: 0x1b }, (_, i) => i + 1);

describe('the corner model', () => {
  it('a rotation steps every family by one', () => {
    for (const base of [0x04, 0x08, 0x0c, 0x10, 0x14, 0x18]) {
      for (let r = 0; r < 4; r++) expect(shapeCorners(base + ((r + 1) & 3))).toEqual(rotate(shapeCorners(base + r)!));
    }
  });

  it('classify inverts cornersOf for every shape and elevation', () => {
    for (const s of SOLID) {
      for (let e = 0; e <= 15; e++) {
        const c = cornersOf(s, e)!;
        const r = classify(c, { prev: s });
        expect(r, `$${s.toString(16)} at ${e}`).toEqual({ shape: s, elev: e });
      }
    }
  });

  it('a flat top is 1-16 steps; a ramp\'s foot 0-15', () => {
    expect(classify([0, 0, 0, 0])).toBeNull();
    expect(classify([1, 1, 1, 1])).toEqual({ shape: 0x01, elev: 0 });
    expect(classify([16, 16, 16, 16])).toEqual({ shape: 0x01, elev: 15 });
    expect(classify([17, 17, 17, 17])).toBeNull();
    expect(classify([0, 0, 1, 1])).toEqual({ shape: 0x04, elev: 0 });
    expect(classify([16, 16, 17, 17])).toBeNull();
  });

  it('saddles and jumps of two have no shape', () => {
    expect(classify([1, 0, 1, 0])).toBeNull();
    expect(classify([0, 0, 2, 2])).toBeNull();
    expect(classify([0, 2, 2, 2])).toBeNull();
  });

  it('new corner cells are faceted unless asked; old ones keep their family', () => {
    const c = cornersOf(0x0c, 3)!;
    expect(classify(c)?.shape).toBe(0x0c);
    expect(classify(c, { diagonal: true })?.shape).toBe(0x14);
    expect(classify(c, { prev: 0x14 })?.shape).toBe(0x14);
    expect(classify(c, { prev: 0x0d, diagonal: true })?.shape).toBe(0x0c);
    expect(classify(cornersOf(0x01, 2)!, { prev: 0x02 })).toEqual({ shape: 0x02, elev: 3 });
  });
});

describe.skipIf(!haveRules)('the corners against the ROM\'s edge table', () => {
  const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);

  it('$81:9310: each edge level is the sum of its two corners', () => {
    for (const s of SOLID) {
      const c = shapeCorners(s) as Corners;
      const edges = [c[0] + c[1], c[1] + c[2], c[2] + c[3], c[3] + c[0]];
      expect([0, 1, 2, 3].map((d) => rules.terrainEdge(s, d)), `$${s.toString(16)}`).toEqual(edges);
    }
  });
});
