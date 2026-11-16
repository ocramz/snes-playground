/**
 * The special tiles of a random hole: only groups the engine ports, each
 * where the ROM's courses put it (docs/tiles.md, and the statistics over the
 * 212 ROM layouts in plans/random_holes.md):
 *
 *   rough $04            a patch of flat cells
 *   friction $20-$23     the ramps of a door, $20 on $04 ... $23 on $07;
 *            $24         or a patch of flat cells
 *   boost $30-$33        on flat ground before a door, pushing through it
 *         $34/36/38/3A   on the ramps of a door up, pushing uphill
 *   kicker $10-$13       a flat cell
 *   arrow $14-$17        a flat cell, turning the ball toward a door or an
 *                        enemy (N E S W)
 *   snap $18-$1B         a flat cell
 *   tree $02             a flat cell clear of the tee (a pillar 3 steps tall)
 *   warp $B0-$B3         one pair, in two slots, each leaving the ball along
 *                        its arrow onto ground at its own level
 *
 * Not placed: the swirls $70-$7B and the switches $5A-$5D (their state and
 * the water switch's block are not the solver's), $58/$59 (stubbed), the
 * overlay/water, the outline $28-$2D, and the hazard actors (the solver
 * cannot run them). The
 * tee and the enemies are placed first; features take only plain cells.
 */
import type { RomRules } from '../rules';
import { DX, DY, FLAT, type HoleGrid } from './grid';
import { flatCells, type Layout, type Slot } from './layout';
import type { Rng } from './rng';

export type FeatureGroup = 'rough' | 'friction' | 'boost' | 'kicker' | 'arrow' | 'snap' | 'tree' | 'warp';

export interface FeatureParams {
  /** How many features, [min, max]. */
  budget: [number, number];
  groups: FeatureGroup[];
}

const TREE = 0x02;

export function addFeatures(rng: Rng, _rules: RomRules, layout: Layout, p: FeatureParams): void {
  const { grid, slots } = layout;
  const n = rng.int(p.budget[0], p.budget[1]);
  let warped = false;
  for (let k = 0; k < n; k++) {
    const g = rng.pick(p.groups);
    if (g === 'warp') {
      if (warped || slots.length < 3) continue;
      warped = warp(rng, grid, slots);
      continue;
    }
    switch (g) {
      case 'rough': patch(rng, grid, rng.pick(slots), 0x04); break;
      case 'friction': friction(rng, grid, slots); break;
      case 'boost': boost(rng, grid, slots); break;
      case 'kicker': single(rng, grid, slots, 0x10 + rng.int(0, 3)); break;
      case 'snap': single(rng, grid, slots, 0x18 + rng.int(0, 3)); break;
      case 'arrow': arrow(rng, grid, slots); break;
      case 'tree': tree(rng, grid, slots); break;
    }
  }
}

/** Plain flat cells of a slot that do not touch the tee. */
function free(grid: HoleGrid, s: Slot): Array<{ x: number; y: number }> {
  return flatCells(grid, s).filter((c) => !nearTile(grid, c.x, c.y, 0x0c));
}

function nearTile(grid: HoleGrid, x: number, y: number, t: number): boolean {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (grid.inside(x + dx, y + dy) && grid.tile[grid.at(x + dx, y + dy)] === t) return true;
  }
  return false;
}

function patch(rng: Rng, grid: HoleGrid, s: Slot, tile: number): void {
  const cells = free(grid, s);
  if (cells.length === 0) return;
  const c = rng.pick(cells);
  const w = rng.int(1, 3);
  const h = rng.int(1, 2);
  for (let y = c.y; y < c.y + h; y++) for (let x = c.x; x < c.x + w; x++) {
    if (cells.some((q) => q.x === x && q.y === y)) grid.put(x, y, { tile });
  }
}

function single(rng: Rng, grid: HoleGrid, slots: Slot[], tile: number): void {
  const cells = free(grid, rng.pick(slots));
  if (cells.length === 0) return;
  const c = rng.pick(cells);
  grid.put(c.x, c.y, { tile });
}

/** The ramp cells between two slots, with the direction each falls toward. */
function rampCells(grid: HoleGrid): Array<{ x: number; y: number; fall: number }> {
  const out: Array<{ x: number; y: number; fall: number }> = [];
  for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
    const i = grid.at(x, y);
    const s = grid.shape[i];
    if (s >= 0x04 && s <= 0x07 && grid.tile[i] === 0) out.push({ x, y, fall: s - 0x04 });
  }
  return out;
}

/** A ramp row (a door) of one fall direction, as runs of neighbouring ramp cells. */
function rampRuns(grid: HoleGrid): Array<Array<{ x: number; y: number; fall: number }>> {
  const cells = rampCells(grid);
  const runs: Array<Array<{ x: number; y: number; fall: number }>> = [];
  const seen = new Set<string>();
  for (const c of cells) {
    const k = `${c.x},${c.y}`;
    if (seen.has(k)) continue;
    const run = [c];
    seen.add(k);
    for (let j = 0; j < run.length; j++) {
      for (const n of cells) {
        const nk = `${n.x},${n.y}`;
        if (!seen.has(nk) && n.fall === run[j].fall && Math.abs(n.x - run[j].x) + Math.abs(n.y - run[j].y) === 1) {
          seen.add(nk);
          run.push(n);
        }
      }
    }
    runs.push(run);
  }
  return runs;
}

