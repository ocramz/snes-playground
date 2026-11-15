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
 * - `cupReveal`: $82:8B5C, the last enemy turns into the cup inside the
 *   step; its own list is systems/reveal.ts (`tickReveal`), and the step
 *   resumes when it is over.
 * - `takeWait`: $82:8A83's 4 frames after an ability enemy's take.
 * - `transform`: the copy ability's transformation, `$82:D9D2`: 48 frames
 *   of `$80:8FB6` inside the trigger `$82:C875`, which the roll loop runs
 *   after the camera, the shadow, the sprite and the still count. So the
 *   post-step systems run on the frame that requests it, and not on the
 *   one that resumes the step (the ability's setup, the store).
 * - `abilityWait`: a wait inside an ability's setup (Parasol's 9 frames,
 *   the UFO's 24 on the ground), the same way.
 * - `waterWait`: the water's entry ($82:81F5 / $82:80D0) jumps to the frame
 *   helper $80:8F78 once inside the step, then returns from the handler
 *   (sim/water.ts): one frozen frame.
 * - `warp`: $82:AA02, the ball goes from one warp panel to the other inside
 *   the step; its own list is systems/warp.ts (`tickWarp`), and the step
 *   resumes when it is over.
 * The HUD thread (the tomato queue) runs in the hit-stops, the take and water waits,
 * the reveal and the warp, as the ROM's frame helper $80:8F78 does; not in the
 * guide's or the APU's lag, where the main loop is busy.
 *
 * A stall of N frames requested on frame F idles frames F+1..F+N-1 and
 * resumes on frame F+N. The suspended ball step's state rides as plain
 * fields (koota traits hold primitives only).
 */
export type StallKind =
  | 'none' | 'hitStop' | 'stepStop' | 'cupReveal' | 'takeWait' | 'waterWait' | 'warp'
  | 'transform' | 'abilityWait' | 'guideLag' | 'apuLag';

/** Stalls requested after the post-step systems' place in the roll loop: they run on the request frame, not on resume. */
export function postStepFirst(kind: StallKind): boolean {
  return kind === 'transform' || kind === 'abilityWait';
}

export const Stall = trait({
  kind: 'none' as StallKind,
  framesLeft: 0,
  resumeAt: -1,
  /** $6A6E: the squash variant a hit-stop shows (the request's A). */
  variant: 0,
  /** A guide lag's sound, requested after the guide: played on its last idle frame (-1 none). */
  sfx: -1,
  // the suspended step's route and landing outcome
  pRoute: '' as string,
  pReroute: '' as string,
  pEntry: '' as string,
  pOutcome: '' as string,
});
