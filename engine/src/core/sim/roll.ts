/**
 * The rolling default handler $81:8A56: the crest test stub, the button
 * modifiers' rolling effects, rolling friction ($81:8A81), slope
 * acceleration ($81:8AE1) and the grounder curve (loc_roll_curve
 * $81:8D17). Also the friction class index ($81:80C5-$81:80ED).
 */
import { s16, wrap16, hi16, mulFloor } from '../fixed';
import type { Ctx, Work } from './context';
import { launch } from './wall-step';

/**
 * $81:80C5: classIndex ($6A72) = mode * 8 + frictionClass[code], a byte
 * index into the per-mode tables (4 words a mode). $81:8C12's words are
 * already byte offsets (0, 2, 4, 6: classes 0-3, `ADC $81:8C12,X` at $80E1);
 * a first port doubled them, which read mode 1's friction on the diagonal
 * ramps (codes 5-8) and the faceted shapes $08-$0B.
 */
export function classIndex(ctx: Ctx, w: Work): void {
  const { rules } = ctx;
  let code = w.code;
  const shape = w.shape;
  if (shape >= 8 && shape < 12) code = 9; // shapes $08-$0B forced to class 6
  w.classIndex = w.mode * 8 + rules.table('frictionClass')[code];
  // $DA3A = tbl_roll_friction[$6A72]: the tables are word-indexed by
  // $6A72 / 2 = mode * 4 + class.
  w.rollMu = rules.table('rollFriction')[w.classIndex >> 1];
}

/**
 * $81:980B, the crest test: does the ground fall away under the rolling
 * ball? It clears the landing lock-out every rolling frame. Returns the
 * surface code the ball launches from ($81:8B7B, A = that code, carry set;
 * `$6A7A` + 1), else null.
 *
 * - No edge crossed ($6A78 = $FFFF): the code changed on a shape with the
 *   crest flag ($81:9B45[$D9FE]) launches from the old code ($DA24).
 * - An edge crossed ($81:9831, types 0-7, >= 8 hangs): a list of quadrant
 *   samples along the ball's path — (quadrant, which cell) words from the
 *   old cell through the corner's ($6A76) to the new — chosen by the
 *   crossing type and the old and new quadrants ($DA22, $DA02; types 0-3)
 *   or the corner's pick ($6A74; types 4-7). Each consecutive pair of
 *   samples ($81:9964) is a crest when, in one cell, the codes differ and
 *   the shape has the crest flag; across a boundary, when
 *   $81:9C3D[code1 x 36 + quadrant1 x 9 + code2] is non-zero. The first
 *   crest launches from the pair's first code.
 *
 * A type-0-3 pair of quadrants with no list (0) cannot occur at the ball's
 * speeds; the ROM would read code bytes as a list ($994F: 0 - $9A0D), the
 * port reports no crest.
 */
export function crestTest(ctx: Ctx, w: Work): number | null {
  const { rules } = ctx;
  w.launchLock = 0; // $81:980B: STZ $6A7A
  if (w.moveDir === 0xffff) {
    // no edge crossed this frame ($6A78 = $FFFF: $980E BPL not taken); the
    // flag is the current shape's ($D9FE), the same cell as the last frame's
    if (w.code !== w.pCode && (rules.table('crestShape')[w.shape] & 0xff) !== 0) {
      w.launchLock += 1;
      return w.pCode; // SEC
    }
    return null;
  }
  const t = w.moveDir;
  if (t >= 8) throw new Error(`$81:9834: crossing type ${t} hangs`);
  let list: number;
  if (t < 4) {
    // $81:984B-$81:98E1: ($DA22 x 4 + $DA02) x 2 into the type's table
    list = rules.table('crestCross')[t * 16 + w.pQuad * 4 + w.quad];
    if (list === 0) return null;
  } else {
    // $81:9913-$81:994B: the corner's pick chooses one of two lists; the
    // first when $6A74 is 0, 1, 2, 0 for the types 4-7
    const pick = [0, 1, 2, 0][t - 4];
    list = rules.table('crestDiag')[(t - 4) * 2 + (w.diagPick === pick ? 0 : 1)];
  }
  const lists = rules.table('crestLists');
  const n = ctx.course.w * ctx.course.h;
  // $994F: the direct page's cells, by the samples' selector byte
  const cellOf = (sel: number): number => (sel === 2 ? w.pCell : sel === 4 ? w.cell : sel === 8 ? w.crossAxis : -1);
  const sample = (word: number): { q: number; sel: number; shape: number; code: number } => {
    const q = word & 0xff;
    const sel = (word >> 8) & 0xff;
    const cell = cellOf(sel);
    const shape = cell >= 0 && cell < n ? ctx.course.shape[cell] & 0xff : 0; // $6B90,X
    return { q, sel, shape, code: rules.terrainQuad(shape, q) }; // $81:9D81
  };
  for (let i = (list - 0x9a0d) >> 1; ; i++) {
    const w2 = lists[i + 1];
    if (w2 & 0x8000) return null; // $9966 BMI: the list's end, CLC
    const b = sample(w2);
    const a = sample(lists[i]);
    let crest: boolean;
    if ((a.sel & b.sel) !== 0) {
      // $99C2: one cell: the codes differ on a crest-flagged shape
      crest = a.code !== b.code && (rules.table('crestShape')[a.shape] & 0xff) !== 0;
    } else {
      // $99D8: across a boundary
      crest = (rules.table('crestStep')[a.code * 36 + a.q * 9 + b.code] & 0xff) !== 0;
    }
    if (crest) {
      w.launchLock += 1; // $9A08: INC $6A7A, SEC
      return a.code;
    }
  }
}

