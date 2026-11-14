/**
 * The cup (docs/physics.md "The cup"; handlers $82:AD8E land,
 * $82:AD36 hit-from-the-side, $82:AFE9 the depth lookup). Tile $08 never
 * occurs in course data — it is written into layer 2 when the last enemy
 * becomes the cup (phase 6) — but the physics below is complete.
 *
 * The hole-out *sequence* ($82:AD13's camera pan and song) is phase 6; the
 * physics state the ROM leaves behind is set here and the step ends.
 */
import { s16, wrap16, mulFloor } from '../fixed';
import type { Ctx, Work } from './context';
import { DONE, LANDING, ROLLING, type DispatchOutcome } from './types';

/**
 * sub_cup_depth $82:AFE9: looks the ball's folded position up in the 32x32
 * dish profile at $88:8990 (word index = (foldY >> 10) * 32 + (foldX >>
 * 10)) and *lowers the probe's ground by the depth* ($DA06/$DA08), so a
 * ball rolling over the dish follows its surface. Returns the depth;
 * $5000 is the flat centre.
 */
export function cupDepth(ctx: Ctx, w: Work): number {
  // the ROM folds a negative fraction with EOR #$FFFF only ($82:AFEC BPL):
  // $8000-$FFFF map to $7FFF-$0000, values under $8000 pass through
  const fold = (v: number): number => (s16(v) < 0 ? wrap16(v ^ 0xffff) : v & 0xffff);
  const row = (fold(w.yf) >> 10) & 0x1f;
  const col = (fold(w.xf) >> 10) & 0x1f;
  const depth = ctx.rules.table('cupDepth')[row * 32 + col];
  w.ground = (w.ground - depth) | 0;
  return depth;
}

/** $82:B048: the ball must be in the middle half of the cell. */
function middleHalf(w: Work): boolean {
  return (
    w.xf >= 0x4000 && w.xf < 0xc000 &&
    w.yf >= 0x4000 && w.yf < 0xc000
  );
}

export function cupLand(ctx: Ctx, w: Work): DispatchOutcome {
  if (!middleHalf(w)) return LANDING; // $82:B062: not over the cup
  if (w.air !== 0 && w.z > w.ground + 0x2d41) return LANDING; // too high
  if (w.holed !== 0) return cupSinking(ctx, w); // $82:AE61
  const depth = cupDepth(ctx, w);
  w.cupDepthScratch = depth; // $6B7E
  if (depth === 0) {
    w.holed = 0; // $82:ADB2
    return LANDING;
  }
  if (depth === 0x5000) {
    // the centre: hole-out when the ball is at or below ground' + $4000,
    // i.e. $1000 below the original surface (physics.md "The cup")
    if (w.z <= w.ground + 0x4000) {
      holeOut(w);
      return DONE;
    }
    w.holed = 0;
    return LANDING;
  }
  // on the dish wall: a grounded ball follows the lowered surface
  if (w.z >= w.ground) {
    w.holed = 0;
    return LANDING;
  }
  rimPull(w);
  w.z = w.ground;
  return { next: 'landing', entry: 'gravityOnly' }; // $82:AE04 -> $81:899F
}

export function cupHit(ctx: Ctx, w: Work): DispatchOutcome {
  if (!middleHalf(w)) return ROLLING;
  const depth = cupDepth(ctx, w);
  w.cupDepthScratch = depth;
  if (depth === 0) {
    w.holed = 0;
    return ROLLING;
  }
  if (depth === 0x5000) {
    // the centre drops the rolling ball into the air ($82:AD7A)
    w.vz = 0;
    w.air = 1;
    return { next: 'landing', entry: 'gravityOnly' };
  }
  const speed = Math.abs(s16(w.vx)) + Math.abs(s16(w.vy));
  if (speed >= 0x0300) {
    // a fast ball on the rim drops too
    w.vz = 0;
    w.air = 1;
    return { next: 'landing', entry: 'gravityOnly' };
  }
  rimPull(w);
  return ROLLING;
}

/**
 * $82:AF09/$82:AF51: on the rim a slow ball is damped toward the centre:
 * vz <- hi((|vx|+|vy|) x $6000), vx/vy <- hi(v x $6000) ($80:A367 = the
 * high word of the exact product), then
 * vx += mulFloor($0600, -(xf - $8000)) and the same for y.
 */
function rimPull(w: Work): void {
  const hi = (a: number, b: number): number => wrap16(Math.floor((s16(a) * s16(b)) / 0x10000));
  const speed = Math.abs(s16(w.vx)) + Math.abs(s16(w.vy));
  w.vz = hi(speed, 0x6000);
  w.vx = hi(w.vx, 0x6000);
  w.vy = hi(w.vy, 0x6000);
  w.vx = wrap16(w.vx + mulFloor(0x0600, wrap16(0x8000 - w.xf)));
  w.vy = wrap16(w.vy + mulFloor(0x0600, wrap16(0x8000 - w.yf)));
}

/**
 * $82:AE2B: the hole-out test passed. $82:AD13 (the reveal sequence:
 * camera, song, the ball-to-star swap) is phase 6; the physics state the
 * ROM leaves in the work copy is set here and the step ends.
 */
function holeOut(w: Work): void {
  w.holed = 1;
  w.air = 1; // $82:AE31
  w.vz = wrap16(w.vz + s16(w.gravity));
  w.cupGround = w.ground; // $6B80/$6B82
  w.vx = 0;
  w.vy = 0;
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
}

/** $82:AE61: already holed — the sinking loop, one iteration per step. */
function cupSinking(ctx: Ctx, w: Work): DispatchOutcome {
  w.vz = wrap16(w.vz + s16(w.gravity));
  if (w.vz < 0) {
    // the ROM adds vz to z as a 32-bit sum and tests the borrow ($82:AE6D)
    const z2 = (w.z + s16(w.vz)) | 0;
    if (z2 < 0 || z2 < w.cupGround) {
      // $82:AE7C: vz = -z lo... the ROM reflects: vz = -zLow when the sum
      // underflows; with the clamp below this path only matters off-course
      w.z = w.cupGround;
      w.vz = 0;
      w.vx = 0;
      w.vy = 0;
      w.holed += 1; // $82:AEC1: 2 once the hole-out has run
      w.cupDepthScratch = 0xffff;
      return DONE;
    }
    w.z = z2;
  }
  if (w.cupGround === 0) {
    cupDepth(ctx, w); // refreshes the probe ground ($82:AE8E)
    w.cupGround = w.ground;
  }
  if (w.z >= w.cupGround) {
    w.z = w.cupGround;
    w.vz = 0;
    w.vx = 0;
    w.vy = 0;
    w.holed += 1;
    w.cupDepthScratch = 0xffff;
    return DONE;
  }
  return DONE;
}
