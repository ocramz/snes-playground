import { createWorld, type World } from 'koota';
import { Pad } from './traits/pad';
import { Time } from './traits/time';
import { Shot } from './traits/shot';
import { HoleFlow } from './traits/flow';
import { Camera } from './traits/camera';
import { Guide } from './traits/guide';
import { Pose, BallScreen } from './traits/pose';
import {
  BallPos, BallVel, BallAir, BallSpin, BallMode, BallHoled, BallHeading,
  StillCount, Modifier, BallWork,
} from './traits/ball';
import { Stall } from './systems/stall';

/**
 * The one game world. No module-level world: the headless test harness and
 * the Phaser host each create their own (plans/port_v1_koota_phaser4.md,
 * "createGameWorld(), no global"). The world singletons are the frame
 * clock, the pad, the stall, and phase 5's shot, flow, camera and guide.
 */
export function createGameWorld(): World {
  const world = createWorld();
  world.add(Time);
  world.add(Pad);
  world.add(Stall);
  world.add(Shot);
  world.add(HoleFlow);
  world.add(Camera);
  world.add(Guide);
  return world;
}

/** The ball entity: the block-backed traits, the work copy, Kirby's pose. */
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
    BallWork(),
    Pose(),
    BallScreen(),
  );
  return e;
}
