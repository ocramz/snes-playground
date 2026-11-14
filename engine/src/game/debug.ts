/**
 * The debug hook's actions (?debug): the ball put onto an enemy or onto the
 * cup through core's `placeBall`, the way test/course-driver.ts pokes it
 * (and tools/snesstep/autoplay.py pokes the game): onto an enemy airborne,
 * 0.4 cell short of its centre, moving inward at $2000 a frame, half a step
 * above it; onto the cup still on its centre. For the e2e scripts and for
 * playing the hole-out by hand from the console.
 */
import type { World } from 'koota';
import { placeBall } from '../core/actions';
import { Course, courseEntity } from '../core/traits/course';
import { Cell, EnemyKind, Hover, IsCup, IsEnemy, TakenBy } from '../core/traits/hole';
import { HoleFlow } from '../core/traits/flow';

const STEP = 0x5a82;

function top(world: World, x: number, y: number): number {
  const c = courseEntity(world).get(Course)!;
  return ((c.elev[y * c.w + x] + 1) * STEP) | 0;
}

/** The free enemies' cells, in list order (the last one becomes the cup). */
export function freeEnemies(world: World): Array<{ x: number; y: number }> {
  return world.query(IsEnemy, Cell, EnemyKind)
    .filter((e) => !e.has(IsCup) && e.targetFor(TakenBy) === undefined)
    .sort((a, b) => a.get(EnemyKind)!.listIndex - b.get(EnemyKind)!.listIndex)
    .map((e) => ({ ...e.get(Cell)! }));
}

/** Throw the rolling ball into the next free enemy. False when not rolling or none is left. */
export function hitNextEnemy(world: World): boolean {
  if (world.get(HoleFlow)!.phase !== 'Rolling') return false;
  const next = freeEnemies(world)[0];
  if (!next) return false;
  const e = world.query(IsEnemy, Cell).find((n) => n.get(Cell)!.x === next.x && n.get(Cell)!.y === next.y)!;
  placeBall(world, {
    xc: next.x, xf: 0x8000 - 0x6666, yc: next.y, yf: 0x8000,
    z: top(world, next.x, next.y) + e.get(Hover)!.steps * STEP + 0x2d41, vx: 0x2000, vy: 0, vz: 0, air: 1,
  });
  return true;
}

/** Put the rolling ball still on the cup's centre. False when not rolling or there is no cup. */
export function putOnCup(world: World): boolean {
  if (world.get(HoleFlow)!.phase !== 'Rolling') return false;
  const cup = world.queryFirst(IsCup);
  if (cup === undefined) return false;
  const { x, y } = cup.get(Cell)!;
  placeBall(world, { xc: x, xf: 0x8000, yc: y, yf: 0x8000, z: top(world, x, y), vx: 0, vy: 0, vz: 0, air: 0 });
  return true;
}
