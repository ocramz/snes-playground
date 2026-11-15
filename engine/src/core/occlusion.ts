/**
 * Kirby's occlusion table: the hole's table 10 (`$88:C570` → `$7E:A3B2`,
 * docs/courses.md), which `$82:F4FD` reads to send Kirby behind the course
 * while he is over a gap (sim/priority.ts).
 *
 * The table is indexed by Kirby's screen column
 * d = xc + yc + carry(xf + yf). The projection puts him at 32 (x + y), so
 * each column is 32 px wide. A column's records list ranges of xc, each with
 * the course cell that is in front of those positions on the screen, and
 * the OAM priority to use when Kirby is below that cell's top. ROM holes
 * carry the game's table (tools/export_web.py `occlusion_table`). Authored
 * holes get one from `buildOcclusion`.
 */

/** One record: xmin ≤ xc < xmax is behind `cell` (row-major), at OAM priority `prio`. */
export interface OcclusionRecord {
  xmin: number;
  xmax: number;
  prio: number;
  cell: number;
}

/** Per screen column (w + h of them): its records, or null (`$FFFF`). */
export type OcclusionTable = ReadonlyArray<ReadonlyArray<OcclusionRecord> | null>;

/** course.json `occlusion`: per column null, or [xmin, xmax, prio, cell] records. */
export type OcclusionJson = Array<Array<[number, number, number, number]> | null>;

export function fromOcclusionJson(json: OcclusionJson, w: number, h: number): OcclusionTable {
  if (json.length !== w + h) throw new Error(`occlusion table has ${json.length} columns, expected ${w + h}`);
  return json.map((col) => (col === null ? null : col.map(([xmin, xmax, prio, cell]) => ({ xmin, xmax, prio, cell }))));
}

/**
 * A table for a hole the ROM has none for (authored and generated holes).
 * Each gap position (xc, yc) on column d (the two cases of the carry: yc =
 * d - xc and yc = d - xc - 1) is behind the nearest course cell in front of
 * it on that column. Those are the cells covering column d (cx + cy ∈
 * {d - 1, d}) with a larger cx - cy, which sit lower on the screen and so
 * nearer the camera. If the two cases disagree, the no-carry one wins.
 * Consecutive xc with the same cell make one record, at priority 1 (under
 * both course layers).
 *
 * Checked against the 232 ROM tables over every gap position and both
 * carries (2026-11-15): the rule picks the table's cell, or no record, for
 * 70,950 of 71,124 positions (99.76 %). The ROM's priority-2 records, under
 * the front layer only, are not reproduced.
 */
export function buildOcclusion(w: number, h: number, shape: ArrayLike<number>): OcclusionTable {
  const gap = (x: number, y: number): boolean => x < 0 || y < 0 || x >= w || y >= h || shape[y * w + x] === 0;
  /** The nearest cell in front of (x, y) on column d, or -1. */
  const front = (d: number, x: number, y: number): number => {
    let best = -1;
    let bestKey = Infinity;
    for (const s of [d - 1, d]) {
      for (let cx = Math.max(0, s - (h - 1)); cx <= Math.min(w - 1, s); cx++) {
        const cy = s - cx;
        if (gap(cx, cy)) continue;
        const key = cx - cy;
        if (key > x - y && key < bestKey) {
          bestKey = key;
          best = cy * w + cx;
        }
      }
    }
    return best;
  };
  const out: Array<OcclusionRecord[] | null> = [];
  for (let d = 0; d < w + h; d++) {
    const recs: OcclusionRecord[] = [];
    for (let xc = 0; xc < w; xc++) {
      let cell = -1;
      // the carry's two positions; the lookup is only reached over a gap
      for (const yc of [d - xc, d - xc - 1]) {
        if (yc < 0 || yc >= h || !gap(xc, yc)) continue;
        cell = front(d, xc, yc);
        break;
      }
      const last = recs[recs.length - 1];
      if (cell < 0) continue;
      if (last !== undefined && last.cell === cell && last.xmax === xc) last.xmax = xc + 1;
      else recs.push({ xmin: xc, xmax: xc + 1, prio: 1, cell });
    }
    out.push(recs.length > 0 ? recs : null);
  }
  return out;
}
