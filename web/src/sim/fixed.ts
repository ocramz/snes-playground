// 65C816 integer semantics for the ball physics. Everything is a JS double
// holding an integer; none of these ever produce a fraction.

/** Wrap to a signed 16-bit value (what a 16-bit accumulator holds). */
export const s16 = (v: number): number => ((v & 0xffff) ^ 0x8000) - 0x8000;
/** Wrap to an unsigned 16-bit value. */
export const u16 = (v: number): number => v & 0xffff;

/**
 * $81:97A9, signed A x X >> 15: the 32-bit product, shifted left once and
 * its high word taken, i.e. floor(a * b / 32768).
 */
export const mulQ15 = (a: number, b: number): number => Math.floor((a * b) / 32768);

/**
 * $81:9793, the same multiply on the magnitude of `a`, negated back, so it
 * rounds toward zero. Used for the bounce damping.
 */
export const mulQ15s = (a: number, b: number): number =>
  a < 0 ? -mulQ15(-a, b) : mulQ15(a, b);

/** High word of a signed 32-bit product ($80:A378 leaves it in $38A0). */
export const hiWord = (a: number, b: number): number => Math.floor((a * b) / 65536);

/** Arithmetic shift right by `n` of a signed integer. */
export const sar = (v: number, n: number): number => Math.floor(v / 2 ** n);

/** Absolute value as the ROM does it for a signed word (EOR #$FFFF / INC). */
export const abs16 = (v: number): number => (v < 0 ? (-v) & 0xffff : v);
