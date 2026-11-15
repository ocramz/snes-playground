import { trait } from 'koota';

/**
 * The phases of the 1-player game around one hole (plans/port_v1_koota_
 * phaser4.md "Core: hole flow and course loop", corrected in phase 6 from
 * the disassembly). The original is a straight line of blocking code — the
 * turn top $80:F278, the set-up, the aim loop $81:A619, the shot thread
 * $81:BE91, the roll loop $82:BFBC, the roll's end $80:F37A and its three
 * paths, the hole-out $80:F48C — and the engine turns each blocking wait
 * into a phase with a frame timer.
 */
export type FlowPhase =
  | 'Idle' // no hole running
  | 'ShotSetup' // $80:F73B / $80:C4FF / $80:C5F1, three frames
  | 'Aim' // the aim loop $81:A680-$81:A80A
  | 'PanToShot' // $81:BE91: pan to the shot view, then the curl
  | 'Spin' // $81:BF07-$81:BFCC: the panel opens, then the selectors
  | 'Power' // $81:BFDC-$81:C032: the meter
  | 'LaunchDelay' // $81:C035 to the first physics step
  | 'Rolling' // the roll loop $82:C052-
  | 'RollEnd' // $82:C172: after the shot is over, until the HUD's tomatoes hide
  | 'SettleWait' // $80:F39F: 30 frames + the turn top
  | 'Tired' // $80:C79A: tomatoes 1 or 2 at the turn top
  | 'OutOfTomatoes' // $82:E1EE + $80:F85C: a life for 4 tomatoes, same hole
  | 'BallLost' // $80:F830 + $80:F59A: tomatoes 0, back to the shot origin
  | 'Respawn' // $83:9589 + $80:F8C5 + $80:F8DA: a life, the refill
  | 'HoleOut' // holed: the sink, then $80:F48C's hole-out
  | 'HoleOver' // the RESULT card ($83:D3ED): waits for `nextHole`
  | 'GameOver' // scene 9 ($83:D856): waits for `continueGame` / `endGame`
  | 'CourseDone'; // after the last hole ($6A62)

/**
 * World singleton. `since` is the core frame the phase was entered on; a
 * system reads `t = Time.frame - since`, the frames since (0 on the
 * entering frame), and compares it with the measured offsets.
 */
export const HoleFlow = trait({
  phase: 'Idle' as FlowPhase,
  since: 0,
  /** The phase before the current one (the set-up's turn load tells a lost
   *  ball's retake from a new shot). */
  prev: 'Idle' as FlowPhase,
  /** HoleOut: the shot holed in one ($D82A == 2 at the hole-out). */
  holeInOne: 0,
  /** The phase's own timeline length, when it is computed on entry (Tired). */
  length: 0,
  /** RollEnd: where the roll goes when it has ended. */
  next: 'SettleWait' as FlowPhase,
});

/** Song 11 ($89), course 1 holes 1-4's: the song of the holes the ROM has no list for (the
 *  authored and generated ones). A ROM hole plays its own (`CourseData.song`, from `$80:C967`'s
 *  per-course lists; docs/audio.md). Song events carry the song's number (the request byte - $7E). */
export const HOLE_SONG = 0x89 - 0x7e;
