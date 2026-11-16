/**
 * The level editor's operations (docs/editor.md "The operations"). Each
 * takes a level and a selection and returns a new level (the input is never
 * changed, so the editor's undo is a list of levels) with a notice when part
 * of the selection could not follow.
 *
 * The terrain operations work on corner heights (core/level/corners.ts):
 * - raise / lower: the selection's cells move one step. In 'slope' mode the
 *   ring around them follows where it met them flush (its corners on the
 *   selection's vertices at their height move too) and is re-shaped; on
 *   flat ground that makes HoleGrid's hill and pit stamps. In 'cliff' mode
 *   only the selection moves, and its border becomes steps;
 * - blend: the selection's vertex heights are interpolated between the
 *   heights around it, so a gutter between two terraces becomes a ramp;
 * - flatten, dig, fill, a shape brush.
 * A cell whose new corners have no shape keeps its old one. Its markings
 * follow its shape (palette.ts adaptTile), and actors stay where they are
 * for the lint to report.
 */
import { HoleGrid, DX, DY } from '../gen/grid';
import { CORNER_DX, CORNER_DY, MAX_ELEV, classify, cornersOf, type Corners } from './corners';
import { adaptTile, paintByte, placementError, WATER } from './palette';
import { isEnemyTile, ENEMY_LIST_MAX, TEE_TILE } from '../sweep';
import type { Selection } from './select';

export interface Level {
  name: string;
  grid: HoleGrid;
}

export interface OpResult {
  level: Level;
  /** Did anything change? */
  changed: boolean;
  /** What could not be done, for the editor's status line. */
  notice?: string;
}

export const MIN_SIDE = 4;
export const MAX_SIDE = 32;

type Ctx = { g: HoleGrid; removed: number };

function begin(level: Level): Ctx {
  return { g: level.grid.clone(), removed: 0 };
}

function done(level: Level, ctx: Ctx, notices: string[] = []): OpResult {
  const g = ctx.g;
  const a = level.grid;
  const changed =
    g.w !== a.w || g.h !== a.h ||
    !eq(g.shape, a.shape) || !eq(g.elev, a.elev) || !eq(g.walls, a.walls) || !eq(g.tile, a.tile);
  if (ctx.removed > 0) notices.push(`${ctx.removed} marking${ctx.removed > 1 ? 's' : ''} removed (no longer fit the ground)`);
  return {
    level: changed ? { name: level.name, grid: g } : level,
    changed,
    notice: notices.length > 0 ? notices.join('; ') : undefined,
  };
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Set a cell's shape and elevation; its marking follows the shape. */
function setCell(ctx: Ctx, i: number, shape: number, elev: number): void {
  const g = ctx.g;
  const before = g.shape[i];
  g.shape[i] = shape;
  g.elev[i] = shape === 0 ? 0 : elev;
  if (shape === 0) {
    if (g.tile[i] !== 0) ctx.removed += 1;
    g.tile[i] = 0;
    g.walls[i] = 0;
    return;
  }
  if (before !== shape && g.tile[i] !== 0) {
    const t = adaptTile(g.tile[i], shape);
    if (t === 0) ctx.removed += 1;
    g.tile[i] = t;
  }
}

/** A diagonal ramp $18-$1B beside the cell: new corner cells take the diagonal family. */
function nearDiagonal(g: HoleGrid, x: number, y: number): boolean {
  for (let d = 0; d < 4; d++) {
    const nx = x + DX[d];
    const ny = y + DY[d];
    if (!g.inside(nx, ny)) continue;
    const s = g.shape[g.at(nx, ny)];
    if (s >= 0x18 && s <= 0x1b) return true;
  }
  return false;
}

const vkey = (g: HoleGrid, vx: number, vy: number): number => vy * (g.w + 1) + vx;

function cellsOf(g: HoleGrid, sel: Selection): number[] {
  return [...sel].filter((i) => i >= 0 && i < g.w * g.h).sort((a, b) => a - b);
}

/**
 * Raise (delta 1) or lower (delta -1) the selection's solid cells one step.
 * 'slope': the ring that met them flush follows and is re-shaped into ramps
 * and corners; 'cliff': only the selection moves.
 */
export function raise(level: Level, sel: Selection, delta: 1 | -1, mode: 'slope' | 'cliff'): OpResult {
  const src = level.grid;
  const region = cellsOf(src, sel).filter((i) => src.shape[i] !== 0);
  if (region.length === 0) return { level, changed: false, notice: 'select some ground first' };
  const ctx = begin(level);
  const inRegion = new Set(region);
  const word = delta > 0 ? 'raise' : 'lower';
  // the selection itself: every cell keeps its shape, one step up or down
  const moved: Array<[number, number, number]> = [];
  for (const i of region) {
    const c = cornersOf(src.shape[i], src.elev[i])!;
    const r = classify(c.map((v) => v + delta) as Corners, { prev: src.shape[i] });
    if (!r) {
      return {
        level, changed: false,
        notice: `can't ${word} further: elevations are 0-${MAX_ELEV} (a flat top 1-${MAX_ELEV + 1})`,
      };
    }
    moved.push([i, r.shape, r.elev]);
  }
  for (const [i, s, e] of moved) setCell(ctx, i, s, e);
  const notices: string[] = [];
  if (mode === 'slope') {
    // the heights the selection had at each of its vertices
    const at = new Map<number, Set<number>>();
    for (const i of region) {
      const x = i % src.w;
      const y = (i - x) / src.w;
      const c = cornersOf(src.shape[i], src.elev[i])!;
      for (let k = 0; k < 4; k++) {
        const v = vkey(src, x + CORNER_DX[k], y + CORNER_DY[k]);
        let s = at.get(v);
        if (!s) at.set(v, (s = new Set()));
        s.add(c[k]);
      }
    }
    const ring = new Set<number>();
    for (const i of region) {
      const x = i % src.w;
      const y = (i - x) / src.w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!src.inside(nx, ny)) continue;
        const j = src.at(nx, ny);
        if (!inRegion.has(j) && src.shape[j] !== 0) ring.add(j);
      }
    }
    let stuck = 0;
    for (const j of [...ring].sort((a, b) => a - b)) {
      const x = j % src.w;
      const y = (j - x) / src.w;
      const c = cornersOf(src.shape[j], src.elev[j])!;
      let follows = false;
      for (let k = 0; k < 4; k++) {
        const h = at.get(vkey(src, x + CORNER_DX[k], y + CORNER_DY[k]));
        if (h && h.has(c[k])) {
          c[k] += delta;
          follows = true;
        }
      }
      if (!follows) continue;
      const r = classify(c, { prev: src.shape[j], diagonal: nearDiagonal(src, x, y) });
      if (r) setCell(ctx, j, r.shape, r.elev);
      else stuck += 1;
    }
    if (stuck > 0) notices.push(`${stuck} cell${stuck > 1 ? 's' : ''} around it could not slope: left as steps`);
  }
  return done(level, ctx, notices);
}

