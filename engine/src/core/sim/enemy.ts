/**
 * The enemy-tile handler ($82:8967 on land, $82:8963/$82:8967 on the
 * rolling path) — the detection half of docs/physics.md "The hit rule".
 *
 * The take itself (loc_enemy_taken $82:8A98: the owner store, the star
 * count, the last-enemy-to-cup conversion and its reveal stall) needs the
 * hole's enemy entities and is **phase 6**: `onEnemyHit` is a hook the
 * ball-step system wires to the phase-6 action. Until it is wired the
 * detection runs and the take is skipped, which the traces that take an
 * enemy will show.
 */
import type { Ctx, Work } from './context';
import { LANDING, ROLLING, type DispatchOutcome } from './types';

/** The per-player enemy latch ($6A68) rides on the ball's work copy. */
export function enemyLatch(work: Work): number {
  return work.enemyLatch;
}

/**
 * $82:8990: does the ball hit the enemy on this cell? Both fractions must
 * be in the middle half; a grounded ball counts, an airborne one only
 * within the height window H - $2D41 .. H + $5A82 around the enemy's own
 * hover height H (measured from the ground under the ball).
 *
 * The enemy's hover height comes from the hole's enemy entities (the
 * thread slot's $5B1C field, phase 6); until then `hoverSteps` is 0, the
 * value every ground enemy has — the pit enemies of course 5 hole 6 are
 * the known exception (docs/physics.md).
 */
export function enemyHitTest(_ctx: Ctx, w: Work, hoverSteps: number): boolean {
  if (!(w.xf >= 0x4000 && w.xf < 0xc000)) return false;
  if (!(w.yf >= 0x4000 && w.yf < 0xc000)) return false;
  if (w.air === 0) return true;
  const h = hoverSteps * 0x5a82;
  const upper = h + 0x5a82;
  const lower = h - 0x2d41;
  return w.z < upper && w.z >= lower;
}

/** $82:8967: the dispatch entry. `hoverSteps` comes from the hole entities. */
export function enemyDispatch(ctx: Ctx, w: Work, hoverSteps = 0, onTake?: (work: Work) => void): DispatchOutcome {
  const hit = enemyHitTest(ctx, w, hoverSteps);
  if (!hit) {
    // $82:8A21: in the cell but outside the window clears the latch
    w.enemyLatch = 0;
    w.enemyHitMark = 0; // $6A0C
  } else if (w.enemyLatch === 0) {
    w.enemyLatch = 1;
    w.enemyHitMark = 1;
    onTake?.(w);
  }
  // $82:8983: airborne continues into the landing chain, grounded into the
  // rolling default
  return w.air !== 0 ? LANDING : ROLLING;
}
