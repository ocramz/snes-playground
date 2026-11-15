/**
 * One shot of a generated hole, simulated silently with the engine's own
 * physics: the kernel entries of BALL_STEP (`runKernelStep`) on a work
 * copy, as the shot guide does (sim/guide.ts), but with the play context
 * (`presentation` unset: the full tile tables, so enemies, friction, boosts,
 * kickers, arrows, snaps and the cup all act) and the shot set up the way
 * the live flow sets it (systems/hole-flow.ts `setupShot`, systems/panel.ts
 * `launchBall`). The random holes' solver (solve.ts) is built on it.
 *
 * What it leaves out, on purpose (plans/random_holes.md):
 * - the buttons while the ball moves (A/Y), so no modifier;
 * - the hazard actors (no `ctx.course.hazards`): the generator places none;
 * - the take's and the reveal's stalls, which only freeze the ball.
 * The warp, a non-kernel entry, is stood in for by the `onWarp` hook with
 * the pure helpers of sim/warp.ts, exactly as systems/warp.ts `startWarp`
 * applies them.
 */
import type { CourseData } from '../course-data';
import type { RomRules } from '../rules';
import type { Ctx, Work } from '../sim/context';
import { kernelCourse, toggleOnAtLoad, waterOffAtLoad } from '../sim/context';
import { emptyWork } from '../traits/ball';
import { probe } from '../sim/probe';
import { countStill } from '../sim/still';
import { shotPower, launchVelocity, shotSpin } from '../sim/shot';
import { warpDestination, warpExit, warpTeleport } from '../sim/warp';
import { cloneWork, runKernelStep } from '../systems/ball-step';

/** $D9B6 for a fly shot ($81:B656). */
export const FLY_ELEVATION = 60;
/** The step cap: a full-power grounder rests after about 430 steps on flat ground. */
export const MAX_SHOT_STEPS = 1500;
/** The cup's tile, written at run time ($82:8B5C). */
export const CUP_TILE = 0x08;

export interface ShotSpec {
  /** $D9B4, degrees 0-359 (0 = +x, 90 = +y). */
  aim: number;
  /** $6B3A at the press, 0-63. */
  meter: number;
  fly: boolean;
  /** The selectors, 0-12, 6 = none. */
  side?: number;
  topBack?: number;
}

export type ShotOutcome = 'rest' | 'lost' | 'holed' | 'timeout';

export interface ShotResult {
  outcome: ShotOutcome;
  /** The work copy where the ball came to rest (or was lost, holed, cut off). */
  work: Work;
  /** The cells (index y * w + x) whose enemy test passed, in order, each once. */
  hits: number[];
  /** The step on which each of `hits` happened. */
  hitSteps: number[];
  steps: number;
}

/** A solver's context: the play tables and its own copy of layer 2 (the cup is written into it). */
export function simContext(rules: RomRules, data: CourseData): Ctx {
  return { rules, course: { ...kernelCourse(data), layer2: Uint8Array.from(data.tile) } };
}

/** The ball on the tee, as `startHole` puts it (core/actions.ts). */
export function teeWork(ctx: Ctx, tee: { x: number; y: number }): Work {
  const w = emptyWork();
  w.toggleOn = toggleOnAtLoad(ctx.course.layer2) ? 1 : 0; // $82:BC59
  w.waterOff = waterOffAtLoad(ctx.course.layer2) ? 1 : 0;
  w.xc = tee.x; w.xf = 0x8000;
  w.yc = tee.y; w.yf = 0x8000;
  w.air = 0;
  probe(ctx, w);
  w.z = w.ground;
  return w;
}

/**
 * Play one shot from a resting ball. `from` is not changed; `onStep` sees
 * the work copy after every step. The ball keeps
 * what the live work copy keeps between shots (the latches, the probe, the
 * heading); the set-up's resets and the launch are applied as the flow does.
 */
export function simulateShot(
  ctx: Ctx, from: Work, shot: ShotSpec, maxSteps = MAX_SHOT_STEPS,
  onStep?: (w: Work, step: number) => void,
): ShotResult {
  const { rules } = ctx;
  const w = cloneWork(from);
  // $80:C519 and the turn's resets (hole-flow.ts setupShot)
  w.lost = 0;
  w.fellOut = 0;
  w.fallTimer = 0xf0;
  w.over = 0;
  w.frames = 0;
  w.holed = 0;
  w.mode = 0;
  w.modifierKind = -1;
  w.modifierWindow = 0;
  w.modifierTimer = 0;
  // the launch ($81:C04C, $81:C0DF; panel.ts launchBall)
  w.shotAim = ((shot.aim % 360) + 360) % 360;
  w.shotElev = shot.fly ? FLY_ELEVATION : 0;
  const power = shotPower(rules, shot.meter, shot.fly);
  shotSpin(rules, w, shot.side ?? 6, shot.topBack ?? 6, power);
  launchVelocity(rules, w, power, shot.fly ? -1 : 0);
  w.air = shot.fly ? 1 : 0;
  w.airFrames = 0;
  w.spinBounceSfx = 0;
  const grounder = shot.fly ? 0 : 1;
  const onWarp = (ww: Work): void => {
    if (ww.warpPending === 0) return;
    ww.warpPending = 0;
    const to = warpDestination(ctx.course.warps, ww);
    if (to === null) return;
    warpTeleport(ctx, ww, to);
    warpExit(ctx, ww, grounder);
  };
  const hits: number[] = [];
  const hitSteps: number[] = [];
  let outcome: ShotOutcome = 'timeout';
  let steps = 0;
  while (steps < maxSteps) {
    steps += 1;
    // $82:F03E: $DA2C <- the heading the last step left (the warp reads it)
    w.scratch = w.deg;
    runKernelStep(ctx, w, onWarp);
    onStep?.(w, steps);
    if (w.enemyHit !== 0) {
      const cell = w.enemyHit - 1;
      if (!hits.includes(cell)) {
        hits.push(cell);
        hitSteps.push(steps);
      }
    }
    if (w.holed >= 1) {
      outcome = 'holed';
      break;
    }
    // $81:89AA set the lost flag; below z 0 in the air nothing can stop the
    // fall any more (ball-step.ts move-probe-edges), and the projection
    // flags it ($81:A516)
    if ((w.lost & 1) !== 0 || (w.air !== 0 && w.z < 0)) {
      outcome = 'lost';
      break;
    }
    countStill(w);
    if (w.over !== 0) {
      outcome = 'rest';
      break;
    }
  }
  return { outcome, work: w, hits, hitSteps, steps };
}
