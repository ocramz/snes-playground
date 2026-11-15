/**
 * The terrain of a random hole, legal by construction (plans/random_holes.md
 * "Design"): square slots of flat ground on a lattice, one cell of gutter
 * between neighbours, a path of slots walked from the tee's slot, and each
 * link between consecutive slots made from the gutter cells between them:
 *
 *   level         flat at that level
 *   one step      a row of ramps at the upper elevation, falling toward the
 *                 lower slot (a ramp joins flush at both ends: its high edge
 *                 2e+2 meets the upper flat, its low edge 2e the lower one)
 *   1-2 steps     (downhill along the path only) flat at the upper level: a
 *     down        deliberate step-down, the one place an edge is not flush
 *
 * A gutter cell touches only its two slots and other gutter cells, so the
 * ramps' sides open onto gaps, which is the ROM's own pattern for them
 * (docs/terrain.md); a step up of two or more never happens. Inside a slot
 * of side 5 or more a hill, a hollow or a mound may stand, a cell clear of
 * the slot's rim. The rim is then fenced with layer-4 walls, some of them
 * left open so the ball can fall off (the ROM walls about a fifth of such
 * edges; docs/terrain.md "Walls").
 */
import type { RomRules } from '../rules';
import { DX, DY, FLAT, GAP, HoleGrid, MOUND, rampFalling } from './grid';
import type { Rng } from './rng';

export interface LayoutParams {
  /** Slot sides to pick from. */
  slot: number[];
  /** Lattice sizes to pick from (columns and rows each). */
  lattice: number[];
  /** The path's length in slots, [min, max]. */
  path: [number, number];
  /** The chance of one extra slot hanging off the path. */
  branch: number;
  /** The elevation of the tee's slot, [min, max]. */
  startElev: [number, number];
  /** Weights of the elevation change from one slot to the next: 0, +1, -1, -2. */
  rise: [number, number, number, number];
  /** The chance a one-step drop is a step-down rather than a ramp. */
  stepDown: number;
  /** The chance a link's gutter is open along the whole side (else a door of 2+). */
  wideDoor: number;
  /** The chance a slot of side 5+ gets a hill, a hollow or a mound. */
  bump: number;
  /** The chance an edge facing a gap or the border keeps its wall. */
  wall: number;
}

export interface Slot {
  /** The lattice cell. */
  i: number;
  j: number;
  /** The slot's first cell and side, on the final (cropped) grid. */
  x0: number;
  y0: number;
  size: number;
  elev: number;
  /** The slot it hangs off (-1 for the tee's). */
  parent: number;
  /** Slots from the tee's along the path (the branch counts from its parent). */
  depth: number;
  /** A bump (hill, hollow, mound) occupies its middle. */
  bump: boolean;
}

export interface Layout {
  grid: HoleGrid;
  /** The path in order from the tee's slot, then the branch if any. */
  slots: Slot[];
}

export const MAX_ELEV = 7;

export function buildLayout(rng: Rng, rules: RomRules, p: LayoutParams): Layout | null {
  const size = rng.pick(p.slot);
  const cols = rng.pick(p.lattice);
  const rows = rng.pick(p.lattice);
  const pitch = size + 1;
  const grid = new HoleGrid(cols * pitch - 1, rows * pitch - 1);
  const used = new Map<string, number>();
  const key = (i: number, j: number): string => `${i},${j}`;
  const slots: Slot[] = [];
  const add = (i: number, j: number, parent: number, elev: number): void => {
    used.set(key(i, j), slots.length);
    slots.push({
      i, j, x0: i * pitch, y0: j * pitch, size, elev, parent,
      depth: parent < 0 ? 0 : slots[parent].depth + 1, bump: false,
    });
  };
  const freeNeighbours = (i: number, j: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let d = 0; d < 4; d++) {
      const ni = i + DX[d];
      const nj = j + DY[d];
      if (ni >= 0 && nj >= 0 && ni < cols && nj < rows && !used.has(key(ni, nj))) out.push([ni, nj]);
    }
    return out;
  };
  const nextElev = (e: number, allowDown: boolean): number => {
    const delta = rng.weighted([0, 1, -1, -2], allowDown ? p.rise : [p.rise[0], p.rise[1], 0, 0]);
    return Math.max(0, Math.min(MAX_ELEV, e + delta));
  };

  // the path: a self-avoiding walk over the lattice
  const want = rng.int(p.path[0], Math.min(p.path[1], cols * rows));
  add(rng.int(0, cols - 1), rng.int(0, rows - 1), -1, rng.int(p.startElev[0], p.startElev[1]));
  while (slots.length < want) {
    const last = slots[slots.length - 1];
    const next = freeNeighbours(last.i, last.j);
    if (next.length === 0) break;
    const [i, j] = rng.pick(next);
    add(i, j, slots.length - 1, nextElev(last.elev, true));
  }
  if (slots.length < Math.min(3, p.path[0])) return null;
  if (rng.chance(p.branch)) {
    const from = rng.shuffle(slots.slice(0, -1).map((_, k) => k)).find((k) => freeNeighbours(slots[k].i, slots[k].j).length > 0);
    if (from !== undefined) {
      const [i, j] = rng.pick(freeNeighbours(slots[from].i, slots[from].j));
      add(i, j, from, nextElev(slots[from].elev, true));
    }
  }

  for (const s of slots) grid.rect(s.x0, s.y0, s.x0 + size - 1, s.y0 + size - 1, { shape: FLAT, elev: s.elev });
  for (let k = 1; k < slots.length; k++) link(grid, rng, p, slots[slots[k].parent], slots[k], size);
  if (size >= 5) for (const s of slots) bump(grid, rng, p, s);

  // the walls: on the rim, each kept with probability p.wall
  grid.fence(() => rng.chance(p.wall));
  const b = grid.bounds();
  if (!b) return null;
  const cropped = grid.crop(b.x0, b.y0, b.x1, b.y1);
  for (const s of slots) {
    s.x0 -= b.x0;
    s.y0 -= b.y0;
  }
  if (cropped.unintendedSteps(rules).length > 0) return null;
  return { grid: cropped, slots };
}

