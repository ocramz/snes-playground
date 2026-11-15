/**
 * Position integration and the airborne drag ($81:8805/$81:885C), gravity
 * ($81:899F) and the fall-off-the-course test ($81:89AA).
 *
 * The cell+fraction pairs are one signed 32-bit fixed-point number each:
 * the ROM's carry chain (`ADC` into the cell, `DEC` for a negative addend)
 * is exactly a 32-bit add (move.ts derivation in the phase-4 notes).
 */
import { s16, wrap16 } from '../fixed';
import type { Work } from './context';

/** The 32-bit signed value of a (cell, fraction) pair. */
function pack(cell: number, frac: number): number {
  return (s16(cell) << 16) | (frac & 0xffff);
}

function unpack(v: number): { cell: number; frac: number } {
  const lo = v & 0xffff;
  const hi = (v - lo) >> 16; // arithmetic, keeps the sign
  return { cell: hi & 0xffff, frac: lo };
}

/** (cell, frac) += s16(v), with the ROM's 32-bit wraparound. */
function addFrac(cell: number, frac: number, v: number): { cell: number; frac: number } {
  return unpack(pack(cell, frac) + s16(v));
}

/** z += s16(vz) as 32-bit two's complement. */
export function addZ(z: number, vz: number): number {
  return (z + s16(vz)) | 0;
}

/** $81:8805: integrate x, y and z by the velocity. */
export function integrate(w: Work): void {
  const x = addFrac(w.xc, w.xf, w.vx);
  w.xc = x.cell;
  w.xf = x.frac;
  const y = addFrac(w.yc, w.yf, w.vy);
  w.yc = y.cell;
  w.yf = y.frac;
  w.z = addZ(w.z, w.vz);
}

/**
 * $81:885C: air drag on vx and vy, skipped in mode $0A. Each step is
 * `v -= (|v| + $80) >> 8 & $FF` toward zero — for negative v the ROM adds
 * the same magnitude ($81:8862: EOR/INC, then `ADC $D9D4` wraps back).
 */
export function airDrag(w: Work): void {
  const step = (v: number): number => {
    // $81:885C branches on the signed value (BPL), not the pattern
    const sv = s16(v);
    const mag = sv >= 0 ? sv : wrap16(-sv);
    const h = ((mag + 0x80) >> 8) & 0xff;
    return wrap16(sv >= 0 ? v - h : v + h);
  };
  w.vx = step(w.vx);
  w.vy = step(w.vy);
}

/** $81:899F: vz += $DA38, 16-bit wrap. */
export function applyGravity(w: Work): void {
  w.vz = wrap16(w.vz + s16(w.gravity));
}

/**
 * $81:89AA: reached with A = the high word of z. z < -$11_0000 sets the
 * lost flag and zeroes the velocities; anything higher keeps falling.
 */
export function fallBelowCourse(w: Work, zHigh: number): void {
  if (zHigh >= 0xffef) {
    applyGravity(w); // JMP $899F
    return;
  }
  w.lost = 1; // $81:89B2: LDA #1, STA $D9D2
  w.fellOut = 1; // (engine fact: this path, not the projection's flag)
  w.vx = 0;
  w.vy = 0;
  w.vz = 0;
}
