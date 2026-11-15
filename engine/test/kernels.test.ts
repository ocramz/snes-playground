/**
 * The kernels against the numbers emulated in docs/physics.md ("How these
 * were measured" and the sections' *emulated* notes). The trace tests
 * (trace-shots.test.ts) cover the whole step; these pin the individual
 * routines so a regression names its kernel.
 */
import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables, loadRomCourse, loadRomHole, haveRomTest } from './fixtures';
import { fromRomCourse } from '../src/core/course-data';
import { kernelCourse, type Ctx, type Work } from '../src/core/sim/context';
import { emptyWork } from '../src/core/traits/ball';
import { airDrag, integrate, fallBelowCourse } from '../src/core/sim/move';
import { updateHeading } from '../src/core/sim/reflect';
import { reflect } from '../src/core/sim/reflect';
import { friction, slope, classIndex, curve } from '../src/core/sim/roll';
import { launchVelocity, shotSpin } from '../src/core/sim/shot';
import { probe } from '../src/core/sim/probe';
import { cupDepth } from '../src/core/sim/cup';
import { crossEdges } from '../src/core/sim/edges';
import { stepBounce } from '../src/core/sim/wall-step';
import { hitDispatch, landDispatch } from '../src/core/sim/dispatch';
import { s16, wrap16 } from '../src/core/fixed';

