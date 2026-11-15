/**
 * The two turns the tile handlers share: `$82:ED4C`, a rotation of a vector
 * by a signed angle, and `$82:ECFC`, the turn of the velocity to one of the
 * four arrows (the arrow panels $82:A7B7, the warps $82:AA32).
 */
import { s16, wrap16 } from '../fixed';
import type { Ctx, Work } from './context';
import { updateHeading } from './reflect';
import { cosSinDeg } from './trig';

/** $82:ECFC's jump table ($82:ED06): the heading of each arrow, N E S W. */
export const ARROW_HEADING = [270, 0, 90, 180];

function mulFactor(v: number, factor: number): number {
  return wrap16(Math.floor((s16(factor) * s16(v)) / 0x8000));
}

/** $82:ED4C: rotate (vx, vy) by delta degrees, products floor(Q15). */
export function rotateBy(ctx: Ctx, vx: number, vy: number, delta: number): [number, number] {
  const neg = delta < 0;
  const mag = Math.abs(delta);
  const { cos, sin } = cosSinDeg(ctx.rules, mag);
  const c1 = mulFactor(vx, cos);
  const s1 = mulFactor(vy, sin);
  const c2 = mulFactor(vx, sin);
  const s2 = mulFactor(vy, cos);
  if (!neg) return [wrap16(c1 - s1), wrap16(c2 + s2)];
  return [wrap16(c1 + s1), wrap16(s2 - c2)];
}

/**
 * $82:ECFC, A = 0-3 (N E S W): the velocity rotated by (heading - $D9DA)
 * through $82:ED3B, so the speed is kept, the cross axis zeroed (vx for N/S,
 * vy for E/W), then the heading ($81:8E60).
 */
export function turnToDir(ctx: Ctx, w: Work, dir: number): void {
  const delta = s16(wrap16(ARROW_HEADING[dir & 3] - w.deg)); // SEC / SBC $D9DA
  const [vx, vy] = rotateBy(ctx, w.vx, w.vy, delta);
  w.vx = (dir & 1) === 0 ? 0 : vx; // $82:ED1E: STZ $D9D4
  w.vy = (dir & 1) === 0 ? vy : 0; // $82:ED33: STZ $D9D6
  updateHeading(ctx.rules, w); // $82:ED36
}
