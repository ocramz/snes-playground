/**
 * The hazard tiles (read 2026-11-14; notes/engine-phase6-holes.md
 * "Hazards"). They are bumpers: a hit bounces the ball, queues a tomato -1
 * and asks the roll loop for a reaction ($D780, run after the step by
 * systems/hazard-reaction.ts). None of them loses the ball.
 *
 *   $80-$8F, $98-$A1  `$82:98F8` land / `$82:9940` hit: the tile's shape
 *                     ($82:997E: bands, L-pieces, end caps over a quarter
 *                     disc), then a cube test against each listed bumper
 *                     (object 76, `$82:9ABF`/`$82:E701`, half-size $58E0)
 *   $90-$97           `$82:9653` / `$82:9693`: a box at the cell centre whose
 *                     height follows the bobbing bumper's frame ($82:967B)
 *   $A2               `$82:9858` / `$82:987B`: the same box at a fixed height
 *   $AC-$AE           `$82:86B9` / `$82:8656`: the volcano's cone (a height
 *                     window and a diamond) and its base (its eruption state)
 *   $05               `$82:A55E` / `$82:A576`: at or under the surface, every
 *                     frame; the reaction throws the ball
 *
 * Kernels: no world access. What the systems do with a hit comes back as
 * facts on the work copy: `tomatoLoss` (queued -1s), `hurt` ($D780),
 * `hazardHit` (the effect object $2F, presentation), `sfxNow`.
 */
import { s16, wrap16, mulQ15s, hi16, atan2Deg } from '../fixed';
import type { Ctx, Work } from './context';
import type { ActorRun } from './actors';
import { degreeMatrix, reflectWith, updateHeading } from './reflect';
import { restorePrev } from './wall-step';
import { LANDING, ROLLING, DONE, type DispatchOutcome } from './types';

const GRAVITY_ONLY: DispatchOutcome = { next: 'landing', entry: 'gravityOnly' };

/** The hole's hazard actors, as the kernels see them (shared with the world singleton). */
export interface HazardField {
  actors: ActorRun[];
  /** $B6BA: the object-76 bumpers' actor indices, in record order. */
  list: number[];
  /** $ABB8 -> $B4F8: the actor on each cell, -1 none. */
  atCell: Int16Array;
}

function field(ctx: Ctx): HazardField | null {
  return ctx.course.hazards ?? null;
}

function sin(ctx: Ctx, deg: number): number {
  return ctx.rules.table('sinDeg')[((deg % 360) + 360) % 360];
}
function cos(ctx: Ctx, deg: number): number {
  return ctx.rules.table('sinDeg')[(((deg % 360) + 360) % 360) + 90];
}
const abs16 = (v: number): number => (s16(v) < 0 ? wrap16(-s16(v)) : v & 0xffff);
const neg16 = (v: number): number => wrap16(-s16(v));
const M = (a: number, b: number): number => mulQ15s(a, b);
const add = (...v: number[]): number => wrap16(v.reduce((p, q) => p + q, 0));
const atan = (ctx: Ctx, x: number, y: number): number => atan2Deg(x, y, ctx.rules.table('atanDeg'));

// ------------------------------------------------------------------ penalty

/** `$83:ABC5` + `$82:9C8D`: the tomato, the reaction, the effect, sfx $6F, the spin cleared. */
function penalty(w: Work): void {
  w.tomatoLoss += 1;
  w.hazardHit += 1; // $82:EED8 (object $2F)
  w.hurt = 0x14; // $D780
  w.sfxNow = 0x6f;
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
}

// ------------------------------------------------------------- the cube test

interface Cube {
  hit: boolean;
  /** $1C: the axes passed, x then y then z, before the first miss. */
  axes: number;
  /** $40/$44/$48: actor - ball, the low words (signed). */
  dx: number;
  dy: number;
  dz: number;
}

/** `$82:E701`: |actor - ball| < half on each axis (32-bit, the high word 0). */
function cube(bx: number, by: number, bz: number, ax: number, ay: number, az: number, half = 0x58e0): Cube {
  const d = [(ax - bx) | 0, (ay - by) | 0, (az - bz) | 0];
  let axes = 0;
  for (const v of d) {
    const m = Math.abs(v);
    if (m > 0xffff || m >= half) break;
    axes++;
  }
  return { hit: axes === 3, axes, dx: wrap16(d[0]), dy: wrap16(d[1]), dz: wrap16(d[2]) };
}

