/**
 * The terrain shapes as corner heights: the level editor's model
 * (docs/editor.md "The corner model").
 *
 * Every solid shape is four corner heights above the cell's elevation,
 * (NW, NE, SE, SW), in whole steps. Each edge's level in $81:9310's table
 * (`terrainEdge`, half steps) is the sum of its two corners: N = NW + NE,
 * E = NE + SE, S = SE + SW, W = SW + NW. All 27 solid shapes agree with the
 * ROM's table (measured on tables.json, 2026-11-16; test/level-corners.test.ts).
 * So two cells meet flush when they share both corners of their common edge,
 * and the absolute corner heights (elevation + corner) of a hole are a
 * height field on the grid's vertices, broken where there is a step.
 *
 * The mound $02 and the dimple $03 are flat cells with a bump or a dip in
 * the middle (their corners: 0000 and 1111); the faceted corners $08-$0F
 * and the diagonal ones $10-$17 have the same corners and differ only inside
 * the cell (docs/terrain.md). `classify` keeps either choice a cell had.
 */

/** Corner heights NW, NE, SE, SW. */
export type Corners = [number, number, number, number];

export const NW = 0;
export const NE = 1;
export const SE = 2;
export const SW = 3;

/** The vertex offsets of the corners NW, NE, SE, SW from the cell's (x, y). */
export const CORNER_DX = [0, 1, 1, 0] as const;
export const CORNER_DY = [0, 0, 1, 1] as const;

/** One rotation step: the shape families' r + 1 ((NW, NE, SE, SW) -> (SW, NW, NE, SE)). */
export function rotate(c: Corners): Corners {
  return [c[3], c[0], c[1], c[2]];
}

const FAMILY_BASE: ReadonlyArray<[number, Corners]> = [
  [0x04, [0, 0, 1, 1]], // cardinal ramp falling N, E, S, W
  [0x08, [1, 0, 1, 1]], // three corners up, falling NE, SE, SW, NW
  [0x0c, [0, 0, 0, 1]], // one corner up
  [0x10, [1, 0, 1, 1]], // $08-$0B as true diagonals
  [0x14, [0, 0, 0, 1]], // $0C-$0F as true diagonals
  [0x18, [1, 0, 1, 2]], // the full diagonal ramp
];

/** The corners of each shape above its elevation; null for the gap. */
const SHAPE_CORNERS: ReadonlyArray<Corners | null> = (() => {
  const t: Array<Corners | null> = new Array(0x1c).fill(null);
  t[0x01] = [1, 1, 1, 1];
  t[0x02] = [0, 0, 0, 0];
  t[0x03] = [1, 1, 1, 1];
  for (const [base, c0] of FAMILY_BASE) {
    let c = c0;
    for (let r = 0; r < 4; r++) {
      t[base + r] = c;
      c = rotate(c);
    }
  }
  return t;
})();

/** Pattern (corners minus their least) -> the shape of the faceted/plain family. */
const PATTERNS: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (const s of [0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x18, 0x19, 0x1a, 0x1b]) {
    m.set(SHAPE_CORNERS[s]!.join(','), s);
  }
  return m;
})();

/** The shape's corners above its elevation (null: the gap, or not a shape). */
export function shapeCorners(shape: number): Corners | null {
  const c = SHAPE_CORNERS[shape];
  return c ? [c[0], c[1], c[2], c[3]] : null;
}

/** The cell's absolute corner heights, in steps (null: a gap). */
export function cornersOf(shape: number, elev: number): Corners | null {
  const c = shapeCorners(shape);
  return c ? [c[0] + elev, c[1] + elev, c[2] + elev, c[3] + elev] : null;
}

/** The highest elevation byte (layer 3 holds $00-$0F). */
export const MAX_ELEV = 0x0f;

export interface Classified {
  shape: number;
  elev: number;
}

export interface ClassifyHints {
  /** The cell's shape before the change: keeps a mound, a dimple or a diagonal corner. */
  prev?: number;
  /** A new corner cell takes the diagonal family ($10-$17) instead of the faceted one. */
  diagonal?: boolean;
}

/**
 * The shape and elevation whose corners are these (absolute heights), or
 * null when no shape has them: a saddle, a jump of two along an edge, or an
 * elevation outside $00-$0F (a flat top is at least 1 step high).
 */
export function classify(c: Corners, hints: ClassifyHints = {}): Classified | null {
  const m = Math.min(c[0], c[1], c[2], c[3]);
  const key = `${c[0] - m},${c[1] - m},${c[2] - m},${c[3] - m}`;
  const ok = (shape: number, elev: number): Classified | null =>
    elev >= 0 && elev <= MAX_ELEV ? { shape, elev } : null;
  if (key === '0,0,0,0') {
    if (hints.prev === 0x02) return ok(0x02, m);
    if (hints.prev === 0x03) return ok(0x03, m - 1);
    return ok(0x01, m - 1);
  }
  const s = PATTERNS.get(key);
  if (s === undefined) return null;
  if (s >= 0x08 && s <= 0x0f) {
    const prevDiagonal = hints.prev !== undefined && hints.prev >= 0x10 && hints.prev <= 0x17;
    const prevFaceted = hints.prev !== undefined && hints.prev >= 0x08 && hints.prev <= 0x0f;
    if (prevDiagonal || (!prevFaceted && hints.diagonal)) return ok(s + 8, m);
  }
  return ok(s, m);
}

/** The highest corner of a cell: the top a flat cell at that height would have. */
export function topOf(shape: number, elev: number): number | null {
  const c = cornersOf(shape, elev);
  return c ? Math.max(c[0], c[1], c[2], c[3]) : null;
}

/** A cardinal ramp's fall direction (0-3 = N E S W), or -1. */
export function rampFall(shape: number): number {
  return shape >= 0x04 && shape <= 0x07 ? shape - 0x04 : -1;
}