describe.skipIf(!haveRules)('kernels vs the emulated numbers', () => {
  const rules = new RomRules(loadTables());
  const course = haveRomTest ? fromRomCourse(loadRomCourse()) : null;
  const ctx: Ctx = {
    rules,
    course: course
      ? kernelCourse(course)
      : { w: 1, h: 1, shape: Uint8Array.of(1), elev: Uint8Array.of(0), walls: Uint8Array.of(0), layer2: Uint8Array.of(0), originY: 0, screenBase: 224 },
  };
  const work = (): Work => emptyWork();

  it('air drag: vx 1024 -> 1020, 2217 -> 2208 ($81:885C)', () => {
    const w = work();
    w.vx = 1024;
    airDrag(w);
    expect(s16(w.vx)).toBe(1020);
    w.vx = wrap16(2217);
    airDrag(w);
    expect(s16(w.vx)).toBe(2208);
    // negative velocities move toward zero by the same magnitude
    w.vx = wrap16(-2217);
    airDrag(w);
    expect(s16(w.vx)).toBe(-2208);
  });

  it('heading: 180 while vx < 0 and vy = 0 ($81:8E60)', () => {
    const w = work();
    w.vx = wrap16(-1000);
    w.vy = 0;
    updateHeading(rules, w);
    expect(w.deg).toBe(180);
    // and the last heading survives a still ball
    w.vx = 0;
    w.vy = 0;
    updateHeading(rules, w);
    expect(w.deg).toBe(180);
  });

  it('rolling friction on flat ground: -12 toward +x, -13 toward -x ($81:8A81)', () => {
    const w = work();
    w.rollMu = 0x0c00;
    w.deg = 0; // +x
    w.vx = 4000;
    friction(ctx, w);
    expect(s16(w.vx)).toBe(3988);
    w.deg = 180; // moving -x: cos < 0, the asymmetric rounding
    w.vx = wrap16(-4000);
    friction(ctx, w);
    expect(s16(w.vx)).toBe(-3987);
    // friction never reverses the ball
    w.vx = 5;
    friction(ctx, w);
    expect(s16(w.vx)).toBe(0);
  });

  it('slope acceleration on hole 1\'s ramp: vx 0 -> -43, then -34 ($81:8AE1)', () => {
    const w = work();
    // hole 1's ramp cell (11,3), shape $07 (rises with +x, code 4)
    w.xc = 11; w.xf = 0x8000; w.yc = 3; w.yf = 0x8000; w.z = 0;
    probe(ctx, w);
    expect(w.code).toBe(4);
    classIndex(ctx, w);
    // the first frame: friction 0 (heading deg is invalid until set), slope -43
    w.deg = 270; // cos = 0, sin = -1
    friction(ctx, w);
    slope(ctx, w);
    expect(s16(w.vx)).toBe(-43);
    // the next frame: -43 plus 9 of friction
    updateHeading(rules, w);
    friction(ctx, w);
    slope(ctx, w);
    // the net per-frame change is -34: slope -43 plus 9 of friction
    expect(s16(w.vx)).toBe(-34 - 43);
  });

  it('flat drop: vz -1728 reflects to 1058 with vx 912 -> 892 ($81:8905)', () => {
    const w = work();
    w.code = 0; // flat
    w.air = 1; // the vz column acts only while airborne ($81:8E17)
    w.vx = 912;
    w.vz = wrap16(-1728);
    reflect(rules, w, 0);
    // the flat matrix: vx x $7FFF, vz x -$7FFF
    expect(s16(w.vx)).toBe(911);
    expect(s16(w.vz)).toBe(1727);
    // the damping: x $7D6F / x $5332 through the sign-magnitude multiply
    w.vx = mulQ15sRef(w.vx, 0x7d6f);
    w.vz = mulQ15sRef(w.vz, 0x5332);
    w.vz = wrap16(w.vz + s16(w.gravity));
    expect(s16(w.vx)).toBe(892);
    expect(s16(w.vz)).toBe(1058);
  });

  it('ramp drop on code 4: vx -1301, vz 1003 ($81:9444)', () => {
    const w = work();
    w.code = 4;
    w.air = 1;
    w.vz = wrap16(-2112);
    reflect(rules, w, 4);
    expect(s16(w.vx)).toBe(-1328); // 0.628 x -2112
    expect(s16(w.vz)).toBe(1642); // -0.778 x -2112
    w.vx = mulQ15sRef(w.vx, 0x7d6f);
    w.vz = mulQ15sRef(w.vz, 0x5332);
    w.vz = wrap16(w.vz + s16(w.gravity));
    expect(s16(w.vx)).toBe(-1301);
    expect(s16(w.vz)).toBe(1003);
  });

  it('grounder launch: P = $1104 -> vx $1102 ($81:BA0B)', () => {
    const w = work();
    w.shotAim = 0;
    w.shotElev = 0;
    launchVelocity(rules, w, 0x1104);
    expect(w.vx).toBe(0x1102);
    expect(s16(w.vz)).toBe(0);
  });

  it('fly launch: P = $1156 -> vx 2217, vz 3843 ($81:BA0B)', () => {
    const w = work();
    w.shotAim = 0;
    w.shotElev = 60;
    launchVelocity(rules, w, 0x1156);
    expect(s16(w.vx)).toBe(2217);
    expect(s16(w.vz)).toBe(3843);
  });

  it('spin: fly t=0 -> 2104, t=11 -> -2245, side s=2 -> 707; grounder s=2 -> 1792 ($81:C1D5)', () => {
    const P = 0x1156;
    const w = work();
    w.shotAim = 0;
    w.shotElev = 60;
    shotSpin(rules, w, 6, 0, P);
    expect(s16(w.spinX)).toBe(2104);
    shotSpin(rules, w, 6, 11, P);
    expect(s16(w.spinX)).toBe(-2245);
    shotSpin(rules, w, 2, 6, P);
    expect(s16(w.spinY)).toBe(707);
    const g = work();
    g.shotAim = 0;
    g.shotElev = 0;
    shotSpin(rules, g, 2, 6, 0x1104);
    expect(s16(g.spinX)).toBe(1792);
    shotSpin(rules, g, 10, 6, 0x1104);
    expect(s16(g.spinX)).toBe(-1792);
  });

  it('grounder curve: vy 0 -> 118 then 236 at omega 1792 ($81:8D17)', () => {
    const w = work();
    w.shotElev = 0;
    w.spinX = 1792;
    w.spinPending = 1;
    w.vx = 4342;
    w.vy = 0;
    curve(w);
    expect(s16(w.vy)).toBe(118);
    curve(w);
    expect(s16(w.vy)).toBe(236);
  });

  it('cup depth: the centre at fraction $8000 holes, $0000/$2000/$C000 do not ($82:AFE9)', () => {
    if (!course) return;
    const at = (xf: number, yf: number): number => {
      const w = work();
      w.xc = 6; w.xf = xf; w.yc = 5; w.yf = yf; w.z = 23170;
      probe(ctx, w);
      return cupDepth(ctx, w);
    };
    expect(at(0x8000, 0x8000)).toBe(0x5000);
    expect(at(0x0000, 0x8000)).not.toBe(0x5000);
    expect(at(0x2000, 0x8000)).not.toBe(0x5000);
    expect(at(0xc000, 0x8000)).not.toBe(0x5000);
  });

  it('integration carries the fraction into the cell ($81:8805)', () => {
    const w = work();
    w.xc = 6; w.xf = 0xfff0; w.yc = 3; w.yf = 0x8000;
    w.vx = 0x20;
    integrate(w);
    expect(w.xc).toBe(7);
    expect(w.xf).toBe(0x10);
    w.vx = wrap16(-0x30);
    integrate(w);
    expect(w.xc).toBe(6);
    expect(w.xf).toBe(0xffe0);
  });

  it('the fall below -$11_0000 sets lost and zeroes the velocities ($81:89AA)', () => {
    const w = work();
    w.z = -0x120000;
    w.vx = 100;
    fallBelowCourse(w, 0xffee); // the high word of -0x120000
    expect(w.lost).toBe(1);
    expect(w.vx).toBe(0);
    expect(w.vz).toBe(0);
    // a shallow fall keeps falling under gravity
    const w2 = work();
    w2.vz = wrap16(-1000);
    fallBelowCourse(w2, 0xffff);
    expect(w2.lost).toBe(0);
    expect(s16(w2.vz)).toBe(-1064);
  });

  it('edge crossing: a flush ramp edge is no step, whichever way it is crossed ($81:9001)', () => {
    if (!course) return;
    // hole 1: the rim ramp (6,0), $06 at elevation 1, falls S onto the flat
    // (6,1) at elevation 0; crossing +y enters (6,1) by its N edge
    const w = crossing(ctx, [6, 0], [6, 1]);
    expect(w.moveDir).toBe(2);
    expect(w.stepHeight).toBe(0);
    expect(w.edge).toBe(0xffff);
    expect(crossing(ctx, [6, 1], [6, 0]).stepHeight).toBe(0); // -y, by the S edge
  });
});

