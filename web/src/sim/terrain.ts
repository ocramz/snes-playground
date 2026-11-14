import type { CourseJson, Rom } from './tables';

/** What sub_terrain_probe ($81:9479) leaves in $D9FC-$DA0A. */
export interface Probe {
  col: number;
  row: number;
  idx: number; // $D9FC, row * width + col (-1 off the grid)
  shape: number; // $D9FE, 0 = no cell
  elev: number; // $DA00
  quad: number; // $DA02, 0-3 = N E S W
  code: number; // $DA04, surface code 0-8
  ground: number; // $DA08:$DA06, 16.16
  tile: number; // $DA0A, layer-2 byte
}

export const emptyProbe = (): Probe => ({
  col: 0, row: 0, idx: -1, shape: 0, elev: 0, quad: 0, code: 0, ground: 0, tile: 0,
});

export const copyProbe = (dst: Probe, src: Probe): void => {
  dst.col = src.col; dst.row = src.row; dst.idx = src.idx; dst.shape = src.shape;
  dst.elev = src.elev; dst.quad = src.quad; dst.code = src.code;
  dst.ground = src.ground; dst.tile = src.tile;
};

/** Quadrant of a point in a cell, $81:9479: 0 N, 1 E, 2 S, 3 W (N = -y). */
export function quadrant(xf: number, yf: number): number {
  if (xf + yf >= 0x10000) return xf >= yf ? 1 : 2;
  return xf >= yf ? 0 : 3;
}

export class Terrain {
  readonly w: number;
  readonly h: number;
  readonly shape: Uint8Array;
  readonly elev: Uint8Array;
  readonly walls: Uint8Array;
  /** Layer 2, mutable: the last enemy's cell becomes the cup ($08). */
  readonly tile: Uint8Array;

  constructor(readonly rom: Rom, course: CourseJson) {
    this.w = course.w;
    this.h = course.h;
    this.shape = Uint8Array.from(course.shape);
    this.elev = Uint8Array.from(course.elev);
    this.walls = Uint8Array.from(course.walls);
    this.tile = Uint8Array.from(course.tile);
  }

  inGrid(col: number, row: number): boolean {
    return col >= 0 && col < this.w && row >= 0 && row < this.h;
  }

  /** World Z of an elevation's base, Z(h) = h * $5A82 ($88:8000/$88:80C8). */
  baseZ(h: number): number {
    return this.rom.zHi[h] * 65536 + this.rom.zLo[h];
  }

  /**
   * Surface Z at a sub-cell position and its surface code, as
   * tools/terrain.py Tables.surface_z / $81:9479 do.
   */
  surface(shape: number, elev: number, quad: number, xf: number, yf: number): { z: number; code: number } {
    const rom = this.rom;
    const code = rom.quad[shape * 4 + quad];
    const base = this.baseZ(elev);
    if (shape & 0x10) {
      const v = rom.quadDiag[shape * 4 + quad];
      if (v !== 0xffff) return { z: base + v, code };
      let acc: number;
      switch (code) {
        case 5: acc = 0xffff - xf + yf; break;
        case 6: acc = 0xffff - xf + (0xffff - yf); break;
        case 7: acc = xf + (0xffff - yf); break;
        default: acc = xf + yf; break;
      }
      return { z: base + rom.ramp[(acc >> 7) & 0x3ff] - rom.diagBias[shape], code };
    }
    if (code === 0) return { z: base + 0x5a82, code };
    let acc: number;
    switch (code) {
      case 1: acc = yf; break;
      case 2: acc = 0xffff - xf; break;
      case 3: acc = 0xffff - yf; break;
      default: acc = xf; break;
    }
    return { z: base + rom.ramp[acc >> 7], code };
  }

  /** Fill `out` for a position. */
  probe(col: number, row: number, xf: number, yf: number, out: Probe): void {
    out.col = col;
    out.row = row;
    out.quad = quadrant(xf, yf);
    if (!this.inGrid(col, row)) {
      out.idx = -1; out.shape = 0; out.elev = 0; out.code = 0; out.ground = 0; out.tile = 0;
      return;
    }
    const idx = row * this.w + col;
    out.idx = idx;
    out.tile = this.tile[idx];
    const shape = this.shape[idx];
    out.shape = shape;
    if (shape === 0) {
      out.elev = 0; out.code = 0; out.ground = 0;
      return;
    }
    out.elev = this.elev[idx];
    const s = this.surface(shape, out.elev, out.quad, xf, yf);
    out.code = s.code;
    out.ground = s.z;
  }

  /** $81:925E: a cell's surface level at one edge, in half height steps. */
  edgeLevel(shape: number, elev: number, edge: number): number {
    return (2 * elev + this.rom.edge[shape * 4 + edge]) & 0xff;
  }

  /** Layer-4 wall flag of a cell on an edge, $81:92AC. */
  wallFlag(idx: number, edge: number): boolean {
    if (idx < 0 || idx >= this.walls.length) return false;
    return (this.walls[idx] & (1 << edge) & 0x0f) !== 0;
  }
}
