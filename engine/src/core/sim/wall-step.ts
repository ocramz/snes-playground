/**
 * Wall bounce ($81:9390), step bounce ($81:93D1) and the step-down launch
 * (loc_launch $81:8B78, also the crest launch's entry $81:8B7B).
 */
import { s16, wrap16, asr, hi16 } from '../fixed';
import type { Ctx, Work } from './context';
import { reflect } from './reflect';

/** $81:87B2: restore x, y and the probe fields from the previous frame. */
export function restorePrev(w: Work): void {
  w.xf = w.pXf;
  w.xc = w.pXc;
  w.yf = w.pYf;
  w.yc = w.pYc;
  w.cell = w.pCell;
  w.shape = w.pShape;
  w.elev = w.pElev;
  w.quad = w.pQuad;
  w.code = w.pCode;
  w.ground = w.pGround;
  w.tile = w.pTile;
}

/** $81:9390: a layer-4 wall bounce — pure reflection, no loss. */
export function wallBounce(ctx: Ctx, w: Work): void {
  restorePrev(w);
  reflect(ctx.rules, w, 9 + w.wallEdge);
}

/**
 * The step-bounce clamp table ($81:93E2 = $93FA, $9402, $93EA, $93F2): the
 * fraction forced to the old cell's side of the edge. N (moving +y) puts y at
 * $FFFF, S (moving -y) at $0000 ($93EA: LDA #0 / STA $D9F4).
 */
const STEP_CLAMP: Array<['xf' | 'yf', number]> = [
  ['yf', 0xffff], // N
  ['xf', 0x0000], // E
  ['yf', 0x0000], // S
  ['xf', 0xffff], // W
];

/**
 * $81:93D1: ran into a terrain step. Restores the previous position, puts
 * the ball against the edge, reflects with matrix 9 + edge and scales the
 * component normal to the edge by $DA40 through the per-edge masks.
 */
export function stepBounce(ctx: Ctx, w: Work): void {
  const { rules } = ctx;
  restorePrev(w);
  const edge = w.edge;
  if (edge < 4) {
    const [axis, value] = STEP_CLAMP[edge];
    if (axis === 'xf') w.xf = value;
    else w.yf = value;
  }
  reflect(rules, w, 9 + edge);
  if (rules.table('stepDampMaskX')[edge] !== 0) {
    w.vx = mulFloorW(w.vx, w.stepDamp); // $81:9418: vx x $DA40
  }
  if (rules.table('stepDampMaskY')[edge] !== 0) {
    w.vy = mulFloorW(w.vy, w.stepDamp); // $81:9436
  }
}

function mulFloorW(v: number, factor: number): number {
  return wrap16(Math.floor((s16(factor) * s16(v)) / 0x8000));
}

/**
 * loc_launch $81:8B78/$81:8B7B (A = the old surface code): the ball leaves
 * the ground over a step down or a ramp crest.
 */
export function launch(ctx: Ctx, w: Work, oldCode: number): void {
  const { rules } = ctx;
  const lx = rules.table('launchX')[oldCode];
  const ly = rules.table('launchY')[oldCode];
  // $80:A378 returns the high word of the exact 32-bit product; the two
  // high words are summed as 16-bit (web-demo.md "Step down").
  w.vz = wrap16(hi16(w.vx, lx) + hi16(w.vy, ly));
  // mode 5 with $D762 set rescales vz by mul16x8(vz, $B4) ($81:8BB6); the
  // copy-ability modes are deferred, so that branch is not ported.
  // halve when the new surface code is non-zero and the old shape is not in
  // the $10-$1B family ($81:8BC3)
  if (w.code !== 0 && (w.pShape & 0x10) === 0) {
    w.vz = asr(w.vz, 1);
  }
  w.air = 1;
}
