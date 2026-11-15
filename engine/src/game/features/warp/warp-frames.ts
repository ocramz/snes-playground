/**
 * The warp's two objects (pure; no Phaser), recorded frame by frame in
 * web_warp (tools/snesstep/trace_actors.py --types 63,64, and a watch on the
 * slots' types; read 2026-11-14). Both are drawn where Kirby is drawn: 63 at
 * his projection where he went in (it copies $091E/$093E), 64 at the one
 * where he comes out ($82:AB55-$82:AB68). Pictures are objects.json's by
 * (table, index), the thread's frame number $5D9C:
 *
 *   63, spawned with the stage `out` (core systems/warp.ts), gone 37 frames
 *       later (2498 -> 2535): first Kirby's own picture ($5D9C = $FFFF, the
 *       frame it copied from $0B1E; the sheet's capture of it, table
 *       $89:9295), then the star burst, table $89:94F5, frames 0-10.
 *   64, spawned with the stage `in`, gone 26 frames later with Kirby's
 *       return (2563 -> 2589): table $89:94F5, frames 0-7, 20, 0.
 */
import type { WarpStage } from '../../../core/traits/warp';

/** [the frame of the object's life it starts on, table, index]. */
type Pictures = ReadonlyArray<readonly [number, number, number]>;

export const OBJ63: Pictures = [
  [0, 0, 0], [2, 1, 0], [8, 1, 1], [10, 1, 2], [12, 1, 3], [14, 1, 4],
  [16, 1, 5], [18, 1, 6], [20, 1, 7], [22, 1, 8], [26, 1, 9], [32, 1, 10],
];
export const OBJ63_LIFE = 37;

export const OBJ64: Pictures = [
  [0, 0, 0], [2, 0, 1], [6, 0, 2], [12, 0, 3], [14, 0, 4], [16, 0, 5],
  [18, 0, 6], [20, 0, 7], [22, 0, 20], [24, 0, 0],
];
export const OBJ64_LIFE = 26;

export interface WarpPicture {
  type: 63 | 64;
  table: number;
  index: number;
  /** Drawn where Kirby went in ('out') or where he comes out ('in'). */
  at: 'out' | 'in';
}

function pick(list: Pictures, t: number): readonly [number, number, number] {
  let cur = list[0];
  for (const p of list) if (p[0] <= t) cur = p;
  return cur;
}

/** The picture the warp shows in `stage`, `t` frames into it, or null. */
export function warpPicture(stage: WarpStage, t: number): WarpPicture | null {
  if (stage === 'out' && t < OBJ63_LIFE) {
    const [, table, index] = pick(OBJ63, t);
    return { type: 63, table, index, at: 'out' };
  }
  if (stage === 'in' && t < OBJ64_LIFE) {
    const [, table, index] = pick(OBJ64, t);
    return { type: 64, table, index, at: 'in' };
  }
  return null;
}
