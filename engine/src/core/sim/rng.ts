/**
 * The game's random numbers, `$80:87DD` (read 2026-11-15; notes/port-v2-
 * phase4-water.md): a byte from the 16-bit word `$0079` and the byte
 * `$007B`, through the hardware multiplier. In a 1P hole only the water's
 * bubbles (object 67, `$85:E800`/`$85:E906`) call it once the shot is set
 * up (course 1 hole 7: `--log-pc $80:87DD`); the hole's opening calls it
 * from `$84:B871`, before the engine's hole begins.
 *
 *     A = ($0079 lo) << 8 | $007B lo; WRMPYA = $007B lo, WRMPYB = $0079 lo
 *     $007B = A + $6D (16-bit, carry C1)
 *     p = $007B lo x $0079 lo; p = ROR(ROR(p)) through C1
 *     $0079 = ROR((p & 3) + $0079) with its carry, bit 15 set if the bit out is 1
 *     return ROR(ROR(p)) & $FF, through that bit
 */

export interface RngState {
  /** $0079, 16-bit. */
  a: number;
  /** $007B-$007C, 16-bit (only the low byte feeds back). */
  b: number;
}

/** ROR of a 16-bit value through a carry: [value, carry out]. */
function ror(v: number, c: number): [number, number] {
  return [((v >> 1) | (c << 15)) & 0xffff, v & 1];
}

/** `$80:87DD`: the next byte; advances `s` in place. */
export function rngNext(s: RngState): number {
  const lo79 = s.a & 0xff;
  const lo7b = s.b & 0xff;
  const acc = (lo79 << 8) | lo7b;
  const sum = acc + 0x6d; // CLC / ADC #$006D
  let c = sum > 0xffff ? 1 : 0;
  s.b = sum & 0xffff; // STA $007B
  let p = lo7b * lo79; // $4216
  [p, c] = ror(p, c);
  [p, c] = ror(p, c);
  const pushed = p;
  const t = (pushed & 3) + s.a; // AND #3 / CLC / ADC $0079
  c = t > 0xffff ? 1 : 0;
  let a: number;
  [a, c] = ror(t & 0xffff, c);
  // BCC / ORA #$8000: the bit shifted out sets bit 15 (the ROR already
  // rotated the add's carry in there)
  if (c) a |= 0x8000;
  s.a = a;
  let r: number;
  [r, c] = ror(pushed, c);
  [r] = ror(r, c);
  return r & 0xff;
}
