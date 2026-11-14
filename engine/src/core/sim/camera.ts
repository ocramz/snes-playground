/**
 * The camera's moves (read 2026-11-14; build/engine/disasm/flow-follow.txt,
 * docs/web-demo.md "Camera"). Pure functions over the Camera fields; the
 * `update-camera` system decides which runs.
 */
import { s16, wrap16 } from '../fixed';

export interface CameraFields {
  x: number; y: number;
  wantX: number; wantY: number;
  lagX: number; lagY: number;
  arrived: number;
}

/** One axis of $81:BA8A: step toward `target` by min(cap, |d| >> 3 + 1). */
function panAxis(cur: number, target: number, cap: number): { v: number; on: boolean } {
  const d = s16(wrap16(target - cur));
  if (d === 0) return { v: cur, on: true };
  let step = (Math.abs(d) >> 3) + 1;
  if (step >= cap) step = cap;
  return { v: wrap16(cur + (d < 0 ? -step : step)), on: false };
}

/**
 * $81:BA8A: pan toward the point (px, py) in Kirby's screen space — the
 * camera aims at (px - 128, py + 112), x by at most 10 a frame, y by 5.
 * `arrived` ($6AB0) is set only when both axes were already there.
 */
export function panStep(c: CameraFields, px: number, py: number): void {
  const ax = panAxis(c.x, wrap16(px - 0x80), 10);
  const ay = panAxis(c.y, wrap16(py + 0x70), 5);
  c.x = ax.v;
  c.y = ay.v;
  c.arrived = ax.on && ay.on ? 1 : 0;
}

/** $81:BE9A: the aim's quarter (0-89, 90-179, 180-269, 270-359). */
export function aimQuarter(aim: number): number {
  return aim < 0x5a ? 0 : aim < 0xb4 ? 1 : aim < 0x10e ? 2 : 3;
}

/**
 * One axis of $80:BAB4: the wanted lag, -24 x the screen motion since last
 * frame, as the integer word of the 16.16 product, clamped to `cap` in
 * magnitude. The ROM forms 8d + 16d with ROL pairs (the bits shifted out of
 * the integer come back in at the fraction's bottom, as in the projection),
 * then stores the clamped magnitude with the opposite sign.
 */
function wantAxis(cur: number, curF: number, prev: number, prevF: number, cap: number): number {
  // SEC; SBC (fraction), SBC (integer): the carry is "no borrow"
  const l = sub16(curF, prevF, 1);
  const h = sub16(cur, prev, l.c);
  const r8 = rol(h.v, l.v, h.c, 3); // x 8: $02 (fraction), $04 (integer)
  const r16 = rol(r8.hi, r8.lo, r8.c, 1); // x 16: $00, $06
  let sumLo = r16.lo + r8.lo;
  const carry = sumLo > 0xffff ? 1 : 0;
  sumLo &= 0xffff;
  const v = s16((r16.hi + r8.hi + carry) & 0xffff);
  let mag = Math.abs(v);
  if (mag >= cap) mag = cap;
  return v < 0 ? mag : wrap16(-mag);
}

function sub16(a: number, b: number, cin: number): { v: number; c: number } {
  const r = (a & 0xffff) - (b & 0xffff) - (1 - cin);
  return { v: r & 0xffff, c: r >= 0 ? 1 : 0 };
}

function rol(hi: number, lo: number, carry: number, n: number): { hi: number; lo: number; c: number } {
  let c = carry;
  for (let i = 0; i < n; i++) {
    const nlo = ((lo << 1) | c) & 0xffff;
    c = (lo >> 15) & 1;
    const nhi = ((hi << 1) | c) & 0xffff;
    c = (hi >> 15) & 1;
    lo = nlo;
    hi = nhi;
  }
  return { hi, lo, c };
}

/** Kirby's screen position now and last frame (BallScreen's fields). */
export interface ScreenPos {
  x: number; xf: number; y: number; yf: number;
  px: number; pxf: number; py: number; pyf: number;
}

/**
 * The locked follow, $80:BA35 (follow state 2, the 1-player case): the
 * wanted lag from Kirby's motion ($80:BAB4: x clamped at $70, y at $60),
 * the lag eased toward it ($80:BB42: by |e| >> 5 + 1 on both axes),
 * then the camera on Kirby + (-128, +112) + lag.
 */
export function followStep(c: CameraFields, k: ScreenPos): void {
  c.wantX = wantAxis(k.x, k.xf, k.px, k.pxf, 0x70);
  c.wantY = wantAxis(k.y, k.yf, k.py, k.pyf, 0x60);
  c.lagX = ease(c.lagX, c.wantX, 5);
  c.lagY = ease(c.lagY, c.wantY, 5);
  c.x = wrap16(k.x - 0x80 + c.lagX);
  c.y = wrap16(k.y + 0x70 + c.lagY);
}

function ease(lag: number, want: number, shift: number): number {
  const e = s16(wrap16(want - lag));
  if (e === 0) return lag;
  const step = (Math.abs(e) >> shift) + 1;
  return wrap16(lag + (e < 0 ? -step : step));
}
