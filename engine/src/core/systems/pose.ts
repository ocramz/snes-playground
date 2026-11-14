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
import { ball } from './flow-util';


export function updatePose(world: World): void {
  const e = world.queryFirst(BallWork);
  if (e === undefined) return; // no hole running
  const w = e.get(BallWork)!;
  const pose = e.get(Pose)!;
  if (w.hopRequest !== 0) {
    w.hopRequest = 0;
    w.bouncePose = 0;
    e.set(Pose, { ...pose, state: PoseState.Hop, timer: HOP_FRAMES });
    return;
  }
  if (w.bouncePose !== 0) {
    w.bouncePose = 0;
    if (pose.state !== PoseState.Hop) e.set(Pose, { ...pose, state: PoseState.Roll, timer: 0 });
    return;
  }
  if (pose.state === PoseState.Hop && pose.timer > 0) {
    const left = pose.timer - 1;
    e.set(Pose, { ...pose, timer: left, state: left === 0 ? PoseState.Roll : PoseState.Hop });
  }
}

/** The hit-stop's pose: 12 on its first frame, the return when it ends. */
export function squashPose(world: World, begin: boolean, variant: number): void {
  const e = ball(world);
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
