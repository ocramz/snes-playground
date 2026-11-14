/**
 * The end-to-end harness of phase 5: hole 1 played from its shot set-up by
 * one of the stepper's input scripts (tools/snesstep/inputs/web_*.txt),
 * recording, every core frame, the same WRAM words tools/snesstep/
 * trace_flow.py watches — under the same names — and the ball block that
 * trace_ball.py records.
 *
 * Frames: the engine's hole starts at the set-up, the game's after a
 * 168-frame intro, so engine frame f is game frame f + GAME_OFFSET. The
 * offset is pinned on web_flow's set-up ($80:C4FF writes the aim and the
 * elevation at game frame 2334, the set-up's second frame) and is the same
 * for every script: they all start hole 1 with `2100 A`.
 */
import { readFileSync } from 'node:fs';
import { createGameWorld } from '../src/core/world';
import { runCoreFrame } from '../src/core/schedule';
import { startCourse } from '../src/core/actions';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { drainEvents, type GameEvent } from '../src/core/events';
import { Pad } from '../src/core/traits/pad';
import { Time } from '../src/core/traits/time';
import { Shot } from '../src/core/traits/shot';
import { Camera } from '../src/core/traits/camera';
import { HoleFlow } from '../src/core/traits/flow';
import { Course, courseEntity } from '../src/core/traits/course';
import { Pose, BallScreen } from '../src/core/traits/pose';
import { BallPos, BallVel, BallAir, BallSpin, BallWork, StillCount } from '../src/core/traits/ball';
import { s16 } from '../src/core/fixed';
import type { World } from 'koota';
import type { Ctx } from '../src/core/sim/context';
import { heldAt, parseInputScript } from './input-script';
import { inputScriptPath, loadRomCourse, loadTables } from './fixtures';
import type { BallTraceFrame, FlowEvent } from './align';

/** Engine frame f is game frame f + GAME_OFFSET (see the header). */
export const GAME_OFFSET = 2332;

export interface FlowRun {
  world: World;
  ctx: Ctx;
  /** [game frame, name, value] on every change, as trace_flow.py writes them. */
  events: FlowEvent[];
  /** The ball block after every frame, stamped with the game frame. */
  ball: BallTraceFrame[];
  /** Every event the core emitted, stamped with the game frame. */
  emitted: Array<GameEvent & { gameFrame: number }>;
  /** The phase on each frame (game frame -> phase), for debugging. */
  phases: Array<[number, string]>;
}

/** The engine-side values of trace_flow.py's WATCH names. */
export function sample(world: World): Record<string, number> {
  const shot = world.get(Shot)!;
  const cam = world.get(Camera)!;
  const e = world.queryFirst(BallWork)!;
  const pose = e.get(Pose)!;
  const sc = e.get(BallScreen)!;
  const pos = e.get(BallPos)!;
  const screenBase = courseEntity(world).get(Course)!.screenBase;
  return {
    state: pose.state,
    facing: pose.facing,
    angle: pose.angle,
    aim: s16(shot.aim),
    elev: s16(shot.elev),
    side: shot.side,
    tb: shot.topBack,
    meter: shot.meter & 0xffff,
    cx38: s16(cam.x),
    cy38: s16(cam.y),
    camx: s16(cam.x),
    camy: s16(screenBase - cam.y),
    tgtx: s16(cam.targetX),
    tgty: s16(cam.targetY),
    kx: s16(sc.x),
    ky: s16(sc.y),
    kxf: sc.xf,
    kyf: sc.yf,
    c2: s16(cam.wantX),
    c4: s16(cam.wantY),
    c6: s16(cam.lagX),
    c8: s16(cam.lagY),
    st: cam.mode,
    bx: s16(pos.xc),
    by: s16(pos.yc),
    air: e.get(BallAir)!.air,
    over: e.get(StillCount)!.over,
  };
}

function readBall(world: World, gameFrame: number): BallTraceFrame {
  const e = world.queryFirst(BallWork)!;
  const pos = e.get(BallPos)!;
  const vel = e.get(BallVel)!;
  const spin = e.get(BallSpin)!;
  const shot = world.get(Shot)!;
  return {
    f: gameFrame,
    xc: pos.xc, xf: pos.xf, yc: pos.yc, yf: pos.yf, z: pos.z,
    vx: s16(vel.vx), vy: s16(vel.vy), vz: s16(vel.vz),
    air: e.get(BallAir)!.air ? 1 : 0,
    spinx: s16(spin.sx), spiny: s16(spin.sy), spinp: spin.pending,
    aim: shot.aim, elev: shot.elev,
  };
}

/**
 * Play `script` (a tools/snesstep/inputs name) for `frames` core frames from
 * hole 1's set-up. `until` stops early (it sees the world after each frame).
 */
export function runFlowScript(
  script: string,
  frames: number,
  opts: { offset?: number; until?: (world: World, gameFrame: number) => boolean } = {},
): FlowRun {
  const offset = opts.offset ?? GAME_OFFSET;
  const rules = new RomRules(loadTables());
  const course = fromRomCourse(loadRomCourse());
  const world = createGameWorld();
  const ctx = startCourse(world, rules, [course]);
  const entries = parseInputScript(readFileSync(inputScriptPath(script), 'utf8'));
  const run: FlowRun = { world, ctx, events: [], ball: [], emitted: [], phases: [] };
  const last = new Map<string, number>();
  for (let i = 0; i < frames; i++) {
    const gameFrame = world.get(Time)!.frame + 1 + offset;
    const pad = world.get(Pad)!;
    world.set(Pad, { ...pad, raw: heldAt(entries, gameFrame) });
    runCoreFrame(world, ctx);
    for (const ev of drainEvents(world)) run.emitted.push({ ...ev, gameFrame });
    const s = sample(world);
    for (const [k, v] of Object.entries(s)) {
      if (last.get(k) !== v) {
        last.set(k, v);
        run.events.push([gameFrame, k, v]);
      }
    }
    run.ball.push(readBall(world, gameFrame));
    run.phases.push([gameFrame, world.get(HoleFlow)!.phase]);
    if (opts.until?.(world, gameFrame)) break;
  }
  return run;
}
