import { trait } from 'koota';

/**
 * The phases of one hole's shot cycle (plans/port_v1_koota_phaser4.md,
 * "Core: hole flow and course loop"). The original is a straight line of
 * blocking code ($80:F278-$80:F3D1: set-up, the aim loop $81:A619, the shot
 * thread $81:BE91, the roll loop $82:BFBC); the engine turns each blocking
 * wait into a phase with a frame timer.
 */
export type FlowPhase =
  | 'Idle' // no hole running
  | 'ShotSetup' // $80:F795 / $80:C4FF / $80:C5F1, three frames
  | 'Aim' // the aim loop $81:A680-$81:A80A
  | 'PanToShot' // $81:BE91: pan to the shot view, then the curl
  | 'Spin' // $81:BF07-$81:BFCC: the panel opens, then the selectors
  | 'Power' // $81:BFDC-$81:C032: the meter
  | 'LaunchDelay' // $81:C035 to the first physics step
  | 'Rolling' // the roll loop $82:C052-
  | 'SettleWait' // $80:F39F: 30 frames, then the next set-up
  | 'BallLost' // the lost ball: frozen, then back to the shot origin
  | 'Respawn' // from the reset to the next set-up (measured, web_fly)
  | 'HoleDone'; // holed; the hole-out is phase 6

/**
 * World singleton. `since` is the core frame the phase was entered on; a
 * system reads `t = Time.frame - since`, the frames since (0 on the
 * entering frame), and compares it with the measured offsets.
 */
export const HoleFlow = trait({
  phase: 'Idle' as FlowPhase,
  since: 0,
  /** Shots taken on this hole (the set-up's $D82A + 1 is phase 6's counter). */
  shots: 0,
  /** The phase before the current one (the set-up's turn load tells a lost
   *  ball's retake from a new shot). */
  prev: 'Idle' as FlowPhase,
});
