/**
 * The snap panels' star trail in the frame (sim/snap-stars.ts):
 *
 * - `noteSnapPush`, from the ball step's effects: a push clears `$699A`
 *   ($82:A5F7) and, with the latch clear, spawns an object 61 ($82:A60E;
 *   the event `snap-trail`).
 * - `tickSnapTrail`, in the thread tick (list 3 of `$80:E0C0`): the stars
 *   live so far, then the spawners, whose bursts run in the same tick.
 *
 * Object 61 reads the ball as the scheduler finds it: the work copy's
 * `$DA0A` (or the guide's, while it is still there, as boost-hum.ts), the
 * block's velocity, `$D9DE`, and Kirby's projected point ($81:A21E:
 * `$091E,X` = `$DA58`, `$093E,X` = `$8B9A` - `$DA5C`).
 */
import type { World } from 'koota';
import type { Ctx } from '../sim/context';
import { BallWork, BallVel, type BallWorkFields } from '../traits/ball';
import { BallScreen } from '../traits/pose';
import { findActivePlayer } from '../traits/player';
import { SnapTrail } from '../traits/snap';
import { newSpawner, tickSpawner, tickStar, type StarRun } from '../sim/snap-stars';
import { emitEvent } from './flow-util';

/** The step's facts: the keep-alive and the spawns. */
export function noteSnapPush(world: World, w: BallWorkFields): void {
  if (w.snapKeep === 0 && w.snapSpawn === 0) return;
  const trail = world.get(SnapTrail)!;
  if (w.snapKeep !== 0) trail.keep = 0; // STZ $699A
  for (let i = 0; i < w.snapSpawn; i++) {
    trail.spawners.push(newSpawner());
    emitEvent(world, 'snap-trail');
  }
}

export function tickSnapTrail(world: World, ctx: Ctx): void {
  const trail = world.get(SnapTrail);
  if (!trail || (trail.spawners.length === 0 && trail.stars.length === 0)) return;
  for (const s of trail.stars) tickStar(ctx.rules, s);
  const e = findActivePlayer(world);
  const born: StarRun[] = [];
  if (e && trail.spawners.length > 0) {
    const w = e.get(BallWork)!;
    const vel = e.get(BallVel)!;
    const sc = e.get(BallScreen)!;
    const ball = {
      tile: w.guideLeft !== 0 ? w.guideTile : w.tile,
      vx: vel.vx, vy: vel.vy,
      dir16: w.dir16,
      x: sc.x & 0xffff,
      y: (ctx.course.screenBase - sc.y) & 0xffff,
    };
    for (const s of trail.spawners) {
      const r = tickSpawner(ctx.rules, s, trail.keep, ball);
      trail.keep = r.keep;
      born.push(...r.stars);
    }
  }
  for (const s of born) tickStar(ctx.rules, s); // spawned during the tick: thread and draw now
  trail.stars = trail.stars.filter((s) => !s.done).concat(born.filter((s) => !s.done));
  trail.spawners = trail.spawners.filter((s) => !s.done);
}
