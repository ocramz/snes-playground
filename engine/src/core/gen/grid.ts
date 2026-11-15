/**
 * A hole under construction: the four layers as mutable grids, the stamps
 * the layouts are built from, the edge check, and the authored-course JSON
 * the engine reads (engine/courses/README.md). A port of
 * tools/engine_courses.py's `Hole` (plans/random_holes.md).
 *
 * Directions are the grid's, as everywhere: 0-3 = N E S W, N = -y, E = +x
 * (docs/terrain.md). A ramp cell has the elevation of the terrace above it
 * and falls toward the one below: lower side N -> $04, E $05, S $06, W $07.
 */
import type { AuthoredCourseJson } from '../course-data';
import type { RomRules } from '../rules';

export const DX = [0, 1, 0, -1] as const;
export const DY = [-1, 0, 1, 0] as const;

/** Shapes. */
export const GAP = 0x00;
export const FLAT = 0x01;
export const MOUND = 0x02;
/** The cardinal ramp falling toward direction d (its low edge on side d). */
export const rampFalling = (d: number): number => 0x04 + (d & 3);

/** One edge between two solid cells whose levels differ. */
export interface EdgeDelta {
  x: number;
  y: number;
  /** The direction from (x, y) to its neighbour: 1 (E) or 2 (S). */
  dir: number;
  /** level(x, y) - level(neighbour), in half steps. */
  delta: number;
}

export class HoleGrid {
  readonly shape: Uint8Array;
  readonly elev: Uint8Array;
  readonly walls: Uint8Array;
  readonly tile: Uint8Array;
  /** Edges a step is meant to be on, as `edgeKey`s (the layouts' step-downs). */
  readonly steps = new Set<string>();

  constructor(readonly w: number, readonly h: number) {
    const n = w * h;
    this.shape = new Uint8Array(n);
    this.elev = new Uint8Array(n);
    this.walls = new Uint8Array(n);
    this.tile = new Uint8Array(n);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  at(x: number, y: number): number {
    return y * this.w + x;
  }

  solid(x: number, y: number): boolean {
    return this.inside(x, y) && this.shape[this.at(x, y)] !== GAP;
  }

  put(x: number, y: number, p: { shape?: number; elev?: number; tile?: number; walls?: number }): void {
    if (!this.inside(x, y)) throw new Error(`put outside the grid: (${x},${y})`);
    const i = this.at(x, y);
    if (p.shape !== undefined) this.shape[i] = p.shape;
    if (p.elev !== undefined) this.elev[i] = p.elev;
    if (p.tile !== undefined) this.tile[i] = p.tile;
    if (p.walls !== undefined) this.walls[i] |= p.walls;
  }

  rect(x0: number, y0: number, x1: number, y1: number, p: { shape?: number; elev?: number; tile?: number }): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.put(x, y, p);
  }

  /** The surface level at side d of a cell, in half steps ($81:925E). */
  level(rules: RomRules, x: number, y: number, d: number): number {
    const i = this.at(x, y);
    return 2 * this.elev[i] + rules.terrainEdge(this.shape[i], d);
  }

  /** Mark the edge from (x, y) toward d as a deliberate step. */
  allowStep(x: number, y: number, d: number): void {
    this.steps.add(edgeKey(x, y, d));
  }