/** A kernel context over a small authored grid (flat unless `shape` says otherwise). */
function gridCtx(rules: RomRules, w: number, h: number, elev: number[], opts: { shape?: number[]; walls?: number[]; tile?: number[] } = {}): Ctx {
  const n = w * h;
  return {
    rules,
    course: {
      w, h,
      shape: Uint8Array.from(opts.shape ?? new Array(n).fill(1)),
      elev: Uint8Array.from(elev),
      walls: Uint8Array.from(opts.walls ?? new Array(n).fill(0)),
      layer2: Uint8Array.from(opts.tile ?? new Array(n).fill(0)),
      originY: 0, screenBase: 224,
    },
  };
}

/** The ball probed at (x, y) and fractions, as a fresh work copy. */
function at(ctx: Ctx, x: number, y: number, xf = 0x8000, yf = 0x8000): Work {
  const w = emptyWork();
  w.xc = x; w.xf = xf; w.yc = y; w.yf = yf;
  probe(ctx, w);
  return w;
}

/** The ball moved from `from` to `to` in one frame, then $81:9001. */
function crossing(ctx: Ctx, from: [number, number, number?, number?], to: [number, number, number?, number?]): Work {
  const p = at(ctx, ...from);
  const w = at(ctx, ...to);
  w.pXc = p.xc; w.pXf = p.xf; w.pYc = p.yc; w.pYf = p.yf;
  w.pCell = p.cell; w.pShape = p.shape; w.pElev = p.elev;
  w.pQuad = p.quad; w.pCode = p.code; w.pGround = p.ground; w.pTile = p.tile;
  crossEdges(ctx, w);
  return w;
}