export interface RollModifier {
  /** $DA76: -1 none, 0 = A, 2 = Y. */
  kind: number;
  /** $DA7A: the remaining frames. */
  timer: number;
}

/** $81:8A56: the rolling step proper. */
export function rollDefault(ctx: Ctx, w: Work, modifier: RollModifier): void {
  if (w.mode === 0x0a) return; // mode $0A skips the whole rolling step
  const launched = crestTest(ctx, w);
  if (launched !== null) {
    launch(ctx, w, launched); // JMP $8B7B (no spin clear on the crest path)
    return;
  }
  // $81:8A68: the A/Y rolling modifiers.
  // A ($DA76 = 0): while the timer is up (non-zero), friction and slope are
  // skipped (JML $8D17); the frame the timer reads 0 applies them
  // ($81:8A72 BEQ $8A8B). Y ($DA76 = 2): while the timer is up, $1100 is
  // added to the friction and the normal step runs ($81:8A81); at 0 the
  // step is skipped ($81:8A7D JML $8D17) - the emulated "1 frame with no
  // friction".
  let skipFriction = false;
  if (modifier.kind === 0) {
    if (modifier.timer !== 0) skipFriction = true;
  } else if (modifier.kind === 2) {
    if (modifier.timer !== 0) {
      w.rollMu = wrap16(w.rollMu + 0x1100); // $81:8A85
    } else {
      skipFriction = true;
    }
  }
  if (!skipFriction) {
    friction(ctx, w);
    slope(ctx, w);
  }
  curve(w);
}

/**
 * $81:8A81: rolling friction, per axis, with the asymmetric rounding:
 * direction >= 0 rounds ((P + $80) >> 8) & $FF, direction < 0 floors one
 * unit more ($FF00 | ((P - $80) >> 8)). The 16-bit subtraction clamps at
 * zero from either side — friction never reverses the ball.
 */
export function friction(ctx: Ctx, w: Work): void {
  const { rules } = ctx;
  const axis = (direction: number, v: number): number => {
    // P = floor((direction x mu) / 2^15) as the 16-bit word ($80:A378 + the
    // ASL/ROL pair at $81:8A9D)
    const p = wrap16(Math.floor((s16(direction) * s16(w.rollMu)) / 0x8000));
    const fx =
      direction >= 0
        ? (wrap16(p + 0x80) >> 8) & 0xff
        : 0xff00 | ((wrap16(p + 0xff80) >> 8) & 0xff);
    if (fx === 0) return v;
    // $81:8AC8: the two branches clamp oppositely. For v >= 0 a borrow
    // (v_u < fx_u) zeroes the axis; for v < 0 NO borrow (the sum crossed
    // zero upward) zeroes it, and a borrow keeps the wrapped remainder.
    const r = wrap16(v - s16(fx));
    const borrow = (v & 0xffff) < (fx & 0xffff);
    if (s16(v) >= 0) return borrow ? 0 : r;
    return borrow ? r : 0;
  };
  const deg = w.deg;
  const cos = rules.table('sinDeg')[(deg + 90) % 450]; // $80:A656 = sin + 90
  const sin = rules.table('sinDeg')[deg];
  w.vx = axis(cos, w.vx);
  w.vy = axis(sin, w.vy);
}

/**
 * $81:8AE1: slope acceleration. g = tbl_ball_gravity[$6A72] (word index
 * classIndex >> 1); the per-code direction tables give the Q15 factors and
 * the product goes through $81:97A9 (floor).
 */
export function slope(ctx: Ctx, w: Work): void {
  const { rules } = ctx;
  const g = rules.table('ballGravity')[w.classIndex >> 1];
  const ax = rules.table('slopeAccelX')[w.code];
  if (ax !== 0) w.vx = wrap16(w.vx + mulFloor(g, ax));
  const ay = rules.table('slopeAccelY')[w.code];
  if (ay !== 0) w.vy = wrap16(w.vy + mulFloor(g, ay));
}

/**
 * loc_roll_curve $81:8D17: the grounder's curve while the spin is pending
 * — a semi-implicit rotation via the one's-complement product, run until
 * the first landing or a step hit. Wall bounces do not stop it.
 */
export function curve(w: Work): void {
  if (w.shotElev !== 0 || w.spinPending === 0) return;
  curveCore(w);
}

/** `$81:8D21`, the curve's rotation without the grounder's gates (Tornado's steering calls it). */
export function curveCore(w: Work): void {
  if (w.spinX === 0) return;
  const omega = w.spinX;
  w.vx = wrap16(w.vx + hi16(~omega & 0xffff, w.vy));
  w.vy = wrap16(w.vy + hi16(omega, w.vx));
}
