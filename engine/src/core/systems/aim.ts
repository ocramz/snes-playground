/**
 * The aim stage, the loop $81:A680-$81:A80A (schedule items 6 and 7; read
 * 2026-11-14, build/engine/disasm/flow-aim.txt). One iteration a frame:
 *
 *   A pressed  -> sfx $34, pose 4, the loop returns ($81:A780): PanToShot
 *   $81:B555   the d-pad turns the aim / picks the shot kind
 *   $81:BB4A   the facing, when the aim changed
 *   $81:BA8A   the camera pans toward the guide's end (update-camera)
 *   $81:A7E6   pose 5 while a direction is held or L/R pressed, else 4
 *   $81:A956   on a change: the guide again ($6ACE = 1, $6ADA = 16), sfx
 *              $53; in a fly shot, 16 quiet iterations later the full guide
 *              ($6ACE = $6ACC). The guide outlasts the frame: the loop's
 *              next iteration comes `guideLagFrames` later (Stall guideLag).
 *
 * port_v2 phase 7 adds Start (the pause menu), B (the spin preset), Y (the
 * look around), L/R (the 45-degree snaps) and the idle timer (the score
 * panel): updateAim's header, systems/aim-ui.ts.
 */
import type { World } from 'koota';
import { Pad } from '../traits/pad';
import { Shot, GUIDE_FULL_ENDS } from '../traits/shot';
import { Guide } from '../traits/guide';
import { Camera } from '../traits/camera';
import { Pose, PoseState } from '../traits/pose';
import { BallWork, BallPos } from '../traits/ball';
import { Stall } from '../traits/stall';
import type { Ctx } from '../sim/context';
import { aimPad, PAD, type AimInput } from '../sim/aim';
import { facingFromAim } from '../sim/facing';
import { simulateGuide } from '../sim/guide';
import { aimQuarter } from '../sim/camera';
import { BallScreen } from '../traits/pose';
import { emitEvent, enterPhase, frameOf, phaseNow } from './flow-util';
import { activePlayer } from '../traits/player';
import { AimUi, IDLE_FRAMES } from '../traits/aim-ui';
import { panStep } from '../sim/camera';
import { Session } from '../traits/session';
import {
  scorecard, pauseMenu, openPause, presetStep, endPreset, lookScroll, lookArrows, showPanel, hidePanel, panelShown,
} from './aim-ui';

/**
 * Schedule item 6: one aim iteration, in the game's order (`$81:A680`-
 * `$81:A80A`; port_v2 phase 7 adds the pause, B, Y, L/R and the idle timer):
 *
 *   `$EA7E` (the pause open)  -> `$81:BDAD`, then the pose
 *   `$6B38` (the lockout)     -> one less; B is skipped this iteration
 *   B held / the preset up    -> `$83:B214` (with Y: the look too); the
 *                                 release ends the preset (`$81:A6DA`)
 *   Y held                    -> the idle timer 90; with the d-pad the look
 *                                 (`$81:B9A2`); alone, the score panel
 *   the look on (Y released)  -> the pan back; arrived: the look ends
 *   Start pressed             -> the pause opens
 *   A pressed                 -> sfx `$34`, pose 4: PanToShot
 *   otherwise                 -> the d-pad and L/R (`$81:B555`), the facing
 *   `$81:A7B5`                -> the pan toward the aim's target (update-camera)
 *   `$81:A7BF`                -> the idle timer: 90 quiet iterations show the
 *                                 score panel; a change or the look hides it
 *   `$81:A7E6`                -> pose 5 while turning, else 4
 *   `$81:B908`                -> the look's arrows
 */
