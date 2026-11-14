/**
 * The core actions (plans/port_v1_koota_phaser4.md "Actions"). Phase 4
 * ships `placeBall`, the poke equivalent the trace tests seed from and the
 * later debug UI reuses: it writes the block traits and the Shot fields
 * directly, exactly as tools/snesstep's pokes do.
 */
import type { World } from 'koota';
import { ballEntity } from './systems/ball-step';
import { BallPos, BallVel, BallAir, BallSpin, StillCount, Modifier } from './traits/ball';
import { Shot } from './traits/shot';
import { BallWork, type BallWorkFields } from './traits/ball';
import { probe } from './sim/probe';
import type { Ctx } from './sim/context';

export interface BallPlacement {
  xc: number; xf: number; yc: number; yf: number; z: number;
  vx: number; vy: number; vz: number;
  air: number;
  aim?: number;
  elev?: number;
  spinX?: number; spinY?: number; spinPending?: number;
}

export function placeBall(world: World, p: BallPlacement, ctx?: Ctx): void {
  const e = ballEntity(world);
  e.set(BallPos, { xc: p.xc, xf: p.xf, yc: p.yc, yf: p.yf, z: p.z });
  e.set(BallVel, { vx: p.vx, vy: p.vy, vz: p.vz });
  e.set(BallAir, { air: p.air });
  if (p.spinX !== undefined || p.spinY !== undefined || p.spinPending !== undefined) {
    e.set(BallSpin, {
      sx: p.spinX ?? 0,
      sy: p.spinY ?? 0,
      pending: p.spinPending ?? 0,
    });
  }
  const shot = e.get(Shot)!;
  e.set(Shot, {
    aim: p.aim ?? shot.aim,
    elev: p.elev ?? shot.elev,
    power: shot.power,
  });
  // the placement clears the shot-over state, as a poke does
  e.set(StillCount, { over: 0, frames: 0 });
  e.set(Modifier, { kind: -1, window: 0, timer: 0 });
  if (ctx) {
    // Seed the work copy's probe fields (the ROM's block carries them at
    // $D8C2-$D8DE; a poke that skips them leaves the first step's z at the
    // stale ground). The next begin-ball-step copies them to "previous".
    const w = e.get(BallWork)! as BallWorkFields;
    w.xc = p.xc; w.xf = p.xf; w.yc = p.yc; w.yf = p.yf; w.z = p.z;
    w.vx = p.vx; w.vy = p.vy; w.vz = p.vz; w.air = p.air;
    probe(ctx, w);
  }
}