  /**
   * Every edge between two solid cells whose levels differ ($81:925E: 0 is
   * flush, a step up blocks, a drop launches). Each pair once (E and S).
   */
  edgeDeltas(rules: RomRules): EdgeDelta[] {
    const out: EdgeDelta[] = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!this.solid(x, y)) continue;
        for (const d of [1, 2]) {
          const nx = x + DX[d];
          const ny = y + DY[d];
          if (!this.solid(nx, ny)) continue;
          const delta = this.level(rules, x, y, d) - this.level(rules, nx, ny, (d + 2) & 3);
          if (delta !== 0) out.push({ x, y, dir: d, delta });
        }
      }
    }
    return out;
  }

  /** The edge deltas no layout asked for (should be none). */
  unintendedSteps(rules: RomRules): EdgeDelta[] {
    return this.edgeDeltas(rules).filter((e) => !this.steps.has(edgeKey(e.x, e.y, e.dir)));
  }

  /**
   * Layer-4 walls on the edges that face a gap or the grid's border, each
   * kept with probability `keep` (1 = fenced all round, as the test holes;
   * the ROM walls about a fifth of them and lets the ball fall elsewhere).
   */
  fence(keep: (x: number, y: number, d: number) => boolean = () => true): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (!this.solid(x, y)) continue;
        for (let d = 0; d < 4; d++) {
          if (this.solid(x + DX[d], y + DY[d])) continue;
          if (keep(x, y, d)) this.walls[this.at(x, y)] |= 1 << d;
        }
      }
    }
  }

  /**
   * A one-cell plateau at `elev` ringed by ramps down to elev - 1, over
   * flat ground at elev - 1 (engine_courses.py `hill`). Needs the 3x3 around
   * (x, y) to be flat at elev - 1.
   */
  hill(x: number, y: number, elev: number, diagonal = false): void {
    const c = diagonal ? 0x14 : 0x0c;
    this.put(x, y, { shape: FLAT, elev });
    this.put(x, y - 1, { shape: 0x04, elev });
    this.put(x, y + 1, { shape: 0x06, elev });
    this.put(x - 1, y, { shape: 0x07, elev });
    this.put(x + 1, y, { shape: 0x05, elev });
    this.put(x - 1, y - 1, { shape: c + 3, elev }); // NW (0,1,1,0)
    this.put(x + 1, y - 1, { shape: c + 0, elev }); // NE (0,0,1,1)
    this.put(x + 1, y + 1, { shape: c + 1, elev }); // SE (1,0,0,1)
    this.put(x - 1, y + 1, { shape: c + 2, elev }); // SW (1,1,0,0)
  }

  /**
   * A one-cell hollow at elev - 1 ringed by ramps up to flat ground at
   * `elev` (engine_courses.py `pit`, without its terrace and entry ramp).
   * Needs the 3x3 around (x, y) to be flat at `elev` (elev >= 1).
   */
  pit(x: number, y: number, elev: number, diagonal = false): void {
    const c = diagonal ? 0x10 : 0x08;
    this.put(x, y, { shape: FLAT, elev: elev - 1 });
    this.put(x, y - 1, { shape: 0x06, elev });
    this.put(x, y + 1, { shape: 0x04, elev });
    this.put(x - 1, y, { shape: 0x05, elev });
    this.put(x + 1, y, { shape: 0x07, elev });
    this.put(x - 1, y - 1, { shape: c + 1, elev }); // NW (2,1,1,2)
    this.put(x + 1, y - 1, { shape: c + 2, elev }); // NE (2,2,1,1)
    this.put(x + 1, y + 1, { shape: c + 3, elev }); // SE (1,2,2,1)
    this.put(x - 1, y + 1, { shape: c + 0, elev }); // SW (1,1,2,2)
  }

  /** The bounding box of the solid cells, or null when there are none. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = this.w, y0 = this.h, x1 = -1, y1 = -1;
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (!this.solid(x, y)) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return x1 < 0 ? null : { x0, y0, x1, y1 };
  }

  /** A copy cut to the rectangle (inclusive), the step marks moved with it. */
  crop(x0: number, y0: number, x1: number, y1: number): HoleGrid {
    const g = new HoleGrid(x1 - x0 + 1, y1 - y0 + 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = this.at(x, y);
      const j = g.at(x - x0, y - y0);
      g.shape[j] = this.shape[i];
      g.elev[j] = this.elev[i];
      g.walls[j] = this.walls[i];
      g.tile[j] = this.tile[i];
    }
    for (const k of this.steps) {
      const [x, y, d] = k.split(',').map(Number);
      g.steps.add(`${x - x0},${y - y0},${d}`);
    }
    return g;
  }

  /** The engine's authored-course JSON (engine/courses/README.md). */
  toJson(name: string, about: string): AuthoredCourseJson {
    const rows = (g: Uint8Array): string[] => {
      const out: string[] = [];
      for (let y = 0; y < this.h; y++) {
        const cells: string[] = [];
        for (let x = 0; x < this.w; x++) {
          const v = g[this.at(x, y)];
          cells.push(v === 0 ? '..' : v.toString(16).toUpperCase().padStart(2, '0'));
        }
        out.push(cells.join(' '));
      }
      return out;
    };
    return {
      name, about, w: this.w, h: this.h,
      shape: rows(this.shape), elev: rows(this.elev), walls: rows(this.walls), tile: rows(this.tile),
    };
  }
}

export function edgeKey(x: number, y: number, d: number): string {
  // one key per edge, whichever side names it
  if (d === 0) return `${x},${y - 1},2`;
  if (d === 3) return `${x - 1},${y},1`;
  return `${x},${y},${d}`;
}