export function updateAim(world: World, ctx: Ctx): void {
  const { phase, t } = phaseNow(world);
  if (phase !== 'Aim' || t === 0) return;
  const pad = world.get(Pad)!;
  const e = activePlayer(world);
  world.set(AimUi, { ...world.get(AimUi)!, pan: 0 });
  // $81:BCB6: SELECT's mid-course card blocks the iteration while it is up
  if (scorecard(world, pad.pressed, holeSongOf(world))) return;
  const ui = () => world.get(AimUi)!;
  const setUi = (patch: Partial<ReturnType<typeof ui>>): void => world.set(AimUi, { ...ui(), ...patch });
  let facingChange = t === 1; // $81:A665/$81:A669 (the head's tail, t = 1)
  let idleStep = true; // $81:A7BF is reached (the pause skips it)
  if (ui().pause !== 0) {
    pauseMenu(world, pad.pressed); // $81:BDAD, then JMP $A7E6
    idleStep = false;
  } else {
    let route: 'y' | 'pan' | 'idle' = 'y';
    if (ui().lockout !== 0) {
      setUi({ lockout: ui().lockout - 1 }); // $81:A696
    } else if (ui().preset !== 0 || (pad.held & PAD.B) !== 0) {
      if ((pad.held & PAD.B) !== 0) {
        // $81:A6B0: Y with B starts the look too
        if ((pad.held & PAD.Y) !== 0 && ui().look === 0) setUi({ look: 1, arrows: ui().arrows === 0 ? 1 : ui().arrows });
        presetStep(world, pad.held); // $83:B214
        if (ui().look === 0) {
          setUi({ arrows: 0 });
          route = 'pan'; // $81:A6D4
        } else {
          route = 'idle'; // $81:A6D7
        }
      } else {
        endPreset(world); // $81:A6DA
      }
    }
    if (route === 'y') {
      const shot = world.get(Shot)!;
      if ((pad.held & PAD.Y) !== 0) {
        world.set(Shot, { ...shot, idle: IDLE_FRAMES }); // $81:A6F5
        if (ui().look !== 0) {
          if ((pad.held & PAD.DPAD) !== 0) lookScroll(world, pad.held); // $81:A705
        } else if ((pad.held & PAD.DPAD) !== 0) {
          setUi({ look: 1, arrows: ui().arrows === 0 ? 1 : ui().arrows }); // $81:A714
          if (panelShown(world)) hidePanel(world); // $81:A724
        } else {
          if (ui().arrows === 0) setUi({ arrows: 1 }); // $81:A72A
          if (!panelShown(world)) showPanel(world); // $81:A737
        }
        route = 'idle';
      } else {
        // $81:A73E
        if (panelShown(world) && shot.idle !== 0 && ui().look !== 0) hidePanel(world); // $81:A74D
        if (ui().look !== 0) {
          // $81:A756: the pan back to the aim's target; arrived, the look ends
          const cam = { ...world.get(Camera)! };
          panStep(cam, cam.targetX, cam.targetY);
          world.set(Camera, cam);
          if (cam.arrived !== 0) setUi({ arrows: 0, look: 0 });
          route = 'idle';
        } else {
          setUi({ arrows: 0 }); // $81:A76E
          if ((pad.pressed & PAD.START) !== 0) {
            openPause(world); // $81:A779, then JMP $A7E6
            idleStep = false;
            route = 'idle';
          } else if ((pad.pressed & PAD.A) !== 0) {
            // $81:A780: the aim is confirmed
            if (panelShown(world)) hidePanel(world); // $81:A78D
            emitEvent(world, 'aim-confirm', 0x34);
            e.set(Pose, { ...e.get(Pose)!, state: PoseState.Aim });
            // $81:BE9A: the shot view, Kirby + the quarter's offset
            const sc = e.get(BallScreen)!;
            const q = aimQuarter(shot.aim);
            world.set(Shot, {
              ...shot,
              viewX: (sc.x + ctx.rules.table('shotViewX')[q]) & 0xffff, // $81:C0F0
              viewY: (sc.y + ctx.rules.table('shotViewY')[q]) & 0xffff, // $81:C0F8
            });
            enterPhase(world, 'PanToShot');
            return;
          } else {
            const s: AimInput = {
              aim: shot.aim, hold: shot.hold, kind: shot.kind, grounder: shot.grounder,
              elev: shot.elev, guideSide: shot.guideSide, guideTB: shot.guideTB, changed: shot.changed,
            };
            aimPad(s, pad.held, pad.pressed, ctx.rules.table('aimSnap'));
            world.set(Shot, { ...shot, ...s });
            if (s.changed !== 0) facingChange = true; // $81:A7A8
            route = 'pan';
          }
        }
      }
    }
    if (route === 'pan') setUi({ pan: 1 }); // $81:A7B5: update-camera pans
    if (idleStep) {
      // $81:A7BF: the idle timer
      const shot = world.get(Shot)!;
      if (ui().look === 0 && shot.changed === 0) {
        if (shot.idle !== 0) {
          const idle = shot.idle - 1;
          world.set(Shot, { ...shot, idle });
          if (idle === 0) showPanel(world); // $81:A7D1
        }
      } else {
        world.set(Shot, { ...shot, idle: IDLE_FRAMES }); // $81:A7D7
        if (panelShown(world)) hidePanel(world); // $81:A7E2
      }
    }
  }
  // $81:A7E6: the pose
  const pose = e.get(Pose)!;
  let { facing, angle } = pose;
  if (facingChange) ({ facing, angle } = facingFromAim(ctx.rules, world.get(Shot)!.aim));
  const turning = (pad.pressed & (PAD.L | PAD.R)) !== 0 || (pad.held & PAD.DPAD) !== 0;
  e.set(Pose, { ...pose, state: turning ? PoseState.AimTurn : PoseState.Aim, facing, angle });
  lookArrows(world); // $81:A80A
}

/** The hole's song (`$80:C967`, CourseData.song). */
function holeSongOf(world: World): number {
  const s = world.get(Session)!;
  return s.courses[s.holeIndex]?.song ?? 0;
}

/**
 * Schedule item 7, $81:A956: the guide again when the aim changed; in a fly
 * shot, the full guide once the aim has been still for 16 iterations.
 */
