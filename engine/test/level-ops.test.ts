/**
 * The level editor's operations (src/core/level/ops.ts): raising and
 * lowering on flat ground make HoleGrid's hill and pit stamps, raise and
 * lower undo each other, a cliff's border is all steps, blend bridges a
 * gutter flush, and the markings follow their cells' shapes.
 */
import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables } from './fixtures';
import { HoleGrid } from '../src/core/gen/grid';
import {
  autoFence, blend, clearWalls, cropToContent, dig, eraseTile, fill, flatten, paintTile, raise, resize, setShape,
  toggleWall, type Level,
} from '../src/core/level/ops';
import { floorAt, rectCells } from '../src/core/level/select';
import { WATER, adaptTile, placementError } from '../src/core/level/palette';
import { cornersOf } from '../src/core/level/corners';
import { lintLevel } from '../src/core/level/lint';
import { defaultLevel } from '../src/core/level/default-level';

function field(w: number, h: number, elev: number): Level {
  const g = new HoleGrid(w, h);
  g.rect(0, 0, w - 1, h - 1, { shape: 0x01, elev });
  return { name: 'T', grid: g };
}

const layers = (l: Level): number[][] => [Array.from(l.grid.shape), Array.from(l.grid.elev), Array.from(l.grid.walls), Array.from(l.grid.tile)];