describe.skipIf(!haveRules)('edge crossings, steps and drops ($81:9001, $81:925E, $81:93D1)', () => {
  const rules = new RomRules(loadTables());
  const hole = (n: number): Ctx | null => {
    const j = haveRomTest ? loadRomHole(n) : null;
    return j ? { rules, course: kernelCourse(fromRomCourse(j)) } : null;
  };

  it('course 1 hole 2: the pit\'s ramps join flush both ways along y', () => {
    const h2 = hole(1);
    if (!h2) return;
    // (4,15) flat at 1 -> (4,16) $06 at 1 -> (4,17) flat at 0 -> (4,18) $04 at 1
    for (const [a, b] of [[15, 16], [16, 17], [17, 18], [18, 19]] as const) {
      const down = crossing(h2, [4, a], [4, b]);
      expect(down.moveDir, `+y ${a}->${b}`).toBe(2);
      expect(down.stepHeight, `+y ${a}->${b}`).toBe(0);
      expect(down.edge).toBe(0xffff);
      const up = crossing(h2, [4, b], [4, a]);
      expect(up.moveDir, `-y ${b}->${a}`).toBe(0);
      expect(up.stepHeight, `-y ${b}->${a}`).toBe(0);
    }
  });

  it('course 1 hole 3: +y into the elevation-4 row is a step up of 6 by the N edge, -y off it a drop by the S edge', () => {
    const h3 = hole(2);
    if (!h3) return;
    const up = crossing(h3, [2, 7], [2, 8]); // physics.md's emulated step hit
    expect(up.moveDir).toBe(2);
    expect(up.edge).toBe(0);
    expect(up.stepHeight).toBe(6);
    const down = crossing(h3, [5, 8], [5, 7]); // physics.md's emulated 2-step drop
    expect(down.moveDir).toBe(0);
    expect(down.edge).toBe(2);
    expect(down.stepHeight).toBe(-4);
  });

  it('along x: a step up is positive, a drop negative', () => {
    const c = gridCtx(rules, 3, 1, [0, 1, 0]);
    const east = crossing(c, [0, 0], [1, 0]);
    expect([east.moveDir, east.edge, east.stepHeight]).toEqual([1, 3, 2]);
    const off = crossing(c, [1, 0], [2, 0]);
    expect([off.moveDir, off.edge, off.stepHeight]).toEqual([1, 3, -2]);
    const west = crossing(c, [2, 0], [1, 0]);
    expect([west.moveDir, west.edge, west.stepHeight]).toEqual([3, 1, 2]);
    // rolling off an island's edge into a gap is a drop
    const gap = gridCtx(rules, 2, 1, [1, 0], { shape: [1, 0] });
    expect(crossing(gap, [0, 0], [1, 0]).stepHeight).toBe(-4);
  });

  it('a diagonal move checks the second boundary\'s wall even when it is flush ($81:9248)', () => {
    // 2x2 flat; walls on (1,0)'s S edge and (0,1)'s E edge, so whichever
    // neighbour the cross product picks, the second boundary is walled
    const c = gridCtx(rules, 2, 2, [0, 0, 0, 0], { walls: [0, 1 << 2, 1 << 1, 0] });
    const w = crossing(c, [0, 0, 0xf000, 0xe000], [1, 1, 0x1000, 0x1000]);
    expect(w.moveDir).toBe(5);
    expect(w.stepHeight).toBe(0);
    expect(w.wallEdge === 0 || w.wallEdge === 3, `wallEdge ${w.wallEdge}`).toBe(true);
  });

  it('the step bounce puts the ball on the old cell\'s side: $FFFF moving +y, $0000 moving -y ($81:93E2)', () => {
    const h3 = hole(2);
    if (h3) {
      // the emulated +y hit at 3072: y clamped to 7 + $FFFF, vy 2952 -> -1919, vx 738 -> 737
      const w = crossing(h3, [2, 7, 0x8000, 0xff00], [2, 8, 0x8000, 0x0200]);
      w.vx = 738; w.vy = 2952;
      stepBounce({ rules, course: h3.course }, w);
      expect([w.yc, w.yf]).toEqual([7, 0xffff]);
      expect(s16(w.vy)).toBe(-1919);
      expect(s16(w.vx)).toBe(737);
    }
    // -y into a higher row: back to the old cell's top, y fraction 0
    const c = gridCtx(rules, 1, 2, [1, 0]);
    const w = crossing(c, [0, 1, 0x8000, 0x0100], [0, 0, 0x8000, 0xff00]);
    expect([w.edge, w.stepHeight]).toEqual([2, 2]);
    w.vy = wrap16(-1000);
    stepBounce(c, w);
    expect([w.yc, w.yf]).toEqual([1, 0]);
    expect(s16(w.vy)).toBeGreaterThan(0);
  });
});

