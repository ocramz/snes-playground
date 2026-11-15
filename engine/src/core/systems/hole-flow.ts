/**
 * The 1-player game around a hole (schedule items 4, 5 and 30;
 * plans/port_v1_koota_phaser4.md "Core: hole flow and course loop", as
 * corrected by the phase-6 read of the disassembly). The original is the
 * straight line $80:F278-$80:F48C (build/engine/disasm/flow-holeloop.txt);
 * its blocking waits are phases here, and each phase that changes counters
 * on its way is a small timeline of {t, action} measured on the flow traces
 * (build/engine/rom-test/flow_web_*.json) and the stepper's sound log:
 *
 *   ShotSetup     t0 $80:F73B (the turn's load: elevation $FFFF),
 *                 t1 $80:C4FF (strokes + 1, the snap toward the target),
 *                 t2 $80:C5F1 + the head of $81:A619, then Aim from t3
 *   LaunchDelay   -> Rolling at R + 24, R the frame the meter latched
 *   RollEnd       the shot is over at O ($D9BE): the roll loop's last
 *                 frames `$82:C172` wait until the HUD's tomatoes are hidden
 *                 ($68F4): it exits at E = max(O + 2, the hiding + 1)
 *                 (web_flow 3473 -> 3475; web_tomatoes 2529 -> 2567, the HUD
 *                 hidden at 2566). Then holed, lost or settled, from E:
 *   SettleWait    `$80:F39F`'s wait 30, then tomatoes 0 -> OutOfTomatoes
 *                 (`$80:F3AC`); the turn top at E + 31, where 1-2 tomatoes ->
 *                 Tired (`$80:C79A`), else the set-up (web_flow 3506,
 *                 web_tomatoes 2598)
 *   BallLost      GAME OVER if no life is left (`$80:F387`); `$80:F830`:
 *                 tomatoes 0 + song $7E at E + 30, sfx $54 at E + 33 (web_fly
 *                 3528/3531); the ball back at the shot's origin at E + 79 (3577)
 *   Respawn       from that reset R: the hole's song again at R + 3
 *                 (3580), a life and sfx $0B at R + 61 (3638), the refill
 *                 `$80:F8DA`: +1 at R + 71, 81, ... (8 tries, 3648-3718),
 *                 the next set-up at R + 334 (3911)
 *   HoleOut       the roll ends when the ball has sunk (holed 2, shot over;
 *                 web_hole 3908): the pan to the cup, the card, the songs,
 *                 the bonus tomato, the 1UP; HoleOver at the blank before
 *                 the RESULT card (see HOLEOUT_*)
 */
import type { World } from 'koota';
import { HoleFlow, HOLE_SONG } from '../traits/flow';
import { Shot, METER_TOP } from '../traits/shot';
import { Camera } from '../traits/camera';
import { Pose, PoseState, BallScreen, BallSprite, PRIO_OVER } from '../traits/pose';
import {
  BallPos, BallVel, BallAir, BallHoled, StillCount, Modifier, BallWork,
} from '../traits/ball';
import { Strokes, Career, STROKES_MAX, TomatoQueue } from '../traits/counters';
import { Session } from '../traits/session';
import { Cell } from '../traits/hole';
import type { Ctx } from '../sim/context';
import { aimToward, nearestEnemy, snapAim } from '../sim/aim';
import { shotPower } from '../sim/shot';
import { panStep } from '../sim/camera';
import { project } from '../projection';
import { ball, emitEvent, enterPhase, phaseNow } from './flow-util';
import { requestGuide } from './aim';
import { rollPoseState } from './panel';
import { freeEnemies } from './reveal';
import { Reveal } from '../traits/reveal';
import { changeTomatoes, gainLife, loseLife, setTomatoes, tomatoes } from './counters';

