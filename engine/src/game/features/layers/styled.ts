/**
 * The terrain of a hole without bitmaps (the random holes, the test holes),
 * drawn with the ROM's own course art (plans/random_holes.md "Game-styled
 * renderer"). tools/terrain_style.py cut exemplar patches from the 92 plain
 * ROM geometries: per terrain shape the commonest colour of every pixel of a
 * cell's surface (93-100 % of the instances agree), per floor marking the
 * same, and the two step faces the camera sees. This software rasteriser
 * paints a course from them, back to front by x - y like procedural.ts:
 *
 * - each cell's four quadrant triangles (the ones $81:9479 tests), their
 *   corners at core's surfaceZ and projected like everything else
 *   (docs/web-demo.md: x = 32 (x + y), y = originY + 16 (x - y) - 16 Z /
 *   $5A82), filled from its shape's patch, or its marking's, at the same
 *   offset from the cell's left vertex; the art sits on the 8x8 tile grid,
 *   so the offset is all a patch needs;
 * - each E (+x) and N (-y) side that stands above its neighbour (or a gap,
 *   down to Z 0) from the face patches: the first step under the edge, the
 *   last step over the bottom, the middle ones between;
 * - the layer-4 walls as the ROM draws them: a line two pixels thick along
 *   the edge in the play area's outline colour (MAP13's rim, measured
 *   2026-11-15), into a separate white mask that the view tints with the
 *   outline walk, as for the ROM holes' layer_outline.
 *
 * A shape without a patch (the dimple $03: no ROM course has one) takes the
 * flat patch, shaded by its slope. Pure: no Phaser, node-tested.
 */
import type { RomRules } from '../../../core/rules';
import { surfaceZ } from '../../../core/terrain';

export interface StyleRect {
  x: number;
  y: number;
  w: number;
  h: number;
  n?: number;
  agree?: number;
}

/** tools/terrain_style.py's terrain_style.json. */
export interface TerrainStyleJson {
  about?: string;
  top: Record<string, StyleRect>;
  mark: Record<string, StyleRect>;
  face: Record<string, StyleRect>;
}

export interface TerrainStyle {
  json: TerrainStyleJson;
  /** terrain_style.png's RGBA pixels. */
  atlas: { data: Uint8ClampedArray; width: number; height: number };
}

export interface StyledCourse {
  w: number;
  h: number;
  shape: ArrayLike<number>;
  elev: ArrayLike<number>;
  walls: ArrayLike<number>;
  layer2: ArrayLike<number>;
  originY: number;
}

export interface TerrainRaster {
  width: number;
  height: number;
  /** The course-bitmap position of pixel (0, 0). */
  x0: number;
  y0: number;
  /** RGBA. */
  pixels: Uint8ClampedArray;
  /** RGBA, white where the walls are drawn (tinted by the outline walk). */
  outline: Uint8ClampedArray;
}

type Pt = [number, number];

/** The four quadrant triangles' outer corners, N E S W (procedural.ts). */
const QUADS: Array<[Pt, Pt]> = [
  [[0, 0], [1, 0]],
  [[1, 0], [1, 1]],
  [[1, 1], [0, 1]],
  [[0, 1], [0, 0]],
];
/** The cell edges N E S W, as the walls' bits number them. */
const EDGES: Array<[Pt, Pt]> = [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]]];
const STEP_PX = 16;
/** The offsets sampleNear tries, nearest first. */
const NEAR: Array<[number, number]> = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
const FACE_BROWN: [number, number, number] = [0x8a, 0x6a, 0x40];

const hex2 = (v: number): string => v.toString(16).toUpperCase().padStart(2, '0');

