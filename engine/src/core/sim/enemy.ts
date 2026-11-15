/**
 * The enemy-tile handler, `$82:8967` (tiles $40-$52 and $57 on land, and
 * $40-$4C and $57 on the rolling path; read 2026-11-14) — docs/physics.md
 * "The hit rule". Tiles $4D-$52 on the rolling path go to `$82:8963`, a bare
 * `JML $81:8A56`: a rolling ball never tests a hovering enemy.
 *
 *   $82:8967  JSR $8990 (the hit test); on a hit with the latch $6A68 clear:
 *             INC $6A68, JSR $8A2E (the take), $6A0C = 1
 *   $82:8983  airborne -> $81:8905 (the landing), grounded -> $81:8A56
 *   $82:8A21  a miss in the cell clears $6A68 and $6A0C
 *
 * The kernel never touches the hole's entities: a hit leaves the fact
 * `enemyHit` (the cell index + 1), and the `take-enemy` system of the ball
 * step does the take right after the tile dispatch, where `$8A2E` sits.
 */
import type { Ctx, Work } from './context';
import { LANDING, ROLLING, type DispatchOutcome } from './types';
import { enemyHover } from '../sweep';

/**
 * $82:8990: does the ball hit the enemy on this cell? Both fractions must
 * be in the middle half ($4000-$BFFF); a grounded ball counts; an airborne
 * one only within the window around the enemy's hover height H, measured
 * from the ground under the ball ($DA06/$DA08): from ground + H - $2D41 up
 * to (not including) ground + H + $5A82. H = tbl_height_z[$5B1C].
 */
export function enemyHitTest(ctx: Ctx, w: Work, hoverSteps: number): boolean {
  if (!(w.xf >= 0x4000 && w.xf < 0xc000)) return false;
  if (!(w.yf >= 0x4000 && w.yf < 0xc000)) return false;
  if (w.air === 0) return true;
  const h = (w.ground + ctx.rules.heightZ(hoverSteps)) | 0;
  const upper = (h + 0x5a82) | 0;
  const lower = (h - 0x2d41) | 0;
  return w.z < upper && w.z >= lower;
}

/** $82:8967: the dispatch entry. The hover height comes from the tile ($82:B69F). */
export function enemyDispatch(ctx: Ctx, w: Work): DispatchOutcome {
  const hit = enemyHitTest(ctx, w, enemyHover(ctx.rules, w.tile));
  if (!hit) {
    // $82:8A21: in the cell but outside the window clears the latch
    w.enemyLatch = 0;
    w.enemyHitMark = 0; // $6A0C
  } else if (w.enemyLatch === 0) {
    w.enemyLatch = 1;
    w.enemyHit = (w.cell + 1) & 0xffff; // the take follows the dispatch
    w.enemyHitMark = 1;
  }
  return w.air !== 0 ? LANDING : ROLLING;
}
