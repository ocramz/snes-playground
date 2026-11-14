/**
 * The shot's launch numbers: sub_shot_power $81:C2E6,
 * sub_launch_velocity $81:BA0B and sub_shot_spin $81:C1D5. The flow systems
 * (phase 5) call these; the ball step consumes the results, and the shot
 * guide reuses them silently.
 */
import { s16, wrap16, mul16x8 } from '../fixed';
import type { RomRules } from '../rules';
import type { Work } from './context';
import { cosDeg, sinDeg } from './trig';

/** $81:C2E6: P = ($1300 x tbl_power[meter]) >> 14, as a 16-bit word. */
export function shotPower(rules: RomRules, meter: number, flyShot: boolean): number {
  const tbl = rules.table(flyShot ? 'powerFly' : 'powerGround');
  const product = rules.const_('powerScale') * tbl[meter];
  return wrap16(Math.floor(product / 0x4000));
}

/**
 * $81:BA0B: vz = P sin(e) and h = P cos(e) through the $80:A378 + ASL/ROL
 * pair (= floor(P x dir / 2^15) as a 16-bit word); vx = h cos(phi) and
 * vy = h sin(phi) through $81:BA63, whose negative products round toward
 * zero (the magnitude is floored, then the sign applied).
 * `elevOverride` is the Hi-Jump entry ($81:BA0E with A = the power).
 */
export function launchVelocity(rules: RomRules, w: Work, power: number, elevOverride = -1): void {
  const elev = elevOverride >= 0 ? elevOverride : w.shotElev;
  w.vz = mulFloorW(power, sinDeg(rules, elev));
  const h = mulFloorW(power, cosDeg(rules, elev));
  w.vx = signMag(s16(h) * s16(cosDeg(rules, w.shotAim)));
  w.vy = signMag(s16(h) * s16(sinDeg(rules, w.shotAim)));
}

function mulFloorW(a: number, b: number): number {
  return wrap16(Math.floor((s16(a) * s16(b)) / 0x8000));
}

/** $81:BA63: the sign-magnitude product rounding. */
function signMag(product: number): number {
  return product < 0 ? -((-product) >> 15) : (product >> 15) & 0xffff;
}

/**
 * $81:C1D5: the spin from the latched selectors.
 * Grounder: $D9CC = ($4000 x curve[s]) >> 8 and $D9CE = (P x tbl[t]) >> 8,
 * both through $80:A342 (16 x 8, bits 8-23); pending = the OR.
 * Fly shot: K = (P/2 + P/4 + flySpinBase) << 1; T = (tbl[t] x K) >> 8 and
 * S = (tbl[s] x K) >> 8; the axis terms multiply T and S by the HIGH BYTE
 * of the Q15 cosine/sine — the side term's second axis uses the negated
 * cosine, whose high byte is $80, not $7F (web-demo.md "Spin").
 * Pending counts the non-zero terms ($81:C273/$81:C2B9).
 */
export function shotSpin(rules: RomRules, w: Work, side: number, tb: number, power: number): void {
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
  if (w.shotElev === 0) {
    w.spinX = mul16x8(0x4000, rules.table('curve')[side]);
    w.spinY = mul16x8(power, rules.table('spinGroundTB')[tb]);
    w.spinPending = wrap16(w.spinX | w.spinY);
    return;
  }
  const k2 = wrap16(((power >> 1) + (power >> 2) + rules.const_('flySpinBase')) << 1);
  const cosHigh = highByte(cosDeg(rules, w.shotAim));
  const sinHigh = highByte(sinDeg(rules, w.shotAim));
  const negCosHigh = highByte(wrap16(-s16(cosDeg(rules, w.shotAim))));
  const tbV = rules.table('spinFlyTB')[tb];
  const sideV = rules.table('spinFlySide')[side];
  if (tbV !== 0) {
    const t = mul16x8(k2, tbV);
    w.spinX = mul16x8(t, cosHigh);
    w.spinY = mul16x8(t, sinHigh);
    w.spinPending += 1;
  }
  if (sideV !== 0) {
    const s = mul16x8(k2, sideV);
    w.spinX = wrap16(w.spinX + mul16x8(s, sinHigh));
    w.spinY = wrap16(w.spinY + mul16x8(s, negCosHigh));
    w.spinPending += 1;
  }
}

function highByte(v: number): number {
  return (v >> 8) & 0xff;
}
