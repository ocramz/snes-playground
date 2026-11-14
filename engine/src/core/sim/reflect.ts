/**
 * sub_ball_heading $81:8E60 and the reflection machinery:
 * sub_reflect_surface $81:9444 (matrix load) and sub_reflect $81:8DAF.
 */
import { wrap16 } from '../fixed';
import { atan2Deg, mulFloor } from '../fixed';
import type { RomRules } from '../rules';
import type { Work } from './context';

/** $81:8E60. A zero velocity keeps the last heading; a moving ball updates it. */
export function updateHeading(rules: RomRules, w: Work): void {
  const moving = (w.vx | w.vy) !== 0;
  w.deg = moving
    ? atan2Deg(w.vx, w.vy, rules.table('atanDeg'))
    : w.lastDeg;
  const d32 = rules.dir32(w.deg) & 0xff; // $D9E0
  w.dir32 = d32;
  w.dir16 = d32 >> 1; // $D9DE
  if (moving) w.lastDeg = w.deg;
}

/**
 * The 3x3 Q15 reflection matrix for surface code `code` (or 9 + edge for a
 * wall/step), loaded symmetrically: the ROM reads words 0, 1, 2, 4, 5 and 8
 * of the 9-word row at reflectIndex[i] bytes into tbl_reflect_matrix.
 */
export interface Mat {
  m00: number; m01: number; m02: number;
  m11: number; m12: number;
  m22: number;
}

export function loadMatrix(rules: RomRules, index: number): Mat {
  const off = rules.table('reflectIndex')[index]; // a byte offset
  const m = rules.table('reflectMatrix');
  const word = (i: number): number => m[off / 2 + i];
  return {
    m00: word(0),
    m01: word(1), // also m10
    m02: word(2), // also m20
    m11: word(4),
    m12: word(5), // also m21
    m22: word(8),
  };
}

/** sub_reflect $81:8DAF: v <- M v, each product through $81:97A9 (floor). */
export function reflect(rules: RomRules, w: Work, index: number): void {
  reflectWith(w, loadMatrix(rules, index));
}

/**
 * $82:E6C1's row for a heading in degrees: $88:9390 + 12 x deg, the same
 * six words $81:9444 loads.
 */
export function degreeMatrix(rules: RomRules, deg: number): Mat {
  const t = rules.table('reflectDeg');
  const o = (deg % 360) * 6;
  return { m00: t[o], m01: t[o + 1], m02: t[o + 2], m11: t[o + 3], m12: t[o + 4], m22: t[o + 5] };
}

/** $81:8DAF with a matrix already loaded (the entry $81:8DAB). */
export function reflectWith(w: Work, m: Mat): void {
  const vx = w.vx;
  const vy = w.vy;
  const vz = w.vz;
  let rx = 0;
  let ry = 0;
  let rz = 0;
  if (vx !== 0) {
    if (m.m00 !== 0) rx = mulFloor(vx, m.m00);
    if (m.m01 !== 0) ry = mulFloor(vx, m.m01);
    if (m.m02 !== 0) rz = mulFloor(vx, m.m02);
  }
  if (vy !== 0) {
    if (m.m01 !== 0) rx = wrap16(rx + mulFloor(vy, m.m01));
    if (m.m11 !== 0) ry = wrap16(ry + mulFloor(vy, m.m11));
    if (m.m12 !== 0) rz = wrap16(rz + mulFloor(vy, m.m12));
  }
  if (w.air !== 0 && vz !== 0) {
    // the vz column acts only while the ball is airborne ($81:8E17)
    if (m.m02 !== 0) rx = wrap16(rx + mulFloor(vz, m.m02));
    if (m.m12 !== 0) ry = wrap16(ry + mulFloor(vz, m.m12));
    if (m.m22 !== 0) rz = wrap16(rz + mulFloor(vz, m.m22));
  }
  w.vx = rx;
  w.vy = ry;
  w.vz = rz;
}
