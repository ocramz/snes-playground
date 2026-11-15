/**
 * The warp's state (`$82:AA02`, systems/warp.ts): its stage, the two cells,
 * the pan's target and whether Kirby's sprite is off. The warp runs as the
 * `warp` stall (traits/stall.ts); the views read this trait to hide Kirby
 * and to draw objects 63 (at the warp he left) and 64 (where he comes out).
 */
import { trait } from 'koota';

/**
 * - lead: $80:8FB6's 10 frames, Kirby still at the warp he landed on;
 * - out: object 63 there (Kirby curls up, a flash, stars), Kirby's sprite off;
 * - pan: the camera's pan to the other warp ($81:BA8A);
 * - in: object 64 there (a flash, stars), Kirby's sprite still off;
 * - hold: Kirby back on, the 1-player wait.
 */
export type WarpStage = 'none' | 'lead' | 'out' | 'pan' | 'in' | 'hold';

export const Warp = trait({
  stage: 'none' as WarpStage,
  /** Frames in the current stage. */
  t: 0,
  /** The warp the ball went into and the one it comes out of. */
  fromX: 0,
  fromY: 0,
  toX: 0,
  toY: 0,
  /** $DA58 / $DA5C at the stage `out`: Kirby's projection at the destination, the pan's target. */
  panX: 0,
  panY: 0,
  /** Kirby's projection where he went in, where object 63 is drawn ($091E/$093E -> $5F1C/$5F9C). */
  outX: 0,
  outY: 0,
  /** $0B7E / $0B82 = $FFFF: Kirby's sprite is not drawn. */
  hidden: 0,
});
