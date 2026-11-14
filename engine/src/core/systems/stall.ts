import { trait } from 'koota';

/**
 * The stall: a stretch of frames in which the original's main loop is
 * blocked inside one routine and nothing else of the frame runs
 * (plans/port_v1_koota_phaser4.md, schedule item 3, `tick-stall`).
 *
 * - `hitStop` / `stepStop`: $81:8C95 waits 4 (landing, $81:8C79) or 2 (step
 *   hit, $81:8C48) frames inside the ball step, then the step resumes at
 *   `resumeAt`. Its own list is the squash pose.
 * - `guideLag`: the aim loop simulates the shot guide ($81:A956 ->
 *   $81:A9B8), which takes longer than a frame; the loop's next iteration
 *   comes `framesLeft` frames later. Nothing runs meanwhile, and the pad is
 *   not latched (a press that comes and goes inside the lag is lost).
 * - `apuLag`: a song request ($80:B4AC) blocks on the APU's port handshake
 *   ($80:B70A-$80:B724) for about three frames; measured when the falling
 *   ball's song starts (web_fly/web_fly_spin: records 3252 -> 3256).
 * - `cupReveal`: $82:8B5C (phase 6).
 *
 * A stall of N frames requested on frame F idles frames F+1..F+N-1 and
 * resumes on frame F+N. The suspended ball step's state rides as plain
 * fields (koota traits hold primitives only).
 */
export type StallKind = 'none' | 'hitStop' | 'stepStop' | 'cupReveal' | 'guideLag' | 'apuLag';

export const Stall = trait({
  kind: 'none' as StallKind,
  framesLeft: 0,
  resumeAt: -1,
  /** $6A6E: the squash variant a hit-stop shows (the request's A). */
  variant: 0,
  // the suspended step's route and landing outcome
  pRoute: '' as string,
  pReroute: '' as string,
  pEntry: '' as string,
  pOutcome: '' as string,
});
