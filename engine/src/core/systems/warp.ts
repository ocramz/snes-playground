/**
 * The warp, `$82:AA02` (read 2026-11-14): the ball goes from one warp panel
 * to the other inside the ball step, which blocks until the presentation is
 * over (sim/warp.ts has the handlers and the move). Recorded with
 * web_warp (rolled onto $B4 (4,22) of course 1 hole 4: F = 2488) and
 * web_warp_fly (landed on it: F = 2479), `--log-pc` on the stages:
 *
 *   F        the handler: the ball moved and re-probed, sound $76
 *            ($82:AABC), $6A48 set (the player's own threads stop,
 *            $85:8177 / $85:822B -> $82:AC94)
 *   F + 10   $80:8FB6 with 10 ends ($82:AAC7): Kirby's sprite off
 *            ($0B7E/$0B82), object 63 at his old place, Kirby's projection
 *            at the destination ($81:A4C6, $81:A430: $DA56-$DA64), the
 *            camera's lags $38C2-$38C8 zeroed
 *   F + 48   object 63 raises $699C ($85:CEAB): 38 frames, both runs
 *   F + 49   from here a frame, then a pan toward Kirby's projection
 *            ($82:AB3F-$82:AB50, $81:BA8A), until a pan finds the camera
 *            there: A (web_warp: 27 pans, A = 2563; web_warp_fly: 26, 2553)
 *   A        object 64 at the destination, sound $77 ($82:AB7C)
 *   A + 26   Kirby's sprite back ($82:AB86)
 *   A + 46   the 1-player wait ($82:ABA0, 20 frames) is over: $6A48
 *            cleared, the threads resumed ($82:ACAA), the turn to the
 *            destination's arrow, and the step goes on (2609, 2599)
 *
 * The HUD thread runs throughout ($80:8F78 runs every thread: web_warp_fly's
 * tomato at 2485). The threads that stop on $6A48 are the player's own
 * objects; the engine draws none of them in a warp.
 */
import type { World } from 'koota';
import { Camera } from '../traits/camera';
import { Shot } from '../traits/shot';
import { BallWork, type BallWorkFields } from '../traits/ball';
import { BallScreen, Pose, PoseState } from '../traits/pose';
import { Warp } from '../traits/warp';
import { panStep } from '../sim/camera';
import { project } from '../projection';
import { warpDestination, warpExit, warpTeleport } from '../sim/warp';
import type { Ctx } from '../sim/context';
import { emitEvent } from './flow-util';
import { activePlayer } from '../traits/player';

/** $82:AAC0: the frames before Kirby goes. */
export const WARP_LEAD = 10;
/** Object 63's frames until it raises $699C (measured: 2498 -> 2536, 2489 -> 2527). */
export const WARP_OUT = 38;
/** $82:AB7F: object 64 to Kirby's return. */
export const WARP_IN = 26;
/** $82:ABA0: the 1-player wait after it. */
export const WARP_HOLD = 20;
/** The warp's two sounds ($82:AABC, $82:AB7C). */
export const WARP_SFX_OUT = 0x76;
export const WARP_SFX_IN = 0x77;

/**
 * The `warp` step entry: when a warp's handler passed this step, move the
 * ball, turn it, and start the stall. Null when there is nothing to do (no
 * handler passed, or a warp with no pair: see warpDestination).
 */
export function startWarp(world: World, ctx: Ctx, w: BallWorkFields): { kind: 'warp'; frames: number; state: number } | null {
  if (w.warpPending === 0) return null;
  w.warpPending = 0;
  const to = warpDestination(ctx.course.warps, w);
  if (to === null) return null;
  if (w.warpSquash !== 0) {
    // $82:A9BD-$82:A9C9: Kirby's state $0C, its variant $6A6E
    const e = activePlayer(world);
    e.set(Pose, { ...e.get(Pose)!, state: PoseState.Squash, variant: w.lock6a6e, timer: 0 });
  }
  const from = { x: w.xc, y: w.yc };
  warpTeleport(ctx, w, to);
  emitEvent(world, 'warp', WARP_SFX_OUT);
  // after the stall in the ROM ($82:AA2A); nothing reads the velocity meanwhile
  warpExit(ctx, w, world.get(Shot)!.grounder);
  world.set(Warp, {
    stage: 'lead', t: 0,
    fromX: from.x, fromY: from.y, toX: to.x, toY: to.y,
    panX: 0, panY: 0, outX: 0, outY: 0, hidden: 0,
  });
  return { kind: 'warp', frames: 0, state: 0 };
}

/**
 * One frame of the warp's own list. Returns true on the frame the step
 * resumes (the stall runner then finishes the step and runs the post-step
 * systems).
 */
export function tickWarp(world: World, ctx: Ctx): boolean {
  const r = { ...world.get(Warp)! };
  r.t += 1;
  switch (r.stage) {
    case 'lead':
      if (r.t === WARP_LEAD) {
        // $82:AAC7-$82:AB33
        const e = activePlayer(world);
        const w = e.get(BallWork)!;
        const old = e.get(BallScreen)!;
        r.outX = old.x; // object 63 takes Kirby's place ($85:CE1A)
        r.outY = old.y;
        const p = project(ctx.course, w.xc, w.xf, w.yc, w.yf, w.z);
        e.set(BallScreen, { x: p.x, xf: p.xf, y: p.y, yf: p.yf, px: p.x, pxf: p.xf, py: p.y, pyf: p.yf });
        world.set(Camera, { ...world.get(Camera)!, wantX: 0, wantY: 0, lagX: 0, lagY: 0 });
        r.stage = 'out';
        r.t = 0;
        r.hidden = 1;
        r.panX = p.x;
        r.panY = p.y;
      }
      break;
    case 'out':
      if (r.t === WARP_OUT) {
        r.stage = 'pan';
        r.t = 0;
      }
      break;
    case 'pan': {
      const cam = { ...world.get(Camera)! };
      panStep(cam, r.panX, r.panY);
      world.set(Camera, cam);
      if (cam.arrived) {
        emitEvent(world, 'warp', WARP_SFX_IN); // with object 64
        r.stage = 'in';
        r.t = 0;
      }
      break;
    }
    case 'in':
      if (r.t === WARP_IN) {
        r.hidden = 0;
        r.stage = 'hold';
        r.t = 0;
      }
      break;
    case 'hold':
      if (r.t === WARP_HOLD) {
        world.set(Warp, { ...r, stage: 'none', t: 0 });
        return true;
      }
      break;
    default:
      return true;
  }
  world.set(Warp, r);
  return false;
}
