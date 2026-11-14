import { trait } from 'koota';

/**
 * World singleton: player 1's pad, in the SNES bit layout of $4218/$4219
 * (B $8000, Y $4000, SELECT $2000, START $1000, UP $0800, DOWN $0400,
 * LEFT $0200, RIGHT $0100, A $0080, X $0040, L $0020, R $0010) — the same
 * layout tools/snesstep/src/main.rs uses for input scripts.
 * Originals: $1E67/$1E6B, the stall latch $6A7C.
 */
export const Pad = trait({ held: 0, pressed: 0, prev: 0, stallLatch: 0 });
