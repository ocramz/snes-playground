// The shot: power, launch velocity and spin ($81:C2E6, $81:BA0B, $81:C1D5).
import { mulQ15 } from './fixed';
import { cosDeg, sinDeg } from './trig';
import type { Rom } from './tables';

const s8 = (v: number): number => ((v & 0xff) ^ 0x80) - 0x80;
/** High byte of a Q15 word as a signed byte (the 8-bit multiplier of $80:A342). */
const hiByte = (q15: number): number => s8((q15 & 0xffff) >> 8);

/** $81:C2E6: P = ($1300 * tbl_power[meter]) >> 14. */
export function shotPower(rom: Rom, meter: number, fly: boolean): number {
  const t = fly ? rom.powerFly : rom.powerGround;
  return Math.floor((rom.c.powerScale * t[meter]) / 16384);
}

/** Q15 product, sign-magnitude, as $81:BA63 does for the horizontal parts. */
function mulQ15Mag(a: number, b: number): number {
  const p = a * b;
  return p >= 0 ? Math.floor(p / 32768) : -Math.floor((-p - 1) / 32768);
}

/** $81:BA0B: vz = P sin e, h = P cos e, vx = h cos phi, vy = h sin phi. */
export function launchVelocity(rom: Rom, power: number, aim: number, elev: number): { vx: number; vy: number; vz: number } {
  const vz = mulQ15(power, sinDeg(rom, elev));
  const h = mulQ15(power, cosDeg(rom, elev));
  return {
    vx: mulQ15Mag(h, cosDeg(rom, aim)),
    vy: mulQ15Mag(h, sinDeg(rom, aim)),
    vz,
  };
}

/**
 * $81:C1D5. `side` and `topBack` are the two 0-12 selectors (6 = none).
 * Grounder: a curve rate in spinX. Fly shot: an impulse (spinX, spinY) added
 * at the first bounce. `pending` is $D9D0.
 */
export function shotSpin(rom: Rom, power: number, aim: number, elev: number, side: number, topBack: number):
  { spinX: number; spinY: number; pending: number } {
  let spinX = 0, spinY = 0, pending = 0;
  if (elev === 0) {
    spinX = Math.floor((0x4000 * rom.curve[side]) / 256);
    spinY = Math.floor((power * rom.spinGroundTB[topBack]) / 256);
    pending = spinX | spinY;
    return { spinX, spinY, pending };
  }
  const k = 2 * ((power >> 1) + (power >> 2) + rom.c.flySpinBase);
  const cosA = rom.sin[aim + 90];
  const sinA = rom.sin[aim];
  if (rom.spinFlyTB[topBack] !== 0) {
    const t = Math.floor((rom.spinFlyTB[topBack] * k) / 256);
    spinX = Math.floor((t * hiByte(cosA)) / 256);
    spinY = Math.floor((t * hiByte(sinA)) / 256);
    pending += 1;
  }
  const sd = rom.spinFlySide[side];
  if (sd !== 0) {
    const sv = Math.floor((k * sd) / 256);
    spinX += Math.floor((sv * hiByte(sinA)) / 256);
    spinY += Math.floor((sv * hiByte((-cosA) & 0xffff)) / 256);
    pending += 1;
  }
  return { spinX, spinY, pending };
}
