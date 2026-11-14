/**
 * The shot thread $81:BE91 (schedule items 8-10; read 2026-11-14,
 * build/engine/disasm/flow-panel.txt): the pan to the shot view, the curl,
 * the panel's spin stage, the power meter, and the launch. Frame offsets
 * are the thread's yields as the flow traces show them
 * (notes/engine-phase5-flow.md):
 *
 *   PanToShot  P = the A press. P+5: the first pan; from P+6 each frame
 *              first asks whether the last pan found the camera there
 *              ($6AB0, $81:BEE6), then pans again. Arrived -> pose 6, Spin.
 *   Spin       C = the curl. C+39/C+41: the panel object shows the meter
 *              as $FFFF, then 0 ($84:8FD9/$84:9073). C+42: the selectors'
 *              first frame ($81:C12E); from C+43 an A press ends the stage.
 *   Power      Q = that press. Q+4: sfx $57; from Q+5 each frame tests A
 *              (latch) before the meter moves; it fires by itself at 0.
 *   LaunchDelay R = the latch. R+1: power and spin ($81:C2E6, $81:C1D5);
 *              R+22: the roll's start ($82:BFBC: the follow's lag, sfx
 *              $18 or $19 at full power, the launch velocity into the
 *              block); R+24: the first physics step (hole-flow.ts).
 */
import type { World } from 'koota';
import { Pad } from '../traits/pad';
import { Shot, METER_TOP, TB_PERIOD } from '../traits/shot';
import { Camera } from '../traits/camera';
import { Pose, PoseState, BallScreen } from '../traits/pose';
import { BallVel, BallAir, BallSpin, StillCount, BallWork, emptyWork } from '../traits/ball';
import type { Ctx } from '../sim/context';
import { PAD } from '../sim/aim';
import { shotPower, launchVelocity, shotSpin } from '../sim/shot';
import { ball, emitEvent, enterPhase, phaseNow } from './flow-util';

export const PAN_DELAY = 4;
export const PANEL_METER_HIDE = 39;
export const PANEL_METER_SHOW = 41;
export const SPIN_FIRST = 42;
export const POWER_SFX_AT = 4;
export const POWER_FIRST = 5;
export const ROLL_START_AT = 22;

/** Schedule item 8: the curl's trigger, the panel and the spin stage. */
export function updateSpinStage(world: World): void {
  const { phase, t } = phaseNow(world);
  if (phase === 'PanToShot') {
    if (t > PAN_DELAY && world.get(Camera)!.arrived !== 0) {
      // $81:BEEB: the camera is on the shot view: Kirby curls
      const e = ball(world);
      e.set(Pose, { ...e.get(Pose)!, state: PoseState.Curl, timer: 0 });
      const shot = world.get(Shot)!;
      // $81:BF41-$81:BF62: the panel's initial state
      world.set(Shot, {
        ...shot,
        tbTimer: TB_PERIOD,
        meter: 0,
        meterDir: 1,
        topBack: 6,
        sideTimer: 1,
        tbDir: -1,
      });
      enterPhase(world, 'Spin');
    }
    return;
  }
  if (phase !== 'Spin') return;
  if (t === PANEL_METER_HIDE) world.set(Shot, { ...world.get(Shot)!, meter: 0xffff });
  if (t === PANEL_METER_SHOW) world.set(Shot, { ...world.get(Shot)!, meter: 0 });
  if (t < SPIN_FIRST) return;
  const pad = world.get(Pad)!;
  if (t > SPIN_FIRST) {
    // $81:BFB5-$81:BFCC: (B cancels: not ported) A goes to the power stage
    if ((pad.pressed & PAD.A) !== 0) {
      enterPhase(world, 'Power');
      return;
    }
  }
  selectors(world, pad.held);
  const shot = world.get(Shot)!;
  world.set(Shot, { ...shot, guideSide: shot.side }); // $81:BFB5
}

