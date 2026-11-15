/**
 * Kirby behind the course: table 10 (src/core/occlusion.ts), `$82:F4FD`
 * (src/core/sim/priority.ts), and the view's pure half
 * (features/kirby/sprite-rules.ts). The numbers are hole 1's table and the
 * web_fly snapshots cited in priority.ts.
 */
import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { fromRomCourse, type CourseJson } from '../src/core/course-data';
import { buildOcclusion, fromOcclusionJson, type OcclusionTable } from '../src/core/occlusion';
import { kernelCourse, type KernelCourse, type Work } from '../src/core/sim/context';
import { kirbyPriority, occluder } from '../src/core/sim/priority';
import { emptyWork } from '../src/core/traits/ball';
import { DEPTH as LAYER } from '../src/game/features/layers/layer-depth';
import { KIRBY_DEPTH, kirbyDepth, shadowShown } from '../src/game/features/kirby/sprite-rules';
import { haveRomTest, haveRules, loadRomCourse, loadRomHole, loadTables } from './fixtures';

describe('the occlusion table builder', () => {
  it('puts a gap behind the nearest cell in front on its screen column', () => {
    // x 0 is a gap, x 1 is ground: (0,1) is behind (1,0) without the carry,
    // and behind (1,1) with it (column 2)
    const t = buildOcclusion(2, 2, [0, 1, 0, 1]);
    expect(t).toEqual([
      null,
      [{ xmin: 0, xmax: 1, prio: 1, cell: 1 }],
      [{ xmin: 0, xmax: 1, prio: 1, cell: 3 }],
      null,
    ]);
  });

  it('merges a run of xc behind the same cell into one record', () => {
    // a 4x2 hole whose back row (y 1) is a gap. On column 1 the gap (0, 1)
    // is behind (0, 0), the cell just in front of it; on column 2 both
    // (0, 1) with the carry and (1, 1) without it are behind (1, 0)
    const t = buildOcclusion(4, 2, [1, 1, 1, 1, 0, 0, 0, 0]);
    for (const col of t) {
      for (const r of col ?? []) expect(r.prio).toBe(1);
    }
    expect(t[1]).toEqual([{ xmin: 0, xmax: 1, prio: 1, cell: 0 }]);
    expect(t[2]).toEqual([{ xmin: 0, xmax: 2, prio: 1, cell: 1 }]);
  });
});