/** RollEnd: `$82:C172` runs at least one frame after the over, then tests $68F4. */
export const ROLL_END_MIN = 2;
/** SettleWait, from the roll loop's exit E: the turn top's first frame ($80:F278 -> the set-up's t0). */
export const SETTLE_FRAMES = 31;
/** $80:F39F: the wait before the out-of-tomatoes test ($80:F3AC). */
export const SETTLE_WAIT = 30;
export const LAUNCH_FRAMES = 24;

/** BallLost, from the roll loop's exit E (web_fly 3498). */
export const LOST_ZERO_AT = 30; // $80:F83B STZ $D7F0, song $7E ($80:F845): 3528
export const LOST_SFX_AT = 33; // sfx $54 ($80:F84C): 3531
export const LOST_RESET_AT = 79; // the ball back at the origin: 3577

/** Respawn, from the reset frame R (web_fly 3577). */
export const RESPAWN_SONG_AT = 3; // the hole's song again ($82:B0EC): 3580
export const RESPAWN_LIFE_AT = 61; // $80:F8D0 DEC $D7F4, sfx $0B: 3638
export const REFILL_FIRST = 71; // $80:F8DA: 8 x (wait 10, +1): 3648 ...
export const REFILL_STEP = 10;
export const REFILL_TRIES = 8;
export const RESPAWN_FRAMES = 334; // the next set-up: 3911

/**
 * Tired ($80:C79A, at the turn top when fewer than 3 tomatoes are left):
 * after the turn's load (the elevation's $FFFF, web_tomatoes 2863), the pan
 * toward Kirby (`$80:C8A8`: a frame, then `$81:BA8A`, until it arrives),
 * pose 11 (2873), wait 80 (`$80:C7C6`), 36 more at one tomato (`$80:C7BF`);
 * then the set-up's `$80:C4FF` (2953; with one tomato 3227 -> 3343).
 */
export const TIRED_WAIT = 0x50;
export const TIRED_WAIT_ONE = 0x24;

/**
 * OutOfTomatoes ($82:E1EE, then $80:F85C), from its first frame O, the end
 * of $80:F39F's wait (web_tomatoes 3606, sfx 0 from $82:E20A):
 *
 *   O + 15    pose 3, song $8F, object $BE (Kirby falls asleep; 3621)
 *   O + 212   object $BE is done ($D798): the hole's song again ($82:E25F,
 *             3818); no life left -> GAME OVER ($80:F3B5)
 *   O + 282   `$80:F876`: a life, sfx $0B (3888)
 *   O + 312   object $40, sfx $77 (3918)
 *   O + 348   the refill, `$80:F8DA`: 8 x (+1, 10 frames) (3954 ...)
 *   O + 449   the turn top: the set-up on the same hole, the ball where it
 *             lies (4055)
 */
export const OOT_POSE_AT = 15;
export const OOT_SLEEP_END = 212;
export const OOT_LIFE_AT = 282;
export const OOT_OBJECT_AT = 312;
export const OOT_REFILL_FIRST = 348;
export const OOT_SETUP_AT = 449;

/**
 * HoleOut (read 2026-11-14; measured on web_hole, the hole played out with
 * no pokes, and c1n's hole-outs; docs/web-demo.md). The sink ends the roll:
 * holed 2 and shot over in the same step (web_hole 3908; `$81:A612`), the
 * roll loop exits (RollEnd), the main flow takes the holed path `$80:F48C`,
 * and from the next frame `$83:C8A0` pans the camera toward the cup's projection ($ECBB, $ECBD +
 * $12; the reveal wrote it) until it arrives. The card is written on that
 * frame C (`$83:D4F6`; web_hole 3911-3921). From C, the same offsets on
 * web_hole and c1n (3150):
 *
 *   C + 31    song 25 ($97, $83:D2B6), or in one: song 0 ($7E) and the night
 *   C + 58    in one: song 26 ($98, $83:D2DD)
 *   C + 386   in one: the 1UP ($80:F62D; c1n's sfx $2D, unconfirmed frame)
 *   C + 94    the bonus tomato ($80:F69E; in one C + 445, unconfirmed)
 *   C + 147   song 24 ($96, the star warp $83:C748; in one C + 498)
 *   C + 410   the screen blank before the RESULT card (in one C + 760):
 *             HoleOver, until the card's button (`nextHole`)
 */
