/**
 * sub_terrain_probe $81:9479: fills the work's probe fields for the ball's
 * current position. Ported from the disassembly and cross-checked against
 * tools/terrain.py (the generator of terrain_golden.json); docs/terrain.md
 * is the write-up.
 */
import { wrap16 } from '../fixed';
import type { Ctx, Work } from './context';
import { quadrant, surfaceZ } from '../terrain';

/**
 * The gap exit ($81:94DA): shape 0, ground Z 0, tile 0, code 0. The cell
 * index and quadrant keep their computed values, as on the ROM.
 */
function gapExit(w: Work): void {
  w.shape = 0;
  w.elev = 0;
  w.tile = 0;
  w.ground = 0;
  w.code = 0;
}

export function probe(ctx: Ctx, w: Work): void {
  const { course, rules } = ctx;
  const xf = wrap16(w.xf);
  const yf = wrap16(w.yf);
  w.quad = quadrant(xf, yf); // $DA02

  // Cell index = row * width + col ($949C: the hardware multiply writes the
  // 16-bit width with the row in its low byte, so $4202/$4203 get row and
  // width).
  w.cell = w.yc * course.w + w.xc; // $D9FC

  const col = s16c(w.xc);
  const row = s16c(w.yc);
  if (col < 0 || col >= course.w || row < 0 || row >= course.h) {
    gapExit(w);
    return;
  }
  const i = w.cell;
  w.elev = course.elev[i]; // $DA00
  w.shape = course.shape[i]; // $D9FE
  if (w.shape === 0) {
    gapExit(w);
    return;
  }
  w.tile = course.layer2[i]; // $DA0A
  w.code = rules.terrainQuad(w.shape, w.quad); // $DA04
  w.ground = surfaceZ(rules, w.shape, w.elev, xf, yf); // $DA08:$DA06
}

/** The cell counters are signed 16-bit words. */
function s16c(v: number): number {
  return ((v & 0xffff) << 16) >> 16;
}
