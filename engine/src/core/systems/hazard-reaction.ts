/**
 * A hazard's reaction (read 2026-11-14): the roll loop runs `$82:DB9A` with
 * A = $D780 after the step's store (`$82:C0A8`), and the reaction writes the
 * block. It first disarms the A/Y modifier ($DA76 = -1, $DA78 = 0), then
 * dispatches on $D780 - $0C (`$82:DBDE`):
 *
 *   $0F  a volcano's base (`$82:DBFF` -> `$82:DDF1`): the ball thrown on
 *        along its own direction (atan2 of vx, vy): speed $0500 across,
 *        vz $0800, airborne; Kirby's state 40; sfx $7B
 *   $13  the $05 tile (`$82:DD39`): thrown along its heading ($D886, the
 *        block's copy of $D9DA): vx, vy = mulFloor(cos, sin, $0474), vz
 *        $0880, airborne; state 49
 *   $14  a bumper (`$82:DD93`): state 49 only (the bounce was the handler's)
 *
 * Each also sets the block's gravity to $80:DC1D = $FFC0, the normal one.
 * State 49 lasts 32 frames, then 14 (web_haz80 2486 -> 2518, 2524 -> 2556);
 * state 40's length is unmeasured (taken as the same).
 */
import type { World } from 'koota';
import { BallAir, BallVel, Modifier, BallWork, type BallWorkFields } from '../traits/ball';
import { Pose } from '../traits/pose';
import type { Ctx } from '../sim/context';
import { atan2Deg, mulFloor, wrap16 } from '../fixed';
import { ball, emitEvent } from './flow-util';

/** Kirby's hurt states and their length (measured: 49). */
export const HURT_POSE = 49;
export const THROWN_POSE = 40;
export const HURT_FRAMES = 32;

export function hazardReaction(world: World, ctx: Ctx, w: BallWorkFields): void {
  const e = ball(world);
  w.modifierKind = -1; // $82:DBC1
  w.modifierWindow = 0;
  e.set(Modifier, { ...e.get(Modifier)!, kind: -1, window: 0 });
  const sinT = ctx.rules.table('sinDeg');
  const cosOf = (d: number): number => sinT[(d % 360) + 90];
  const sinOf = (d: number): number => sinT[d % 360];
  const throwBall = (deg: number, speed: number, vz: number): void => {
    const vx = mulFloor(cosOf(deg), speed);
    const vy = mulFloor(sinOf(deg), speed);
    e.set(BallVel, { vx, vy, vz });
    e.set(BallAir, { air: 1 });
    const work = e.get(BallWork)!;
    work.vx = vx; work.vy = vy; work.vz = vz; work.air = 1;
  };
  switch (w.hurt) {
    case 0x0f: {
      const v = e.get(BallVel)!;
      throwBall(atan2Deg(v.vx, v.vy, ctx.rules.table('atanDeg')), 0x0500, 0x0800);
      e.set(Pose, { ...e.get(Pose)!, state: THROWN_POSE, timer: HURT_FRAMES });
      emitEvent(world, 'thrown', 0x7b);
      break;
    }
    case 0x13:
      throwBall(w.deg === 0xffff ? w.lastDeg : w.deg, 0x0474, 0x0880);
      e.set(Pose, { ...e.get(Pose)!, state: HURT_POSE, timer: HURT_FRAMES });
      break;
    case 0x14:
      e.set(Pose, { ...e.get(Pose)!, state: HURT_POSE, timer: HURT_FRAMES });
      break;
    default:
      break;
  }
  w.gravity = wrap16(0xffc0); // $80:DC1D
  w.hurt = 0;
}
