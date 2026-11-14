import { createWorld, type World } from 'koota';
import { Pad } from './traits/pad';
import { Time } from './traits/time';
import { Shot } from './traits/shot';
import {
  BallPos, BallVel, BallAir, BallSpin, BallMode, BallHoled, BallHeading,
  StillCount, Modifier, BallWork,
} from './traits/ball';
import { Stall } from './systems/stall';

/**
 * The one game world. No module-level world: the headless test harness and
 * the Phaser host each create their own (plans/port_v1_koota_phaser4.md,
 * "createGameWorld(), no global"). Traits land subsystem by subsystem; the
 * ball entity and the stall runner are phase 4's additions.
 */
export function createGameWorld(): World {
  const world = createWorld();
  world.add(Time);
  world.add(Pad);
  world.add(Stall);
  return world;
}

/** The ball entity: the block-backed traits plus the work copy. */
export function spawnBall(world: World): number {
  const e = world.spawn(
    BallPos({ xc: 0, xf: 0, yc: 0, yf: 0, z: 0 }),
    BallVel({ vx: 0, vy: 0, vz: 0 }),
    BallAir({ air: 0 }),
    BallSpin({ sx: 0, sy: 0, pending: 0 }),
    BallMode({ mode: 0 }),
    BallHoled({ holed: 0 }),
    BallHeading({ deg: 0, last: 0 }),
    StillCount({ over: 0, frames: 0 }),
    Modifier({ kind: -1, window: 0, timer: 0 }),
    Shot({ aim: 0, elev: 0, power: 0 }),
    BallWork(),
  );
  return e;
}
