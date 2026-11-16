/**
 * A hazard's reaction (read 2026-11-14; 2026-11-15 for the codes in the
 * mode): the roll loop runs `$82:DB9A` with A = $D780 after the step's store
 * (`$82:C0A8`), and the reaction writes the block: the code becomes the
 * mode and the worn ability (`$82:DBBB`), which Kirby's state code B ends
 * (one step for $14; until the first bounce for $13; for $0F the flight
 * and 41 iterations), then it dispatches on $D780 - $0C (`$82:DBDE`):
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
import { BallAir, BallVel, BallMode, BallAbility, type BallWorkFields } from '../traits/ball';
import { thaw } from '../sim/water';
import { Pose } from '../traits/pose';
import type { Ctx } from '../sim/context';
import { atan2Deg, mulFloor, wrap16 } from '../fixed';
import { emitEvent } from './flow-util';
import { activePlayer } from '../traits/player';

/** Kirby's hurt states and their length (measured: 49). */
export const HURT_POSE = 49;
export const THROWN_POSE = 40;
export const HURT_FRAMES = 32;

export function hazardReaction(world: World, ctx: Ctx, w: BallWorkFields): void {
  const e = activePlayer(world);
  const code = w.hurt;
  w.hurt = 0;
  // $82:DB9A: the ice gives way ($82:D9C2)
  if (w.waterFreeze !== 0) thaw(w);
  // $82:DBBB: the code into the block's mode and worn ability (the next
  // load brings it into the step: Kirby's state code B, sim/abilities.ts
  // codeAir/codeGround, ends it); its work-copy writes of the modifier
  // ($DA76/$DA78) are lost at that load
  e.set(BallMode, { mode: code });
  e.set(BallAbility, { ...e.get(BallAbility)!, worn: code });
  const sinT = ctx.rules.table('sinDeg');
  const cosOf = (d: number): number => sinT[(d % 360) + 90];
  const sinOf = (d: number): number => sinT[d % 360];
  const throwBall = (deg: number, speed: number, vz: number): void => {
    const vx = mulFloor(cosOf(deg), speed);
    const vy = mulFloor(sinOf(deg), speed);
    e.set(BallVel, { vx, vy, vz });
    e.set(BallAir, { air: 1 });
    w.vx = vx; w.vy = vy; w.vz = vz; w.air = 1;
  };
  switch (code) {
    case 0x0f: {
      // $82:DBFF + $82:DDF1: on along its own direction, $0500, vz $0800
      const v = e.get(BallVel)!;
      throwBall(atan2Deg(v.vx, v.vy, ctx.rules.table('atanDeg')), 0x0500, 0x0800);
      e.set(Pose, { ...e.get(Pose)!, state: THROWN_POSE, timer: HURT_FRAMES });
      w.d788 = 0;
      emitEvent(world, 'thrown', 0x7b);
      break;
    }
    case 0x13:
      // $82:DD39: along the block's heading $D886, $0474, vz $0880
      throwBall(w.deg === 0xffff ? w.lastDeg : w.deg, 0x0474, 0x0880);
      e.set(Pose, { ...e.get(Pose)!, state: HURT_POSE, timer: HURT_FRAMES });
      w.stillGate = 0; // $D84A,X
      w.d784 = 1;
      w.block6a = 0; // $D95E,X
      break;
    case 0x14:
      // $82:DD93 (palette set 3 is the view's)
      w.d76c = wrap16(w.d76c + 1);
      w.block6a = 0;
      e.set(Pose, { ...e.get(Pose)!, state: HURT_POSE, timer: HURT_FRAMES });
      w.stillGate = 0;
      break;
    default:
      throw new Error(`hazard reaction ${code}: 2P only, not ported (step 9)`);
  }
  w.gravity = wrap16(0xffc0); // $D932,X = $80:DC1D
  for (const sfx of w.abilitySfx) emitEvent(world, 'ability', sfx);
  w.abilitySfx = [];
}
