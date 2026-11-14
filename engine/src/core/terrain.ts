/**
 * The playfield surface, ported from sub_terrain_probe $81:9479 and the
 * step routine $81:925E, over the same ROM tables (docs/terrain.md;
 * tools/terrain.py is the reference implementation and the golden fixture's
 * generator). Pure functions; the grid lookup is the caller's.
 *
 * Fractions xf/yf are the 16-bit sub-cell positions ($D9F0/$D9F4). Heights
 * are 32-bit world Z: one elevation step is rules.zUnit ($5A82).
 */
import type { RomRules } from './rules';

/** Direction order of the edge and quadrant tables: N E S W = 0 1 2 3. */
export const DIR = { N: 0, E: 1, S: 2, W: 3 } as const;

/** The opposite edge ($81:9001: EOR #$0002). */
export function oppositeDir(dir: number): number {
  return dir ^ 2;
}

/** Which of the cell's four triangles a point is in ($81:9479). */
export function quadrant(xf: number, yf: number): number {
  if (xf + yf >= 0x10000) return xf >= yf ? 1 : 2;
  return xf >= yf ? 0 : 3;
}

/** Z of a cell's base at elevation h ($88:8000/$88:80C8). */
export function baseZ(rules: RomRules, elev: number): number {
  return rules.heightZ(elev);
}

/**
 * The ground's world Z at a sub-cell position, as $81:9479 computes it.
 * shape/elev are the cell's layer-1 and layer-3 bytes. A gap (shape 0) has
 * ground Z 0 and stops nothing ($81:94DA).
 */
export function surfaceZ(rules: RomRules, shape: number, elev: number, xf: number, yf: number): number {
  if (shape === 0) return 0;
  const q = quadrant(xf, yf);
  const base = baseZ(rules, elev);
  if (shape & 0x10) {
    // the diagonal families ($81:9573): a flat quadrant carries its offset
    // directly, a $FFFF marker falls through to the true-diagonal handlers
    const v = rules.terrainQuadDiag(shape, q);
    if (v !== 0xffff) return base + v;
    const code = rules.terrainQuad(shape, q);
    const acc =
      code === 5 ? (0xffff - xf) + yf :
      code === 6 ? (0xffff - xf) + (0xffff - yf) :
      code === 7 ? xf + (0xffff - yf) :
                   xf + yf; // code 8
    return base + rules.ramp((acc >> 7) & 0x3ff) - rules.terrainDiagBias(shape);
  }
  const code = rules.terrainQuad(shape, q);
  if (code === 0) return base + rules.zUnit; // flat, top of cell ($81:9534)
  const acc =
    code === 1 ? yf :
    code === 2 ? 0xffff - xf :
    code === 3 ? 0xffff - yf :
                 xf; // code 4
  return base + rules.ramp(acc >> 7);
}

/**
 * The surface level at one edge midpoint, in half height steps:
 * 2 x elevation + tbl_terrain_edge_h[shape*4 + dir] ($81:925E).
 */
export function edgeLevel(rules: RomRules, shape: number, elev: number, dir: number): number {
  return 2 * elev + rules.terrainEdge(shape, dir);
}

/**
 * The step across a shared edge, in half steps, as $81:9001/$81:925E
 * compute it: the level the next cell shows on its opposite side minus the
 * level the current cell shows on the motion side. Zero means the surfaces
 * meet flush; positive is a step up (blocked), negative a drop ($D9E4 is
 * set to the direction when it is nonzero).
 */
export function stepAcross(
  rules: RomRules,
  fromShape: number,
  fromElev: number,
  toShape: number,
  toElev: number,
  dir: number,
): number {
  return edgeLevel(rules, toShape, toElev, oppositeDir(dir)) - edgeLevel(rules, fromShape, fromElev, dir);
}
