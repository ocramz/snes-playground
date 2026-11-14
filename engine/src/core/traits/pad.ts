import { trait } from 'koota';

/**
 * World singleton: player 1's pad, in the SNES bit layout of $4218/$4219
 * (B $8000, Y $4000, SELECT $2000, START $1000, UP $0800, DOWN $0400,
 * LEFT $0200, RIGHT $0100, A $0080, X $0040, L $0020, R $0010) — the same
 * layout tools/snesstep/src/main.rs uses for input scripts.
 *
 * The host writes `raw` (the buttons down this frame); the `latch-pad`
 * system derives the rest, as the NMI does:
 *   held    $0067  the buttons down
 *   pressed $006B  the buttons that went down this frame
 *   prev           last frame's `held`
 *   last           last frame's `raw` (the edge detector's memory)
 * During a hit-stop the ROM ORs held and pressed into $6A7C/$6A7E and hands
 * them back as $0067/$006B when the stall ends ($81:8CAB-$81:8CDE);
 * `stallLatch`/`stallPressed` are those accumulators.
 */
export const Pad = trait({
  raw: 0,
  held: 0,
  pressed: 0,
  prev: 0,
  last: 0,
  stallLatch: 0,
  stallPressed: 0,
});