export function rasterTerrain(rules: RomRules, c: StyledCourse, style: TerrainStyle): TerrainRaster {
  const zUnit = rules.zUnit;
  const at = (x: number, y: number): number => y * c.w + x;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < c.w && y < c.h;
  const solid = (x: number, y: number): boolean => inside(x, y) && (c.shape[at(x, y)] & 0xff) !== 0;

  // the raster's extent: every cell from its highest possible top to Z 0 under it
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) {
    if (!solid(x, y)) continue;
    const e = c.elev[at(x, y)] & 0xff;
    minX = Math.min(minX, 32 * (x + y));
    maxX = Math.max(maxX, 32 * (x + y) + 64);
    minY = Math.min(minY, c.originY + 16 * (x - y) - 16 * (e + 3) - 16);
    maxY = Math.max(maxY, c.originY + 16 * (x + 1 - y) + 16);
  }
  if (minX === Infinity) {
    minX = 0; minY = 0; maxX = 1; maxY = 1;
  }
  const x0 = Math.floor(minX) - 2;
  const y0 = Math.floor(minY) - 2;
  const width = Math.ceil(maxX) - x0 + 2;
  const height = Math.ceil(maxY) - y0 + 2;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const outline = new Uint8ClampedArray(width * height * 4);

  const atlas = style.atlas;
  const sample = (r: StyleRect, u: number, v: number): number => {
    if (u < 0 || v < 0 || u >= r.w || v >= r.h) return -1;
    const k = ((r.y + v) * atlas.width + (r.x + u)) * 4;
    if (atlas.data[k + 3] === 0) return -1;
    return k;
  };
  /** The patch's pixel, or the nearest opaque one within 2 px (the patches' rims). */
  const sampleNear = (r: StyleRect, u: number, v: number): number => {
    for (const [du, dv] of NEAR) {
      const k = sample(r, u + du, v + dv);
      if (k >= 0) return k;
    }
    return -1;
  };
  const paint = (X: number, Y: number, r: number, g: number, b: number): void => {
    const px = X - x0;
    const py = Y - y0;
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const k = (py * width + px) * 4;
    pixels[k] = r; pixels[k + 1] = g; pixels[k + 2] = b; pixels[k + 3] = 255;
    outline[k + 3] = 0; // whatever is painted later hides a wall line under it
  };
  const paintAtlas = (X: number, Y: number, k: number, shade = 1): void => {
    const d = atlas.data;
    paint(X, Y, d[k] * shade, d[k + 1] * shade, d[k + 2] * shade);
  };
  const mark = (X: number, Y: number): void => {
    const px = X - x0;
    const py = Y - y0;
    if (px < 0 || py < 0 || px >= width || py >= height) return;
    const k = (py * width + px) * 4;
    outline[k] = 255; outline[k + 1] = 255; outline[k + 2] = 255; outline[k + 3] = 255;
  };

  /** Z at a point of cell (x, y) in fractions, sampled a hair toward `toward` (inside its plane). */
  const zAt = (x: number, y: number, p: Pt, toward: Pt = [0.5, 0.5]): number => {
    const i = at(x, y);
    const fx = p[0] + (toward[0] - p[0]) * 0.02;
    const fy = p[1] + (toward[1] - p[1]) * 0.02;
    const xf = Math.max(0, Math.min(0xffff, Math.round(fx * 0x10000)));
    const yf = Math.max(0, Math.min(0xffff, Math.round(fy * 0x10000)));
    return surfaceZ(rules, c.shape[i] & 0xff, c.elev[i] & 0xff, xf, yf);
  };
  const proj = (x: number, y: number, p: Pt, z: number): Pt => [
    32 * (x + p[0] + y + p[1]),
    c.originY + 16 * (x + p[0] - (y + p[1])) - (16 * z) / zUnit,
  ];

  const flat = style.json.top['01'];
  const faceE = { top: style.json.face.E_top, mid: style.json.face.E_mid, bottom: style.json.face.E_bottom };
  const faceN = { top: style.json.face.N_top, mid: style.json.face.N_mid, bottom: style.json.face.N_bottom };

  const cells: Array<[number, number]> = [];
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (solid(x, y)) cells.push([x, y]);
  cells.sort((a, b) => a[0] - a[1] - (b[0] - b[1]) || a[0] + a[1] - (b[0] + b[1]));

  for (const [x, y] of cells) {
    const i = at(x, y);
    const shape = c.shape[i] & 0xff;
    const e = c.elev[i] & 0xff;
    const tile = c.layer2[i] & 0xff;
    const patch = style.json.mark[`${hex2(tile)}_${hex2(shape)}`] ?? style.json.top[hex2(shape)] ?? null;
    // the patch's anchor: the cell's left vertex at its flat top, at (0, 32)
    const ax = 32 * (x + y);
    const ay = c.originY + 16 * (x - y) - 16 * (e + 1) - 32;

    // the top: the four quadrant planes
    for (let q = 0; q < 4; q++) {
      const [a, b] = QUADS[q];
      const mid: Pt = [(a[0] + b[0] + 0.5) / 3, (a[1] + b[1] + 0.5) / 3];
      const za = zAt(x, y, a, mid);
      const zb = zAt(x, y, b, mid);
      const zc = zAt(x, y, [0.5, 0.5], mid);
      const shade = patch ? 1 : slopeShade(q, za, zb, zc, zUnit);
      fillTriangle(proj(x, y, a, za), proj(x, y, b, zb), proj(x, y, [0.5, 0.5], zc), (X, Y) => {
        const k = (patch ? sampleNear(patch, X - ax, Y - ay) : -1);
        if (k >= 0) return paintAtlas(X, Y, k);
        const f = flat ? sampleNear(flat, X - ax, Y - ay) : -1;
        if (f >= 0) return paintAtlas(X, Y, f, shade);
        paint(X, Y, 0x48 * shade, 0xa8 * shade, 0x48 * shade);
      });
    }

    // the sides the camera sees: E (+x) and N (-y)
    const sides = [
      { a: [1, 0] as Pt, b: [1, 1] as Pt, nx: x + 1, ny: y, na: [0, 0] as Pt, nb: [0, 1] as Pt, tex: faceE, e: true },
      { a: [0, 0] as Pt, b: [1, 0] as Pt, nx: x, ny: y - 1, na: [0, 1] as Pt, nb: [1, 1] as Pt, tex: faceN, e: false },
    ];
    for (const s of sides) {
      const za = zAt(x, y, s.a);
      const zb = zAt(x, y, s.b);
      const gap = !solid(s.nx, s.ny);
      const da = gap ? 0 : zAt(s.nx, s.ny, s.na);
      const db = gap ? 0 : zAt(s.nx, s.ny, s.nb);
      if (za - da < zUnit / 8 && zb - db < zUnit / 8) continue;
      const p1 = proj(x, y, s.a, za);
      const p2 = proj(x, y, s.b, zb);
      const p3 = proj(x, y, s.b, Math.min(zb, db));
      const p4 = proj(x, y, s.a, Math.min(za, da));
      const left = Math.round(p1[0]);
      const face = (X: number, Y: number): void => {
        const u = X - left;
        const t = (u + 0.5) / 32;
        const top = p1[1] + (p2[1] - p1[1]) * t;
        const bottom = p4[1] + (p3[1] - p4[1]) * t;
        const v = Y + 0.5 - top;
        const up = bottom - (Y + 0.5);
        let r: StyleRect | undefined;
        let vv: number;
        if (v < STEP_PX) {
          r = s.tex.top; vv = v;
        } else if (up <= STEP_PX) {
          r = s.tex.bottom ?? s.tex.mid; vv = STEP_PX - up;
        } else {
          r = s.tex.mid ?? s.tex.top; vv = v % STEP_PX;
        }
        // the patch's own edge row at this column (terrain_style.py face_mask)
        const edge = s.e ? 16 - (u >> 1) : u >> 1;
        let k = r ? sample(r, u, edge + Math.floor(vv)) : -1;
        if (k < 0 && r) k = sample(r, u, edge + Math.floor(vv) + (vv < 8 ? 1 : -1));
        if (k >= 0) return paintAtlas(X, Y, k);
        const kk = s.e ? 0.62 : 0.78;
        paint(X, Y, FACE_BROWN[0] * kk, FACE_BROWN[1] * kk, FACE_BROWN[2] * kk);
      };
      fillTriangle(p1, p2, p3, face);
      fillTriangle(p1, p3, p4, face);
    }

    // the walls ($80:8815 bits N E S W): the outline-coloured rim line
    const walls = c.walls[i] & 0x0f;
    for (let d = 0; d < 4; d++) {
      if ((walls & (1 << d)) === 0) continue;
      const [a, b] = EDGES[d];
      const pa = proj(x, y, a, zAt(x, y, a));
      const pb = proj(x, y, b, zAt(x, y, b));
      const [l, r] = pa[0] <= pb[0] ? [pa, pb] : [pb, pa];
      for (let X = Math.round(l[0]); X < Math.round(r[0]); X++) {
        const t = (X + 0.5 - l[0]) / (r[0] - l[0]);
        const ey = Math.floor(l[1] + (r[1] - l[1]) * t);
        mark(X, ey);
        mark(X, ey + 1);
      }
    }
  }
  return { width, height, x0, y0, pixels, outline };
}

