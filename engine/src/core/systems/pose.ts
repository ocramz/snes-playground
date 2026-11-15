/**
 * `update-pose` (schedule item 32): the timed returns of Kirby's state
 * machine and the facts the ball step leaves. The states themselves are
 * written where the ROM writes them (aim.ts, panel.ts, hole-flow.ts); this
 * system owns what the animation scripts do on their own:
 *
 * - the A arming's hop ($82:DAAE, BallWork.hopRequest) -> 13, and the hop
 *   script's store of 14 after 17 frames ($87:81C1);
 * - an airborne bounce -> 14 unless hopping ($82:CE07-$82:CE27,
 *   BallWork.bouncePose);
 * - the hit-stop's squash ($81:8CA2) -> 12 while the stall lasts, then 13
 *   if it interrupted a hop, else 14 ($81:8CC6-$81:8CD2): see `squashPose`.
 */
import type { World } from 'koota';
import { Pose, PoseState, HOP_FRAMES } from '../traits/pose';
import { BallWork } from '../traits/ball';
import { activePlayer, findActivePlayer } from '../traits/player';
import { HURT_POSE, THROWN_POSE } from './hazard-reaction';


export function updatePose(world: World): void {
  const e = findActivePlayer(world);
  if (e === undefined) return; // no hole running
  const w = e.get(BallWork)!;
  const pose = e.get(Pose)!;
  if (w.hopRequest !== 0) {
    w.hopRequest = 0;
    w.bouncePose = 0;
    e.set(Pose, { ...pose, state: PoseState.Hop, timer: HOP_FRAMES });
    return;
  }
  const hurt = pose.state === HURT_POSE || pose.state === THROWN_POSE;
  if (w.bouncePose !== 0) {
    // $82:CE19: the plain air code's bounce pose cuts a hurt pose short too
    // (web_hazad 2499: 49 -> 14); a hit code's own handler runs instead of
    // the plain code while its code is in the mode
    w.bouncePose = 0;
    if (pose.state !== PoseState.Hop) e.set(Pose, { ...pose, state: PoseState.Roll, timer: 0 });
    return;
  }
  if ((pose.state === PoseState.Hop || hurt) && pose.timer > 0) {
    // the hop's script returns to 14 after 17 frames; a hazard's hurt pose after 32
    const left = pose.timer - 1;
    e.set(Pose, { ...pose, timer: left, state: left === 0 ? PoseState.Roll : pose.state });
  }
}

/** The hit-stop's pose: 12 on its first frame, the return when it ends. */
export function squashPose(world: World, begin: boolean, variant: number): void {
  const e = activePlayer(world);
  const pose = e.get(Pose)!;
  if (begin) {
    // $81:8C9E: the state is pushed; $81:8CC6 restores 13 or 14
    const resume = pose.state === PoseState.Hop ? PoseState.Hop : PoseState.Roll;
    e.set(Pose, { ...pose, state: PoseState.Squash, variant, timer: 0, resume });
    return;
  }
  const back = pose.resume === PoseState.Hop ? PoseState.Hop : PoseState.Roll;
  e.set(Pose, { ...pose, state: back, timer: back === PoseState.Hop ? HOP_FRAMES : 0 });
}

/**
 * What Kirby's animation scripts (`$87`, run by the thread phase of the
 * frame helper, stall frames included) do to the game's state:
 * - state 20 (Stone) stores 2 every tick (`$87:81C1`); the ground handler
 *   writes 20 back each iteration, so 2 shows only while it does not run;
 * - state 25 (Hi-Jump in the air) waits 6 x 6 ticks, then stores $D762 = 0
 *   (`$87:A9D1`), which ends the mode at the next iteration (d17: 25 at
 *   2108, the store at 2145 line 41, the end at 2145).
 * The thread phase of iteration F runs in the first lines of video frame
 * F + 1, before that frame's body: a store shows from the next frame on
 * (`Pose.pending`, applied by `applyScriptStore` at the frame's start).
 */
export function kirbyScripts(world: World): void {
  const e = findActivePlayer(world);
  if (e === undefined) return;
  const pose = e.get(Pose)!;
  // an object's store this tick ran first ($80:BF4D before $87:808E)
  const state = pose.pending >= 0 ? pose.pending : pose.state;
  let scriptT = pose.scriptState === state ? pose.scriptT + 1 : 1;
  let pending = pose.pending;
  if (state === STONE_POSE) pending = PoseState.Hold2;
  if (state === HIJUMP_AIR_POSE && scriptT === HIJUMP_SCRIPT_TICKS) e.get(BallWork)!.d762 = 0;
  if (scriptT > 0xffff) scriptT = 0xffff;
  e.set(Pose, { ...pose, scriptState: state, scriptT, pending });
}

/** At the frame's start: a script's store from the last thread phase. */
export function applyScriptStore(world: World): void {
  const e = findActivePlayer(world);
  if (e === undefined) return;
  const pose = e.get(Pose)!;
  if (pose.pending < 0) return;
  e.set(Pose, { ...pose, state: pose.pending, pending: -1, timer: 0 });
}

const STONE_POSE = 0x14;
const HIJUMP_AIR_POSE = 0x19;
/** State 25's six `wait 6`, then the store: on the 37th tick from the state's change. */
export const HIJUMP_SCRIPT_TICKS = 37;
