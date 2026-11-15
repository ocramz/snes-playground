/**
 * The cup, tile $08 (docs/physics.md "The cup"): `$82:AD8E` on land,
 * `$82:AD36` hit from the side, `$82:AFE9` the depth, `$82:AE61` the sink
 * (all re-read 2026-11-14 against web_hole, which holes out with no pokes).
 * Tile $08 never occurs in course data: the reveal writes it into layer 2
 * when the last enemy becomes the cup.
 *
 *   $82:B048  both handlers first: the ring's latch. Over the middle half
 *             and on the ground or within half a step of it: $6A68 set
 *             (once; the ring object $693C is nudged — presentation);
 *             elsewhere $6A68 and $6A0C cleared. It gates nothing.
 *   $82:AFE9  the depth from the 32x32 dish profile, and the probe's ground
 *             lowered by it ($DA06/$DA08 = ground'); $5000 is the centre.
 *
 * Land ($82:AD8E):
 *   holed already -> the sink ($82:AE61)
 *   depth 0 -> holed 0, the default landing
 *   depth $5000 -> hole-out if z <= ground' + $4000 ($82:AEF3), else the
 *                  default landing
 *   on the dish's wall: z >= ground' -> the default landing; below it, the
 *                  rim's damping and pull ($82:AF09), z = ground', the
 *                  gravity tail ($81:899F)
 *   hole-out ($82:AE2B): holed 1, airborne, vz + gravity, the ground'
 *                  recorded ($6B80/$6B82), object 75 ($82:AD13), vx = vy =
 *                  spin = 0, gravity reset ($82:B027); the step ends
 * Hit ($82:AD36, the rolling path):
 *   depth 0 -> holed 0, the default roll
 *   depth $5000, or |vx| + |vy| >= $0300 -> vz 0, airborne, the gravity tail
 *   else the pull ($82:AF51), the default roll
 * Sink ($82:AE61), each step while holed and airborne over tile $08 (the
 * step's move has already added vz to z):
 *   vz + gravity; a vz that would take z below 0 becomes -z's low word;
 *   the ground' recorded if it was not; z at or below it -> z = ground',
 *   v = 0, holed 2 ($82:AEC1), Kirby's state 1, the music's volume 0, the
 *   sound $82:AEF5[mode]. The step ends either way.
 */
import { s16, wrap16, mulFloor } from '../fixed';
import type { Ctx, Work } from './context';
import { updateHeading } from './reflect';
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

/** $82:B048: the cup ring's latch (shares $6A68 with the enemies and the pillar). */
function ringLatch(w: Work): void {
  const middle = w.xf >= 0x4000 && w.xf < 0xc000 && w.yf >= 0x4000 && w.yf < 0xc000;
  const low = w.air === 0 || w.z <= ((w.ground + 0x2d41) | 0);
  if (middle && low) {
    if (w.enemyLatch === 0) w.enemyLatch = 1; // $82:B08A (the ring object is presentation)
    return;
  }
  w.enemyLatch = 0; // $82:B09A
  w.enemyHitMark = 0;
}

export function cupLand(ctx: Ctx, w: Work): DispatchOutcome {
  ringLatch(w);
  if (w.holed !== 0) return cupSinking(ctx, w); // $82:AD96
  const depth = cupDepth(ctx, w);
  w.cupDepthScratch = depth; // $6B7E
  if (depth === 0) {
    w.holed = 0; // $82:ADB2
    return LANDING;
  }
  if (depth === 0x5000) {
    // $82:AE08: the centre holes the ball at or below ground' + $4000
    if (((w.ground + 0x4000) | 0) >= w.z) {
      holeOut(w);
      return DONE;
    }
    w.holed = 0;
    return LANDING;
  }
  // on the dish's wall: at or above ground' the ordinary landing
  if (w.z >= w.ground) {
    w.holed = 0;
    return LANDING;
  }
  rimDamp(w); // $82:AF09 (+ $82:AF51)
  rimPull(ctx, w);
  w.z = w.ground;
  return { next: 'landing', entry: 'gravityOnly' }; // $82:AE04 -> $81:899F
}

export function cupHit(ctx: Ctx, w: Work): DispatchOutcome {
  ringLatch(w);
  const depth = cupDepth(ctx, w);
  if (depth === 0) {
    w.cupDepthScratch = 0; // $82:AD4C
    w.holed = 0;
    return ROLLING;
  }
  w.cupDepthScratch = depth;
  const speed = Math.abs(s16(w.vx)) + Math.abs(s16(w.vy));
  if (depth === 0x5000 || speed >= 0x0300) {
    // $82:AD7A: the ball drops into the cup or off the rim
    w.vz = 0;
    w.air = 1;
    return { next: 'landing', entry: 'gravityOnly' };
  }
  rimPull(ctx, w); // $82:AD87
  return ROLLING;
}

/**
 * $82:AF09: on the rim, vz <- hi((|vx| + |vy|) x $6000), vx/vy <- hi(v x
 * $6000) ($80:A367, the high word of the product).
 */
function rimDamp(w: Work): void {
  const hi = (a: number, b: number): number => wrap16(Math.floor((s16(a) * s16(b)) / 0x10000));
  const speed = Math.abs(s16(w.vx)) + Math.abs(s16(w.vy));
  w.vz = hi(speed, 0x6000);
  w.vx = hi(w.vx, 0x6000);
  w.vy = hi(w.vy, 0x6000);
}

/**
 * $82:AF51: the pull toward the centre, vx += mulFloor(-(xf ^ $8000),
 * $0600) and the same for y ($81:97A9), then the heading ($81:8E60).
 */
function rimPull(ctx: Ctx, w: Work): void {
  w.vx = wrap16(w.vx + mulFloor(wrap16(-(w.xf ^ 0x8000)), 0x0600));
  w.vy = wrap16(w.vy + mulFloor(wrap16(-(w.yf ^ 0x8000)), 0x0600));
  updateHeading(ctx.rules, w);
}

/** $82:AE2B: the hole-out test passed. */
function holeOut(w: Work): void {
  w.holed = 1;
  w.holedIn = 1;
  w.air = 1; // $82:AE31
  w.vz = wrap16(w.vz + w.gravity); // $82:AE34: $DA38 + $D9D8
  w.cupGround = w.ground; // $6B80/$6B82: the lowered ground
  w.vx = 0;
  w.vy = 0;
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
  w.gravity = 0xffc0; // $82:B027: $80:DB6D
}

/** $82:AE61: the sink, one iteration per step (see the header). */
function cupSinking(ctx: Ctx, w: Work): DispatchOutcome {
  w.vz = wrap16(w.vz + w.gravity);
  if (s16(w.vz) < 0) {
    // $82:AE6D-$82:AE83: z + vz below 0 (no carry out of the 32-bit sum)
    if (((w.z + s16(w.vz)) | 0) < 0) w.vz = wrap16(-(w.z & 0xffff));
  }
  if (w.cupGround === 0) {
    cupDepth(ctx, w); // $82:AE8E
    w.cupGround = w.ground;
  }
  if (w.cupGround >= w.z) {
    w.z = w.cupGround; // $82:AEAF
    w.vz = 0;
    w.vx = 0;
    w.vy = 0;
    w.holed += 1; // $82:AEC1: 2 once the ball has sunk
    w.sunk = 1;
    w.block6a = 0xffff; // $82:AEC4: $DA6A
  }
  return DONE;
}