const x32 = (w: Work): number => ((w.xc << 16) | w.xf) >>> 0;
const y32 = (w: Work): number => ((w.yc << 16) | w.yf) >>> 0;

// ---------------------------------------------------------- $80-$8F, $98-$A1

/** `$82:997E`: does the ball stand on the tile's own shape? */
function shapeTest(ctx: Ctx, w: Work): boolean {
  const s = ctx.rules.table('hazardShape')[w.tile - 0x80];
  const band = (v: number): boolean => v >= 0x2800 && v < 0xd800;
  const { xf, yf } = w;
  switch (s) {
    case 0: return band(xf);
    case 1: return band(yf);
    case 2: return lpiece(ctx, xf ^ 0xffff, yf);
    case 3: return lpiece(ctx, xf ^ 0xffff, yf ^ 0xffff);
    case 4: return lpiece(ctx, xf, yf ^ 0xffff);
    case 5: return lpiece(ctx, xf, yf);
    case 6: return yf < 0x8000 ? disc(ctx, xf, yf) : band(xf);
    case 7: return xf >= 0x8000 ? disc(ctx, xf, yf) : band(yf);
    case 8: return yf >= 0x8000 ? disc(ctx, xf, yf) : band(xf);
    case 9: return xf < 0x8000 ? disc(ctx, xf, yf) : band(yf);
    default: return false;
  }
}

/** `$82:9A29`. */
function lpiece(ctx: Ctx, bc: number, be: number): boolean {
  if (bc >= 0xd800 || be >= 0xd800) return false;
  if (be < 0x2800 && bc < 0x2800) return false;
  if ((bc & be & 0x8000) === 0) return true;
  return disc(ctx, bc, be);
}

/** `$82:9A49`: the quarter disc at $88:A470 (64 x 64 bits, LSB first). */
function disc(ctx: Ctx, bc: number, be: number): boolean {
  const a = (v: number): number => abs16(wrap16((v === 0 ? 1 : v) - 0x8000));
  const row = a(be) >> 9;
  const col = a(bc) >> 9;
  return ((ctx.rules.table('hazardDisc')[row * 8 + (col >> 3)] >> (col & 7)) & 1) === 1;
}

/** `$82:9ABF`: the first listed bumper the ball's cube touches (latched by $6A22). */
function bumperHit(ctx: Ctx, w: Work): { actor: ActorRun; c: Cube } | null {
  const f = field(ctx);
  if (!f) return null;
  for (const i of f.list) {
    const a = f.actors[i];
    const c = cube(x32(w), y32(w), w.z, a.x, a.y, a.z);
    if (c.hit) {
      if (w.hazLatch !== 0) return null;
      w.hazLatch += 1;
      return { actor: a, c };
    }
  }
  w.hazLatch = 0;
  return null;
}

/** `$82:9B3B`: the speed brought to at least $0900, or the push by direction. */
function bounce9B3B(ctx: Ctx, w: Work, a: ActorRun, c: Cube): [number, number] {
  const dir = a.dir & 3;
  let ax = abs16(w.vx);
  let ay = abs16(w.vy);
  const push = (): [number, number] => [
    wrap16(ctx.rules.table('bumpPushX')[dir]), wrap16(ctx.rules.table('bumpPushY')[dir]),
  ];
  if (wrap16(ax + ay) === 0) return push();
  if (w.air === 0) {
    const sx = s16(c.dx) < 0 ? 1 : 0;
    const sy = s16(c.dy) < 0 ? 1 : 0;
    const gate = ctx.rules.table('bumpSignGate')[dir * 4 + sy * 2 + sx];
    const head = ctx.rules.table('bumpHeadingGate')[dir * 32 + (w.dir32 & 31)];
    if (gate === 0 && head !== 0) return push();
  }
  if (ax + ay >= 0x0900) return [w.vx, w.vy];
  const bx = ax;
  const by = ay;
  do {
    ax += bx;
    ay += by;
  } while (ax + ay < 0x0900);
  return [s16(w.vx) < 0 ? neg16(ax) : wrap16(ax), s16(w.vy) < 0 ? neg16(ay) : wrap16(ay)];
}