export function updateShotGuide(world: World, ctx: Ctx): void {
  publishGuide(world);
  const { phase, t } = phaseNow(world);
  if (phase !== 'Aim' || t === 0) return;
  const shot = world.get(Shot)!;
  if (shot.changed !== 0) {
    world.set(Shot, {
      ...shot,
      guideEnds: 1,
      guideTimer: (GUIDE_FULL_ENDS as number) !== 1 ? 16 : 0, // $81:A964
      changed: 0,
    });
    // $81:A977 -> $81:A98B: the guide first, then the facing and the tick:
    // the sound comes on the lag's last frame (web_flow 2336 -> 2338)
    requestGuide(world, ctx, -1, 0x53);
    return;
  }
  if (shot.kind === 2 && shot.guideTimer !== 0) {
    const left = shot.guideTimer - 1;
    world.set(Shot, { ...shot, guideTimer: left });
    if (left === 0) {
      world.set(Shot, { ...world.get(Shot)!, guideEnds: GUIDE_FULL_ENDS });
      requestGuide(world, ctx, -1, 0x53); // $81:A9AC: JMP $A970, the same path and tick
    }
  }
}

/**
 * $81:AE26-$81:AE2F: a guide computed on an earlier frame has written its
 * first end, projected, as the aim camera's target. (The ROM writes it at
 * the guide's end, which falls in the lag's last frame; the loop's next
 * iteration is the first to pan toward it.)
 */
export function publishGuide(world: World): void {
  const g = world.get(Guide)!;
  if (g.pendingFrame < 0 || g.pendingFrame >= frameOf(world) || g.ends.length === 0) return;
  const cam = world.get(Camera)!;
  world.set(Camera, { ...cam, targetX: g.ends[0].sx, targetY: g.ends[0].sy });
  g.pendingFrame = -1;
}

/**
 * Simulate the guide now and keep its result; the camera picks the new
 * target up on the next frame it runs (Guide.pendingFrame). `lag` -1 asks
 * for the measured lag of the loop; 0 for none (the set-up's guide).
 */
export function requestGuide(world: World, ctx: Ctx, lag: number, tick = -1): void {
  const shot = world.get(Shot)!;
  const e = activePlayer(world);
  const live = e.get(BallWork)!;
  const pos = e.get(BallPos)!;
  // the live work copy carries the block's position; the guide restarts
  // from the origin ($81:BB18)
  const seed = { ...live, xc: pos.xc, xf: pos.xf, yc: pos.yc, yf: pos.yf, z: pos.z };
  const r = simulateGuide(ctx, seed, {
    aim: shot.aim,
    elev: shot.elev,
    kind: shot.kind,
    grounder: shot.grounder,
    guideSide: shot.guideSide,
    guideTB: shot.guideTB,
    ends: Math.max(1, shot.guideEnds),
    originXf: shot.originXf, originXc: shot.originXc,
    originYf: shot.originYf, originYc: shot.originYc, originZ: shot.originZ,
  }, ctx.course);
  live.wallCode = r.wallCode; // the guide ran on the real work copy
  live.boostFlash = r.boostFlash; // $6A28: a global the guide's boost hits write
  live.guideTile = r.tile; // $DA0A until the next step reloads the block
  live.guideLeft = 1;
  if (r.rollMu !== null) {
    // $DA3A/$6A72: the guide's last rolling step's ($81:B24C); the coefficients are work-only here
    live.rollMu = r.rollMu;
    live.classIndex = r.classIndex;
  }
  const g = world.get(Guide)!;
  g.points = r.points;
  g.ends = r.ends;
  g.steps = r.steps;
  g.version += 1;
  g.pendingFrame = frameOf(world); // (AoS: the trait's object, mutated in place)
  const frames = lag < 0 ? guideLagFrames(r.steps, shot.kind === 2, shot.guideEnds > 1) : lag;
  if (frames > 1) {
    world.set(Stall, { ...world.get(Stall)!, kind: 'guideLag', framesLeft: frames, resumeAt: -1, sfx: tick });
  } else {
    if (frames === 1) world.set(Stall, { ...world.get(Stall)!, kind: 'guideLag', framesLeft: 1, resumeAt: -1, sfx: -1 });
    if (tick >= 0) emitEvent(world, 'aim-tick', tick);
  }
}

/**
 * How many frames the guide costs the aim loop: its next iteration comes
 * this many frames later. Measured, not derived (the guide's cycle count is
 * not modelled): a 40-step rolling guide gives 3 (web_flow 2353/2356, every
 * auto-repeat step), a fly shot's guide to its first landing 5 (web_ui
 * 2600/2605), the fly shot's full guide (3 ends, $6ACC) 8 (web_fly and
 * web_ui: requested at 2620, its tick at 2627 — phase 6, from the sound
 * log). Approximated as 1 + ceil(steps / 20) for rolling guides and the
 * measured 5 / 8 for airborne ones; notes/engine-phase5-flow.md.
 */
export function guideLagFrames(steps: number, fly: boolean, full = false): number {
  if (fly) return full ? 8 : 5;
  return 1 + Math.ceil(steps / 20);
}