describe.skipIf(!haveRules)('the arrow panels $14-$17 ($82:A6C7, $82:A70B, $82:A74F, $82:A783, $82:A7B7)', () => {
  const rules = new RomRules(loadTables());
  // a 3x3 flat with the S arrow $16 in the middle and the E arrow $15 east of it
  const c = gridCtx(rules, 3, 3, new Array(9).fill(0), { tile: [0, 0, 0, 0, 0x16, 0x15, 0, 0, 0] });
  const mod = { kind: -1, timer: 0 };
  const rolling = (x: number, xf: number, yf: number, vx: number, vy: number): Work => {
    const w = at(c, x, 1, xf, yf);
    w.z = w.ground;
    w.vx = wrap16(vx); w.vy = wrap16(vy);
    w.spinX = 300; w.spinPending = 1;
    updateHeading(rules, w);
    return w;
  };

  it('rolling onto the S arrow: the velocity turns to 90 at the same speed, the spin goes, sound $0C, once', () => {
    const w = rolling(1, 0x8000, 0x3000, -1000, 1732); // heading 120
    expect(w.deg).toBe(120);
    expect(hitDispatch(c, w, mod).next).toBe('rolling');
    expect(w.vx).toBe(0);
    expect(Math.abs(s16(w.vy) - 2000)).toBeLessThanOrEqual(4);
    expect(w.deg).toBe(90);
    expect([w.spinX, w.spinPending, w.tailSfx, w.enemyLatch]).toEqual([0, 0, 0x0c, 1]);
    // the latch: the next frame on the panel does nothing
    w.vx = 500; w.tailSfx = 0xffff;
    hitDispatch(c, w, mod);
    expect([w.vx, w.tailSfx]).toEqual([500, 0xffff]);
  });

  it('outside the side window nothing turns and the latch clears', () => {
    const w = rolling(1, 0x5000, 0x8000, -1000, 1732); // x below $6000
    w.enemyLatch = 1;
    hitDispatch(c, w, mod);
    expect([s16(w.vx), s16(w.vy), w.enemyLatch, w.tailSfx]).toEqual([-1000, 1732, 0, 0xffff]);
  });

  it('landing: the wider window, only at or under the surface', () => {
    const w = rolling(1, 0x5000, 0x8000, -1000, 1732); // x inside [$4800, $B7FF)
    w.air = 1;
    w.z = w.ground + 0x100; // above the surface
    landDispatch(c, w, mod);
    expect(s16(w.vx)).toBe(-1000);
    w.z = w.ground - 0x100;
    landDispatch(c, w, mod);
    expect(w.vx).toBe(0);
    expect(w.tailSfx).toBe(0x0c);
  });

  it('the E arrow turns the ball to 0 and zeroes vy', () => {
    const w = rolling(2, 0x8000, 0x8000, 1732, 1000); // heading 30
    hitDispatch(c, w, mod);
    expect(w.vy).toBe(0);
    expect(Math.abs(s16(w.vx) - 2000)).toBeLessThanOrEqual(4);
    expect(w.deg).toBe(0);
  });

  it('the shot guide does not see the arrows ($81:B455)', () => {
    const w = rolling(1, 0x8000, 0x8000, -1000, 1732);
    hitDispatch({ ...c, presentation: false }, w, mod);
    expect(s16(w.vx)).toBe(-1000);
  });
});

