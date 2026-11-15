/**
 * The pure half of the snap panels' stars (snap-stars-view.ts): object 62's
 * pictures and where a star sorts. Object 62 draws table `$89:9485`
 * (tables.json `snapStars`' scripts set it), indices 0-4: one 8x8 part each
 * (build/sprites/emu/obj_062.json, the objects atlas). Lists 0-2 open with
 * the record `$7E $DA74`, so they take Kirby's OAM priority ($DA74 = his
 * $D96A): under the course with him. Lists 3 and 4 are always priority 3.
 */
import { kirbyDepth } from '../kirby/sprite-rules';

export const SNAP_STAR_TYPE = 62;
/** `$89:9485`'s place in the sheet's tables. */
export const SNAP_STAR_TABLE = 0;
export const SNAP_STAR_FRAMES = [0, 1, 2, 3, 4] as const;

/**
 * A star's depth. Its OAM queue is Kirby's, or the one after it when it
 * flies off toward the camera's side (dir16 < 3 or >= 11, $85:CFB9); Kirby
 * is enqueued before the threads draw, so either way it is drawn behind him
 * (unconfirmed: checked against one stepper snapshot, notes/
 * port-v2-phase3-snaps.md). The engine has no queues: just behind Kirby's
 * sort, and under the course with him for frames 0-2.
 */
export function starDepth(frame: number, kirbyPrio: number, kirbySorted: number): number {
  const sorted = kirbySorted - 1e-6;
  return frame <= 2 ? kirbyDepth(kirbyPrio, sorted) : sorted;
}