export const HOLEOUT_PAN_FROM = 1;
export const HOLEOUT_CUP_RAISE = 0x12; // $83:C8A0: ADC #$0012 to $ECBD
export const HOLEOUT_SONG_AT = 31;
export const HOLEOUT_HIO_SONG_AT = 58;
export const HOLEOUT_HIO_LIFE_AT = 386;
export const HOLEOUT_BONUS_AT = 94;
export const HOLEOUT_HIO_BONUS_AT = 445;
export const HOLEOUT_WARP_AT = 147;
export const HOLEOUT_HIO_WARP_AT = 498;
export const HOLEOUT_FRAMES = 410;
export const HOLEOUT_HIO_FRAMES = 760;

/** Schedule item 4: the phase clock's own transitions and timelines. */
export function updateHoleFlow(world: World, ctx: Ctx): void {
  const { phase, t } = phaseNow(world);
  switch (phase) {
    case 'RollEnd':
      if (t >= ROLL_END_MIN && !world.get(TomatoQueue)!.visible) rollOutcome(world);
      return;
    case 'SettleWait':
      if (t === SETTLE_WAIT && tomatoes(world) === 0) {
        // $80:F3AC: the 30-frame wait is over and no tomato is left
        enterPhase(world, 'OutOfTomatoes');
        outOfTomatoes(world, 0); // its first frame is this one (web_tomatoes 3606)
        return;
      }
      if (t >= SETTLE_FRAMES) enterPhase(world, 'ShotSetup'); // the turn top, $80:F278
      return;
    case 'Tired':
      tired(world, t);
      return;
    case 'OutOfTomatoes':
      outOfTomatoes(world, t);
      return;
    case 'BallLost':
      if (t === LOST_ZERO_AT) {
        setTomatoes(world, 0);
        emitEvent(world, 'song', 0); // $7E: no song
      }
      if (t === LOST_SFX_AT) emitEvent(world, 'ball-lost', 0x54);
      if (t >= LOST_RESET_AT) {
        resetToOrigin(world, ctx);
        enterPhase(world, 'Respawn');
      }
      return;
    case 'Respawn':
      if (t === RESPAWN_SONG_AT) emitEvent(world, 'song', HOLE_SONG);
      if (t === RESPAWN_LIFE_AT) loseLife(world);
      if (t >= REFILL_FIRST && t < REFILL_FIRST + REFILL_STEP * REFILL_TRIES && (t - REFILL_FIRST) % REFILL_STEP === 0) {
        changeTomatoes(world, 1);
      }
      if (t >= RESPAWN_FRAMES) enterPhase(world, 'ShotSetup');
      return;
    case 'LaunchDelay':
      if (t >= LAUNCH_FRAMES) {
        // $82:C84E: the roll's pose from the latched selectors
        const e = ball(world);
        const shot = world.get(Shot)!;
        e.set(Pose, { ...e.get(Pose)!, state: rollPoseState(shot.rollSide, shot.rollTB, shot.grounder !== 0), timer: 0 });
        enterPhase(world, 'Rolling');
      }
      return;
    case 'HoleOut':
      holeOut(world, t);
      return;
    default:
      return;
  }
}

/**
 * $80:C79A (see TIRED_*): each frame the pan toward Kirby until it
 * arrives, then pose 11 and the wait; at its end the set-up resumes at its
 * second frame ($80:C4FF). `length` holds the wait, then its end.
 */