/** The gutter cells between slot `a` and its neighbour `b`, made into a door. */
function link(grid: HoleGrid, rng: Rng, p: LayoutParams, a: Slot, b: Slot, size: number): void {
  const d = DX.findIndex((dx, k) => dx === b.i - a.i && DY[k] === b.j - a.j); // a -> b
  // the gutter line: the column or row of cells between the two squares
  const vertical = d === 1 || d === 3; // a gutter column (b is E or W)
  const gx = d === 1 ? a.x0 + size : d === 3 ? a.x0 - 1 : -1;
  const gy = d === 2 ? a.y0 + size : d === 0 ? a.y0 - 1 : -1;
  let from = 0;
  let to = size - 1;
  if (!rng.chance(p.wideDoor)) {
    const width = rng.int(2, size - 1);
    from = rng.int(0, size - width);
    to = from + width - 1;
  }
  const down = a.elev - b.elev; // along the path, a -> b
  const step = down >= 2 || (down === 1 && rng.chance(p.stepDown));
  for (let t = from; t <= to; t++) {
    const x = vertical ? gx : a.x0 + t;
    const y = vertical ? a.y0 + t : gy;
    if (down === 0) {
      grid.put(x, y, { shape: FLAT, elev: a.elev });
    } else if (down === -1) {
      // up a step: ramps at b's elevation, falling back toward a
      grid.put(x, y, { shape: rampFalling((d + 2) & 3), elev: b.elev });
    } else if (!step) {
      // down a step: ramps at a's elevation, falling toward b
      grid.put(x, y, { shape: rampFalling(d), elev: a.elev });
    } else {
      // a step-down: flat at a's level, the drop on the edge into b
      grid.put(x, y, { shape: FLAT, elev: a.elev });
      grid.allowStep(x, y, d);
    }
  }
}

/** A hill, a hollow or a mound in the slot's middle, one cell clear of its rim. */
function bump(grid: HoleGrid, rng: Rng, p: LayoutParams, s: Slot): void {
  if (!rng.chance(p.bump)) return;
  const m = Math.floor(s.size / 2);
  const cx = s.x0 + m + (s.size >= 6 ? rng.int(-1, 0) : 0);
  const cy = s.y0 + m + (s.size >= 6 ? rng.int(-1, 0) : 0);
  const kind = rng.weighted(['hill', 'pit', 'mound'], [3, s.elev >= 1 ? 2 : 0, 1]);
  const diagonal = rng.chance(0.5);
  if (kind === 'hill' && s.elev + 1 <= MAX_ELEV) grid.hill(cx, cy, s.elev + 1, diagonal);
  else if (kind === 'pit') grid.pit(cx, cy, s.elev, diagonal);
  else if (s.elev + 1 <= MAX_ELEV) grid.put(cx, cy, { shape: MOUND, elev: s.elev + 1 });
  else return;
  s.bump = true;
}

/** The cells of a slot that are plain flat ground at its own level. */
export function flatCells(grid: HoleGrid, s: Slot): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = s.y0; y < s.y0 + s.size; y++) for (let x = s.x0; x < s.x0 + s.size; x++) {
    const i = grid.at(x, y);
    if (grid.shape[i] === FLAT && grid.elev[i] === s.elev && grid.tile[i] === 0) out.push({ x, y });
  }
  return out;
}

/** True when the 8 cells around (x, y) are all solid. */
export function enclosed(grid: HoleGrid, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if ((dx || dy) && (!grid.inside(x + dx, y + dy) || grid.shape[grid.at(x + dx, y + dy)] === GAP)) return false;
  }
  return true;
}
