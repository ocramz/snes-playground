/**
 * The hole's shot cycle around the aim stage and the roll (schedule items 4,
 * 5 and 30; plans/port_v1_koota_phaser4.md "Core: hole flow and course
 * loop"). The original is the straight line $80:F278-$80:F3D1 (read
 * 2026-11-14, build/engine/disasm/flow-holeloop.txt); its blocking waits are
 * phases here, with the frame offsets measured on the recorded flow traces
 * (build/engine/rom-test/flow_web_*.json, notes/engine-phase5-flow.md):
 *
 *   ShotSetup   t0 $80:F73B (the turn's load: elevation $FFFF),
 *               t1 $80:C4FF (shot set-up: the snap toward the target),
 *               t2 $80:C5F1 + the head of $81:A619 (origin, pose 4, guide),
 *               then Aim from t3
 *   SettleWait  over at O -> the next set-up at O + 32 (web_flow 3474/3506)
 *   BallLost    the shot is over with the lost flag set (camera.ts: the
 *               fall's 240-frame countdown) at O -> the ball back at the
 *               shot's origin at O + 81 (web_fly 3496/3577; $80:F38F)
 *   Respawn     -> the next set-up 334 frames later (web_fly 3911; $80:F396)
 *   LaunchDelay -> Rolling at R + 24, R the frame the meter latched
 *               (the first physics step; web_flow 2960/2984)
 */
import type { World } from 'koota';
import { HoleFlow } from '../traits/flow';
import { Shot, METER_TOP } from '../traits/shot';
import { Camera } from '../traits/camera';
import { Course, courseEntity } from '../traits/course';
import { Pose, PoseState, BallScreen } from '../traits/pose';
import {
  BallPos, BallVel, BallAir, BallHoled, StillCount, Modifier, BallWork,
} from '../traits/ball';
import type { Ctx } from '../sim/context';
import { aimToward, nearestEnemy, snapAim } from '../sim/aim';
import { shotPower } from '../sim/shot';
import { project } from '../projection';
import { ball, enterPhase, phaseNow } from './flow-util';
import { requestGuide } from './aim';
import { rollPoseState } from './panel';

export const SETTLE_FRAMES = 32;
export const LOST_RESET_AT = 81;
export const RESPAWN_FRAMES = 334;
export const LAUNCH_FRAMES = 24;

/** Schedule item 4: the phase clock's own transitions. */
export function updateHoleFlow(world: World, ctx: Ctx): void {
  const { phase, t } = phaseNow(world);
  switch (phase) {
    case 'SettleWait':
      if (t >= SETTLE_FRAMES) enterPhase(world, 'ShotSetup');
      return;
    case 'BallLost':
      if (t >= LOST_RESET_AT) {
        resetToOrigin(world, ctx);
        enterPhase(world, 'Respawn');
      }
      return;
    case 'Respawn':
      if (t >= RESPAWN_FRAMES) enterPhase(world, 'ShotSetup');
      return;
    case 'LaunchDelay':
      if (t >= LAUNCH_FRAMES) {
        // $82:C84E: the roll's pose from the latched selectors
        const e = ball(world);
        const shot = world.get(Shot)!;
        e.set(Pose, { ...e.get(Pose)!, state: rollPoseState(shot.rollSide, shot.rollTB), timer: 0 });
        enterPhase(world, 'Rolling');
      }
      return;
    default:
      return;
  }
}

