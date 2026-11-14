/**
 * The kernels against the numbers emulated in docs/physics.md ("How these
 * were measured" and the sections' *emulated* notes). The trace tests
 * (trace-shots.test.ts) cover the whole step; these pin the individual
 * routines so a regression names its kernel.
 */
import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables, loadRomCourse, haveRomTest } from './fixtures';
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

  it('edge crossing: a cardinal move finds the shared edge ($81:9001)', () => {
    if (!course) return;
    const w = work();
    // hole 1: rolling +y from the flat tee area into the rim
    w.xc = 6; w.xf = 0x8000; w.yc = 1; w.yf = 0x8000; w.z = 0;
    probe(ctx, w);
    w.pXc = 6; w.pYc = 0; // moved +y
    w.pShape = course.shape[0 * course.w + 6];
    w.pElev = course.elev[0 * course.w + 6];
    crossEdges(ctx, w);
    expect(w.moveDir).toBe(2);
    expect(w.stepHeight).not.toBe(0);
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
