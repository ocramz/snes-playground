/**
 * The level editor's selections: sets of cell indices (y * w + x).
 * A "floor section" is what a click on flat ground selects: the cells
 * reachable through shared edges whose four corners are all at the clicked
 * cell's height (flat cells, mounds and dimples at that height), which is
 * the terrace the editor raises and lowers as one (docs/editor.md).
 */
import type { HoleGrid } from '../gen/grid';
import { DX, DY } from '../gen/grid';
import { cornersOf } from './corners';

export type Selection = ReadonlySet<number>;

/** The cells of the rectangle between two cells, inclusive, clipped to the grid. */
export function rectCells(g: HoleGrid, x0: number, y0: number, x1: number, y1: number): Set<number> {
  const out = new Set<number>();
  const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
  for (let y = Math.max(0, ay); y <= Math.min(g.h - 1, by); y++) {
    for (let x = Math.max(0, ax); x <= Math.min(g.w - 1, bx); x++) out.add(g.at(x, y));
  }
  return out;
}

/** The level corners' height of a cell, or null when it is not level (or a gap). */
export function levelHeight(g: HoleGrid, i: number): number | null {
  const c = cornersOf(g.shape[i], g.elev[i]);
  if (!c) return null;
  return c[0] === c[1] && c[1] === c[2] && c[2] === c[3] ? c[0] : null;
}

/**
 * The floor section through (x, y): the 4-connected level cells at its
 * height. A cell that is not level selects itself alone; a gap nothing.
 */
export function floorAt(g: HoleGrid, x: number, y: number): Set<number> {
  const out = new Set<number>();
  if (!g.solid(x, y)) return out;
  const start = g.at(x, y);
  const h = levelHeight(g, start);
  out.add(start);
  if (h === null) return out;
  const todo = [start];
  while (todo.length > 0) {
    const i = todo.pop()!;
    const cx = i % g.w;
    const cy = (i - cx) / g.w;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (!g.inside(nx, ny)) continue;
      const j = g.at(nx, ny);
      if (out.has(j) || levelHeight(g, j) !== h) continue;
      out.add(j);
      todo.push(j);
    }
  }
  return out;
}

/** Every cell of the grid. */
export function allCells(g: HoleGrid): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < g.w * g.h; i++) out.add(i);
  return out;
}
