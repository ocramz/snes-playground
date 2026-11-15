/**
 * The pure halves of the cup's rim mask (features/enemies/cup-mask.ts) and
 * of the warp's objects (features/warp/warp-frames.ts): the frames they are
 * up on, against the recordings their headers cite.
 */
import { describe, expect, it } from 'vitest';
import { CupMaskClock, cupMaskCut, rowsAboveCut, MASK_LEAD } from '../src/game/features/enemies/cup-mask';
import { warpPicture, OBJ63_LIFE, OBJ64_LIFE } from '../src/game/features/warp/warp-frames';
import { WARP_IN, WARP_OUT } from '../src/core/systems/warp';
import type { GameEvent } from '../src/core/events';

const ev = (kind: string, frame: number): GameEvent => ({ id: 0, kind, frame, seq: 0, romSfx: -1, subject: 0 });

describe('the cup\'s rim mask', () => {
  it('is up from the hole-out + 2 (web_hole: holed 3894, the mask in OAM at 3896)', () => {
    const c = new CupMaskClock();
    expect(c.active(100)).toBe(false);
    c.note([ev('bounce', 99), ev('holed-in', 100)]);
    expect(c.active(100 + MASK_LEAD - 1)).toBe(false);
    expect(c.active(100 + MASK_LEAD)).toBe(true);
    expect(c.active(100 + 200)).toBe(true);
    c.reset();
    expect(c.active(100 + MASK_LEAD)).toBe(false);
  });

  it('cuts Kirby from its third row: the corner + 2 + the two notch rows', () => {
    expect(cupMaskCut(500, { oy: -2 })).toBe(504);
    // a 24-row sprite whose top is at 490 keeps 14 rows; one wholly below keeps none
    expect(rowsAboveCut(490, 24, 504)).toBe(14);
    expect(rowsAboveCut(510, 24, 504)).toBe(0);
    expect(rowsAboveCut(400, 24, 504)).toBe(24);
  });
});

describe('the warp\'s objects', () => {
  it('63 lives inside the stage out, 64 inside the stage in (web_warp: 2498-2535, 2563-2589)', () => {
    expect(OBJ63_LIFE).toBeLessThan(WARP_OUT);
    expect(OBJ64_LIFE).toBe(WARP_IN);
    expect(warpPicture('out', 0)).toEqual({ type: 63, table: 0, index: 0, at: 'out' });
    expect(warpPicture('out', 2)).toEqual({ type: 63, table: 1, index: 0, at: 'out' });
    expect(warpPicture('out', 36)?.index).toBe(10);
    expect(warpPicture('out', 37)).toBeNull();
    expect(warpPicture('in', 22)?.index).toBe(20);
    expect(warpPicture('in', 25)?.index).toBe(0);
    expect(warpPicture('in', 26)).toBeNull();
    expect(warpPicture('lead', 5)).toBeNull();
    expect(warpPicture('pan', 5)).toBeNull();
    expect(warpPicture('hold', 5)).toBeNull();
  });
});
