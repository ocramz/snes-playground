/**
 * The flow kernels against what the recorded game shows (flow_web_*.json,
 * trace_web_*.json; `make engine-traces`) and the numbers read from the
 * disassembly (notes/engine-phase5-flow.md).
 */
import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { facingFromAim } from '../src/core/sim/facing';
import { aimPad, aimToward, nearestEnemy, snapAim, to88, type AimInput, PAD } from '../src/core/sim/aim';
import { panStep, aimQuarter } from '../src/core/sim/camera';
import { project } from '../src/core/projection';
import { simulateGuide } from '../src/core/sim/guide';
import { rollPoseState } from '../src/core/systems/panel';
import { createGameWorld } from '../src/core/world';
import { startCourse } from '../src/core/actions';
import { BallWork, BallPos } from '../src/core/traits/ball';
import { Pad } from '../src/core/traits/pad';
import { latchPad } from '../src/core/systems/pad';
import { haveRules, haveRomTest, loadFlow, loadRomCourse, loadTables, loadTrace } from './fixtures';

describe.skipIf(!haveRules)('flow kernels', () => {
  const rules = new RomRules(loadTables());

  it('snaps the aim to the nearest 45 degrees with the ROM thresholds ($80:C902)', () => {
    expect([0, 22, 23, 67, 68, 112, 113, 157, 158, 202, 203, 247, 248, 292, 293, 337, 338, 359].map(snapAim))
      .toEqual([0, 0, 45, 45, 90, 90, 135, 135, 180, 180, 225, 225, 270, 270, 315, 315, 0, 0]);
  });

  it('the aim quarter and the shot view offsets ($81:BE9A, $81:C0F0/$C0F8)', () => {
    expect([0, 89, 90, 179, 180, 269, 270, 359].map(aimQuarter)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(Array.from(rules.table('shotViewX'))).toEqual([80, 0, -80, 0]);
    expect(Array.from(rules.table('shotViewY'))).toEqual([0, 40, 0, -56]);
  });

  it('turns 1 degree on a press, then 3 a call from the 15th held call ($81:B555)', () => {
    const s: AimInput = { aim: 0, hold: 0, kind: 0, grounder: 1, elev: 0, guideSide: 6, guideTB: 6, changed: 0 };
    const seen: number[] = [];
    for (let i = 0; i < 17; i++) {
      s.changed = 0;
      aimPad(s, PAD.LEFT, i === 0 ? PAD.LEFT : 0);
      seen.push(s.aim);
    }
    // 1 on the first call, nothing for 14 calls, then +3 each call
    expect(seen).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 4, 7]);
    // Right turns down and wraps
    const r: AimInput = { aim: 0, hold: 0, kind: 0, grounder: 1, elev: 0, guideSide: 6, guideTB: 6, changed: 0 };
    aimPad(r, PAD.RIGHT, PAD.RIGHT);
    expect(r.aim).toBe(359);
    // no direction held: the counter resets
    aimPad(r, 0, 0);
    expect(r.hold).toBe(0);
  });

  it('Up picks the fly shot, Down the grounder ($81:B604/$81:B661)', () => {
    const s: AimInput = { aim: 0, hold: 0, kind: 0, grounder: 1, elev: 0, guideSide: 6, guideTB: 6, changed: 0 };
    aimPad(s, PAD.UP, PAD.UP);
    expect({ kind: s.kind, elev: s.elev, grounder: s.grounder }).toEqual({ kind: 2, elev: 60, grounder: 0 });
    aimPad(s, PAD.DOWN, PAD.DOWN);
    expect({ kind: s.kind, elev: s.elev, grounder: s.grounder }).toEqual({ kind: 0, elev: 0, grounder: 1 });
  });

  it('the roll pose from the latched selectors ($82:C815-$82:C84E)', () => {
    expect(rollPoseState(6, 6)).toBe(14);
    expect(rollPoseState(6, 3)).toBe(16); // web_fly: tb latched at 3
    expect(rollPoseState(2, 3)).toBe(15); // web_fly_spin
    expect(rollPoseState(12, 6)).toBe(15); // web_ui
  });

  it('pans 10/5 a frame toward (target - 128, target + 112) ($81:BA8A, web_flow 2336)', () => {
    const c = { x: 192, y: 304, wantX: 0, wantY: 0, lagX: 0, lagY: 0, arrived: 0 };
    panStep(c, 408, 147);
    expect([c.x, c.y, c.arrived]).toEqual([202, 299, 0]);
    const d = { ...c, x: 280, y: 259 };
    panStep(d, 408, 147);
    expect(d.arrived).toBe(1);
  });

  it('latch-pad: held, the new presses and the memories', () => {
    const world = createGameWorld();
    world.set(Pad, { ...world.get(Pad)!, raw: PAD.A });
    latchPad(world);
    expect(world.get(Pad)!.pressed).toBe(PAD.A);
    latchPad(world);
    expect(world.get(Pad)!).toMatchObject({ held: PAD.A, pressed: 0, prev: PAD.A });
  });

  it('rounds a cell + fraction to 8.8 like $80:A594', () => {
    expect(to88(6, 0x8000)).toBe(0x0680);
    expect(to88(6, 0xff80)).toBe(0x0700);
  });
});

