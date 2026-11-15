/**
 * The terrain drawn from the course grid, for the authored test courses
 * (they have no bitmaps) and as the debug view over a ROM hole (?debug,
 * key D). Each cell is its four triangles (the quadrants $81:9479 tests,
 * core terrain.ts `quadrant`), each a plane whose corners come from
 * core's surfaceZ, projected like everything else; the faces a step shows
 * the camera (+x and -y: they face down the screen) go down to the
 * neighbour's surface. Cells are painted back to front by x - y. Shading
 * is by slope; the colour by the special-tile group of docs/tiles.md;
 * layer-4 walls and the outline tiles $28-$2D are lines on the surface; the
 * warps $B0-$B7 carry a tick toward the edge their arrow leaves by.
 * It is a picture of the data the physics runs on, not of the game's art.
 */
import Phaser from 'phaser';
import type { RomRules } from '../../../core/rules';
import type { CourseState } from '../../../core/traits/course';
import { surfaceZ } from '../../../core/terrain';
import { worldOf } from '../../bridge/placement';

type Pt = [number, number];

const GRASS = 0x48a848;

function tileColour(tile: number): number {
  if (tile === 0x04) return 0x2f7a2f; // rough
  if (tile === 0x05) return 0xa05030;
  if (tile === 0x08) return 0x205020; // the cup's tile, once revealed
  if (tile === 0x0c) return 0x98d898; // the tee
  if (tile >= 0x10 && tile <= 0x13) return 0xa060d0; // kickers
  if (tile >= 0x14 && tile <= 0x17) return 0xe8e040; // arrow panels
  if (tile >= 0x18 && tile <= 0x1b) return 0x40c0d0; // snaps
  if (tile >= 0x20 && tile <= 0x24) return 0xd8c078; // friction
  if (tile >= 0x30 && tile <= 0x3b) return 0xe89030; // boost panels
  if ((tile >= 0x80 && tile <= 0xa2) || (tile >= 0xac && tile <= 0xae)) return 0xc04848; // hazards
  if (tile >= 0xb0 && tile <= 0xb9) return 0x7050e0; // warps
  return GRASS;
}

function shade(colour: number, k: number): number {
  const f = (c: number): number => Math.max(0, Math.min(255, Math.round(c * k)));
  return (f((colour >> 16) & 255) << 16) | (f((colour >> 8) & 255) << 8) | f(colour & 255);
}

/** The four quadrant triangles' outer corners, in cell fractions (N E S W = q0..q3). */
const QUADS: Array<[Pt, Pt]> = [
  [[0, 0], [1, 0]],
  [[1, 0], [1, 1]],
  [[1, 1], [0, 1]],
  [[0, 1], [0, 0]],
];

/** The outline tiles' lines through the cell (docs/web-demo.md "Newly established"). */
const OUTLINE: Record<number, [Pt, Pt]> = {
  0x28: [[0.5, 0], [0.5, 1]],
  0x29: [[0, 0.5], [1, 0.5]],
  0x2a: [[0.5, 0], [0, 0.5]],
  0x2b: [[0, 0.5], [0.5, 1]],
  0x2c: [[1, 0.5], [0.5, 1]],
  0x2d: [[0.5, 0], [1, 0.5]],
};

/** The warps' exit arrow tips, N E S W (cell fractions). */
const WARP_TIP: Pt[] = [[0.5, 0.15], [0.85, 0.5], [0.5, 0.85], [0.15, 0.5]];