function tired(world: World, t: number): void {
  const flow = world.get(HoleFlow)!;
  const e = ball(world);
  const pose = e.get(Pose)!;
  if (pose.state !== PoseState.Tired) {
    const sc = e.get(BallScreen)!;
    const cam = { ...world.get(Camera)! };
    panStep(cam, sc.x, sc.y);
    world.set(Camera, cam);
    if (cam.arrived) {
      e.set(Pose, { ...pose, state: PoseState.Tired, timer: 0 }); // $80:C7AE
      world.set(HoleFlow, { ...flow, length: t + flow.length });
    }
    return;
  }
  if (t >= flow.length) {
    enterPhase(world, 'ShotSetup');
    const f = world.get(HoleFlow)!;
    world.set(HoleFlow, { ...f, since: f.since - 1 }); // setup-shot runs its t1 this frame
  }
}

/**
 * $82:E1EE (no tomato left after a settled shot): the music stops, pose 3,
 * object $BE and song $8F (Kirby falls asleep), until it ends; then lives 0
 * -> GAME OVER, else `$80:F85C`: a life, the refill, the same hole from
 * where the ball lies.
 */
function outOfTomatoes(world: World, t: number): void {
  const e = ball(world);
  if (t === 0) emitEvent(world, 'silence', 0); // $82:E206: JSL $80:B542 with A = 0
  if (t === OOT_POSE_AT) {
    e.set(Pose, { ...e.get(Pose)!, state: PoseState.Native, timer: 0 }); // $82:E221
    emitEvent(world, 'song', 0x8f - 0x7e); // song $8F + object $BE (Kirby asleep)
  }
  if (t === OOT_SLEEP_END) {
    emitEvent(world, 'song', HOLE_SONG); // $82:E25F
    if (world.get(Career)!.lives === 0) {
      enterGameOver(world); // $80:F3B5
      return;
    }
  }
  if (t === OOT_LIFE_AT) loseLife(world);
  if (t === OOT_OBJECT_AT) emitEvent(world, 'life-object', 0x77); // $80:F89B
  if (t >= OOT_REFILL_FIRST && t < OOT_REFILL_FIRST + REFILL_STEP * REFILL_TRIES && (t - OOT_REFILL_FIRST) % REFILL_STEP === 0) {
    changeTomatoes(world, 1);
  }
  if (t >= OOT_SETUP_AT) enterPhase(world, 'ShotSetup');
}

/** The hole-out (see HOLEOUT_*). `length` holds the card's frame C once the pan has arrived. */
function holeOut(world: World, t: number): void {
  const flow = world.get(HoleFlow)!;
  const hio = flow.holeInOne !== 0;
  if (flow.length === 0) {
    if (t < HOLEOUT_PAN_FROM) return;
    const r = world.get(Reveal)!;
    const cam = { ...world.get(Camera)! };
    panStep(cam, r.panX, (r.panY + HOLEOUT_CUP_RAISE) & 0xffff);
    world.set(Camera, cam);
    if (!cam.arrived) return;
    // $83:D4F6: the card's strokes ($D82A - 1; 99 stays 99)
    const s = world.get(Session)!;
    const c = world.get(Career)!;
    const strokes = ball(world).get(Strokes)!.n;
    c.card[s.holeIndex] = strokes >= STROKES_MAX ? STROKES_MAX : strokes - 1;
    world.set(HoleFlow, { ...flow, length: t });
    return;
  }
  const c = t - flow.length;
  if (c === HOLEOUT_SONG_AT) emitEvent(world, 'song', hio ? 0 : 0x97 - 0x7e);
  if (hio && c === HOLEOUT_HIO_SONG_AT) emitEvent(world, 'song', 0x98 - 0x7e);
  if (hio && c === HOLEOUT_HIO_LIFE_AT) gainLife(world);
  if (c === (hio ? HOLEOUT_HIO_BONUS_AT : HOLEOUT_BONUS_AT)) changeTomatoes(world, 1); // $80:DD5A = 1
  if (c === (hio ? HOLEOUT_HIO_WARP_AT : HOLEOUT_WARP_AT)) emitEvent(world, 'song', 0x96 - 0x7e);
  if (c >= (hio ? HOLEOUT_HIO_FRAMES : HOLEOUT_FRAMES)) enterPhase(world, 'HoleOver');
}