describe.skipIf(!haveRules || !haveRomTest)('flow kernels on hole 1', () => {
  const rules = new RomRules(loadTables());
  const course = fromRomCourse(loadRomCourse());

  it('reads the projection origins from the header (232, 456)', () => {
    expect(course.originY).toBe(232);
    expect(course.screenBase).toBe(456);
  });

  it('projects bit for bit ($81:A4C6): the tee, and a rolling ball of web_flow', () => {
    const tee = project(course, 6, 0x8000, 3, 0x8000, 23170);
    expect([tee.x, tee.xf, tee.y]).toEqual([320, 0, 192]);
    // trace_web_flow f2995 -> flow_web_flow f2994 (the stamps lag a frame)
    const p = project(course, 7, 7305, 3, 7776, 23170);
    expect([p.x, p.xf, p.y, p.yf]).toEqual([327, 23840, 176, 7557]);
  });

  it('every projected position of web_flow\'s roll is the one the game wrote', () => {
    const trace = loadTrace('web_flow');
    const flow = loadFlow('web_flow');
    if (!trace || !flow) return;
    // the flow's kx/kxf/ky/kyf at frame f project the block recorded at f + 1
    const at = new Map<number, Record<string, number>>();
    const cur: Record<string, number> = {};
    for (const [f, n, v] of flow.events) {
      cur[n] = v as number;
      at.set(f, { ...cur });
    }
    let checked = 0;
    for (const r of trace.frames) {
      if (r.f < 2990 || r.f > 3240) continue;
      const k = at.get(r.f - 1);
      if (!k) continue;
      const p = project(course, r.xc, r.xf, r.yc, r.yf, r.z);
      if (p.xf !== k.kxf || p.yf !== k.kyf) continue; // a frame the record and the flush disagree on
      expect([p.x, p.y]).toEqual([k.kx, k.ky]);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('Kirby faces the way the game shows for every aim of the web_flow sweep ($81:BB4A/$81:BCA0)', () => {
    const flow = loadFlow('web_flow');
    if (!flow) return;
    const cur: Record<string, number> = {};
    const frames = new Map<number, Record<string, number>>();
    for (const [f, n, v] of flow.events) {
      cur[n] = v as number;
      frames.set(f, { ...cur });
    }
    let checked = 0;
    for (const [f, n] of flow.events) {
      if (n !== 'aim' || f < 2336 || f > 2680) continue;
      const s = frames.get(f)!;
      expect(facingFromAim(rules, s.aim), `aim ${s.aim}`).toMatchObject({ facing: s.facing, angle: s.angle });
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('the target and the snap at a set-up ($82:8E41, $82:AFB0, $80:C902)', () => {
    // the tee: (8,3) and (6,5) tie at 2.0 cells; the first in the list wins
    expect(nearestEnemy(6, 0x8000, 3, 0x8000, course.enemies)).toBe(0);
    expect(snapAim(aimToward(rules, 6, 0x8000, 3, 0x8000, 8, 0x8000, 3, 0x8000))).toBe(0);
    // web_flow's second shot: the ball at rest, the cup ($82:8B5C wrote
    // $6B6C-$6B72 = 6:$8C00, 5:$7800 at 3245) -> 180 (game frame 3507)
    expect(snapAim(aimToward(rules, 9, 6672, 5, 19560, 6, 0x8c00, 5, 0x7800))).toBe(180);
  });

  it("the guide's first end is the aim camera's target (web_flow 2336: aim 0 -> 408, 147)", () => {
    const world = createGameWorld();
    const ctx = startCourse(world, rules, [course]);
    const e = world.queryFirst(BallWork)!;
    const pos = e.get(BallPos)!;
    const shot = (aim: number, elev: number) => ({
      aim, elev, kind: elev ? 2 : 0, grounder: elev ? 0 : 1, guideSide: 6, guideTB: 6, ends: 1,
      originXf: pos.xf, originXc: pos.xc, originYf: pos.yf, originYc: pos.yc, originZ: pos.z,
    });
    const g0 = simulateGuide(ctx, e.get(BallWork)!, shot(0, 0), ctx.course);
    expect([g0.ends[0].sx, g0.ends[0].sy, g0.steps]).toEqual([408, 147, 40]);
    const g1 = simulateGuide(ctx, e.get(BallWork)!, shot(1, 0), ctx.course);
    expect([g1.ends[0].sx, g1.ends[0].sy]).toEqual([410, 148]);
    // the fly shot's guide ends at its first landing (web_ui 2604)
    const gf = simulateGuide(ctx, e.get(BallWork)!, shot(0, 60), ctx.course);
    expect([gf.ends[0].sx, gf.ends[0].sy]).toEqual([440, 132]);
  });
});

describe('the core frame with no hole', () => {
  it('runs idle without a ball entity', async () => {
    const { runCoreFrame } = await import('../src/core/schedule');
    const world = createGameWorld();
    const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);
    expect(() => runCoreFrame(world, { rules, course: { w: 0, h: 0, shape: new Uint8Array(0), elev: new Uint8Array(0), walls: new Uint8Array(0), layer2: new Uint8Array(0), originY: 0, screenBase: 0 } })).not.toThrow();
  });
});
