/**
 * The core frame (plans/port_v1_koota_phaser4.md, "Core: one frame"):
 *
 *   prologue   advance-frame, latch-pad, tick-stall
 *   flow       update-hole-flow, setup-shot, update-aim, update-shot-guide,
 *              update-spin-stage, update-power-meter, launch-ball
 *   ball step  BALL_STEP (items 11-29), in Rolling only
 *   post-step  detect-ball-out, update-camera, update-pose
 *
 * The stall runner: while a stall is active a frame runs only that stall's
 * own list. A hit-stop requested on frame F idles F+1..F+N-1; on F+N the
 * suspended step resumes and the post-step systems follow. A `guideLag`
 * idles likewise and its last frame is an ordinary frame. The host latches
 * input by writing `Pad.raw` before each call.
 */
import type { World } from 'koota';
import { Time } from './traits/time';
import { Pad } from './traits/pad';
import { runBallStep, resumeBallStep, BALL_STEP } from './systems/ball-step';
import { Stall } from './systems/stall';
import { latchPad } from './systems/pad';
import { updateHoleFlow, setupShot, detectBallOut } from './systems/hole-flow';
import { updateAim, updateShotGuide } from './systems/aim';
import { updateSpinStage, updatePowerMeter, launchBall } from './systems/panel';
import { updateCamera } from './systems/camera';
import { updatePose, squashPose } from './systems/pose';
import { phaseNow } from './systems/flow-util';
import type { Ctx } from './sim/context';

export { BALL_STEP };

type System = (world: World, ctx: Ctx) => void;

/** Schedule items 4-10, in order. */
export const FLOW: Array<{ name: string; run: System }> = [
  { name: 'update-hole-flow', run: updateHoleFlow },
  { name: 'setup-shot', run: setupShot },
  { name: 'update-aim', run: updateAim },
  { name: 'update-shot-guide', run: updateShotGuide },
  { name: 'update-spin-stage', run: (w) => updateSpinStage(w) },
  { name: 'update-power-meter', run: (w) => updatePowerMeter(w) },
  { name: 'launch-ball', run: launchBall },
];

/** Schedule items 30-32. */
export const POST_STEP: Array<{ name: string; run: System }> = [
  { name: 'detect-ball-out', run: (w) => detectBallOut(w) },
  { name: 'update-camera', run: updateCamera },
  { name: 'update-pose', run: (w) => updatePose(w) },
];

/** The ball step runs in these phases (plan item 11: Rolling and SettleWait;
 *  the original's roll loop ends with the shot, so SettleWait has none). */
function ballPhase(world: World): boolean {
  return phaseNow(world).phase === 'Rolling';
}

/** One core frame. */
export function runCoreFrame(world: World, ctx: Ctx): void {
  const time = world.get(Time)!;
  world.set(Time, { frame: time.frame + 1 });
  latchPad(world);
  if (tickStall(world, ctx)) return;
  for (const s of FLOW) s.run(world, ctx);
  if (ballPhase(world) && runBallStep(world, ctx)) {
    beginHitStop(world);
    return;
  }
  for (const s of POST_STEP) s.run(world, ctx);
}

/**
 * `tick-stall`. Returns true when the frame is used up by the stall (an
 * idle frame, or a hit-stop's resumption with its post-step systems).
 */
function tickStall(world: World, ctx: Ctx): boolean {
  const stall = world.get(Stall)!;
  if (stall.kind === 'none' || stall.framesLeft <= 0) return false;
  const hit = stall.kind === 'hitStop' || stall.kind === 'stepStop';
  if (hit) {
    // $81:8CAB-$81:8CBF: OR the pad of every stall frame
    const pad = world.get(Pad)!;
    world.set(Pad, {
      ...pad,
      stallLatch: (pad.stallLatch | pad.held) & 0xffff,
      stallPressed: (pad.stallPressed | pad.pressed) & 0xffff,
    });
  }
  const left = stall.framesLeft - 1;
  if (left > 0) {
    world.set(Stall, { ...stall, framesLeft: left });
    return true;
  }
  world.set(Stall, {
    kind: 'none', framesLeft: 0, resumeAt: -1, variant: 0,
    pRoute: '', pReroute: '', pEntry: '', pOutcome: '',
  });
  if (!hit) return false; // the guide's lag: an ordinary frame now
  // $81:8CD5-$81:8CDE: the stall hands back the accumulated pad
  const pad = world.get(Pad)!;
  world.set(Pad, { ...pad, held: pad.stallLatch, pressed: pad.stallPressed, stallLatch: 0, stallPressed: 0 });
  squashPose(world, false, 0);
  if (resumeBallStep(world, ctx, stall)) {
    beginHitStop(world);
    return true;
  }
  for (const s of POST_STEP) s.run(world, ctx);
  return true;
}

/** A hit-stop just began: its own list is the squash pose ($81:8CA2). */
function beginHitStop(world: World): void {
  const pad = world.get(Pad)!;
  world.set(Pad, { ...pad, stallLatch: 0, stallPressed: 0 });
  squashPose(world, true, world.get(Stall)!.variant);
}
