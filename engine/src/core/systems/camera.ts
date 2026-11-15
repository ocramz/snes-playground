/**
 * `update-camera` (schedule item 31): Kirby's projection and the world
 * camera, by phase (docs/web-demo.md "Camera"; read 2026-11-14,
 * build/engine/disasm/flow-*.txt):
 *
 * - Aim: each iteration pans toward the guide's first end ($81:A7B5); a new
 *   guide result becomes the target only on a later frame (aim.ts,
 *   `publishGuide`), so the iteration that asked for it still pans toward
 *   the old one.
 * - PanToShot: from P+4, toward the shot view ($81:BED5).
 * - Rolling: the roll loop's presentation $81:A121:
 *     $81:A46F/$81:A430  project the ball (z included) as Kirby's position
 *     $D9D2 bit 0        the projection sets it when z drops below 0
 *                        ($81:A516). The first time: song $90 ($81:A175,
 *                        the falling ball), $D9D2 = 1, and the song's APU
 *                        handshake stalls the loop (Stall apuLag). From
 *                        then on no follow; $6A88 counts 240 frames to
 *                        "shot over", or less if z < -$18_0000 ($81:A196).
 *     otherwise          the follow ($80:B943 -> $80:B992 -> $80:BA35), then
 *                        last frame's position ($81:A449).
 *   The follow runs while the shot is not over and the work copy moves
 *   ($80:B97C-$80:B98A).
 */
import type { World } from 'koota';
import { Camera } from '../traits/camera';
import { Shot } from '../traits/shot';
import { BallScreen } from '../traits/pose';
import { BallWork, StillCount, BallMode, BallHoled } from '../traits/ball';
import { Stall } from '../traits/stall';
import type { Ctx } from '../sim/context';
import { panStep, followStep } from '../sim/camera';
import { project } from '../projection';
import { ball, emitEvent, phaseNow } from './flow-util';
import { PAN_DELAY } from './panel';

/** The song request's APU handshake, measured (web_fly 3252 -> 3256). */
export const APU_LAG_FRAMES = 4;

export function updateCamera(world: World, ctx: Ctx): void {
  const { phase, t } = phaseNow(world);
  if (phase === 'Aim' && t > 0) {
    const cam = { ...world.get(Camera)! };
    panStep(cam, cam.targetX, cam.targetY);
    world.set(Camera, cam);
    return;
  }
  if (phase === 'PanToShot' && t >= PAN_DELAY) {
    const shot = world.get(Shot)!;
    const cam = { ...world.get(Camera)! };
    panStep(cam, shot.viewX, shot.viewY);
    world.set(Camera, cam);
    return;
  }
  if (rollLoopPresents(world)) presentRoll(world, ctx);
}

/**
 * Whether this frame runs the roll loop's presentation ($81:A121, then
 * $81:A23E and $82:F4FD). The presentation precedes the still count's
 * shot-over ($81:A5CD), so the sink's last step (holed 2 and over in one
 * step) is still projected (web_hole 3908). A fall's over comes from the
 * presentation itself and is seen on the next frame (web_fly 3496).
 */
export function rollLoopPresents(world: World): boolean {
  const { phase, t } = phaseNow(world);
  if (phase === 'Rolling') return true;
  return phase === 'RollEnd' && t === 0 && ball(world).get(BallHoled)!.holed >= 2;
}

/** $81:A121, the roll loop's presentation (see the header). */
function presentRoll(world: World, ctx: Ctx): void {
  const e = ball(world);
  const w = e.get(BallWork)!;
  const sc = e.get(BallScreen)!;
  // $81:A46F: the work copy's position (after the step)
  const p = project(ctx.course, w.xc, w.xf, w.yc, w.yf, w.z);
  if (p.negative) w.lost |= 1; // $81:A516 TSB $D9D2
  const k = { x: p.x, xf: p.xf, y: p.y, yf: p.yf, px: sc.px, pxf: sc.pxf, py: sc.py, pyf: sc.pyf };
  if ((w.lost & 1) !== 0) {
    if (w.fallTimer === 0xf0) {
      // $81:A16C-$81:A190: the first frame of the fall
      const mode10 = e.get(BallMode)!.mode === 0x0a;
      emitEvent(world, 'song', (mode10 ? 0x8f : 0x90) - 0x7e);
      w.lost = 1;
      world.set(Stall, { ...world.get(Stall)!, kind: 'apuLag', framesLeft: APU_LAG_FRAMES, resumeAt: -1 });
    }
    // $81:A196-$81:A1B5
    let over = w.fallTimer === 0;
    if (!over) {
      w.fallTimer -= 1;
      over = ((w.z >>> 16) & 0xffff) < 0xffe8; // $81:A1A1: CMP #$FFE8, BCS
    }
    if (over) {
      w.fallTimer = 0xf0;
      e.set(StillCount, { ...e.get(StillCount)!, over: 1 });
    }
    e.set(BallScreen, k);
    return;
  }
  // $80:B943 -> $80:BA35: the follow, from this frame's and last frame's
  // positions; then $81:A449 makes this frame's the last
  const moving = (w.vx | w.vy | w.vz) !== 0;
  if (e.get(StillCount)!.over === 0 && moving) {
    const cam = { ...world.get(Camera)! };
    followStep(cam, k);
    world.set(Camera, cam);
  }
  e.set(BallScreen, { ...k, px: k.x, pxf: k.xf, py: k.y, pyf: k.yf });
}
