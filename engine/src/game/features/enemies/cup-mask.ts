/**
 * The cup's near rim over Kirby: object 75 (pure; no Phaser).
 *
 * The hole-out ($82:AE2B) spawns object 75 at the cup ($82:AD13): four
 * 16x16 sprites at OAM priority 0 (`build/sprites/emu/obj_075`, 32x32, its
 * top-left at the cup cell's corner + (16, 2)). Every other sprite of play is
 * priority 3, so this is the SNES's sprite mask: the mask has a lower OAM
 * index than Kirby, wins the sprite-vs-sprite choice where both are opaque,
 * and being behind BG1/BG2 lets the course show through. The ring (object
 * 74) has a lower index than the mask and draws over everything. Recorded
 * (read 2026-11-14):
 *   - web_hole, every frame of the 14-frame sink (stepper snapshots
 *     3890-3912): before 3896 Kirby's OAM entries precede the ring's
 *     (Kirby over the ring); from 3896 the order is ring 15-18, mask 23-27,
 *     Kirby 27-36, until Kirby's sprite goes at 3910;
 *   - c1n (trace_cutscene's slot lists): holed at 3121, object 75 from 3123
 *     to 3303 (the plain hole-out) or 3654 (the hole in one), dying 34
 *     frames before the star (128) rises out of the cup in both.
 *
 * The mask's top two rows hold a notch, the ring's opening: there the ring
 * is transparent and so is the mask. Everywhere else on those rows the ring
 * is opaque (checked against the atlas's cupring and cupmask), so the ring
 * over Kirby covers them anyway. The view therefore draws the mask as:
 *   - the ring raised over Kirby, and
 *   - Kirby cut off from the mask's third row down (a crop: the mask is
 *     32 px wide and Kirby, centred in the cup, is 24).
 * Once Kirby is hidden nothing the engine draws is under the mask (the
 * replay's star rises after it is gone), so its life here ends with Kirby's.
 */
import type { GameEvent } from '../../../core/events';

/** The atlas frame cut from obj_075 (tools/export_web_sprites.py). */
export const CUP_MASK_FRAME = 'cupmask';
/** Holed ($DA4A = 1) to object 75's first frame: web_hole 3894 -> 3896, c1n 3121 -> 3123. */
export const MASK_LEAD = 2;
/** The mask's top rows, whose opaque pixels the ring covers (the notch is the ring's opening). */
export const MASK_NOTCH_ROWS = 2;

/** When the mask is up, from the drained `holed-in` events. */
export class CupMaskClock {
  private holedAt: number | null = null;

  /** One host frame's events. */
  note(events: readonly GameEvent[]): void {
    for (const e of events) if (e.kind === 'holed-in') this.holedAt = e.frame;
  }

  /** Whether object 75 is up on core frame `frame`. */
  active(frame: number): boolean {
    return this.holedAt !== null && frame - this.holedAt >= MASK_LEAD;
  }

  reset(): void {
    this.holedAt = null;
  }
}

/**
 * The bitmap y from which Kirby is hidden: the mask's top (the cup cell's
 * corner minus the frame's `oy`) plus its notch rows.
 */
export function cupMaskCut(cornerY: number, mask: { oy?: number }): number {
  return cornerY - (mask.oy ?? 0) + MASK_NOTCH_ROWS;
}

/**
 * How many rows of a sprite whose top is at `top` and which is `height` tall
 * stay drawn above the cut (0 .. height).
 */
export function rowsAboveCut(top: number, height: number, cut: number): number {
  return Math.max(0, Math.min(height, Math.floor(cut - top)));
}