/** `$82:E7B0`: the elastic exchange of the normal components (equal masses). */
function exchange(
  ctx: Ctx, d: [number, number, number],
  ball: [number, number, number], actor: [number, number, number],
): { ball: [number, number, number]; actor: [number, number, number] } {
  const [dx, dy, dz] = d;
  const a1 = atan(ctx, dz, dy);
  const s1 = sin(ctx, a1);
  const c1 = cos(ctx, a1);
  const r = add(M(dz, c1), M(dy, s1));
  const a2 = atan(ctx, r, dx);
  const s2 = sin(ctx, a2);
  const c2 = cos(ctx, a2);
  const cc = M(c1, c2);
  const cs = M(c1, s2);
  const sc = M(s1, c2);
  const ss = M(s1, s2);
  const fwd = ([vx, vy, vz]: [number, number, number]): [number, number, number] => [
    add(M(vx, c2), -s16(M(vy, ss)), -s16(M(vz, cs))),
    add(M(vy, c1), -s16(M(vz, s1))),
    add(M(vx, s2), M(vy, sc), M(vz, cc)),
  ];
  const back = ([t1, t2, n]: [number, number, number]): [number, number, number] => [
    add(M(t1, c2), M(n, s2)),
    add(-s16(M(t1, ss)), M(t2, c1), M(n, sc)),
    add(-s16(M(t1, cs)), -s16(M(t2, s1)), M(n, cc)),
  ];
  const b = fwd(ball);
  const a = fwd(actor);
  return { ball: back([b[0], b[1], a[2]]), actor: back([a[0], a[1], b[2]]) };
}

/** `$82:E6C1`: reflect off the plane at atan2(A, X), then the heading. */
function reflectAt(ctx: Ctx, w: Work, ax: number, ay: number): void {
  reflectWith(w, degreeMatrix(ctx.rules, atan(ctx, ax, ay)));
  updateHeading(ctx.rules, w);
}

export function bumperLand(ctx: Ctx, w: Work): DispatchOutcome {
  if (!shapeTest(ctx, w)) {
    w.hazLatch = 0;
    return LANDING;
  }
  const h = bumperHit(ctx, w);
  if (!h) return LANDING;
  const [vx, vy] = bounce9B3B(ctx, w, h.actor, h.c);
  w.spinPending = 0;
  const r = exchange(ctx, [h.c.dx, h.c.dy, h.c.dz], [vx, vy, w.vz], [0, 0, 0]);
  [w.vx, w.vy, w.vz] = r.ball;
  penalty(w);
  return LANDING;
}

export function bumperHitSide(ctx: Ctx, w: Work): DispatchOutcome {
  if (!shapeTest(ctx, w)) {
    w.stillGate = 0;
    return ROLLING;
  }
  w.stillGate = 1; // $D9C2: on the track the shot cannot settle
  const h = bumperHit(ctx, w);
  if (!h) return ROLLING;
  const [vx, vy] = bounce9B3B(ctx, w, h.actor, h.c);
  w.spinPending = 0;
  w.vx = vx;
  w.vy = vy;
  w.vz = 0;
  reflectAt(ctx, w, h.c.dx, h.c.dy);
  penalty(w);
  return ROLLING;
}

// ------------------------------------------------------------ $90-$97, $A2

/** `$82:9728`: the speed brought to at least $0800 (along the last heading from rest). */
function speedAtLeast(ctx: Ctx, w: Work, min: number): [number, number] {
  let ax = abs16(w.vx);
  let ay = abs16(w.vy);
  if (wrap16(ax + ay) === 0) return [hi16(cos(ctx, w.lastDeg), min), hi16(sin(ctx, w.lastDeg), min)];
  if (ax + ay >= min) return [w.vx, w.vy];
  const bx = ax;
  const by = ay;
  do {
    ax += bx;
    ay += by;
  } while (ax + ay < min);
  return [s16(w.vx) < 0 ? neg16(ax) : wrap16(ax), s16(w.vy) < 0 ? neg16(ay) : wrap16(ay)];
}

/** `$82:EF23`: (vx, vy) scaled up to at least `min` in |vx| + |vy|. */
function atLeast(ctx: Ctx, w: Work, min: number, vx: number, vy: number): [number, number] {
  const ax = abs16(vx);
  const ay = abs16(vy);
  const sum = ax + ay;
  if (sum >= min) return [vx, vy];
  if (sum === 0) return [hi16(cos(ctx, w.lastDeg), min), hi16(sin(ctx, w.lastDeg), min)];
  const k = Math.ceil(min / sum);
  return [s16(vx) < 0 ? neg16(ax * k) : wrap16(ax * k), s16(vy) < 0 ? neg16(ay * k) : wrap16(ay * k)];
}

