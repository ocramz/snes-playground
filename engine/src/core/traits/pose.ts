import { trait } from 'koota';

/**
 * Kirby's animation state machine as the game keys it (docs/animation.md,
 * "The state table"): the semantic state `$D7D4`, the facing `$D7C4`
 * (8 directions) and the shot angle `$D7CC` (16). Never a clip key: the
 * view catalog maps {state, facing, angle} to a clip (reference §12).
 */
export const Pose = trait({
  /** $D7D4: 0 hold, 4/5 aim, 6 curl, 12 squash, 13 hop, 14/15/16 roll. */
  state: 0,
  /** $D7C4 and $D7CC ($81:BCA0). */
  facing: 0,
  angle: 0,
  /** $6A6E: the squash variant a hit-stop shows (state 12's switch). */
  variant: 0,
  /** Frames left in a timed state (the hop's script returns to 14 after 17). */
  timer: 0,
  /** The state a hit-stop's squash returns to: 13 if it interrupted the
   *  hop, else 14 ($81:8C9E pushes the state, $81:8CC6 tests it). */
  resume: 0,
});

/** The pose states the 1-player shot uses (docs/animation.md). */
export const PoseState = {
  Hold: 0,
  Aim: 4,
  AimTurn: 5,
  Curl: 6,
  Squash: 12,
  Hop: 13,
  Roll: 14,
  RollStrong: 15,
  RollMedium: 16,
} as const;

/** The hop's script holds state 13 for 17 frames, then stores 14 ($87:81C1). */
export const HOP_FRAMES = 17;

/**
 * Kirby's projected position ($DA56-$DA5C) and last frame's ($DA5E-$DA64),
 * each an integer and a 16-bit fraction: x = 32 (x + y), y upward
 * (screenBase - the bitmap's y). $81:A449 copies current to previous,
 * $81:A430 stores a new projection ($81:A4C6).
 */
export const BallScreen = trait({
  x: 0, xf: 0, y: 0, yf: 0,
  px: 0, pxf: 0, py: 0, pyf: 0,
});