/**
 * Re-shape the selection to join the ground around it: the heights of its
 * vertices on unselected solid cells are kept (the lowest where they
 * disagree), the others interpolated between them, and each selected cell
 * (gaps too) takes the shape of its four corners. A gutter between two
 * terraces becomes a ramp; a gap between them a bridge.
 */
export function blend(level: Level, sel: Selection): OpResult {
  const src = level.grid;
  const cells = cellsOf(src, sel);
  if (cells.length === 0) return { level, changed: false, notice: 'select some cells first' };
  const selected = new Set(cells);
  const W = src.w + 1;
  const known = new Map<number, number>();
  const verts = new Set<number>();
  for (const i of cells) {
    const x = i % src.w;
    const y = (i - x) / src.w;
    for (let k = 0; k < 4; k++) verts.add((y + CORNER_DY[k]) * W + x + CORNER_DX[k]);
  }
  for (const v of verts) {
    const vx = v % W;
    const vy = (v - vx) / W;
    // the up-to-four cells around the vertex, and which of their corners it is
    const around: Array<[number, number, number]> = [[vx - 1, vy - 1, 2], [vx, vy - 1, 3], [vx, vy, 0], [vx - 1, vy, 1]];
    for (const [cx, cy, k] of around) {
      if (!src.inside(cx, cy)) continue;
      const j = src.at(cx, cy);
      if (selected.has(j) || src.shape[j] === 0) continue;
      const h = cornersOf(src.shape[j], src.elev[j])![k];
      const was = known.get(v);
      known.set(v, was === undefined ? h : Math.min(was, h));
    }
  }
  if (known.size === 0) return { level, changed: false, notice: 'no ground around the selection to blend with' };
  // the rest: the mean of their neighbours, relaxed (a discrete Laplace solve)
  const mean = [...known.values()].reduce((a, b) => a + b, 0) / known.size;
  const value = new Map<number, number>();
  for (const v of verts) value.set(v, known.get(v) ?? mean);
  const free = [...verts].filter((v) => !known.has(v));
  for (let it = 0; it < 400 && free.length > 0; it++) {
    for (const v of free) {
      const vx = v % W;
      let sum = 0;
      let n = 0;
      for (const u of [v - 1, v + 1, v - W, v + W]) {
        if ((u === v - 1 && vx === 0) || (u === v + 1 && vx === W - 1)) continue;
        const h = value.get(u);
        if (h === undefined) continue;
        sum += h;
        n += 1;
      }
      if (n > 0) value.set(v, sum / n);
    }
  }
  const ctx = begin(level);
  let stuck = 0;
  for (const i of cells) {
    const x = i % src.w;
    const y = (i - x) / src.w;
    const c: Corners = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) c[k] = Math.round(value.get((y + CORNER_DY[k]) * W + x + CORNER_DX[k])!);
    const r = classify(c, { prev: src.shape[i] === 0 ? undefined : src.shape[i], diagonal: nearDiagonal(src, x, y) });
    if (r) setCell(ctx, i, r.shape, r.elev);
    else stuck += 1;
  }
  return done(level, ctx, stuck > 0 ? [`${stuck} cell${stuck > 1 ? 's' : ''} had no shape for their corners: left as they were`] : []);
}

