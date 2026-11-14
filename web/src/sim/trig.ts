import type { Rom } from './tables';

/** sin of a whole-degree angle 0-449, Q15 ($80:A5A2). */
export const sinDeg = (rom: Rom, deg: number): number => rom.sin[deg];
/** cos is the same table 90 degrees on ($80:A656). */
export const cosDeg = (rom: Rom, deg: number): number => rom.sin[deg + 90];

/**
 * Hardware 16/8 divide index used by sub_atan2_deg ($80:A546): the ratio of
 * the smaller magnitude to the larger, as 0-255.
 */
function ratioIndex(larger: number, smaller: number): number {
  if (larger >> 8 === 0) {
    // A579: (smaller << 8) / larger, both below 256.
    return Math.floor(((smaller << 8) & 0xff00) / larger);
  }
  let a = larger;
  let x = smaller;
  do {
    x = (x << 1) & 0xffff;
    a = (a << 1) & 0xffff;
  } while ((a & 0x8000) === 0);
  const div = (a >> 8) & 0xff;
  const q = Math.floor(x / div);
  return q >= 0x100 ? 0xff : q;
}

/**
 * sub_atan2_deg $80:A4C1: heading of (vx, vy) in whole degrees 0-359, 0 = +x,
 * 90 = +y. Table-driven; port of the routine, not of math.atan2.
 */
export function atan2Deg(rom: Rom, vx: number, vy: number): number {
  // -$8000 would overflow the negate: the ROM bumps it by one.
  if (vx === -0x8000) vx += 1;
  if (vy === -0x8000) vy += 1;
  let angle: number;
  if (vx === 0) {
    angle = 90;
  } else {
    const ax = Math.abs(vx);
    const ay = Math.abs(vy);
    if (ax === ay) {
      angle = 45;
    } else if (ay < ax) {
      angle = rom.atan[ratioIndex(ax, ay)];
    } else {
      angle = 90 - rom.atan[ratioIndex(ay, ax)];
    }
  }
  const differ = vx < 0 !== vy < 0;
  let base = 0;
  if (vx < 0) base = 180;
  else if (vy < 0) base = 360;
  let r = differ ? base - angle : base + angle;
  if (r >= 360) r -= 360;
  return r;
}
