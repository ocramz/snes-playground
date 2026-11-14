/**
 * Kirby's facing from the aim (docs/animation.md, `$7E:D7C4`/`$7E:D7CC`):
 * `$81:BB4A` stores `$6ABE = (472 - phi) mod 360` (read 2026-11-14:
 * `360 - phi + $70`, wrapped once), `$81:BCA0` reads the 32-sector table
 * `$81:8E98[$6ABE]` and keeps `>> 1` as the shot angle and `>> 2` as the
 * facing. phi 0 gives facing 2 and angle 5.
 */
import type { RomRules } from '../rules';

export function facingFromAim(rules: RomRules, aim: number): { facing: number; angle: number; sector: number } {
  let v = 0x168 - (aim & 0xffff) + 0x70; // $81:BB4A
  if (v >= 0x168) v -= 0x168;
  const sector = rules.dir32(v) & 0xff; // $81:BCA0
  return { facing: sector >> 2, angle: sector >> 1, sector: v };
}
