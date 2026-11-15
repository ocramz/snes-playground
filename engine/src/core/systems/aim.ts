/**
 * The aim stage, the loop $81:A680-$81:A80A (schedule items 6 and 7; read
 * 2026-11-14, build/engine/disasm/flow-aim.txt). One iteration a frame:
 *
 *   A pressed  -> sfx $34, pose 4, the loop returns ($81:A780): PanToShot
 *   $81:B555   the d-pad turns the aim / picks the shot kind
 *   $81:BB4A   the facing, when the aim changed
 *   $81:BA8A   the camera pans toward the guide's end (update-camera)
 *   $81:A7E6   pose 5 while a direction is held or L/R pressed, else 4
 *   $81:A956   on a change: the guide again ($6ACE = 1, $6ADA = 16), sfx
 *              $53; in a fly shot, 16 quiet iterations later the full guide
 *              ($6ACE = $6ACC). The guide outlasts the frame: the loop's
 *              next iteration comes `guideLagFrames` later (Stall guideLag).
 *
 * Y (look around), B (the overview) and Start (pause) are recorded in
 * notes/engine-phase5-flow.md and not ported in phase 5.
 */
import type { World } from 'koota';
import { Pad } from '../traits/pad';
import { Shot, GUIDE_FULL_ENDS } from '../traits/shot';
import { Guide } from '../traits/guide';
import { Camera } from '../traits/camera';
import { Pose, PoseState } from '../traits/pose';
import { BallWork, BallPos } from '../traits/ball';
import { Stall } from '../traits/stall';
import type { Ctx } from '../sim/context';
import { aimPad, PAD, type AimInput } from '../sim/aim';
import { facingFromAim } from '../sim/facing';
import { simulateGuide } from '../sim/guide';
import { aimQuarter } from '../sim/camera';
import { BallScreen } from '../traits/pose';
import { ball, emitEvent, enterPhase, frameOf, phaseNow } from './flow-util';

/** Schedule item 6. */
export function updateAim(world: World, ctx: Ctx): void {
  const { phase, t } = phaseNow(world);
  if (phase !== 'Aim' || t === 0) return;
  const pad = world.get(Pad)!;
  const e = ball(world);
  if ((pad.pressed & PAD.A) !== 0) {
    // $81:A780: the aim is confirmed
    emitEvent(world, 'aim-confirm', 0x34);
    e.set(Pose, { ...e.get(Pose)!, state: PoseState.Aim });
    // $81:BE9A: the shot view, Kirby + the quarter's offset
    const shot = world.get(Shot)!;
    const sc = e.get(BallScreen)!;
    const q = aimQuarter(shot.aim);
    world.set(Shot, {
      ...shot,
      viewX: (sc.x + ctx.rules.table('shotViewX')[q]) & 0xffff, // $81:C0F0
      viewY: (sc.y + ctx.rules.table('shotViewY')[q]) & 0xffff, // $81:C0F8
    });
    enterPhase(world, 'PanToShot');
    return;
  }
  const shot = world.get(Shot)!;
  const s: AimInput = {
    aim: shot.aim, hold: shot.hold, kind: shot.kind, grounder: shot.grounder,
    elev: shot.elev, guideSide: shot.guideSide, guideTB: shot.guideTB, changed: shot.changed,
  };
  aimPad(s, pad.held, pad.pressed);
  world.set(Shot, { ...shot, ...s });
  const pose = e.get(Pose)!;
  let { facing, angle } = pose;
  // $81:A665/$81:A669 (the head's tail, t = 1) and $81:A7A9 (on a change)
  if (s.changed !== 0 || t === 1) ({ facing, angle } = facingFromAim(ctx.rules, s.aim));
  const turning = (pad.pressed & (PAD.L | PAD.R)) !== 0 || (pad.held & PAD.DPAD) !== 0;
  e.set(Pose, { ...pose, state: turning ? PoseState.AimTurn : PoseState.Aim, facing, angle });
}

/**
 * Schedule item 7, $81:A956: the guide again when the aim changed; in a fly
 * shot, the full guide once the aim has been still for 16 iterations.
 */
