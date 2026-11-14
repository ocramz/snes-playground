import { describe, expect, it } from 'vitest';
import { haveAssets, loadRom } from '../../../test/load';
import { launchVelocity, shotPower, shotSpin } from '../shot';

describe.skipIf(!haveAssets)('shot against docs/physics.md', () => {
  const { rom } = loadRom();

  it('launch: a grounder with P=$1104 leaves at vx=$1102', () => {
    const v = launchVelocity(rom, 0x1104, 0, 0);
    expect(v.vx).toBe(0x1102);
    expect(v.vz).toBe(0);
  });

  it('launch: a fly shot with P=$1156 leaves at vx 2217, vz 3843', () => {
    const v = launchVelocity(rom, 0x1156, 0, 60);
    expect(v.vx).toBe(2217);
    expect(v.vz).toBe(3843);
  });

  it('fly spin, P=$1156, aim 0: t=0 -> 2104, t=11 -> -2245, Left (side 2) -> 707', () => {
    expect(shotSpin(rom, 0x1156, 0, 60, 6, 0).spinX).toBe(2104);
    expect(shotSpin(rom, 0x1156, 0, 60, 6, 11).spinX).toBe(-2245);
    expect(shotSpin(rom, 0x1156, 0, 60, 2, 6).spinY).toBe(707);
  });

  it('grounder curve: Left (side 2) -> $0700, Right (10) -> $F900', () => {
    expect(shotSpin(rom, 0x1104, 0, 0, 2, 6).spinX).toBe(0x0700);
    expect(shotSpin(rom, 0x1104, 0, 0, 10, 6).spinX).toBe(-0x700);
  });

  it('power meter range', () => {
    expect(shotPower(rom, 63, true)).toBeGreaterThan(4500);
    expect(shotPower(rom, 0, true)).toBeLessThan(shotPower(rom, 63, true));
  });
});
