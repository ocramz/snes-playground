/**
 * The core frame (plans/port_v1_koota_phaser4.md, "Core: one frame"). The
 * prologue advances the frame counter; the pad is latched by the host (the
 * Phaser bridge or the headless harness) before the schedule runs.
 *
 * Phase 4 runs the ball step only; the flow systems (aim, spin, meter,
 * launch) and the post-step systems (camera, pose) slot in at the marked
 * points in phase 5.
 */
import type { World } from 'koota';
import { Time } from './traits/time';
import { runBallStep, BALL_STEP } from './systems/ball-step';
import type { Ctx } from './sim/context';

export { BALL_STEP };

/** One core frame: prologue, [flow], the ball step, [post-step]. */
export function runCoreFrame(world: World, ctx: Ctx): void {
  const time = world.get(Time)!;
  world.set(Time, { frame: time.frame + 1 });
  // [phase 5: the flow systems run here]
  runBallStep(world, ctx);
  // [phase 5: update-camera and update-pose run here]
}