function friction(rng: Rng, grid: HoleGrid, slots: Slot[]): void {
  const runs = rampRuns(grid);
  if (runs.length > 0 && rng.chance(0.6)) {
    for (const c of rng.pick(runs)) grid.put(c.x, c.y, { tile: 0x20 + c.fall });
    return;
  }
  patch(rng, grid, rng.pick(slots), 0x24);
}

function boost(rng: Rng, grid: HoleGrid, slots: Slot[]): void {
  const runs = rampRuns(grid);
  if (runs.length > 0 && rng.chance(0.5)) {
    // $34 on $04, $36 on $05, $38 on $06, $3A on $07: always pushing uphill
    for (const c of rng.pick(runs)) grid.put(c.x, c.y, { tile: 0x34 + 2 * c.fall });
    return;
  }
  // a flat panel next to a door, pushing through it ($30-$33: N E S W)
  const doors = doorCells(grid, slots);
  if (doors.length === 0) return;
  const d = rng.pick(doors);
  grid.put(d.x, d.y, { tile: 0x30 + d.dir });
}

/** Plain flat slot cells beside a solid gutter cell, with the direction toward it. */
function doorCells(grid: HoleGrid, slots: Slot[]): Array<{ x: number; y: number; dir: number }> {
  const out: Array<{ x: number; y: number; dir: number }> = [];
  for (const s of slots) {
    for (const c of free(grid, s)) {
      for (let d = 0; d < 4; d++) {
        const nx = c.x + DX[d];
        const ny = c.y + DY[d];
        const outside = nx < s.x0 || ny < s.y0 || nx >= s.x0 + s.size || ny >= s.y0 + s.size;
        if (outside && grid.solid(nx, ny)) out.push({ ...c, dir: d });
      }
    }
  }
  return out;
}

function arrow(rng: Rng, grid: HoleGrid, slots: Slot[]): void {
  // toward a door, or toward an enemy in line with the cell
  const doors = doorCells(grid, slots);
  if (doors.length > 0 && rng.chance(0.6)) {
    const d = rng.pick(doors);
    // one cell back from the door, so the turn happens before it
    const bx = d.x - DX[d.dir];
    const by = d.y - DY[d.dir];
    const i = grid.inside(bx, by) ? grid.at(bx, by) : -1;
    if (i >= 0 && grid.shape[i] === FLAT && grid.tile[i] === 0 && !nearTile(grid, bx, by, 0x0c)) grid.put(bx, by, { tile: 0x14 + d.dir });
    else grid.put(d.x, d.y, { tile: 0x14 + d.dir });
    return;
  }
  const s = rng.pick(slots);
  const cells = free(grid, s);
  if (cells.length === 0) return;
  const c = rng.pick(cells);
  grid.put(c.x, c.y, { tile: 0x14 + rng.int(0, 3) });
}

function tree(rng: Rng, grid: HoleGrid, slots: Slot[]): void {
  const cells = slots.flatMap((s) => free(grid, s)).filter((c) => !nearTile(grid, c.x, c.y, TREE));
  if (cells.length === 0) return;
  const c = rng.pick(cells);
  grid.put(c.x, c.y, { tile: TREE });
}

/**
 * One warp pair ($B0-$B3, list 0): an entry in an early slot, an exit in a
 * later one, each tile's arrow (its low two bits, N E S W) pointing at two
 * cells of plain ground at its own level, since the ball leaves the other
 * panel along it (docs/tiles.md "Warp panels").
 */
function warp(rng: Rng, grid: HoleGrid, slots: Slot[]): boolean {
  const pick = (s: Slot): { x: number; y: number; dir: number } | null => {
    const opts: Array<{ x: number; y: number; dir: number }> = [];
    for (const c of free(grid, s)) {
      const e = grid.elev[grid.at(c.x, c.y)];
      for (let d = 0; d < 4; d++) {
        let ok = true;
        for (let k = 1; k <= 2 && ok; k++) {
          const x = c.x + DX[d] * k;
          const y = c.y + DY[d] * k;
          const i = grid.inside(x, y) ? grid.at(x, y) : -1;
          ok = i >= 0 && grid.shape[i] === FLAT && grid.elev[i] === e && grid.tile[i] === 0;
        }
        if (ok) opts.push({ ...c, dir: d });
      }
    }
    return opts.length > 0 ? rng.pick(opts) : null;
  };
  const early = slots.slice(0, Math.ceil(slots.length / 2));
  const late = slots.slice(Math.ceil(slots.length / 2));
  const a = pick(rng.pick(early));
  const b = pick(rng.pick(late));
  if (!a || !b) return false;
  grid.put(a.x, a.y, { tile: 0xb0 + a.dir });
  grid.put(b.x, b.y, { tile: 0xb0 + b.dir });
  return true;
}