export function drawTerrain(scene: Phaser.Scene, rules: RomRules, c: CourseState): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics();
  const at = (x: number, y: number): number => y * c.w + x;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < c.w && y < c.h;
  /** Z at a point of cell (x, y) given in fractions, sampled a little toward `toward` (inside the plane). */
  const z = (x: number, y: number, p: Pt, toward: Pt = [0.5, 0.5]): number => {
    if (!inside(x, y)) return 0;
    const i = at(x, y);
    const fx = p[0] + (toward[0] - p[0]) * 0.02;
    const fy = p[1] + (toward[1] - p[1]) * 0.02;
    const xf = Math.max(0, Math.min(0xffff, Math.round(fx * 0x10000)));
    const yf = Math.max(0, Math.min(0xffff, Math.round(fy * 0x10000)));
    return surfaceZ(rules, c.shape[i], c.elev[i], xf, yf);
  };
  const proj = (x: number, y: number, p: Pt, zz: number): Pt => {
    const px = x + p[0];
    const py = y + p[1];
    const xc = Math.floor(px);
    const yc = Math.floor(py);
    const w = worldOf(c, xc, Math.round((px - xc) * 0x10000) & 0xffff, yc, Math.round((py - yc) * 0x10000) & 0xffff, zz);
    return [w.x, w.y];
  };
  const step = rules.zUnit;
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) cells.push([x, y]);
  cells.sort((a, b) => a[0] - a[1] - (b[0] - b[1]) || a[0] + a[1] - (b[0] + b[1]));

  for (const [x, y] of cells) {
    const i = at(x, y);
    if (c.shape[i] === 0) continue; // a gap
    const base = shade(tileColour(c.layer2[i]), 1 + Math.min(8, c.elev[i]) * 0.04);
    for (let q = 0; q < 4; q++) {
      const [a, b] = QUADS[q];
      const mid: Pt = [(a[0] + b[0] + 0.5) / 3, (a[1] + b[1] + 0.5) / 3];
      const za = z(x, y, a, mid);
      const zb = z(x, y, b, mid);
      const zc = z(x, y, [0.5, 0.5], mid);
      // light from up the screen (-x, +y): a surface rising that way is lit
      const dx = q === 0 || q === 2 ? (q === 0 ? zb - za : za - zb) : 0;
      const dy = q === 1 || q === 3 ? (q === 1 ? zb - za : za - zb) : 0;
      const tilt = (zc - (za + zb) / 2) / step;
      const lit = 1 + (dy - dx) / step * 0.25 + (q === 0 || q === 3 ? tilt : -tilt) * 0.12;
      g.fillStyle(shade(base, Math.max(0.55, Math.min(1.35, lit))), 1);
      const pa = proj(x, y, a, za);
      const pb = proj(x, y, b, zb);
      const pc = proj(x, y, [0.5, 0.5], zc);
      g.fillTriangle(pa[0], pa[1], pb[0], pb[1], pc[0], pc[1]);
    }
    // the faces toward the camera: east (+x) and north (-y)
    const faces: Array<{ a: Pt; b: Pt; nx: number; ny: number; na: Pt; nb: Pt; k: number }> = [
      { a: [1, 0], b: [1, 1], nx: x + 1, ny: y, na: [0, 0], nb: [0, 1], k: 0.62 },
      { a: [0, 0], b: [1, 0], nx: x, ny: y - 1, na: [0, 1], nb: [1, 1], k: 0.78 },
    ];
    for (const f of faces) {
      const za = z(x, y, f.a);
      const zb = z(x, y, f.b);
      const gap = !inside(f.nx, f.ny) || c.shape[at(f.nx, f.ny)] === 0;
      const da = gap ? 0 : z(f.nx, f.ny, f.na);
      const db = gap ? 0 : z(f.nx, f.ny, f.nb);
      if (za - da < step / 8 && zb - db < step / 8) continue;
      const p1 = proj(x, y, f.a, za);
      const p2 = proj(x, y, f.b, zb);
      const p3 = proj(x, y, f.b, Math.min(zb, db));
      const p4 = proj(x, y, f.a, Math.min(za, da));
      g.fillStyle(shade(0x8a6a40, f.k), 1);
      g.fillPoints([p1, p2, p3, p4].map(([px, py]) => new Phaser.Math.Vector2(px, py)), true);
    }
    // layer-4 walls (bits N E S W) and the outline tiles
    g.lineStyle(1, 0xf0f0f0, 1);
    const edges: Array<[Pt, Pt]> = [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]]];
    for (let d = 0; d < 4; d++) {
      if ((c.walls[i] & (1 << d)) === 0) continue;
      const [a, b] = edges[d];
      const pa = proj(x, y, a, z(x, y, a) + step / 4);
      const pb = proj(x, y, b, z(x, y, b) + step / 4);
      g.lineBetween(pa[0], pa[1], pb[0], pb[1]);
    }
    const line = OUTLINE[c.layer2[i]];
    if (line) {
      const [a, b] = line;
      const pa = proj(x, y, a, z(x, y, a));
      const pb = proj(x, y, b, z(x, y, b));
      g.lineStyle(2, 0xffffff, 1).lineBetween(pa[0], pa[1], pb[0], pb[1]);
    }
    const warp = c.layer2[i];
    if (warp >= 0xb0 && warp <= 0xb7) {
      // the exit arrow ($82:ECFC: N E S W = -y +x +y -x)
      const tip = WARP_TIP[(warp - 0xb0) & 3];
      const pa = proj(x, y, [0.5, 0.5], z(x, y, [0.5, 0.5]));
      const pb = proj(x, y, tip, z(x, y, tip));
      g.lineStyle(2, 0xffffff, 1).lineBetween(pa[0], pa[1], pb[0], pb[1]);
    }
  }
  return g;
}
