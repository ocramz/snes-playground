/**
 * The core actions (plans/port_v1_koota_phaser4.md "Actions"):
 *
 * - `placeBall`, the poke equivalent the trace tests seed from and the
 *   later debug UI reuses: it writes the block traits and the Shot fields
 *   directly, exactly as tools/snesstep's pokes do, and lets the ball roll;
 * - `startCourse` / `startHole`, phase 5's minimal form: the course, the
 *   ball on the tee, Kirby's screen position, the camera centred on him and
 *   the flow at the shot set-up. Phase 6 adds the hole's entities (enemies,
 *   the cup, pillars) and the counters.
 */
import type { World } from 'koota';
import { ballEntity } from './systems/ball-step';
import { BallPos, BallVel, BallAir, BallSpin, StillCount, Modifier, BallHoled } from './traits/ball';
import { Shot } from './traits/shot';
import { BallWork, type BallWorkFields, emptyWork } from './traits/ball';
import { HoleFlow } from './traits/flow';
import { Camera } from './traits/camera';
import { Guide } from './traits/guide';
import { Pose, BallScreen } from './traits/pose';
import { Course, setCourse, courseEntity } from './traits/course';
import { Stall } from './systems/stall';
import { Time } from './traits/time';
import { probe } from './sim/probe';
import { kernelCourse, type Ctx } from './sim/context';
import { project } from './projection';
import type { CourseData } from './course-data';
import type { RomRules } from './rules';
import { spawnBall } from './world';

export interface BallPlacement {
  xc: number; xf: number; yc: number; yf: number; z: number;
  vx: number; vy: number; vz: number;
  air: number;
  aim?: number;
  elev?: number;
  spinX?: number; spinY?: number; spinPending?: number;
}

export function placeBall(world: World, p: BallPlacement, ctx?: Ctx): void {
  const e = ballEntity(world);
  e.set(BallPos, { xc: p.xc, xf: p.xf, yc: p.yc, yf: p.yf, z: p.z });
  e.set(BallVel, { vx: p.vx, vy: p.vy, vz: p.vz });
  e.set(BallAir, { air: p.air });
  if (p.spinX !== undefined || p.spinY !== undefined || p.spinPending !== undefined) {
    e.set(BallSpin, {
      sx: p.spinX ?? 0,
      sy: p.spinY ?? 0,
      pending: p.spinPending ?? 0,
    });
  }
  const shot = world.get(Shot)!;
  world.set(Shot, {
    ...shot,
    aim: p.aim ?? shot.aim,
    elev: p.elev ?? shot.elev,
  });
  // the placement clears the shot-over state, as a poke does
  e.set(StillCount, { over: 0, frames: 0 });
  e.set(Modifier, { kind: -1, window: 0, timer: 0 });
  if (ctx) {
    // Seed the work copy's probe fields (the ROM's block carries them at
    // $D8C2-$D8DE; a poke that skips them leaves the first step's z at the
    // stale ground). The next begin-ball-step copies them to "previous".
    const w = e.get(BallWork)! as BallWorkFields;
    w.xc = p.xc; w.xf = p.xf; w.yc = p.yc; w.yf = p.yf; w.z = p.z;
    w.vx = p.vx; w.vy = p.vy; w.vz = p.vz; w.air = p.air;
    probe(ctx, w);
  }
  // a placed ball is in play: the roll's systems run from the next frame
  const flow = world.get(HoleFlow)!;
  world.set(HoleFlow, { ...flow, phase: 'Rolling', since: world.get(Time)!.frame });
}

/** The courses of the current game, kept for `startHole`. */
let loaded: { rules: RomRules; courses: CourseData[] } | null = null;

/**
 * Load a course (an ordered list of holes) and the ROM rules. Returns the
 * context the schedule needs for the first hole (`startHole(world, 0)`).
 */
export function startCourse(world: World, rules: RomRules, courses: CourseData[]): Ctx {
  loaded = { rules, courses };
  return startHole(world, 0);
}

/**
 * Start hole `i` of the loaded course at its shot set-up: the ball on the
 * tee's centre, grounded and still, its ground probed; Kirby's screen
 * position the tee's projection (integers only: $80:F73B loads $DA58/$DA5C,
 * the fractions start at 0); the camera centred on him (192, 304 on hole 1,
 * as the intro leaves it; docs/web-demo.md "The intro").
 */
export function startHole(world: World, i: number): Ctx {
  if (!loaded) throw new Error('startHole before startCourse');
  const data = loaded.courses[i];
  if (!data) throw new Error(`no hole ${i}`);
  setCourse(world, data);
  const course = courseEntity(world).get(Course)!;
  const ctx: Ctx = {
    rules: loaded.rules,
    course: { ...kernelCourse(data), layer2: course.layer2 },
    presentation: true,
  };
  if (world.queryFirst(BallWork) === undefined) spawnBall(world);
  const e = ballEntity(world);
  // a fresh work copy: the set-up's coefficients ($80:C688)
  e.set(BallWork, emptyWork());
  const w = e.get(BallWork)!;
  w.xc = data.tee.x; w.xf = 0x8000;
  w.yc = data.tee.y; w.yf = 0x8000;
  w.air = 0;
  probe(ctx, w);
  w.z = w.ground;
  e.set(BallPos, { xc: w.xc, xf: w.xf, yc: w.yc, yf: w.yf, z: w.z });
  e.set(BallVel, { vx: 0, vy: 0, vz: 0 });
  e.set(BallAir, { air: 0 });
  e.set(BallSpin, { sx: 0, sy: 0, pending: 0 });
  e.set(BallHoled, { holed: 0 });
  e.set(StillCount, { over: 0, frames: 0 });
  e.set(Modifier, { kind: -1, window: 0, timer: 0 });
  e.set(Pose, { state: 0, facing: 0, angle: 0, variant: 0, timer: 0, resume: 0 });
  const p = project(ctx.course, w.xc, w.xf, w.yc, w.yf, w.z);
  e.set(BallScreen, { x: p.x, xf: 0, y: p.y, yf: 0, px: p.x, pxf: 0, py: p.y, pyf: 0 });
  world.set(Shot, {
    ...world.get(Shot)!,
    aim: 0xffff, elev: 0xffff, // $80:F78F/$80:F795 at the hole's start
    side: 0, topBack: 0, guideSide: 6, guideTB: 6, // power-on RAM; the set-up copies 6
    meter: 0, meterDir: 1, power: 0, guideEnds: 0,
  });
  world.set(Camera, {
    x: (p.x - 0x80) & 0xffff, y: (p.y + 0x70) & 0xffff,
    wantX: 0, wantY: 0, lagX: 0, lagY: 0, mode: 0,
    targetX: 0, targetY: 0, arrived: 0,
  });
  const g = world.get(Guide)!;
  g.points = []; g.ends = []; g.steps = 0; g.pendingFrame = -1;
  world.set(Stall, { ...world.get(Stall)!, kind: 'none', framesLeft: 0, resumeAt: -1 });
  // the first core frame after this is the set-up's first
  world.set(HoleFlow, { phase: 'ShotSetup', since: world.get(Time)!.frame + 1, shots: 0, prev: 'Idle' });
  return ctx;
}