export function updateShotGuide(world: World, ctx: Ctx): void {
  publishGuide(world);
  const { phase, t } = phaseNow(world);
  if (phase !== 'Aim' || t === 0) return;
  const shot = world.get(Shot)!;
  if (shot.changed !== 0) {
    world.set(Shot, {
      ...shot,
      guideEnds: 1,
      guideTimer: (GUIDE_FULL_ENDS as number) !== 1 ? 16 : 0, // $81:A964
      changed: 0,
    });
    // $81:A977 -> $81:A98B: the guide first, then the facing and the tick:
    // the sound comes on the lag's last frame (web_flow 2336 -> 2338)
    requestGuide(world, ctx, -1, 0x53);
    return;
  }
  if (shot.kind === 2 && shot.guideTimer !== 0) {
    const left = shot.guideTimer - 1;
    world.set(Shot, { ...shot, guideTimer: left });
    if (left === 0) {
      world.set(Shot, { ...world.get(Shot)!, guideEnds: GUIDE_FULL_ENDS });
      requestGuide(world, ctx, -1, 0x53); // $81:A9AC: JMP $A970, the same path and tick
    }
  }
}

/**
 * $81:AE26-$81:AE2F: a guide computed on an earlier frame has written its
 * first end, projected, as the aim camera's target. (The ROM writes it at
 * the guide's end, which falls in the lag's last frame; the loop's next
 * iteration is the first to pan toward it.)
 */
export function publishGuide(world: World): void {
  const g = world.get(Guide)!;
  if (g.pendingFrame < 0 || g.pendingFrame >= frameOf(world) || g.ends.length === 0) return;
  const cam = world.get(Camera)!;
  world.set(Camera, { ...cam, targetX: g.ends[0].sx, targetY: g.ends[0].sy });
  g.pendingFrame = -1;
}

/**
 * Simulate the guide now and keep its result; the camera picks the new
 * target up on the next frame it runs (Guide.pendingFrame). `lag` -1 asks
 * for the measured lag of the loop; 0 for none (the set-up's guide).
 */
export function requestGuide(world: World, ctx: Ctx, lag: number, tick = -1): void {
  const shot = world.get(Shot)!;
  const e = ball(world);
  const live = e.get(BallWork)!;
  const pos = e.get(BallPos)!;
  // the live work copy carries the block's position; the guide restarts
  // from the origin ($81:BB18)
  const seed = { ...live, xc: pos.xc, xf: pos.xf, yc: pos.yc, yf: pos.yf, z: pos.z };
  const r = simulateGuide(ctx, seed, {
    aim: shot.aim,
    elev: shot.elev,
    kind: shot.kind,
    grounder: shot.grounder,
    guideSide: shot.guideSide,
    guideTB: shot.guideTB,
    ends: Math.max(1, shot.guideEnds),
    originXf: shot.originXf, originXc: shot.originXc,
    originYf: shot.originYf, originYc: shot.originYc, originZ: shot.originZ,
  }, ctx.course);
  live.wallCode = r.wallCode; // the guide ran on the real work copy
  live.boostFlash = r.boostFlash; // $6A28: a global the guide's boost hits write
  live.guideTile = r.tile; // $DA0A until the next step reloads the block
  live.guideLeft = 1;
  const g = world.get(Guide)!;
  g.points = r.points;
  g.ends = r.ends;
  g.steps = r.steps;
  g.version += 1;
  g.pendingFrame = frameOf(world); // (AoS: the trait's object, mutated in place)
  const frames = lag < 0 ? guideLagFrames(r.steps, shot.kind === 2, shot.guideEnds > 1) : lag;
  if (frames > 1) {
    world.set(Stall, { ...world.get(Stall)!, kind: 'guideLag', framesLeft: frames, resumeAt: -1, sfx: tick });
  } else {
    if (frames === 1) world.set(Stall, { ...world.get(Stall)!, kind: 'guideLag', framesLeft: 1, resumeAt: -1, sfx: -1 });
    if (tick >= 0) emitEvent(world, 'aim-tick', tick);
  }
}

/**
 * How many frames the guide costs the aim loop: its next iteration comes
 * this many frames later. Measured, not derived (the guide's cycle count is
 * not modelled): a 40-step rolling guide gives 3 (web_flow 2353/2356, every
 * auto-repeat step), a fly shot's guide to its first landing 5 (web_ui
 * 2600/2605), the fly shot's full guide (3 ends, $6ACC) 8 (web_fly and
 * web_ui: requested at 2620, its tick at 2627 — phase 6, from the sound
 * log). Approximated as 1 + ceil(steps / 20) for rolling guides and the
 * measured 5 / 8 for airborne ones; notes/engine-phase5-flow.md.
 */
export function guideLagFrames(steps: number, fly: boolean, full = false): number {
  if (fly) return full ? 8 : 5;
  return 1 + Math.ceil(steps / 20);
}