/** Schedule item 5: the three set-up frames. */
export function setupShot(world: World, ctx: Ctx): void {
  const { phase, t } = phaseNow(world);
  if (phase !== 'ShotSetup') return;
  const e = ball(world);
  const shot = world.get(Shot)!;
  if (t === 0) {
    // $80:F73B: the turn's load. $D832 was set to $FFFF after a roll that
    // ended on the course ($80:F3A6); a lost ball's retake skips that and
    // reloads the shot's own elevation (web_fly 3912: 60 -> 0).
    if (world.get(HoleFlow)!.prev !== 'Respawn') world.set(Shot, { ...shot, elev: 0xffff });
    return;
  }
  if (t === 1) {
    // $80:C4FF: the shot set-up
    const flow = world.get(HoleFlow)!;
    world.set(HoleFlow, { ...flow, shots: flow.shots + 1 }); // $D82A + 1 (phase 6 counts it)
    const w = e.get(BallWork)!;
    w.lost &= ~1; // $80:C519 TRB #$8001
    w.lost &= ~0x8000;
    e.set(StillCount, { over: e.get(StillCount)!.over, frames: 0 }); // $80:C589
    e.set(Modifier, { kind: -1, window: 0, timer: 0 });
    const cam = world.get(Camera)!;
    world.set(Camera, { ...cam, mode: 2, wantX: 0, wantY: 0, lagX: 0, lagY: 0 }); // $80:C574-$80:C586
    // $82:8E41: the nearest free enemy (phase 5: the course's list as placed;
    // phase 6 tracks takes and the cup, $82:8B5C)
    const pos = e.get(BallPos)!;
    const course = courseEntity(world).get(Course)!;
    let { targetXc, targetXf, targetYc, targetYf } = shot;
    const i = nearestEnemy(pos.xc, pos.xf, pos.yc, pos.yf, course.enemies);
    if (i >= 0) {
      targetXc = course.enemies[i].x;
      targetYc = course.enemies[i].y;
      targetXf = 0x8000;
      targetYf = 0x8000;
    }
    // $80:C902: snap the aim toward it
    const aim = snapAim(aimToward(ctx.rules, pos.xc, pos.xf, pos.yc, pos.yf, targetXc, targetXf, targetYc, targetYf));
    world.set(Shot, {
      ...shot,
      targetXc, targetXf, targetYc, targetYf,
      aim,
      elev: 0, // $80:C5CF
      guideSide: 6, guideTB: 6, // $80:C5D2-$80:C5DB
    });
    return;
  }
  if (t === 2) {
    // $80:C5F1: the full power for the guide, the origin ($81:BAF3), pose 4;
    // then the head of $81:A619
    const pos = e.get(BallPos)!;
    const fly = shot.elev !== 0;
    const next = {
      ...shot,
      power: shotPower(ctx.rules, METER_TOP, fly),
      originXf: pos.xf, originXc: pos.xc, originYf: pos.yf, originYc: pos.yc, originZ: pos.z,
      kind: fly ? 2 : 0, // $81:A632-$81:A644
      grounder: fly ? 0 : 1,
      idle: 90, // $81:A64A
      changed: 0,
      hold: 0,
      guideTimer: 16, // $81:A66C
      guideEnds: shot.guideEnds,
      side: shot.guideSide, // $81:A9EF (the guide copies them)
      topBack: shot.guideTB,
    };
    world.set(Shot, next);
    // $80:C60A's pose 4 is stored through an X the calls before it left
    // (no state change shows in the flow traces); the loop's first
    // iteration sets 4/5. The head's facing ($81:A665) comes after the
    // guide, which spills into the next frame: update-aim does it there.
    requestGuide(world, ctx, 0); // $81:A65B: no lag frame of its own
    enterPhase(world, 'Aim');
  }
}

/** Schedule item 30: what the step left decides the next phase. */
export function detectBallOut(world: World): void {
  const { phase } = phaseNow(world);
  if (phase !== 'Rolling') return;
  const e = ball(world);
  const w = e.get(BallWork)!;
  if (e.get(BallHoled)!.holed !== 0) {
    enterPhase(world, 'HoleDone'); // the hole-out is phase 6
    return;
  }
  // $80:F37F: the roll is over; lost ($D876 bit 0) or settled
  if (e.get(StillCount)!.over === 0) return;
  enterPhase(world, (w.lost & 1) !== 0 ? 'BallLost' : 'SettleWait');
}

/**
 * The lost ball's reset (web_fly 3577): back at the shot's origin, still,
 * airborne (the block's $D8A6 reads 1 there), Kirby in the hold pose, his
 * screen position re-projected (the integers only, as $80:F73B reloads
 * them) and the camera centred on him.
 */
function resetToOrigin(world: World, ctx: Ctx): void {
  const e = ball(world);
  const shot = world.get(Shot)!;
  e.set(BallPos, { xc: shot.originXc, xf: shot.originXf, yc: shot.originYc, yf: shot.originYf, z: shot.originZ });
  e.set(BallVel, { vx: 0, vy: 0, vz: 0 });
  e.set(BallAir, { air: 1 });
  const w = e.get(BallWork)!;
  w.xc = shot.originXc; w.xf = shot.originXf;
  w.yc = shot.originYc; w.yf = shot.originYf;
  w.z = shot.originZ;
  w.vx = 0; w.vy = 0; w.vz = 0;
  w.air = 1;
  w.fellOut = 0;
  w.fallTimer = 0xf0;
  e.set(Pose, { ...e.get(Pose)!, state: PoseState.Hold, timer: 0 });
  const p = project(ctx.course, shot.originXc, shot.originXf, shot.originYc, shot.originYf, shot.originZ);
  const sc = e.get(BallScreen)!;
  e.set(BallScreen, { ...sc, x: p.x, y: p.y });
  const cam = world.get(Camera)!;
  world.set(Camera, { ...cam, x: (p.x - 0x80) & 0xffff, y: (p.y + 0x70) & 0xffff });
}