describe.skipIf(!haveRules)('the snap panels $18-$1B ($82:A5B1, $82:A5E6, $82:A692, $82:A5F7)', () => {
  const rules = new RomRules(loadTables());
  // a row of four flat cells: $18 (N), $19 (E), $1A (S), $1B (W)
  const c = gridCtx(rules, 4, 1, [1, 1, 1, 1], { tile: [0x18, 0x19, 0x1a, 0x1b] });
  const mod = { kind: -1, timer: 0 };
  const on = (x: number, vx: number, vy: number, xf = 0x8000, yf = 0x8000): Work => {
    const w = at(c, x, 0, xf, yf);
    w.z = w.ground;
    w.vx = wrap16(vx); w.vy = wrap16(vy);
    w.spinX = 300; w.spinY = -20; w.spinPending = 1;
    updateHeading(rules, w);
    return w;
  };
  const push = (x: number, vx: number, vy: number): [number, number] => {
    const w = on(x, vx, vy);
    expect(hitDispatch(c, w, mod)).toEqual({ next: 'rolling' });
    return [s16(w.vx), s16(w.vy)];
  };

  it('each panel pushes $300 a frame along its arrow, capped at $2000', () => {
    expect(push(0, 0, -100)).toEqual([0, -868]); // $18: vy - $300
    expect(push(0, 0, -0x1e00)).toEqual([0, -0x2000]); // floored ($82:A63F)
    expect(push(1, 100, 0)).toEqual([868, 0]); // $19: vx + $300
    expect(push(2, 0, 100)).toEqual([0, 868]); // $1A: vy + $300
    expect(push(2, 0, 0x1e00)).toEqual([0, 0x2000]); // capped ($82:A652)
    expect(push(3, -100, 0)).toEqual([-868, 0]); // $1B: vx - $300
    expect(push(3, -0x1e00, 0)).toEqual([-0x2000, 0]); // floored ($82:A67B)
    // against the arrow: the push slows, then turns the ball
    expect(push(2, 0, -500)).toEqual([0, 268]);
  });

  it('$19 at the cap leaves vx unchanged: `BRA $A681` skips the store ($82:A66B)', () => {
    expect(push(1, 0x1c00, 0)).toEqual([0x1f00, 0]); // under the cap: stored
    expect(push(1, 0x1e00, 0)).toEqual([0x1e00, 0]); // $2100 >= $2000: kept as it was
    expect(push(1, 0x1d00, 0)).toEqual([0x1d00, 0]); // $2000 exactly: kept too
  });

  it('a sum that wraps the sign is stored as it is (BMI/BPL test the sum)', () => {
    expect(push(2, 0, 0x7f00)).toEqual([0, s16(0x8200)]);
    expect(push(0, 0, -0x7f00)).toEqual([0, s16(0x7e00)]);
  });

  it('the heading follows the push and the spin is cleared ($81:8E60, $82:A685)', () => {
    const w = on(2, 0, -500);
    expect(w.deg).toBe(270);
    hitDispatch(c, w, mod);
    expect(w.deg).toBe(90);
    expect([w.spinX, w.spinY, w.spinPending]).toEqual([0, 0, 0]);
  });

  it('the latch: sound $11 and object 61 once a pass, the push every frame', () => {
    const w = on(0, 0, -100);
    hitDispatch(c, w, mod);
    expect([w.tailSfx, w.enemyLatch, w.snapSpawn, w.snapKeep]).toEqual([0x11, 1, 1, 1]);
    w.tailSfx = 0xffff; w.snapSpawn = 0; w.snapKeep = 0;
    hitDispatch(c, w, mod);
    expect([w.tailSfx, w.enemyLatch, w.snapSpawn, w.snapKeep]).toEqual([0xffff, 1, 0, 1]);
    expect(s16(w.vy)).toBe(-868 - 768);
  });

  it('the gate: both fractions in [$2800, $DFFF); outside, no push and the latch clears ($82:A692)', () => {
    for (const [xf, yf] of [[0x27ff, 0x8000], [0x8000, 0xdfff], [0xdfff, 0x8000], [0x8000, 0x27ff]]) {
      const w = on(0, 0, -100, xf, yf);
      w.enemyLatch = 1;
      hitDispatch(c, w, mod);
      expect([s16(w.vy), w.enemyLatch, w.snapKeep]).toEqual([-100, 0, 0]);
    }
    const w = on(0, 0, -100, 0x2800, 0xdffe);
    hitDispatch(c, w, mod);
    expect(s16(w.vy)).toBe(-868);
  });

  it('modes 1 and 4 fail the gate; mode $0A skips the handler and keeps the latch', () => {
    for (const mode of [1, 4]) {
      const w = on(0, 0, -100);
      w.mode = mode; w.enemyLatch = 1;
      hitDispatch(c, w, mod);
      expect([s16(w.vy), w.enemyLatch]).toEqual([-100, 0]);
    }
    const w = on(0, 0, -100);
    w.mode = 0x0a; w.enemyLatch = 1;
    hitDispatch(c, w, mod);
    expect([s16(w.vy), w.enemyLatch]).toEqual([-100, 1]);
  });

  it('landing: at or under the surface the ball is set on it and rolls; above it, the default landing', () => {
    const w = on(0, 0, -100);
    w.air = 1;
    w.z = w.ground + 0x100;
    w.vz = wrap16(-600);
    expect(landDispatch(c, w, mod)).toEqual({ next: 'landing', entry: 'full' });
    expect([s16(w.vy), w.air, s16(w.vz)]).toEqual([-100, 1, -600]);
    w.z = w.ground - 0x100;
    expect(landDispatch(c, w, mod)).toEqual({ next: 'rolling' });
    expect([s16(w.vy), w.air, w.vz, w.z]).toEqual([-868, 0, 0, w.ground]);
  });

  it('the shot guide does not see the snap panels ($81:B455)', () => {
    const w = on(0, 0, -100);
    hitDispatch({ ...c, presentation: false }, w, mod);
    expect(s16(w.vy)).toBe(-100);
  });
});

/** mulQ15s with the velocity as A ($81:9793's call order). */
function mulQ15sRef(v: number, factor: number): number {
  const floorQ15 = (a: number, x: number): number =>
    wrap16(Math.floor((s16(a) * s16(x)) / 0x8000));
  return s16(v) < 0
    ? wrap16(-s16(floorQ15(wrap16(-s16(v)), factor)))
    : floorQ15(v, factor);
}
