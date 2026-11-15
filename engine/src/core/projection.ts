/**
 * The screen projection, sub_project $81:A4C6 (read 2026-11-14,
 * build/engine/disasm/flow-project.txt), bit for bit:
 *
 *   x  = 32 (x + y)                       ($6A82:$6A80, + $8B9C = 0)
 *   up = 16 (y - x) + Z x $2D42 / 2^24    ($6A86:$6A84)
 *        - originY ($8B9E) + screenBase ($8B9A)
 *
 * Both are 16.16 values: an integer pixel and a 16-bit fraction. `up`
 * counts upward from the bottom of the screen space; the course bitmap's y
 * is `screenBase - up`, which is docs/web-demo.md's
 * `py = word7 + 16 (x - y) - 16 Z / $5A82`.
 *
 * Details the bit-exact port keeps:
 * - the shifts are ROL pairs through the carry ($81:A4D1, $81:A4F7), so the
 *   bits shifted out of the integer word come back in at the fraction's
 *   bottom (a negative y - x leaves a few low 1 bits in the fraction);
 * - Z's bits 8-23 go through the mode-7 multiplier (signed 16 x 8) by $42
 *   and $2D, its low byte through the CPU multiplier by $2D; a negative Z
 *   (bit 23 set) is negated first and the product subtracted.
 * The y origin lives in the course header (CourseData.originY/screenBase).
 */
import { wrap16 } from './fixed';

export interface Projected {
  /** $6A82 / $6A80. */
  x: number;
  xf: number;
  /** $6A86 / $6A84, upward. */
  y: number;
  yf: number;
  /** Z had bit 23 set; the ROM also sets $D9D2 bit 0 then ($81:A516). */
  negative: boolean;
}

export interface ProjectionOrigin {
  originY: number;
  screenBase: number;
}

/** A 33-bit rotate-left through carry of (hi:lo), `n` times. */
function rolPairs(hi: number, lo: number, carry: number, n: number): { hi: number; lo: number } {
  let c = carry;
  for (let i = 0; i < n; i++) {
    const nlo = ((lo << 1) | c) & 0xffff;
    c = (lo >> 15) & 1;
    const nhi = ((hi << 1) | c) & 0xffff;
    c = (hi >> 15) & 1;
    lo = nlo;
    hi = nhi;
  }
  return { hi, lo };
}

function s8(v: number): number {
  const b = v & 0xff;
  return b >= 0x80 ? b - 0x100 : b;
}

function s16v(v: number): number {
  const w = v & 0xffff;
  return w >= 0x8000 ? w - 0x10000 : w;
}

export function project(
  origin: ProjectionOrigin,
  xc: number, xf: number, yc: number, yf: number, z: number,
): Projected {
  // --- x: (xf + yf, xc + yc + carry) << 5 ---
  let lo = xf + yf;
  let c = lo > 0xffff ? 1 : 0;
  lo &= 0xffff;
  let hiSum = xc + yc + c;
  c = hiSum > 0xffff ? 1 : 0;
  hiSum &= 0xffff;
  const px = rolPairs(hiSum, lo, c, 5);
  const x = wrap16(px.hi); // + $8B9C (0)
  const xfrac = px.lo;

  // --- y: (yf - xf, yc - xc - borrow) << 4 ---
  let dlo = yf - xf;
  let carry = dlo >= 0 ? 1 : 0; // SBC: carry = no borrow
  dlo &= 0xffff;
  let dhi = yc - xc - (1 - carry);
  carry = dhi >= 0 ? 1 : 0;
  dhi &= 0xffff;
  const py = rolPairs(dhi, dlo, carry, 4);
  let yLo = py.lo; // $50
  let yHi = py.hi; // $52

  // --- z: the height term ---
  const zu = z >>> 0; // the 32-bit pattern $4A:$48
  const negative = ((zu >>> 23) & 1) === 1;
  let b54: number; // the low byte
  let m: number; // bits 8-23 (magnitude when negative)
  if (!negative) {
    b54 = zu & 0xff;
    m = (zu >>> 8) & 0xffff;
  } else {
    const loByte = zu & 0xff;
    b54 = (0 - loByte) & 0xff;
    const borrow = loByte !== 0 ? 1 : 0;
    m = (0 - ((zu >>> 8) & 0xffff) - borrow) & 0xffff;
  }
  // mode 7: signed 16 x signed 8 -> 24-bit signed
  const p1 = s16v(m) * s8(0x42);
  const p2 = s16v(m) * s8(0x2d);
  const p3 = 0x2d * b54; // CPU 8 x 8 unsigned
  // ($92:$90) = p1 (sign-extended to 32 bits), then + (p2 low byte << 8)
  // into the low word and + p2 bits 8-23 into the high word
  let t90 = p1 & 0xffff;
  let t92 = (p1 >> 16) & 0xffff;
  let sum = t90 + ((p2 & 0xff) << 8);
  let cc = sum > 0xffff ? 1 : 0;
  t90 = sum & 0xffff;
  t92 = (t92 + ((p2 >> 8) & 0xffff) + cc) & 0xffff;

  if (!negative) {
    sum = p3 + yLo;
    if (sum > 0xffff) yHi = (yHi + 1) & 0xffff;
    sum &= 0xffff;
    sum += t90;
    cc = sum > 0xffff ? 1 : 0;
    yLo = sum & 0xffff;
    yHi = (yHi + t92 + cc) & 0xffff;
  } else {
    let d = yLo - p3;
    if (d < 0) yHi = (yHi - 1) & 0xffff;
    d &= 0xffff;
    d -= t90;
    const borrow = d < 0 ? 1 : 0;
    yLo = d & 0xffff;
    yHi = (yHi - t92 - borrow) & 0xffff;
  }
  const y = wrap16(yHi - origin.originY + origin.screenBase);
  return { x, xf: xfrac, y, yf: yLo, negative };
}

/** The scroll position the camera ($38AC/$38AE) shows ($80:BF4D). */
export function scrollOf(origin: ProjectionOrigin, camX: number, camY: number): { x: number; y: number } {
  return { x: camX, y: origin.screenBase - camY };
}
