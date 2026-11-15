/**
 * Kirby's OAM priority, `$82:F4FD` (the roll loop calls it after the
 * presentation $81:A121 and the shadow $81:A23E: `$82:C06E`, and `$82:C0F7`
 * for player 2). Read 2026-11-15 with tools/dis65816.py:
 *
 *   z < 0 (the high word's sign)             1  behind
 *   on a cell (shape ≠ 0)                    3
 *   over a gap, xc < 0                       1  behind
 *              yc < 0                        3
 *              yc ≥ h ($8B94)                1  behind
 *              else table 10's record for
 *              the column and xc, if z ≤ the
 *              top of its cell               the record's (1 or 2)  behind
 *              else                          3
 *
 * "Behind" also puts Kirby in OAM queue 9 ($DA6C = 9; it is drawn after
 * every other sprite) and counts `$ECDD`, which keeps $81:A1E6 from sorting
 * him back. The engine does not model the queues: a priority below 3 is
 * under the course layers, and every other sprite of play is over them.
 *
 * Emulated on web_fly (`snesstep --snap-every 4`): Kirby left the near side
 * at xc = 12, a column with no record there, so $D96A stays 3 through the
 * snapshot of frame 3252. In 3256 z is below 0, $D96A is 1, and in 3260 his
 * nine sprites are at the end of OAM with priority 1.
 */
import type { RomRules } from '../rules';
import type { KernelCourse, Work } from './context';
import type { OcclusionTable } from '../occlusion';

/**
 * `$82:F571`/`$82:F593`: the record for screen column `d` and column `xc`,
 * or null. The comparisons are the ROM's 8-bit ones: `CMP xmin / BMI` (the
 * sign of the 8-bit difference) and `CMP xmax / BCC`. A column past the
 * directory has no record here; the game reads past the table there.
 */
export function occluder(
  table: OcclusionTable | undefined,
  d: number,
  xc: number,
): { prio: number; cell: number } | null {
  const col = table?.[d];
  if (col === null || col === undefined) return null;
  const x = xc & 0xff;
  for (const r of col) {
    if (((x - (r.xmin & 0xff)) & 0x80) !== 0) continue;
    if (x < (r.xmax & 0xff)) return { prio: r.prio, cell: r.cell };
  }
  return null;
}

/** $82:F4FD on the work copy (after the step): Kirby's OAM priority, $D96A. */
export function kirbyPriority(rules: RomRules, course: KernelCourse, w: Work): number {
  if (w.z < 0) return 1; // $82:F505 LDA $D9FA / BMI
  if (w.shape !== 0) return 3; // $82:F50A LDX $D9FE / BNE
  if ((w.xc & 0x8000) !== 0) return 1; // $82:F50F
  if ((w.yc & 0x8000) !== 0) return 3; // $82:F514
  if ((w.yc & 0xffff) >= course.h) return 1; // $82:F519 CPX $8B94 / BCC
  // $82:F571: the column, with the carry of the fractions
  const carry = (w.xf & 0xffff) + (w.yf & 0xffff) > 0xffff ? 1 : 0;
  const d = ((w.xc & 0xffff) + (w.yc & 0xffff) + carry) & 0xffff;
  const rec = occluder(course.occlusion, d, w.xc);
  if (rec === null) return 3;
  // $82:F539-$82:F556: behind while z ≤ the top of the record's cell,
  // Z(elevation + 1) from $88:80C8/$88:8000
  const top = rules.heightZ((course.elev[rec.cell] ?? 0) + 1);
  return top >= w.z ? rec.prio : 3;
}