function enterGameOver(world: World): void {
  enterPhase(world, 'GameOver');
  emitEvent(world, 'game-over');
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
    // $80:C79A: the turn top's tired pose first, with 1 or 2 tomatoes
    const flow = world.get(HoleFlow)!;
    const n = tomatoes(world);
    if (n < 3 && flow.prev !== 'Tired') {
      enterPhase(world, 'Tired');
      world.set(HoleFlow, { ...world.get(HoleFlow)!, length: n === 1 ? TIRED_WAIT + TIRED_WAIT_ONE : TIRED_WAIT });
      tired(world, 0);
      return;
    }
    // $80:C4FF: the shot set-up; strokes + 1 unless at 99 ($80:C506)
    const st = e.get(Strokes)!;
    if (st.n + 1 <= STROKES_MAX) e.set(Strokes, { n: st.n + 1 });
    const w = e.get(BallWork)!;
    w.lost &= ~1; // $80:C519 TRB #$8001
    w.lost &= ~0x8000;
    e.set(BallSprite, { prio: PRIO_OVER }); // $80:C52F-$80:C535: $D96A = 3
    e.set(StillCount, { over: e.get(StillCount)!.over, frames: 0 }); // $80:C589
    e.set(Modifier, { kind: -1, window: 0, timer: 0 });
    const cam = world.get(Camera)!;
    world.set(Camera, { ...cam, mode: 2, wantX: 0, wantY: 0, lagX: 0, lagY: 0 }); // $80:C574-$80:C586
    // $82:8E41: the free enemy nearest the ball (owner 2, kind $40-$57); once
    // the cup is out there is none, and the target stays the cup's
    // ($82:8B5C wrote it)
    const pos = e.get(BallPos)!;
    let { targetXc, targetXf, targetYc, targetYf } = shot;
    const free = freeEnemies(world).map((en) => en.get(Cell)!);
    const i = nearestEnemy(pos.xc, pos.xf, pos.yc, pos.yf, free);
    if (i >= 0) {
      targetXc = free[i].x;
      targetYc = free[i].y;
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
  // $82:C076 (still count) set the shot over: the roll loop ends (RollEnd)
  if (e.get(StillCount)!.over === 0) return;
  void w;
  enterPhase(world, 'RollEnd');
}

/**
 * `$80:F37A`: the roll loop has exited. Holed ($D956: the sink's end set the
 * shot over, $81:A612), lost ($D876 bit 0) or settled.
 */
function rollOutcome(world: World): void {
  const e = ball(world);
  if (e.get(BallHoled)!.holed !== 0) {
    const hio = e.get(Strokes)!.n === 2 ? 1 : 0; // $83:D2AB tests $D82A == 2
    enterPhase(world, 'HoleOut');
    world.set(HoleFlow, { ...world.get(HoleFlow)!, holeInOne: hio, length: 0 });
    return;
  }
  if ((e.get(BallWork)!.lost & 1) !== 0) {
    if (world.get(Career)!.lives === 0) {
      enterGameOver(world); // $80:F387: no life left to lose
      return;
    }
    enterPhase(world, 'BallLost');
    return;
  }
  enterPhase(world, 'SettleWait');
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
  e.set(BallSprite, { prio: PRIO_OVER }); // $80:F59A -> $80:F5BD: $D96A = 3 (the block's lost bit)
  e.set(Pose, { ...e.get(Pose)!, state: PoseState.Hold, timer: 0 });
  const p = project(ctx.course, shot.originXc, shot.originXf, shot.originYc, shot.originYf, shot.originZ);
  const sc = e.get(BallScreen)!;
  e.set(BallScreen, { ...sc, x: p.x, y: p.y });
  const cam = world.get(Camera)!;
  world.set(Camera, { ...cam, x: (p.x - 0x80) & 0xffff, y: (p.y + 0x70) & 0xffff });
}

/** The phase in which the ball step runs: the roll loop (the sink after holing included). */
export function ballStepRuns(world: World): boolean {
  return phaseNow(world).phase === 'Rolling';
}
