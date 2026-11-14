/**
 * The rolling default handler $81:8A56: the crest test stub, the button
 * modifiers' rolling effects, rolling friction ($81:8A81), slope
 * acceleration ($81:8AE1) and the grounder curve (loc_roll_curve
 * $81:8D17). Also the friction class index ($81:80C5-$81:80ED).
 */
import { s16, wrap16, hi16, mulFloor } from '../fixed';
import type { Ctx, Work } from './context';
import { launch } from './wall-step';

/** $81:80C5: classIndex = mode * 8 + frictionClass[code] * 2 (byte index). */
export function classIndex(ctx: Ctx, w: Work): void {
  const { rules } = ctx;
  let code = w.code;
  const shape = w.shape;
  if (shape >= 8 && shape < 12) code = 9; // shapes $08-$0B forced to class 6
  w.classIndex = w.mode * 8 + rules.table('frictionClass')[code] * 2;
  // $DA3A = tbl_roll_friction[$6A72]: the tables are word-indexed by
  // $6A72 / 2 = mode * 4 + class.
  w.rollMu = rules.table('rollFriction')[w.classIndex >> 1];
}

/**
 * $81:980B (the crest test), ported as far as the disassembly documents
 * (plans risk 5): it clears the landing lock-out every rolling frame, and
 * when no edge was crossed but the surface code changed onto a shape with
 * the crest flag, the ball launches ($81:8B7B, A = the old code, carry
 * set). The eight per-crossing-type branches ($81:9831-$81:994F, the
 * quadrant-sample tables at $81:9A0D+) are **unported** and fall through
 * to "no crest" — exact for flat-to-flat and same-shape crossings; flagged
 * in docs/engine.md and excluded from the exact tests (risk 5).
 * Returns the old surface code when the ball launches, else null.
 */
export function crestTest(ctx: Ctx, w: Work): number | null {
  w.launchLock = 0; // $81:980B: STZ $6A7A
  if (w.moveDir < 0) {
    // no edge crossed this frame ($6A78 = $FFFF)
    if (w.code !== w.pCode && (ctx.rules.table('crestShape')[w.pShape] & 0xff) !== 0) {
      w.launchLock += 1;
      return w.pCode; // SEC
    }
  }
  return null;
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
  if (w.shotElev !== 0 || w.spinPending === 0 || w.spinX === 0) return;
  const omega = w.spinX;
  w.vx = wrap16(w.vx + hi16(~omega & 0xffff, w.vy));
  w.vy = wrap16(w.vy + hi16(omega, w.vx));
}
