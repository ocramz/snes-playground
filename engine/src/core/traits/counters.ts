/**
 * The 1-player counters (read 2026-11-14 from the disassembly; frames
 * pinned by the flow traces, notes/engine-phase6-holes.md):
 *
 *   $D7F0  tomatoes (Kirby's health), 0-4: -1 per shot, +1 per enemy, 0 on
 *          a ball out of bounds, refilled to 4 after a life is lost
 *   $D82A  strokes + 1: 1 at the hole's start ($80:C1DC), +1 per set-up
 *          ($80:C50B), never past 99
 *   $6A10  the enemies the player took ($82:8AA0)
 *   $D852  the stocked copy ability (the work copy's $D9C4; B uses it, once a
 *          shot); $DA90 the stock carried into the next hole
 *   $D7F4  spare lives: 2 at a new game ($80:C058), cap 99
 *   $D80A  the score card, one word per hole ($83:D4F6: $D82A - 1)
 */
import { trait } from 'koota';

/** On the player (ball) entity. */
export const Tomatoes = trait({ n: 4 });
export const Strokes = trait({ n: 1 });
export const Stars = trait({ n: 0 });
/**
 * `$D852`: the stock (B triggers it once a shot; never used up), and `$DA90`:
 * what the hole-out carries into the next hole (`$80:F5EF`; `$80:C22E` at
 * the hole's start). Lost with the ball out of bounds (`$80:F5B7`,
 * `$82:F48D`) and with a life (`$80:F3C1`); 0 at a new course (`$80:C128`).
 */
export const StockedAbility = trait({ id: 0, carry: 0 });

/** The most tomatoes a 1-player game holds ($83:ABF9: +1 only below 5). */
export const TOMATO_MAX = 4;
/** $80:C058: the spare lives of a new game. */
export const START_LIVES = 2;
/** $80:F486: the lives after CONTINUE. */
export const CONTINUE_LIVES = 2;
/** $80:F62D: lives are stored only below 100. */
export const LIVES_MAX = 99;
/** $80:C506: strokes stop counting at 99. */
export const STROKES_MAX = 99;

export interface CareerState {
  /** $D7F4. */
  lives: number;
  /** $D80A + 2 x hole: the strokes of each hole played ($D82A - 1), -1 unplayed. */
  card: number[];
}

/** World singleton (AoS): what survives from hole to hole. */
export const Career = trait((): CareerState => ({ lives: START_LIVES, card: [] }));

/**
 * The tomato queue ($68FA, a 16-entry ring; write index $68F8, read $68F6).
 * `$83:ABC5` pushes a -1 (player | $0100), `$83:ABAD` a +1; the HUD thread
 * ($84:98EC -> $83:ABDD) takes one entry, counts 20 frames and applies it,
 * then takes the next. `pending` is the entry being counted (null = idle),
 * `pushed`/`applied` count the ring's writes and reads (trace names tqw /
 * tqr are twice these, mod $20).
 */
export interface TomatoQueueState {
  entries: number[];
  pending: number | null;
  timer: number;
  pushed: number;
  applied: number;
  /** Frames the consumer skips (the cup reveal's decompression wait). */
  hold: number;
  /** $68F4: the HUD's tomato display is up — from the first entry taken until
   *  90 frames after the last change (`$84:9925` / `$84:9990`). The roll
   *  loop's end waits for it to clear (`$82:C172`). */
  visible: boolean;
  /** Frames left until the display hides (-1 none pending). */
  hideTimer: number;
}

export const TomatoQueue = trait((): TomatoQueueState => ({
  entries: [], pending: null, timer: 0, pushed: 0, applied: 0, hold: 0, visible: false, hideTimer: -1,
}));

/** The HUD thread's period per entry ($84:991F/$84:995A). */
export const TOMATO_QUEUE_FRAMES = 20;
/** From the last change to the display's hiding (web_flow 3087 -> 3176, 3270 -> 3359;
 *  web_tomatoes 2477 -> 2566: iterations, from the $68F4 writes' scanlines). */
export const TOMATO_HUD_HIDE = 89;
