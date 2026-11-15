/**
 * The warp panels, layer-2 tiles $B0-$B9 (docs/tiles.md "Warps"; read
 * 2026-11-14, recorded with web_warp and web_warp_fly):
 *
 * - the load ($82:BD5C, the sweep's handler for a tile with no actor): each
 *   warp's cell goes on one of four lists, in the sweep's order ($B0-$B3,
 *   $B4-$B7, $B8, $B9: x at $B6FC/$B70E/$B720/$B732, y 10 bytes on);
 * - landing on one ($82:A980) or rolling over it ($82:A9DB): inside the
 *   cell's centre window ($82:AC74), not in mode $0A, on landing at or under
 *   the surface, and once per visit (the latch $6A42, cleared out of the
 *   window and by tile $00's handlers); a landing at |vz| >= $900 in mode 0
 *   shows the squash (Kirby's state $0C, $6A6E = the quadrant's code);
 * - the warp ($82:AA02): the other warp of the pair ($82:AA6F; with 1, 3 or
 *   4 on a list the game picks at random, $82:ABC6, which no hole of the ROM
 *   reaches and the engine does not port), the ball moved to its centre
 *   (the fractions $8000) and re-probed ($81:9479), z the ground there; the
 *   step then blocks (systems/warp.ts, the presentation) and, back in it, the
 *   ball turns to the destination's arrow: $82:ECFC for $B0-$B7 (N E S W by
 *   the tile's low two bits), and for a fly shot ($6AD8 = 0) the fly
 *   impulse ($D9CC/$D9CE) is turned by the same arrow minus the heading the
 *   step started with ($82:AC4C, $DA2C = block $D886 = the stored $D9DA).
 *   $B8 and $B9 move the ball and keep its heading.
 *
 * The kernels only test and latch (the guide never gets here: its tile table
 * $81:B455 does not know the warps); the move and the turn are the
 * non-kernel `warp` entry's (systems/ball-step.ts), which starts the stall.
 */
import { s16, wrap16 } from '../fixed';
import type { Ctx, Work } from './context';
import { probe } from './probe';
import { rotateBy, turnToDir } from './turn';
import { LANDING, ROLLING, type DispatchOutcome } from './types';

/** A warp's cell. */
export interface WarpCell {
  x: number;
  y: number;
}

/** The four lists of $82:BD5C. */
export type WarpLists = WarpCell[][];

/** Which list a tile goes on ($82:BD5C), or -1 for a tile that is no warp. */
export function warpGroup(tile: number): number {
  const t = tile & 0xff;
  if (t >= 0xb0 && t < 0xb4) return 0;
  if (t >= 0xb4 && t < 0xb8) return 1;
  if (t === 0xb8) return 2;
  if (t === 0xb9) return 3;
  return -1;
}

/**
 * $82:BD5C over the load-time sweep ($82:B320): every cell row by row from
 * y = 0, each row from its last column, as sweep.ts visits them.
 */
export function sweepWarps(data: { w: number; h: number; tile: ArrayLike<number> }): WarpLists {
  const lists: WarpLists = [[], [], [], []];
  for (let y = 0; y < data.h; y++) for (let x = data.w - 1; x >= 0; x--) {
    const g = warpGroup(data.tile[y * data.w + x]);
    if (g >= 0) lists[g].push({ x, y });
  }
  return lists;
}

/** $82:AC74: the cell's centre window, both fractions in [$2800, $E000). */
export function warpWindow(w: Work): boolean {
  const xf = w.xf & 0xffff;
  const yf = w.yf & 0xffff;
  return xf >= 0x2800 && xf < 0xe000 && yf >= 0x2800 && yf < 0xe000;
}

/** $82:A980: landed on a warp. Then JML $81:8905. */
export function warpLand(_ctx: Ctx, w: Work): DispatchOutcome {
  if (!warpWindow(w)) {
    w.warpLatch = 0; // $82:A9D1
    return LANDING;
  }
  if (w.mode === 0x0a) return LANDING;
  if (w.ground < w.z) return LANDING; // $82:A98D-$82:A99B: above the surface
  if (w.warpLatch !== 0) return LANDING;
  w.warpLatch += 1;
  if (w.mode === 0 && Math.abs(s16(w.vz)) >= 0x0900) {
    // $82:A9BD: $6A6E = $DA04, Kirby's state $0C
    w.lock6a6e = w.code;
    w.warpSquash = 1;
  }
  w.warpPending = 1;
  return LANDING;
}

/** $82:A9DB: rolled onto a warp. Then JML $81:8A56. */
export function warpHit(_ctx: Ctx, w: Work): DispatchOutcome {
  if (!warpWindow(w)) {
    w.warpLatch = 0; // $82:A9F8
    return ROLLING;
  }
  if (w.mode === 0x0a) return ROLLING;
  if (w.warpLatch !== 0) return ROLLING;
  w.warpLatch += 1;
  w.warpPending = 1;
  return ROLLING;
}

/**
 * $82:AA6F: where the warp under the ball leads: the other entry of its
 * list when the list is a pair; null otherwise (the random pick $82:ABC6 is
 * not ported: no hole of the ROM has a list of 1, 3 or 4, and one of 1
 * would hang the game, $82:ABF6 never finding an index).
 */
export function warpDestination(lists: WarpLists | undefined, w: Work): WarpCell | null {
  const g = warpGroup(w.tile);
  if (g < 0 || !lists) return null;
  const list = lists[g];
  if (list.length !== 2) return null;
  const here = list.findIndex((c) => c.x === w.xc && c.y === w.yc);
  if (here < 0) return null;
  return list[here ^ 1]; // $82:AA91: EOR #2 on the word index
}

/**
 * $82:AA9F-$82:AAB2 and $82:AAD6: the ball at the destination's centre,
 * re-probed, z on the ground there. The probe's tile is the destination's.
 */
export function warpTeleport(ctx: Ctx, w: Work, to: WarpCell): void {
  w.xc = to.x;
  w.yc = to.y;
  w.xf = 0x8000;
  w.yf = 0x8000;
  probe(ctx, w);
  w.z = w.ground;
}

/** $82:AC6C: the heading of each arrow, N E S W ($82:ECFC's too). */
export const WARP_HEADING = [270, 0, 90, 180];

/**
 * After the warp ($82:AA2A-$82:AA54, $82:AC4C), on the destination's tile:
 * $B0-$B7 turn the ball to their arrow ($82:ECFC) and, unless a grounder
 * was chosen, the fly impulse by the arrow minus the step's first heading.
 */
export function warpExit(ctx: Ctx, w: Work, grounder: number): void {
  const t = w.tile & 0xff;
  if (t < 0xb0 || t >= 0xb8) return; // $B8, $B9: no turn
  const dir = (t - 0xb0) & 3;
  turnToDir(ctx, w, dir);
  if (grounder !== 0) return; // $82:AC4F
  const delta = s16(wrap16(WARP_HEADING[dir] - w.scratch));
  const [sx, sy] = rotateBy(ctx, w.spinX, w.spinY, delta);
  w.spinX = sx;
  w.spinY = sy;
}