/** Flat ground with its top at `top` steps (1-16) over the selection's solid cells. */
export function flatten(level: Level, sel: Selection, top: number): OpResult {
  const t = Math.max(1, Math.min(MAX_ELEV + 1, Math.round(top)));
  const ctx = begin(level);
  for (const i of cellsOf(level.grid, sel)) if (level.grid.shape[i] !== 0) setCell(ctx, i, 0x01, t - 1);
  return done(level, ctx);
}

/** Gaps where the selection is: no ground, marking or walls. */
export function dig(level: Level, sel: Selection): OpResult {
  const ctx = begin(level);
  for (const i of cellsOf(level.grid, sel)) setCell(ctx, i, 0, 0);
  return done(level, ctx);
}

/**
 * Flat ground over the selection's gaps, level with the highest edge of the
 * ground beside the selection (1 step high when there is none).
 */
export function fill(level: Level, sel: Selection): OpResult {
  const src = level.grid;
  const gaps = cellsOf(src, sel).filter((i) => src.shape[i] === 0);
  if (gaps.length === 0) return { level, changed: false, notice: 'select some gaps first' };
  const inSel = new Set(gaps);
  let top = 0;
  for (const i of gaps) {
    const x = i % src.w;
    const y = (i - x) / src.w;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!src.solid(nx, ny) || inSel.has(src.at(nx, ny))) continue;
      const j = src.at(nx, ny);
      const c = cornersOf(src.shape[j], src.elev[j])!;
      // the neighbour's two corners on the shared edge (its side opposite d)
      const side = (d + 2) & 3;
      top = Math.max(top, c[side], c[(side + 1) & 3]);
    }
  }
  const ctx = begin(level);
  for (const i of gaps) setCell(ctx, i, 0x01, Math.max(1, top) - 1);
  return done(level, ctx);
}

/** The shape brush: any of the 28 shapes at an elevation (shape 0 digs). */
export function setShape(level: Level, sel: Selection, shape: number, elev: number): OpResult {
  if (!Number.isInteger(shape) || shape < 0 || shape > 0x1b) return { level, changed: false, notice: 'shapes are $00-$1B' };
  const e = Math.max(0, Math.min(MAX_ELEV, Math.round(elev)));
  const ctx = begin(level);
  for (const i of cellsOf(level.grid, sel)) setCell(ctx, i, shape, e);
  return done(level, ctx);
}

/**
 * Paint a palette code (palette.ts; WATER takes the cell's shape) over the
 * selection. The tee moves (there is one); enemies stop at 16; a cell the
 * code may not stand on is skipped, and the notice says why.
 */
export function paintTile(level: Level, sel: Selection, code: number): OpResult {
  const ctx = begin(level);
  const g = ctx.g;
  let cells = cellsOf(g, sel);
  if (code === TEE_TILE && cells.length > 0) {
    cells = [cells[cells.length - 1]];
    const target = cells[0];
    if (placementError(code, g.shape[target]) === null) {
      for (let i = 0; i < g.w * g.h; i++) if (g.tile[i] === TEE_TILE && i !== target) g.tile[i] = 0;
    }
  }
  let enemies = 0;
  for (let i = 0; i < g.w * g.h; i++) if (isEnemyTile(g.tile[i])) enemies += 1;
  const refused = new Map<string, number>();
  const refuse = (why: string): void => {
    refused.set(why, (refused.get(why) ?? 0) + 1);
  };
  for (const i of cells) {
    const why = placementError(code, g.shape[i]);
    if (why) {
      refuse(why);
      continue;
    }
    const b = paintByte(code, g.shape[i]);
    if (b === null) continue;
    if (isEnemyTile(b) && !isEnemyTile(g.tile[i])) {
      if (enemies >= ENEMY_LIST_MAX) {
        refuse(`at most ${ENEMY_LIST_MAX} enemies (the enemy list $69DE)`);
        continue;
      }
      enemies += 1;
    } else if (!isEnemyTile(b) && isEnemyTile(g.tile[i])) {
      enemies -= 1;
    }
    g.tile[i] = b;
  }
  const notices = [...refused].map(([why, n]) => (n > 1 ? `${why} (${n} cells)` : why));
  return done(level, ctx, notices);
}