/** A quadrant's light, as procedural.ts shades it: lit from up the screen. */
function slopeShade(q: number, za: number, zb: number, zc: number, step: number): number {
  const dx = q === 0 || q === 2 ? (q === 0 ? zb - za : za - zb) : 0;
  const dy = q === 1 || q === 3 ? (q === 1 ? zb - za : za - zb) : 0;
  const tilt = (zc - (za + zb) / 2) / step;
  const lit = 1 + ((dy - dx) / step) * 0.25 + (q === 0 || q === 3 ? tilt : -tilt) * 0.12;
  return Math.max(0.55, Math.min(1.35, lit));
}

/**
 * Every pixel whose centre is inside the triangle (edges included), in
 * course-bitmap pixels.
 */
function fillTriangle(a: Pt, b: Pt, c: Pt, put: (X: number, Y: number) => void): void {
  const minX = Math.floor(Math.min(a[0], b[0], c[0]));
  const maxX = Math.ceil(Math.max(a[0], b[0], c[0]));
  const minY = Math.floor(Math.min(a[1], b[1], c[1]));
  const maxY = Math.ceil(Math.max(a[1], b[1], c[1]));
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-9) return;
  const s = area > 0 ? 1 : -1;
  const eps = 1e-6;
  for (let Y = minY; Y < maxY; Y++) {
    const py = Y + 0.5;
    for (let X = minX; X < maxX; X++) {
      const px = X + 0.5;
      const w0 = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) * s;
      const w1 = ((c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0])) * s;
      const w2 = ((a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0])) * s;
      if (w0 >= -eps && w1 >= -eps && w2 >= -eps) put(X, Y);
    }
  }
}