/** `$82:EF9B`: |v| raised to at least |min| by whole multiples; a negative result is ones' complement. */
function vzAtLeast(v: number, min: number): number {
  const m = abs16(min);
  const a = abs16(v);
  let r: number;
  if (a >= m) r = a;
  else if (a === 0) return v;
  else {
    let acc = a;
    do acc += a;
    while (acc < m);
    r = acc;
  }
  return s16(v) < 0 ? (r ^ 0xffff) & 0xffff : wrap16(r);
}

/** `$82:96BA` / `$82:98AE`: the box at the cell centre; Z by the actor's frame or fixed. */
function boxTest(ctx: Ctx, w: Work, fixed: boolean): Cube {
  let off = 0x3b00;
  if (!fixed) {
    const f = field(ctx);
    const i = f ? f.atCell[w.cell] : -1;
    const frame = i >= 0 ? f!.actors[i].frame : 0;
    off = ctx.rules.table('bobHeight')[frame & 0xff] ?? 0x3b00;
  }
  const c = cube(x32(w), y32(w), w.z, ((w.xc << 16) | 0x8000) >>> 0, ((w.yc << 16) | 0x8000) >>> 0, (w.ground + off) | 0);
  if (!fixed) w.stillGate = c.axes === 2 ? 1 : 0;
  return c;
}

/** `$82:97B4`: the landing on a box: the exchange, the actor's result reversed, the minimums. */
function boxLandBounce(ctx: Ctx, w: Work, c: Cube): void {
  w.spinPending = 0;
  const [vx, vy] = speedAtLeast(ctx, w, 0x0800);
  const r = exchange(ctx, [c.dx, c.dy, c.dz], [vx, vy, w.vz], [0, 0, 0]);
  let nx = r.actor[0] ^ 0xffff;
  let ny = r.actor[1] ^ 0xffff;
  const nz = r.actor[2] ^ 0xffff;
  [nx, ny] = atLeast(ctx, w, 0x0800, nx, ny);
  w.vx = nx;
  w.vy = ny;
  w.vz = vzAtLeast(nz, 0x0300);
}

export function bobLand(ctx: Ctx, w: Work, fixed = false): DispatchOutcome {
  const c = boxTest(ctx, w, fixed);
  if (!c.hit) {
    w.hazLatch = 0;
    if (!fixed) w.hazAxes = c.axes;
    return LANDING;
  }
  if (w.hazLatch !== 0) return LANDING;
  boxLandBounce(ctx, w, c);
  w.hazLatch += 1;
  penalty(w);
  return LANDING;
}

export function bobHitSide(ctx: Ctx, w: Work, fixed = false): DispatchOutcome {
  const c = boxTest(ctx, w, fixed);
  if (!c.hit) {
    w.hazLatch = 0;
    if (!fixed) w.hazAxes = c.axes;
    return ROLLING;
  }
  if (w.hazLatch !== 0) return ROLLING;
  w.spinPending = 0;
  if (!fixed && w.hazAxes === 2) {
    // `$82:9813`: met from above: the exchange with a falling box
    const r = exchange(ctx, [c.dx, c.dy, c.dz], [0, 0, 0], [0, 0, 0xf000]);
    w.vx = r.ball[0];
    w.vy = r.ball[1];
    w.vz = 0;
  } else {
    [w.vx, w.vy] = speedAtLeast(ctx, w, 0x0800);
    reflectAt(ctx, w, w.xf ^ 0x8000, w.yf ^ 0x8000); // $82:E6B4
  }
  w.hazLatch += 1;
  penalty(w);
  return DONE;
}

// ------------------------------------------------------------- $AC-$AE

function volcanoAt(ctx: Ctx, w: Work): ActorRun | null {
  const f = field(ctx);
  const i = f ? f.atCell[w.cell] : -1;
  return i >= 0 ? f!.actors[i] : null;
}

/** `$82:87C9`: the cone's diamond around the cell centre. */
function diamond(xf: number, yf: number): boolean {
  return yf >= xf - 0x6000 && yf < xf + 0x6000 && xf + yf >= 0x6000 && xf + yf < 0x1a000;
}