describe.skipIf(!haveRules || !haveRomTest)('Kirby\'s priority on hole 1 ($82:F4FD)', () => {
  const rules = new RomRules(loadTables());
  const json = loadRomCourse() as unknown as CourseJson;
  const course: KernelCourse = kernelCourse(fromRomCourse(json));
  /** A gap position of hole 1's left side: xc 1, yc 3, no carry: column 4. */
  const gap = (z: number): Work => {
    const w = emptyWork();
    w.xc = 1; w.xf = 0x4000; w.yc = 3; w.yf = 0x4000;
    w.shape = 0; w.z = z;
    return w;
  };

  it('exports table 10 as the game reads it (directory of w + h columns)', () => {
    expect(json.occlusion).toBeDefined();
    expect(json.occlusion!.length).toBe(json.w + json.h);
    // column 4: xc 0-2 behind cell 15 = (3, 1), priority 1 (decoded by hand
    // from build/courses/000_MAP00/t10, equal to $7E:A3B2 at web_fly 3240)
    expect(json.occlusion![4]).toEqual([[0, 3, 1, 15]]);
    expect(json.occlusion![0]).toBeNull();
  });

  it('is 1 below z 0, anywhere', () => {
    const w = gap(-1);
    expect(kirbyPriority(rules, course, w)).toBe(1);
    w.shape = 1;
    expect(kirbyPriority(rules, course, w)).toBe(1);
  });

  it('is 3 on a cell', () => {
    const w = gap(0x8000);
    w.shape = 1;
    expect(kirbyPriority(rules, course, w)).toBe(3);
  });

  it('over a gap: 1 off the far sides (xc < 0, yc >= h), 3 off the near side (yc < 0)', () => {
    const w = gap(0x8000);
    w.xc = 0xffff;
    expect(kirbyPriority(rules, course, w)).toBe(1);
    w.xc = 1; w.yc = 0xffff;
    expect(kirbyPriority(rules, course, w)).toBe(3);
    w.yc = course.h;
    expect(kirbyPriority(rules, course, w)).toBe(1);
  });

  it('behind the record\'s cell while z is at most its top, Z(elevation + 1)', () => {
    const top = rules.heightZ(course.elev[15] + 1);
    expect(top).toBe(0xb504); // elevation 1: 2 x $5A82
    expect(kirbyPriority(rules, course, gap(top))).toBe(1);
    expect(kirbyPriority(rules, course, gap(top - 1))).toBe(1);
    expect(kirbyPriority(rules, course, gap(top + 1))).toBe(3);
  });

  it('the carry moves the column: xf + yf past $FFFF reads column 5', () => {
    const w = gap(0x8000);
    w.xf = 0x8000; w.yf = 0x8000;
    // column 5: xc 0-2 behind cell 27 = (3, 2), also elevation 1
    expect(occluder(course.occlusion, 5, 1)).toEqual({ prio: 1, cell: 27 });
    expect(kirbyPriority(rules, course, w)).toBe(1);
  });

  it('web_fly\'s fall off the near side: 3 above z 0 (no record), 1 below', () => {
    // the snapshot of 3240: xc 12, xf $2BB5, yc 3, yf $8000, z $7E02, $D96A 3
    const w = emptyWork();
    w.xc = 12; w.xf = 0x2bb5; w.yc = 3; w.yf = 0x8000; w.z = 0x7e02; w.shape = 0;
    expect(kirbyPriority(rules, course, w)).toBe(3);
    w.z = -0x00d8; // 3256: $FFFF:FF28, $D96A 1
    expect(kirbyPriority(rules, course, w)).toBe(1);
  });

  it('the lookup\'s xmin test is the 8-bit sign of xc - xmin ($82:F5A0 BMI)', () => {
    const t: OcclusionTable = [[{ xmin: 0, xmax: 0xff, prio: 2, cell: 0 }]];
    expect(occluder(t, 0, 5)).toEqual({ prio: 2, cell: 0 });
    expect(occluder(t, 0, 0x90)).toBeNull(); // $90 - 0 has bit 7 set
    expect(occluder(t, 1, 5)).toBeNull(); // past the directory
  });
});

describe.skipIf(!haveRomTest)('the builder against the ROM\'s tables', () => {
  it('picks the game\'s cell (or none) for at least 99 % of the gap positions', () => {
    let same = 0;
    let all = 0;
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 11, 54]) {
      const json = loadRomHole(n) as unknown as CourseJson | null;
      if (json === null || json.occlusion === undefined) continue;
      const { w, h, shape } = json;
      const rom = fromOcclusionJson(json.occlusion, w, h);
      const built = buildOcclusion(w, h, shape);
      for (let yc = 0; yc < h; yc++) {
        for (let xc = 0; xc < w; xc++) {
          if (shape[yc * w + xc] !== 0) continue;
          for (const carry of [0, 1]) {
            const d = xc + yc + carry;
            all += 1;
            if ((occluder(rom, d, xc)?.cell ?? -1) === (occluder(built, d, xc)?.cell ?? -1)) same += 1;
          }
        }
      }
    }
    expect(all).toBeGreaterThan(1000);
    expect(same / all).toBeGreaterThanOrEqual(0.99);
  });
});

describe('Kirby\'s sprite among the layers (sprite-rules.ts)', () => {
  it('priority 3 keeps the sort; 1 is under both layers; 2 under the front only', () => {
    expect(kirbyDepth(3, 100.25)).toBe(100.25);
    expect(kirbyDepth(1, 100.25)).toBe(KIRBY_DEPTH.under);
    expect(kirbyDepth(2, 100.25)).toBe(KIRBY_DEPTH.between);
    expect(KIRBY_DEPTH.under).toBeGreaterThan(LAYER.bg3);
    expect(KIRBY_DEPTH.under).toBeLessThan(LAYER.back);
    expect(KIRBY_DEPTH.between).toBeGreaterThan(LAYER.outlineBack);
    expect(KIRBY_DEPTH.between).toBeLessThan(LAYER.front);
  });

  it('no shadow over a gap (ground 0) or below z 0 ($81:A23E)', () => {
    expect(shadowShown({ ground: 0xb504, lost: 0 })).toBe(true);
    expect(shadowShown({ ground: 0, lost: 0 })).toBe(false);
    expect(shadowShown({ ground: 0xb504, lost: 1 })).toBe(false);
    expect(shadowShown({ ground: 0xb504, lost: 0x8000 })).toBe(true);
  });
});
