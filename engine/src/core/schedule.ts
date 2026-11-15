/**
 * The core frame (plans/port_v1_koota_phaser4.md, "Core: one frame"):
 *
 *   prologue   advance-frame, latch-pad, tick-stall
 *   flow       update-hole-flow, setup-shot, update-aim, update-shot-guide,
 *              update-spin-stage, update-power-meter, launch-ball
 *   ball step  BALL_STEP (items 11-29): in Rolling (the roll loop; the sink
 *              is part of it, and the roll ends once the ball has sunk)
 *   post-step  detect-ball-out, update-camera, update-ball-sprite, update-pose
 *   threads    the thread tick: the HUD's tomato queue, the hazard actors
 *
 * The stall runner: while a stall is active a frame runs only that stall's
 * own list. A hit-stop requested on frame F idles F+1..F+N-1; on F+N the
 * suspended step resumes and the post-step systems follow. The cup reveal
 * ($82:8B5C) and the warp ($82:AA02) suspend the step the same way, for as
 * long as their own lists (systems/reveal.ts, systems/warp.ts) run. A
 * `guideLag` idles likewise and its last frame is an ordinary frame. The
 * host latches input by writing `Pad.raw` before each call. `IsPaused` on
 * the world skips the frame entirely.
 *
 * `apply-tomato-queue` (the HUD thread) ends every frame, as the thread
 * scheduler ends the ROM's ($80:8F78 after the main loop's work): a push
 * anywhere in frame F lands at the end of F + 20 (web_flow: the launch's
 * push at 2982, applied 3002; a take's at 3067, applied 3087 — the game
 * stamps those last two 3003/3088 because they happen in the first lines of
 * the next video frame, which still belong to the iteration). It also ends
 * the stall frames whose ROM loop calls the frame helper (the hit-stops,
 * the take's wait, the reveal, the warp), not the guide's or the APU's lag
 * frames.
 */
import type { World } from 'koota';
import { Time } from './traits/time';
import { Pad } from './traits/pad';
import { IsPaused, Session } from './traits/session';
import { runBallStep, resumeBallStep, BALL_STEP } from './systems/ball-step';
import { Stall } from './traits/stall';
import { tickReveal } from './systems/reveal';
import { tickWarp } from './systems/warp';
import { latchPad } from './systems/pad';
import { updateHoleFlow, setupShot, detectBallOut, ballStepRuns } from './systems/hole-flow';
import { updateAim, updateShotGuide } from './systems/aim';
import { updateSpinStage, updatePowerMeter, launchBall } from './systems/panel';
import { updateCamera } from './systems/camera';
import { updateBallSprite } from './systems/ball-sprite';
import { updatePose, squashPose } from './systems/pose';
import { threadTick } from './systems/counters';
import { emitEvent } from './systems/flow-util';
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

/** Schedule items 30-32, with update-ball-sprite between update-camera and update-pose. */
export const POST_STEP: Array<{ name: string; run: System }> = [
  { name: 'detect-ball-out', run: (w) => detectBallOut(w) },
  { name: 'update-camera', run: updateCamera },
  { name: 'update-ball-sprite', run: updateBallSprite },
  { name: 'update-pose', run: (w) => updatePose(w) },
];

/**
 * One core frame. `ctx` defaults to the session's (the hole `startHole`
 * built); without either the frame only advances the clock and the pad.
 */
export function runCoreFrame(world: World, ctx?: Ctx): void {
  if (world.has(IsPaused)) return;
  const time = world.get(Time)!;
  world.set(Time, { frame: time.frame + 1 });
  latchPad(world);
  const c = ctx ?? world.get(Session)?.ctx ?? null;
  if (c === null) return;
  const stall = tickStall(world, c);
  if (stall === 'idle') {
    if (!sameIteration(world)) return; // the guide's / the APU's lag: no thread runs
  } else if (stall === 'none') {
    for (const s of FLOW) s.run(world, c);
    if (ballStepRuns(world) && runBallStep(world, c)) beginHitStop(world);
    else for (const s of POST_STEP) s.run(world, c);
  }
  threadTick(world, c); // the thread scheduler (the HUD, the hazards), at the frame's end
}

/** Is the idle stall one whose ROM loop still runs the threads each frame? */
function sameIteration(world: World): boolean {
  const k = world.get(Stall)!.kind;
  return k === 'hitStop' || k === 'stepStop' || k === 'takeWait' || k === 'cupReveal' || k === 'warp';
}

/**
 * `tick-stall`. 'none': no stall, an ordinary frame. 'idle': a frame of
 * the stall's own list (the stall still active at its end). 'resumed': the
 * stall ended and the suspended step finished, with its post-step systems.
 * A guide/APU lag's last frame is an ordinary frame ('none').
 */
function tickStall(world: World, ctx: Ctx): 'none' | 'idle' | 'resumed' {
  const stall = world.get(Stall)!;
  if (stall.kind === 'none') return 'none';
  const own = stall.kind === 'cupReveal' || stall.kind === 'warp'; // a list of its own, no count
  if (!own && stall.framesLeft <= 0) return 'none';
  const hit = stall.kind === 'hitStop' || stall.kind === 'stepStop';
  const threads = hit || stall.kind === 'takeWait' || own;
  if (hit) {
    // $81:8CAB-$81:8CBF: OR the pad of every stall frame
    const pad = world.get(Pad)!;
    world.set(Pad, {
      ...pad,
      stallLatch: (pad.stallLatch | pad.held) & 0xffff,
      stallPressed: (pad.stallPressed | pad.pressed) & 0xffff,
    });
  }
  if (stall.kind === 'cupReveal') {
    if (!tickReveal(world)) return 'idle';
  } else if (stall.kind === 'warp') {
    if (!tickWarp(world, ctx)) return 'idle';
  } else {
    const left = stall.framesLeft - 1;
    if (left > 0) {
      world.set(Stall, { ...stall, framesLeft: left, sfx: left === 1 ? -1 : stall.sfx });
      if (left === 1 && stall.sfx >= 0) emitEvent(world, 'aim-tick', stall.sfx); // $81:A98B
      return 'idle';
    }
  }
  world.set(Stall, {
    kind: 'none', framesLeft: 0, resumeAt: -1, variant: 0, sfx: -1,
    pRoute: '', pReroute: '', pEntry: '', pOutcome: '',
  });
  if (!threads) return 'none'; // the guide's / the APU's lag: an ordinary frame now
  if (hit) {
    // $81:8CD5-$81:8CDE: the stall hands back the accumulated pad
    const pad = world.get(Pad)!;
    world.set(Pad, { ...pad, held: pad.stallLatch, pressed: pad.stallPressed, stallLatch: 0, stallPressed: 0 });
    squashPose(world, false, 0);
  }
  if (resumeBallStep(world, ctx, stall)) {
    beginHitStop(world);
    return 'resumed';
  }
  for (const s of POST_STEP) s.run(world, ctx);
  return 'resumed';
}

/** A stall just began from inside the step: a hit-stop's own list is the squash pose ($81:8CA2). */
function beginHitStop(world: World): void {
  const stall = world.get(Stall)!;
  if (stall.kind !== 'hitStop' && stall.kind !== 'stepStop') return;
  const pad = world.get(Pad)!;
  world.set(Pad, { ...pad, stallLatch: 0, stallPressed: 0 });
  squashPose(world, true, stall.variant);
}