/** `$82:EDE9`: reflect (vx, vy) across the line at theta degrees. */
function reflectLine(ctx: Ctx, w: Work, theta: number): void {
  const T = (c: number, v: number): number => wrap16(hi16(c, v) << 1);
  const phi = 360 - theta;
  const x1 = wrap16(T(cos(ctx, phi), w.vx) - T(sin(ctx, phi), w.vy));
  const y1 = wrap16(T(sin(ctx, phi), w.vx) + T(cos(ctx, phi), w.vy));
  w.vx = wrap16(T(cos(ctx, theta), x1) + T(sin(ctx, theta), y1));
  w.vy = wrap16(T(sin(ctx, theta), x1) - T(cos(ctx, theta), y1));
}

export function volcanoLand(ctx: Ctx, w: Work): DispatchOutcome {
  if (w.mode === 1) return LANDING;
  const lo = (w.ground + 0x4800) | 0;
  const hi = (w.ground + 0xf000) | 0;
  if (!(w.z > lo && w.z <= hi) || !diamond(w.xf, w.yf)) return volcanoBase(ctx, w, 'land');
  // `$82:888C`: the side it came from
  let side: number;
  if (diamond(w.pXf, w.pYf)) side = 0;
  else if (w.xf < 0x6000 && w.yf < 0x6000) side = 4;
  else if (w.xf >= 0xa000 && w.yf >= 0xa000) side = 2;
  else if (w.quad >= 2) side = 3;
  else side = 1;
  // `$82:88F1`
  if (w.mode !== 6) w.fact4 += 1;
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
  if (side === 0) {
    w.vz = vzAtLeast(neg16(w.vz), 0x0300);
    [w.vx, w.vy] = atLeast(ctx, w, 0x0800, w.vx, w.vy);
  } else {
    reflectLine(ctx, w, side === 1 || side === 3 ? 45 : 135);
  }
  w.tailSfx = 0x7c;
  const v = volcanoAt(ctx, w);
  if (v) v.poke += 1; // $82:870C
  restorePrev(w); // $81:87B2 (x, y and the probe; not z)
  w.stillGate = 0;
  if (w.mode !== 0x0a && w.mode !== 3 && w.mode !== 4) {
    w.hazardHit += 1;
    w.hurt = 0x14;
    w.tomatoLoss += 1;
  }
  return GRAVITY_ONLY;
}

/** `$82:874E` (land) and `$82:8656` (hit): the cone's base, by the volcano's state. */
function volcanoBase(ctx: Ctx, w: Work, side: 'land' | 'hit'): DispatchOutcome {
  const out = side === 'land' ? LANDING : ROLLING;
  const middle = w.xf >= 0x4000 && w.xf < 0xc000 && w.yf >= 0x4000 && w.yf < 0xc000;
  const clr = (): DispatchOutcome => {
    w.stillGate = 0;
    w.volLatch = 0;
    return out;
  };
  if (!middle) return clr();
  if (side === 'land' && w.z > ((w.ground + 0x4800) | 0)) return clr();
  const v = volcanoAt(ctx, w);
  const state = v ? v.dir : 0;
  if (state === 0) return clr();
  if (state === 1) {
    w.stillGate = 1;
    return out;
  }
  if (w.mode === 7 || w.mode === 0x0a || (side === 'hit' && w.mode === 1)) return DONE;
  if (w.volLatch !== 0) return out;
  w.volLatch += 1;
  w.hurt = 0x0f;
  w.tomatoLoss += 1;
  return DONE;
}

export function volcanoHitSide(ctx: Ctx, w: Work): DispatchOutcome {
  return volcanoBase(ctx, w, 'hit');
}

// ------------------------------------------------------------------- $05

/** `$82:A55E` land (at or under the surface) / `$82:A576` hit: every frame, the default landing after. */
export function hazard05(w: Work, side: 'land' | 'hit'): DispatchOutcome {
  if (w.mode === 0x0a) return LANDING;
  if (side === 'land' && (w.ground >>> 0) < (w.z >>> 0)) return LANDING; // 32-bit unsigned
  w.hurt = 0x13;
  w.tomatoLoss += 1;
  w.spinPending = 0;
  w.spinX = 0;
  w.spinY = 0;
  w.tailSfx = 0x6f; // $82:A5A3
  w.hazardHit += 1; // $82:EED8
  return LANDING; // JML $81:8905, from the hit side too
}

