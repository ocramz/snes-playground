/**
 * 65816 integer semantics for the physics core. Every routine here is read
 * off the ROM (tools/dis65816.py) and cited; the values wrap and round the
 * way the original's do, which the frame-exact trace tests depend on.
 *
 * Word values are carried as unsigned 16-bit patterns (0-$FFFF); convert
 * with s16/s8 where the sign matters.
 */

/** The low 16 bits, as the 65816's 16-bit registers keep them. */
export function wrap16(v: number): number {
  return v & 0xffff;
}

/** Read a 16-bit pattern as signed. */
export function s16(v: number): number {
  return ((v & 0xffff) << 16) >> 16;
}

/** Read the low byte of a 16-bit pattern as signed. */
export function s8(v: number): number {
  return ((v & 0xff) << 24) >> 24;
}

/** ASR on a 16-bit word: arithmetic shift, result wrapped. */
export function asr(v: number, n: number): number {
  return wrap16(s16(v) >> n);
}

/**
 * The high word of the exact 32-bit signed product (what the launch and the
 * step-down read: "hi(vx x launch_x)", physics.md "Step down").
 */
export function hi16(a: number, x: number): number {
  return wrap16((s16(a) * s16(x)) >> 16);
}

/**
 * sub_mul_q15 $81:97A9: signed A x X >> 15, floor, through the PPU
 * multiplier. The routine builds the full signed 32-bit product in
 * $90-$93 and returns (product << 1) >> 16, i.e. bits 15-30 of it — the
 * low 16 bits of floor(A x X / 2^15).
 */
export function mulFloor(a: number, x: number): number {
  return wrap16(Math.floor((s16(a) * s16(x)) / 0x8000));
}

/**
 * sub_mul_q15s $81:9793: the sign-magnitude Q15 multiply. Only A's sign is
 * normalised ($81:9793): A < 0 -> -(mulFloor(-A, X)); A >= 0 -> mulFloor.
 * So a negative product with A >= 0 and X < 0 still floors (away from 0);
 * the toward-0 rounding the docs describe holds when the negative operand
 * is A. A = $8000 negates to itself (EOR/INC wrap), as on hardware.
 */
export function mulQ15s(a: number, x: number): number {
  a = wrap16(a);
  if (!(a & 0x8000)) return mulFloor(a, x);
  const neg = wrap16(-a); // EOR #$FFFF / INC A in 16 bits; $8000 -> $8000
  return wrap16(-s16(mulFloor(neg, x)));
}

/**
 * sub_mul_16x8 $80:A342: signed 16-bit A x signed low byte of X through
 * $211B/$211C; the 24-bit product lands at $389E, so what callers read
 * ($389F) is bits 8-23 of it.
 */
export function mul16x8(a: number, x: number): number {
  return wrap16((s16(a) * s8(x)) >> 8);
}

/**
 * The ratio index of sub_atan2_deg's divider ($80:A546): floor(256 x
 * smaller / larger), clamped to 255. For larger >= 256 the ROM normalises
 * both operands left until the larger's bit 15 is set, then divides the
 * 16-bit smaller by the larger's high byte — truncating the divisor's low
 * byte, which can round the quotient up against the exact ratio, so the
 * shift-and-divide is reproduced rather than the ideal formula.
 */
function ratioIndex(smaller: number, larger: number): number {
  if (larger < 0x100) return Math.min(0xff, Math.floor((smaller << 8) / larger));
  let s = smaller;
  let l = larger;
  do {
    s = (s << 1) & 0xffff;
    l = (l << 1) & 0xffff;
  } while (!(l & 0x8000));
  return Math.min(0xff, Math.floor(s / (l >> 8)));
}

/**
 * sub_atan2_deg $80:A4C1: the heading in degrees 0-359 of the vector
 * (vx, vy); 0 is +x and 90 is +y (physics.md "Heading"). Table-driven: the
 * ratio of the smaller to the larger magnitude indexes the arctangent table
 * tbl_atan_deg $80:A928 (degrees 0-45), the quadrant is added from the
 * signs, and a $8000 operand is bumped to $8001 so negation cannot overflow.
 * atan2Deg(0, 0) = 90, as the ROM computes it; the ball code keeps the last
 * heading while still and never relies on it.
 */
export function atan2Deg(vx: number, vy: number, atanDeg: ArrayLike<number>): number {
  let x = wrap16(vx);
  let y = wrap16(vy);
  if (x === 0x8000) x = 0x8001;
  if (y === 0x8000) y = 0x8001;
  const sx = s16(x);
  const sy = s16(y);
  let angle: number;
  if (sx === 0) {
    angle = 90;
  } else {
    const ax = Math.abs(sx);
    const ay = Math.abs(sy);
    if (ax === ay) {
      angle = 45;
    } else {
      const idx = ratioIndex(Math.min(ax, ay), Math.max(ax, ay));
      angle = ay < ax ? atanDeg[idx] : 90 - atanDeg[idx];
    }
  }
  const base = sx < 0 ? 180 : sy < 0 ? 360 : 0;
  let deg = sx < 0 !== sy < 0 ? base - angle : base + angle;
  if (deg >= 360) deg -= 360;
  return deg;
}
