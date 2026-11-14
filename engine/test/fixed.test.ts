import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { asr, atan2Deg, hi16, mul16x8, mulFloor, mulQ15s, s16, s8, wrap16 } from '../src/core/fixed';
import { haveRules, loadTables } from './fixtures';

describe('wrap16 / s16 / s8 / asr', () => {
  it('keeps the low 16 bits and reads signs', () => {
    expect(wrap16(0x1ffff)).toBe(0xffff);
    expect(wrap16(-1)).toBe(0xffff);
    expect(s16(0xffff)).toBe(-1);
    expect(s16(0x7fff)).toBe(32767);
    expect(s8(0xff80)).toBe(-128);
    expect(s8(0x007f)).toBe(127);
  });

  it('asr is arithmetic and wrapped', () => {
    expect(asr(0x8000, 1)).toBe(0xc000);
    expect(asr(0x0004, 1)).toBe(0x0002);
    expect(asr(0xffff, 15)).toBe(0xffff);
  });
});

describe('mulFloor ($81:97A9): signed A x X >> 15, floor', () => {
  it('multiplies Q15 values', () => {
    expect(mulFloor(0x4000, 0x4000)).toBe(0x2000); // 0.5 x 0.5 = 0.25
    expect(mulFloor(0x7fff, 0x7fff)).toBe(0x7ffe); // just under 1
  });

  it('floors negative products (away from 0)', () => {
    // floor(-32767 / 32768) = -1, not 0
    expect(mulFloor(0xffff, 0x7fff)).toBe(0xffff);
    // floor(-134 x 32767 / 32768) = floor(-133.996) = -134
    expect(mulFloor(0xff7a, 0x7fff)).toBe(0xff7a);
  });

  it('wraps the extreme to the 16-bit pattern, as the hardware does', () => {
    expect(mulFloor(0x8000, 0x8000)).toBe(0x8000); // 2^30 >> 15 = 32768 -> $8000
  });
});

describe('mulQ15s ($81:9793): sign-magnitude, only A normalised', () => {
  it('rounds toward 0 when A is the negative operand', () => {
    expect(mulQ15s(0xffff, 0x7fff)).toBe(0); // -(floor(32767/32768)) = -0
  });

  it('still floors when A >= 0 and X < 0 (the documented asymmetry)', () => {
    expect(mulQ15s(0x7fff, 0xffff)).toBe(0xffff); // floor(-32767/32768) = -1
  });

  it('matches mulFloor on positive products', () => {
    expect(mulQ15s(0x4000, 0x4000)).toBe(0x2000);
  });

  it('negates $8000 to itself, as EOR/INC wraps on hardware', () => {
    // neg($8000) = $8000 -> mulFloor(-32768, 16384) = -16384 -> negated = 16384
    expect(mulQ15s(0x8000, 0x4000)).toBe(0x4000);
  });
});

describe('hi16: the high word of the exact product', () => {
  it('reads bits 16-31', () => {
    expect(hi16(0x8000, 0x8000)).toBe(16384); // 2^30 >> 16
    expect(hi16(0xffff, 0x4000)).toBe(0xffff); // -16384 >> 16 = -1
    expect(hi16(0x0000, 0x7fff)).toBe(0);
  });
});

describe('mul16x8 ($80:A342): bits 8-23 of A x s8(X)', () => {
  it('takes X low byte signed', () => {
    expect(mul16x8(0x0100, 0xff80)).toBe(0xff80); // 256 x -128, >> 8 = -128
    expect(mul16x8(0x7fff, 0x007f)).toBe(16255); // floor(32767 x 127 / 256)
  });

  it('ignores X high byte', () => {
    expect(mul16x8(0x0100, 0x7f80)).toBe(mul16x8(0x0100, 0xff80));
  });
});

describe.skipIf(!haveRules)('atan2Deg ($80:A4C1), with the ROM table', () => {
  const rules = new RomRules(loadTables());
  const table = Int32Array.from({ length: 256 }, (_, i) => rules.atanDeg(i));
  const deg = (vx: number, vy: number) => atan2Deg(vx, vy, table);

  it('axes and diagonals (0 = +x, 90 = +y)', () => {
    expect(deg(1, 0)).toBe(0);
    expect(deg(0, 1)).toBe(90);
    expect(deg(-1, 0)).toBe(180); // the emulated special case falls out of the quadrant logic
    expect(deg(0, -1)).toBe(270);
    expect(deg(100, 100)).toBe(45);
    expect(deg(-100, 100)).toBe(135);
    expect(deg(-100, -100)).toBe(225);
    expect(deg(100, -100)).toBe(315);
  });

  it('atan2Deg(0, 0) = 90, as the ROM computes it', () => {
    expect(deg(0, 0)).toBe(90);
  });

  it('bumps $8000 to $8001 instead of overflowing', () => {
    expect(deg(0x8000, 0)).toBe(180);
    expect(deg(0, 0x8000)).toBe(270);
  });

  it('stays within 1 degree of the ideal over a sweep, both divider paths', () => {
    for (const r of [1, 17, 255, 256, 1000, 30000]) {
      for (let a = 0; a < 360; a += 3) {
        const vx = Math.round(r * Math.cos((a * Math.PI) / 180));
        const vy = Math.round(r * Math.sin((a * Math.PI) / 180));
        if (vx === 0 && vy === 0) continue;
        const ideal = Math.round(Math.atan2(vy, vx) * (180 / Math.PI));
        const want = ((ideal % 360) + 360) % 360;
        const got = deg(vx, vy);
        const diff = Math.min((got - want + 360) % 360, (want - got + 360) % 360);
        expect(diff, `r=${r} a=${a} (${vx},${vy})`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('has no systematic error: the mean signed error over the sweep is ~0', () => {
    // the ratio truncation rounds individual results off by up to 1 deg,
    // but it must not drift
    let sum = 0;
    let n = 0;
    for (let vx = -300; vx <= 300; vx += 29) {
      for (let vy = -300; vy <= 300; vy += 31) {
        if (vx === 0 && vy === 0) continue;
        const want = ((Math.round(Math.atan2(vy, vx) * (180 / Math.PI)) % 360) + 360) % 360;
        const got = deg(vx, vy);
        const diff = ((got - want + 540) % 360) - 180;
        sum += diff;
        n++;
      }
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.05);
  });
});