describe('raise and lower', () => {
  it('raising one cell of flat ground makes the hill stamp', () => {
    const l = field(5, 5, 0);
    const r = raise(l, new Set([l.grid.at(2, 2)]), 1, 'slope');
    const want = field(5, 5, 0).grid;
    want.hill(2, 2, 1);
    expect(Array.from(r.level.grid.shape)).toEqual(Array.from(want.shape));
    expect(Array.from(r.level.grid.elev)).toEqual(Array.from(want.elev));
    expect(r.notice).toBeUndefined();
  });

  it('lowering one cell of flat ground makes the pit stamp', () => {
    const l = field(5, 5, 1);
    const r = raise(l, new Set([l.grid.at(2, 2)]), -1, 'slope');
    const want = field(5, 5, 1).grid;
    want.pit(2, 2, 1);
    expect(Array.from(r.level.grid.shape)).toEqual(Array.from(want.shape));
    expect(Array.from(r.level.grid.elev)).toEqual(Array.from(want.elev));
  });

  it('the input level is never changed', () => {
    const l = field(5, 5, 0);
    const before = layers(l);
    raise(l, rectCells(l.grid, 1, 1, 3, 3), 1, 'slope');
    expect(layers(l)).toEqual(before);
  });

  for (const mode of ['slope', 'cliff'] as const) {
    it(`${mode}: raising then lowering a region is the identity`, () => {
      const l = field(8, 7, 2);
      const sel = rectCells(l.grid, 2, 2, 5, 4);
      const up = raise(l, sel, 1, mode).level;
      expect(layers(up)).not.toEqual(layers(l));
      const down = raise(up, sel, -1, mode).level;
      expect(layers(down)).toEqual(layers(l));
    });
  }

  it('the terrace keeps moving: a raised floor section raises again with its slopes', () => {
    const l = field(9, 9, 0);
    const sel = rectCells(l.grid, 3, 3, 5, 5);
    const once = raise(l, sel, 1, 'slope').level;
    const twice = raise(once, sel, 1, 'slope');
    // the ring's ramps had their high side on the terrace: they would need a jump of two
    expect(twice.notice).toMatch(/could not slope/);
    expect(twice.level.grid.elev[twice.level.grid.at(4, 4)]).toBe(2);
  });

  it('cannot lower below the ground or raise above elevation 15', () => {
    const low = field(5, 5, 0);
    const r = raise(low, new Set([low.grid.at(2, 2)]), -1, 'cliff');
    expect(r.changed).toBe(false);
    expect(r.notice).toMatch(/can't lower/);
    const high = field(5, 5, 15);
    expect(raise(high, new Set([high.grid.at(2, 2)]), 1, 'cliff').changed).toBe(false);
  });

  it('a raised floor drags the flush ground beside it but not across a cliff', () => {
    const l = field(7, 3, 1);
    // a cliff: cells x >= 4 one step lower
    for (let y = 0; y < 3; y++) for (let x = 4; x < 7; x++) l.grid.elev[l.grid.at(x, y)] = 0;
    const r = raise(l, rectCells(l.grid, 0, 0, 3, 2), 1, 'slope').level;
    // the lower terrace is not flush with the raised one: it stays as it was
    for (let y = 0; y < 3; y++) expect(r.grid.shape[r.grid.at(4, y)]).toBe(0x01);
    expect(r.grid.elev[r.grid.at(0, 1)]).toBe(2);
  });
});

describe.skipIf(!haveRules)('steps and blending', () => {
  const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);

  it('slope mode leaves no step on flat ground; cliff mode steps the whole border', () => {
    const l = field(9, 8, 1);
    const sel = rectCells(l.grid, 3, 3, 5, 4);
    expect(raise(l, sel, 1, 'slope').level.grid.edgeDeltas(rules)).toEqual([]);
    const cliff = raise(l, sel, 1, 'cliff').level.grid.edgeDeltas(rules);
    // the 3x2 block's border: 3 + 3 edges along x, 2 + 2 along y
    expect(cliff).toHaveLength(10);
    expect(cliff.every((e) => Math.abs(e.delta) === 2)).toBe(true);
  });

  it('blend bridges a gutter between two terraces with flush ramps', () => {
    const g = new HoleGrid(5, 7);
    g.rect(0, 0, 4, 1, { shape: 0x01, elev: 2 }); // top 3
    g.rect(0, 5, 4, 6, { shape: 0x01, elev: 0 }); // top 1
    const l: Level = { name: 'T', grid: g };
    const r = blend(l, rectCells(g, 0, 2, 4, 4));
    expect(r.notice).toBeUndefined();
    expect(r.level.grid.edgeDeltas(rules)).toEqual([]);
    for (let y = 2; y <= 4; y++) expect(r.level.grid.solid(2, y)).toBe(true);
    expect(r.level.grid.shape[r.level.grid.at(2, 2)]).toBe(0x06); // falls S
  });

  it('the default level is valid and flush but for nothing', () => {
    const lint = lintLevel(defaultLevel(), rules);
    expect(lint.issues.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(lint.ok).toBe(true);
    expect(lint.steps).toEqual([]);
  });
});

describe('the other operations', () => {
  it('floor select takes the terrace, not its slopes', () => {
    const l = field(9, 9, 0);
    const up = raise(l, rectCells(l.grid, 3, 3, 5, 5), 1, 'slope').level;
    expect(floorAt(up.grid, 4, 4)).toEqual(rectCells(up.grid, 3, 3, 5, 5));
    expect(floorAt(up.grid, 0, 0).size).toBe(9 * 9 - 25);
    expect(floorAt(up.grid, 2, 4)).toEqual(new Set([up.grid.at(2, 4)])); // a ramp alone
  });

  it('dig, fill, flatten, setShape', () => {
    const l = field(6, 4, 1);
    const sel = rectCells(l.grid, 2, 1, 3, 2);
    const dug = dig(l, sel).level;
    expect(dug.grid.solid(2, 1)).toBe(false);
    const filled = fill(dug, sel).level;
    expect(layers(filled)).toEqual(layers(l));
    const flat = flatten(raise(l, sel, 1, 'slope').level, rectCells(l.grid, 0, 0, 5, 3), 2);
    expect(layers(flat.level)).toEqual(layers(l));
    const ramp = setShape(l, new Set([0]), 0x05, 3).level;
    expect([ramp.grid.shape[0], ramp.grid.elev[0]]).toEqual([0x05, 3]);
  });

  it('walls: two-sided between ground, one-sided at the border; fence and clear', () => {
    const l = field(4, 4, 0);
    const a = toggleWall(l, 1, 1, 1).level; // E of (1,1)
    expect(a.grid.walls[a.grid.at(1, 1)]).toBe(0b0010);
    expect(a.grid.walls[a.grid.at(2, 1)]).toBe(0b1000);
    expect(layers(toggleWall(a, 2, 1, 3).level)).toEqual(layers(l));
    const b = toggleWall(l, 0, 0, 0).level;
    expect(b.grid.walls[0]).toBe(0b0001);
    const fenced = autoFence(l).level;
    expect(fenced.grid.walls[0]).toBe(0b1001);
    expect(layers(clearWalls(fenced).level)).toEqual(layers(l));
  });

  it('resize grows with gaps and crop cuts back', () => {
    const l = field(5, 4, 0);
    const big = resize(l, { n: 2, e: 1, s: 0, w: 3 }).level;
    expect([big.grid.w, big.grid.h]).toEqual([9, 6]);
    expect(big.grid.solid(3, 2)).toBe(true);
    expect(big.grid.solid(2, 2)).toBe(false);
    expect(layers(cropToContent(big).level)).toEqual(layers(l));
    expect(resize(l, { e: 40 }).changed).toBe(false);
  });
});

describe('the palette', () => {
  it('places tiles only where the ROM does', () => {
    expect(placementError(0x0c, 0x01)).toBeNull();
    expect(placementError(0x0c, 0x04)).not.toBeNull();
    expect(placementError(0x40, 0x05)).toBeNull();
    expect(placementError(0x40, 0x06)).not.toBeNull();
    expect(placementError(0x21, 0x05)).toBeNull();
    expect(placementError(0x21, 0x06)).not.toBeNull();
    expect(placementError(0x36, 0x05)).toBeNull();
    expect(placementError(WATER, 0x0f)).toBeNull();
    expect(placementError(WATER, 0x10)).not.toBeNull();
    expect(placementError(0x80, 0x01)).not.toBeNull();
  });

  it('the tee moves, enemies stop at 16, the water takes the shape', () => {
    let l = field(6, 6, 1);
    l = paintTile(l, new Set([0]), 0x0c).level;
    l = paintTile(l, new Set([7]), 0x0c).level;
    expect(l.grid.tile[0]).toBe(0);
    expect(l.grid.tile[7]).toBe(0x0c);
    const many = paintTile(l, rectCells(l.grid, 0, 2, 5, 5), 0x4b);
    expect(Array.from(many.level.grid.tile).filter((t) => t === 0x4b)).toHaveLength(16);
    expect(many.notice).toMatch(/at most 16/);
    const pond = raise(field(5, 5, 1), new Set([12]), -1, 'slope').level;
    const wet = paintTile(pond, rectCells(pond.grid, 1, 1, 3, 3), WATER).level;
    expect(wet.grid.tile[12]).toBe(0x61);
    expect(wet.grid.tile[pond.grid.at(2, 1)]).toBe(0x60 + pond.grid.shape[pond.grid.at(2, 1)]);
    expect(eraseTile(wet, rectCells(wet.grid, 0, 0, 4, 4)).level.grid.tile.every((t) => t === 0)).toBe(true);
  });

  it('markings follow a re-shaped cell or go', () => {
    expect(adaptTile(0x20, 0x06)).toBe(0x22); // ice follows the fall
    expect(adaptTile(0x22, 0x01)).toBe(0x24);
    expect(adaptTile(0x34, 0x07)).toBe(0x3a); // the ramp boost keeps pointing uphill
    expect(adaptTile(0x34, 0x01)).toBe(0x32); // pushing S on flat ground
    expect(adaptTile(0x64, 0x01)).toBe(0x61);
    expect(adaptTile(0x10, 0x05)).toBe(0); // a kicker only on flat ground
    expect(adaptTile(0x4a, 0x07)).toBe(0x4a); // actors stay: lint reports them
    // raising under an ice patch: the ring's ramps take the ice of their fall
    let l = field(5, 5, 0);
    l = paintTile(l, rectCells(l.grid, 0, 0, 4, 4), 0x24).level;
    const up = raise(l, new Set([12]), 1, 'slope');
    expect(up.level.grid.tile[l.grid.at(2, 1)]).toBe(0x20); // the ramp N of the top falls N
    expect(up.notice).toMatch(/4 markings removed/); // the corner cells
  });

  it('a level stays inside its corner heights', () => {
    const l = defaultLevel();
    for (let i = 0; i < l.grid.w * l.grid.h; i++) {
      if (l.grid.shape[i] === 0) continue;
      const c = cornersOf(l.grid.shape[i], l.grid.elev[i])!;
      expect(Math.min(...c)).toBeGreaterThanOrEqual(0);
    }
  });
});