/** Clear the selection's markings and actors. */
export function eraseTile(level: Level, sel: Selection): OpResult {
  const ctx = begin(level);
  for (const i of cellsOf(level.grid, sel)) ctx.g.tile[i] = 0;
  return done(level, ctx);
}

/**
 * Toggle the wall on the edge of (x, y) toward d. Walls are one-sided (the
 * kernel tests the bit of the cell being left, sim/edges.ts), so an edge
 * between two solid cells gets both cells' bits; an edge on a gap or the
 * border, the solid side's.
 */
export function toggleWall(level: Level, x: number, y: number, d: number): OpResult {
  const src = level.grid;
  const nx = x + DX[d & 3];
  const ny = y + DY[d & 3];
  const a = src.solid(x, y) ? src.at(x, y) : -1;
  const b = src.solid(nx, ny) ? src.at(nx, ny) : -1;
  const da = 1 << (d & 3);
  const db = 1 << ((d + 2) & 3);
  if (a < 0 && b < 0) return { level, changed: false, notice: 'no ground on either side' };
  const on = (a >= 0 && (src.walls[a] & da) !== 0) || (b >= 0 && (src.walls[b] & db) !== 0);
  const ctx = begin(level);
  const g = ctx.g;
  if (a >= 0) g.walls[a] = on ? g.walls[a] & ~da : g.walls[a] | da;
  if (b >= 0) g.walls[b] = on ? g.walls[b] & ~db : g.walls[b] | db;
  return done(level, ctx);
}

/** Walls on every edge of the ground that faces a gap or the border (HoleGrid.fence). */
export function autoFence(level: Level): OpResult {
  const ctx = begin(level);
  ctx.g.fence();
  return done(level, ctx);
}

export function clearWalls(level: Level): OpResult {
  const ctx = begin(level);
  ctx.g.walls.fill(0);
  return done(level, ctx);
}

/**
 * Grow (positive) or shrink (negative) the grid on each side, within
 * MIN_SIDE-MAX_SIDE cells a side; new cells are gaps.
 */
export function resize(level: Level, by: { n?: number; e?: number; s?: number; w?: number }): OpResult {
  const src = level.grid;
  const n = by.n ?? 0, e = by.e ?? 0, s = by.s ?? 0, w = by.w ?? 0;
  const W = src.w + w + e;
  const H = src.h + n + s;
  if (W < MIN_SIDE || H < MIN_SIDE || W > MAX_SIDE || H > MAX_SIDE) {
    return { level, changed: false, notice: `a side is ${MIN_SIDE}-${MAX_SIDE} cells` };
  }
  const g = new HoleGrid(W, H);
  for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
    const nx = x + w;
    const ny = y + n;
    if (!g.inside(nx, ny)) continue;
    const i = src.at(x, y);
    const j = g.at(nx, ny);
    g.shape[j] = src.shape[i];
    g.elev[j] = src.elev[i];
    g.walls[j] = src.walls[i];
    g.tile[j] = src.tile[i];
  }
  return done(level, { g, removed: 0 });
}

/** Cut the grid to its ground's bounding box (at least MIN_SIDE a side). */
export function cropToContent(level: Level): OpResult {
  const b = level.grid.bounds();
  if (!b) return { level, changed: false, notice: 'there is no ground' };
  const g = level.grid;
  const grow = (lo: number, hi: number, max: number): [number, number] => {
    while (hi - lo + 1 < MIN_SIDE) {
      if (hi < max - 1) hi += 1;
      else lo -= 1;
    }
    return [lo, hi];
  };
  const [x0, x1] = grow(b.x0, b.x1, g.w);
  const [y0, y1] = grow(b.y0, b.y1, g.h);
  return resize(level, { w: -x0, n: -y0, e: x1 - (g.w - 1), s: y1 - (g.h - 1) });
}

/** Paint the water over the selection (the palette's WATER; a shortcut the tests use). */
export function flood(level: Level, sel: Selection): OpResult {
  return paintTile(level, sel, WATER);
}