/** $81:C12E: the side selector on Left/Right; top/back by itself in a fly shot. */
function selectors(world: World, held: number): void {
  const s = { ...world.get(Shot)! };
  const step = (): boolean => {
    // $81:C1C7: one step on the first frame, then every 8
    s.sideTimer -= 1;
    if (s.sideTimer !== 0) return false;
    s.sideTimer = 8;
    return true;
  };
  if ((held & PAD.RIGHT) !== 0) {
    if (step()) {
      s.side += 1;
      if (s.side > 12) s.side = 12;
      else emitEvent(world, 'spin-side', 0x46);
    }
  } else if ((held & PAD.LEFT) !== 0) {
    if (step()) {
      s.side -= 1;
      if (s.side < 0) s.side = 0;
      else emitEvent(world, 'spin-side', 0x46);
    }
  } else {
    s.sideTimer = 1;
  }
  if (s.elev !== 0 && s.elev !== 0xffff) {
    // $81:C170: top/back walks by itself, 6 -> 0 -> 12 -> 0 ...
    s.tbTimer -= 1;
    if (s.tbTimer === 0) {
      s.tbTimer = TB_PERIOD;
      s.topBack += s.tbDir;
      if (s.topBack === 0 || s.topBack === 12 || s.topBack === 6) {
        emitEvent(world, 'spin-tb', s.topBack === 6 ? 0x42 : 0x3d);
        s.tbTimer <<= 1; // $81:C1AC: it pauses twice as long there
      }
      if (s.topBack === 0 || s.topBack === 12) s.tbDir = -s.tbDir;
    }
  }
  world.set(Shot, s);
}

/** Schedule item 9: the power meter. */
export function updatePowerMeter(world: World): void {
  const { phase, t } = phaseNow(world);
  if (phase !== 'Power') return;
  if (t === POWER_SFX_AT) emitEvent(world, 'power-start', 0x57);
  if (t < POWER_FIRST) return;
  const pad = world.get(Pad)!;
  const shot = world.get(Shot)!;
  if ((pad.pressed & PAD.A) !== 0) {
    enterPhase(world, 'LaunchDelay'); // $81:C035: latched as it is
    return;
  }
  let meter = shot.meter + shot.meterDir;
  let dir = shot.meterDir;
  if (meter <= 0) {
    world.set(Shot, { ...shot, meter: 0 }); // $81:C032: it fires by itself
    enterPhase(world, 'LaunchDelay');
    return;
  }
  if (meter >= METER_TOP) {
    meter = METER_TOP;
    dir = -dir;
  }
  world.set(Shot, { ...shot, meter, meterDir: dir });
}

/** Schedule item 10: power and spin, then the roll's start. */
export function launchBall(world: World, ctx: Ctx): void {
  const { phase, t } = phaseNow(world);
  if (phase !== 'LaunchDelay') return;
  const e = ball(world);
  const shot = world.get(Shot)!;
  if (t === 1) {
    // $81:C04C / $81:C050: the power and the spin
    const fly = shot.elev !== 0;
    const power = shotPower(ctx.rules, shot.meter, fly);
    const tmp = emptyWork();
    tmp.shotAim = shot.aim;
    tmp.shotElev = shot.elev;
    shotSpin(ctx.rules, tmp, shot.side, shot.topBack, power);
    e.set(BallSpin, { sx: tmp.spinX, sy: tmp.spinY, pending: tmp.spinPending });
    // $81:C0C7-$81:C0D3: the selectors the roll's pose reads
    world.set(Shot, { ...shot, power, rollSide: shot.side, rollTB: shot.topBack });
    return;
  }
  if (t === ROLL_START_AT) {
    // $81:C0DF: the launch velocity; $82:BFBC: the roll starts
    const tmp = emptyWork();
    tmp.shotAim = shot.aim;
    tmp.shotElev = shot.elev;
    launchVelocity(ctx.rules, tmp, shot.power, shot.grounder !== 0 ? 0 : -1);
    e.set(BallVel, { vx: tmp.vx, vy: tmp.vy, vz: tmp.vz });
    const fly = shot.grounder === 0;
    e.set(BallAir, { air: fly ? 1 : 0 });
    const w = e.get(BallWork)!;
    w.air = fly ? 1 : 0;
    w.airFrames = 0;
    e.set(StillCount, { over: 0, frames: 0 });
    // $82:BFBC: the follow starts locked on the shot view
    const sc = e.get(BallScreen)!;
    const cam = world.get(Camera)!;
    world.set(Camera, {
      ...cam,
      lagX: (shot.viewX - sc.x) & 0xffff,
      lagY: (shot.viewY - sc.y) & 0xffff,
    });
    emitEvent(world, 'launch', shot.meter === METER_TOP ? 0x19 : 0x18); // $82:BFF0
  }
}

/** $82:C815-$82:C84E: the roll's pose from the latched selectors. */
export function rollPoseState(rollSide: number, rollTB: number): number {
  const d = Math.max(Math.abs(rollSide - 6), Math.abs(rollTB - 6));
  return d < 3 ? PoseState.Roll : d === 3 ? PoseState.RollMedium : PoseState.RollStrong;
}
