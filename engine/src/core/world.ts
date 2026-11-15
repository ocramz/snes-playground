import { createWorld, type Entity, type World } from 'koota';
import { Pad } from './traits/pad';
import { Time } from './traits/time';
import { Shot } from './traits/shot';
import { HoleFlow } from './traits/flow';
import { Camera } from './traits/camera';
import { Guide } from './traits/guide';
import { Pose, BallScreen, BallSprite, PRIO_OVER } from './traits/pose';
import {
  BallPos, BallVel, BallAir, BallWet, BallSpin, BallMode, BallAbility, BallHoled, BallHeading,
  StillCount, Modifier, BallWork,
} from './traits/ball';
import { Tomatoes, Strokes, Stars, StockedAbility, Career, TomatoQueue } from './traits/counters';
import { Session } from './traits/session';
import { Visual } from './traits/visual';
import { BoostHum } from './traits/boost';
import { SnapTrail } from './traits/snap';
import { WaterFx, GameRng, KirbyPalette } from './traits/water';
import { AbilityFx } from './traits/ability-fx';
import { Stall } from './traits/stall';
import { Reveal } from './traits/reveal';
import { Warp } from './traits/warp';
import { Hazards } from './traits/hazards';
import { IsPlayer, IsActivePlayer } from './traits/player';

/**
 * The one game world. No module-level world: the headless test harness and
 * the Phaser host each create their own (plans/port_v1_koota_phaser4.md,
 * "createGameWorld(), no global"). The world singletons are the frame
 * clock, the pad, the stall, the shot, the flow, the camera, the guide,
 * the session (rules + courses), the career (lives, card) and the tomato
 * queue.
 */
export function createGameWorld(): World {
  const world = createWorld();
  // Visual first: it is the one trait the bridge tracks (Removed, Changed),
  // and Koota 0.6.6's tracking loop (`for (bit = 1; bit <= mask; bit <<= 1)`
  // in createQueryInstance) never ends for a trait on a generation's last
  // bit, 2^30: the shift overflows to -2^31, then 0. A trait takes the next
  // bit when the world first sees it, so registering Visual here keeps it on
  // bit 0 however many traits come before its first spawn (the warp's trait
  // pushed it to 2^30, and the hole scene hung in primeBindings).
  world.query(Visual);
  world.add(Time);
  world.add(Pad);
  world.add(Stall);
  world.add(Reveal);
  world.add(Warp);
  world.add(Shot);
  world.add(HoleFlow);
  world.add(Camera);
  world.add(Guide);
  world.add(Session);
  world.add(Career);
  world.add(TomatoQueue);
  world.add(Hazards);
  world.add(BoostHum);
  world.add(SnapTrail);
  world.add(WaterFx);
  world.add(GameRng);
  world.add(AbilityFx);
  return world;
}

/**
 * A player entity (traits/player.ts): the block-backed traits, the work
 * copy, Kirby's pose, the counters. 1 player: it is spawned once, by the
 * first `startCourse`, and is the active player from then on; it is not
 * under the hole root, so it outlives the holes and GAME END.
 */
export function spawnPlayer(world: World): Entity {
  const e = world.spawn(
    IsPlayer,
    IsActivePlayer,
    BallPos({ xc: 0, xf: 0, yc: 0, yf: 0, z: 0 }),
    BallVel({ vx: 0, vy: 0, vz: 0 }),
    BallAir({ air: 0 }),
    BallWet({ wet: 0 }),
    BallSpin({ sx: 0, sy: 0, pending: 0 }),
    BallMode({ mode: 0 }),
    BallAbility({ worn: 0, latch: 0 }),
    BallHoled({ holed: 0 }),
    BallHeading({ deg: 0, last: 0 }),
    StillCount({ over: 0, frames: 0 }),
    Modifier({ kind: -1, window: 0, timer: 0 }),
    BallWork(),
    Pose(),
    BallScreen(),
    BallSprite({ prio: PRIO_OVER }),
    KirbyPalette({ wet: 0 }),
    Tomatoes({ n: 4 }),
    Strokes({ n: 1 }),
    Stars({ n: 0 }),
    StockedAbility({ id: 0, carry: 0 }),
    Visual({ kind: 'ball' }),
  );
  return e;
}
