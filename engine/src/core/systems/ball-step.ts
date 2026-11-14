/**
 * The ball step, schedule items 11-29 (plans/port_v1_koota_phaser4.md), one
 * entry per original routine, in the ROM's order: the roll loop's
 * $82:EFCF (load), $81:801C (the step, ending in its tail $81:9BE5),
 * $82:CDBB (the Kirby state code: the A/Y arming $82:DA51 and the bounce
 * bonus $82:DB20, read 2026-11-14 — the plan's items 12 and 27 sit after
 * the physics), the store and $81:A5CD (the still count). The stall runner
 * (schedule.ts) suspends the list at the hit-stop: the landing chain splits
 * exactly where $81:8C95 blocks for 4 frames, and a step hit for 2
 * ($81:8C48). The `kernel` entries double as the shot guide's step
 * (`runKernelStep`).
 */
import type { World } from 'koota';
import { Time } from '../traits/time';
import { Pad } from '../traits/pad';
import { Shot } from '../traits/shot';
import { emptyWork } from '../traits/ball';
import {
  BallPos, BallVel, BallAir, BallSpin, BallMode, BallHoled, BallHeading,
  StillCount, Modifier, BallWork, type BallWorkFields,
} from '../traits/ball';
import type { Ctx } from '../sim/context';
import { probe } from '../sim/probe';
import { integrate, airDrag, fallBelowCourse } from '../sim/move';
import { updateHeading } from '../sim/reflect';
import { crossEdges } from '../sim/edges';
import { dispatchLanding, finishLanding, stepHitStop, gravityTail, type LandingOutcome } from '../sim/landing';
import { rollDefault, classIndex, type RollModifier } from '../sim/roll';
import { wallBounce, stepBounce, launch } from '../sim/wall-step';
import { landDispatch, hitDispatch, type DispatchOutcome } from '../sim/dispatch';
import { mulQ15s } from '../fixed';
import { countStill } from '../sim/still';
import { s16, wrap16, mul16x8 } from '../fixed';
import { emit } from '../events';
import { Stall } from '../traits/stall';
import { Pose, PoseState } from '../traits/pose';
import { takeEnemy } from './take';
import { pushTomato } from './counters';
import { hazardReaction } from './hazard-reaction';

/** The route `select-outcome` computes; exactly one branch then runs. */
export type BallRoute =
  | { kind: 'wall' }  // $81:88AF/$81:8A03 -> sub_wall_bounce
  | { kind: 'step' }  // $81:88C4/$81:8A19 -> sub_step_bounce
  | { kind: 'drop' }  // $81:8B78 -> loc_launch
  | { kind: 'land' }  // $81:811B -> the landing dispatch
  | { kind: 'roll' }  // $81:8436 -> the hit dispatch
  | { kind: 'fell' }  // $81:89AA: below z 0 - gravity ran, the step ends
  | { kind: 'done' }; // the step ended (lost, gravity-only fall, holed)

interface StepState {
  ctx: Ctx;
  w: BallWorkFields;
  modifier: RollModifier;
  route: BallRoute;
  /** The landing chain's pending outcome across a hit-stop suspension. */
  outcome?: LandingOutcome;
  reroute?: 'landing' | 'rolling' | 'done';
  entry?: 'full' | 'grounded' | 'gravityOnly';
}

/** A stall the step asks for: the runner suspends the list after the entry. */
interface StallRequest {
  kind: 'hitStop' | 'stepStop' | 'cupReveal' | 'takeWait';
  frames: number;
  state: number;
}

/**
 * One entry per original routine. `kernel` entries touch only the work copy
 * and the context, so the shot guide runs them on a clone with no world
 * (`runKernelStep`); the others read or write traits or emit events.
 */
export interface StepEntry {
  name: string;
  kernel: boolean;
  run: (world: World, s: StepState) => StallRequest | null;
}

export const BALL_STEP: StepEntry[] = [
  {
    // $82:F030: the block -> the work copy
    name: 'load-ball-work',
    kernel: false,
    run: (world, s) => {
      loadBallWork(world, s.w);
      return null;
    },
  },
  {
    // $81:801C prologue + $81:8751: clear the facts, mark the heading
    // invalid, copy the previous-frame state
    name: 'begin-ball-step',
    kernel: true,
    run: (_world, s) => {
      const w = s.w;
      w.bounced = 0;
      w.hitStep = 0;
      w.hitWall = 0;
      w.fact4 = 0;
      w.hitStopLatch = 0;
      w.enemyHit = 0;
      w.holedIn = 0;
      w.sunk = 0;
      w.sfxNow = 0xffff;
      w.hurt = 0;
      w.tomatoLoss = 0;
      w.hazardHit = 0;
      w.deg = 0xffff;
      copyPrev(w);
      s.route = w.air !== 0 ? { kind: 'land' } : { kind: 'roll' };
      s.outcome = undefined;
      s.reroute = undefined;
      s.entry = undefined;
      return null;
    },
  },
  {
    // $81:8805/$81:89C2 + $81:8E60 + $81:9479 + $81:87FB + $81:9001
    name: 'move-probe-edges',
    kernel: true,
    run: (_world, s) => {
      const w = s.w;
      if (w.air !== 0) {
        integrate(w);
        if (w.mode !== 0x0a) airDrag(w); // $81:885C
        updateHeading(s.ctx.rules, w);
        w.airFrames += 1;
        probe(s.ctx, w);
        overlayProbe(w);
        w.dampXY = w.bounceSrcX; // $81:8050
        w.dampZ = w.bounceSrcZ;
        if (w.z < 0) {
          // $81:89AA: z < -$11_0000 -> lost; otherwise gravity only, and
          // the step ends either way ($81:89AF / $81:89B2). The gravity is
          // applied here (JMP $899F); nothing else runs.
          fallBelowCourse(w, highWord(w.z));
          s.route = { kind: 'fell' };
          return null;
        }
        crossEdges(s.ctx, w);
        return null;
      }
      // rolling: integrate x/y, z = the previous ground, then probe
      integrate(w);
      w.z = w.pGround;
      updateHeading(s.ctx.rules, w);
      probe(s.ctx, w);
      overlayProbe(w);
      classIndex(s.ctx, w);
      crossEdges(s.ctx, w);
      return null;
    },
  },
  {
    // $81:8069-$81:811A (airborne) / $81:80F4-$81:811A (rolling)
    name: 'select-outcome',
    kernel: true,
    run: (_world, s) => {
      const w = s.w;
      if (s.route.kind === 'done' || s.route.kind === 'fell') return null;
      if (w.wallEdge !== 0xffff) {
        // $81:806C: bounce when the ball is under half a step above the
        // ground it came from; above that the flag is dropped
        if (w.air !== 0 && w.z - w.pGround >= 0x2d41) {
          w.wallEdge = 0xffff; // $81:8085
        } else {
          s.route = { kind: 'wall' };
          return null;
        }
      }
      if (w.stepHeight > 0 && (w.air === 0 || w.z < w.ground)) {
        s.route = { kind: 'step' };
        return null;
      }
      if (w.air === 0 && w.stepHeight < 0) {
        s.route = { kind: 'drop' };
        return null;
      }
      s.route = w.air !== 0 ? { kind: 'land' } : { kind: 'roll' };
      return null;
    },
  },
  {
    // $81:9390 (via $81:88AF/$81:8A03): a layer-4 wall bounce. The outline
    // wall tiles route through the dispatch instead ($82:8FF1/$82:8FE3).
    name: 'bounce-off-wall',
    kernel: true,
    run: (_world, s) => {
      if (s.route.kind !== 'wall') return null;
      wallBounce(s.ctx, s.w);
      s.w.hitWall += 1;
      s.route = { kind: 'done' };
      s.entry = s.w.air !== 0 ? 'gravityOnly' : undefined; // $81:88C1 / RTL
      return null;
    },
  },
  {
    // $81:93D1 (via $81:88C4/$81:8A19)
    name: 'hit-step',
    kernel: true,
    run: (_world, s) => {
      if (s.route.kind !== 'step') return null;
      const w = s.w;
      stepBounce(s.ctx, w);
      w.hitStep += 1;
      w.spinX = 0;
      w.spinY = 0;
      w.spinPending = 0;
      w.tailSfx = 4; // $6A6C = 4
      if (w.air !== 0) w.vz = mulQ15s(w.vz, w.stepDampZ); // $81:88DA: vz x $DA42
      s.route = { kind: 'done' };
      s.entry = w.air !== 0 ? 'gravityOnly' : undefined; // $81:88F6 / RTL
      const hs = w.mode === 0 || w.mode === 7 ? stepHitStop(w) : null;
      return hs ? { kind: 'stepStop', frames: hs.frames, state: hs.state } : null;
    },
  },
  {
    // loc_launch $81:8B78: the rolling step ends after the launch (RTL)
    name: 'drop-off-edge',
    kernel: true,
    run: (_world, s) => {
      if (s.route.kind !== 'drop') return null;
      launch(s.ctx, s.w, s.w.pCode);
      s.route = { kind: 'done' };
      return null;
    },
  },
  {
    // $81:811B (airborne) / $81:8436 (rolling): the tile dispatch
    name: 'dispatch-tile',
    kernel: true,
    run: (_world, s) => {
      const w = s.w;
      if (s.route.kind === 'land' && w.air !== 0) {
        applyRoute(s, landDispatch(s.ctx, w, s.modifier));
      } else if (s.route.kind === 'roll') {
        applyRoute(s, hitDispatch(s.ctx, w, s.modifier));
      } else if (s.route.kind === 'done' && s.entry === undefined && s.w.air !== 0) {
        s.entry = 'gravityOnly';
      }
      return null;
    },
  },
  {
    // $82:8977 -> $82:8A2E / $82:8A98: the enemy's take, inside the tile
    // handler; when one enemy is left it becomes the cup and the step
    // blocks for the reveal ($82:8B5C). Not a kernel: the guide never takes.
    name: 'take-enemy',
    kernel: false,
    run: (world, s) => takeEnemy(world, s.ctx, s.w),
  },
  {
    // the landing chain's first half, $81:8905 (its hit-stop suspends the
    // list here)
    name: 'dispatch-landing',
    kernel: true,
    run: (_world, s) => {
      const w = s.w;
      if (s.reroute === 'landing' && s.entry !== 'gravityOnly') {
        // gravityOnly reroutes (the outline wall's hit, the cup's exits)
        // jump straight to the $81:899F tail - no landing chain
        s.outcome = dispatchLanding(s.ctx, w, s.entry === 'grounded' ? 'grounded' : 'full');
        if (s.outcome.kind === 'hitstop') {
          return { kind: 'hitStop', frames: s.outcome.frames, state: s.outcome.state };
        }
      }
      return null;
    },
  },
  {
    // $81:895B-$81:89A9 (landing) / $81:8A56 (rolling)
    name: 'finish-landing-or-roll',
    kernel: true,
    run: (_world, s) => {
      const w = s.w;
      if (s.route.kind === 'fell') return null; // $81:89AA ends the step
      if (s.reroute === 'rolling') {
        rollDefault(s.ctx, w, s.modifier);
        return null;
      }
      if (s.reroute === 'done') return null;
      if (s.entry === 'gravityOnly') {
        gravityTail(w);
        return null;
      }
      if (s.outcome) finishLanding(s.ctx, w, s.outcome);
      return null;
    },
  },
  {
    // $81:9BE5: the step's tail - the facts become events here
    name: 'emit-step-effects',
    kernel: false,
    run: (world, s) => {
      const api = { frame: world.get(Time)!.frame };
      const w = s.w;
      // inline requests: the pillar's $71 ($82:956C / $82:95F8), a bumper's $6F ($82:9CA1)
      if (w.sfxNow !== 0xffff) emit(world, api, w.sfxNow === 0x71 ? 'pillar' : 'hazard', w.sfxNow);
      for (let i = 0; i < w.hazardHit; i++) emit(world, api, 'hazard-hit'); // $82:EED8: object $2F
      for (let i = 0; i < w.tomatoLoss; i++) pushTomato(world, -1); // $83:ABC5
      if (w.holedIn !== 0) emit(world, api, 'holed-in'); // $82:AD13: object 75 over the cup
      if (w.sunk !== 0) {
        // $82:AEC1-$82:AEEF: Kirby's state 1, the music's volume to 0
        // ($80:B5F4: APU port 2 and $1003), sfx $82:AEF5[mode] ($21 in mode 0)
        const e = ballEntity(world);
        e.set(Pose, { ...e.get(Pose)!, state: PoseState.Holed, timer: 0 });
        emit(world, api, 'music-mute'); // not a sound request: no id
        emit(world, api, 'holed', s.ctx.rules.table('holedSfx')[w.mode & 0xff] ?? 0x21);
      }
      const ev = tailEvent(w);
      if (ev) emit(world, api, ev.kind, ev.romSfx);
      w.tailSfx = 0xffff;
      return null;
    },
  },
  {
    // $82:CDFF / $82:D588, the Kirby state code after the step: $82:DA51
    // arms or counts down the A/Y modifier, and while its window is open
    // $82:DB20 adds the bonus to a bounce, step or wall hit of this step
    name: 'arm-shot-modifier',
    kernel: false,
    run: (world, s) => {
      const open = armModifier(world, s.w);
      if (open) applyModifier(s.ctx, s.w);
      // $82:CE07-$82:CE27: an airborne bounce shows the roll pose again,
      // unless Kirby is hopping (update-pose reads the fact)
      if (s.w.air !== 0 && s.w.bounced !== 0 && (s.w.mode === 0 || s.w.mode >= 11)) s.w.bouncePose = 1;
      return null;
    },
  },
  {
    // $82:F1E3: the work copy -> the block
    name: 'store-ball-work',
    kernel: false,
    run: (world, s) => {
      storeBallWork(world, s.w);
      return null;
    },
  },
  {
    // $81:A5CD
    name: 'count-still-frames',
    kernel: false,
    run: (world, s) => {
      countStill(s.w);
      const e = ballEntity(world);
      e.set(StillCount, { over: s.w.over, frames: s.w.frames });
      return null;
    },
  },
  {
    // $82:C0A8: a hazard's reaction ($D780 -> $82:DB9A), after the store
    name: 'hazard-reaction',
    kernel: false,
    run: (world, s) => {
      if (s.w.hurt !== 0) hazardReaction(world, s.ctx, s.w);
      return null;
    },
  },
];

function applyRoute(s: StepState, out: DispatchOutcome): void {
  s.reroute = out.next;
  if (out.next === 'landing') s.entry = out.entry ?? 'full';
}

/** The tail sfx -> event kinds ($81:9BE5). */
function tailEvent(w: BallWorkFields): { kind: string; romSfx: number } | null {
  if (w.tailSfx !== 0xffff) {
    const kind = w.hitStep !== 0 ? 'step' : w.hitWall !== 0 ? 'wall' : 'tile';
    return { kind, romSfx: w.tailSfx };
  }
  if (w.air !== 0 && w.bounced !== 0) {
    if (w.spinBounceSfx !== 0) {
      // $81:9BF4: the spin streak's sound ($68F0 - 1 + 5); its object ends
      const sfx = w.spinBounceSfx + 4;
      w.spinBounceSfx = 0;
      return { kind: 'bounce', romSfx: sfx };
    }
    if (w.vz >= 0x8000) return null; // $81:9C03 BMI
    const sfx = w.vz >= 0x0500 ? 1 : w.vz >= 0x0200 ? 2 : 3;
    return { kind: 'bounce', romSfx: sfx };
  }
  return null;
}

/**
 * Runs one core frame's ball step from the top. Returns true when a hit-stop
 * suspended it: the frame then ends (the original blocks inside the step,
 * $81:8C95), and `resumeBallStep` finishes the list on the frame the stall
 * runner (schedule.ts, `tick-stall`) hands back.
 */
export function runBallStep(world: World, ctx: Ctx): boolean {
  return runFrom(world, ctx, 0, null);
}

/** The rest of a suspended step, from `Stall.resumeAt`. */
export function resumeBallStep(world: World, ctx: Ctx, stall: {
  resumeAt: number; pRoute: string; pReroute: string; pEntry: string; pOutcome: string;
}): boolean {
  const pending: PendingState | null = stall.pRoute === '' ? null : {
    route: { kind: stall.pRoute as BallRoute['kind'] },
    reroute: (stall.pReroute || undefined) as StepState['reroute'],
    entry: (stall.pEntry || undefined) as StepState['entry'],
    outcome: stall.pOutcome
      ? ({ kind: stall.pOutcome } as LandingOutcome)
      : undefined,
  };
  return runFrom(world, ctx, stall.resumeAt, pending);
}

interface PendingState {
  route: BallRoute;
  outcome?: LandingOutcome;
  reroute?: StepState['reroute'];
  entry?: StepState['entry'];
}

function runFrom(world: World, ctx: Ctx, start: number, pending: PendingState | null): boolean {
  const e = world.queryFirst(BallWork);
  if (e === undefined) throw new Error('no ball entity');
  const w = e.get(BallWork)!;
  const mod = e.get(Modifier)!;
  const s: StepState = {
    ctx,
    w,
    modifier: { kind: mod.kind, timer: mod.timer },
    route: pending?.route ?? { kind: 'land' },
    outcome: pending?.outcome,
    reroute: pending?.reroute,
    entry: pending?.entry,
  };
  for (let i = start; i < BALL_STEP.length; i++) {
    const req = BALL_STEP[i].run(world, s);
    if (req) {
      world.set(Stall, {
        kind: req.kind,
        framesLeft: req.frames,
        resumeAt: i + 1,
        variant: req.state,
        pRoute: s.route.kind,
        pReroute: s.reroute ?? '',
        pEntry: s.entry ?? '',
        pOutcome: s.outcome?.kind ?? '',
      });
      return true;
    }
  }
  return false;
}

/**
 * One silent step of the kernel entries on a work copy — the shot guide's
 * use (plans/port_v1_koota_phaser4.md: "simulateGuide runs BALL_STEP too,
 * on a cloned BallWork with buttons off, stalls ignored and no events").
 * A hit-stop request does not suspend: the list simply goes on.
 */
export function runKernelStep(ctx: Ctx, w: BallWorkFields): void {
  const s: StepState = {
    ctx,
    w,
    modifier: { kind: -1, timer: 0 },
    route: { kind: 'land' },
  };
  for (const entry of BALL_STEP) {
    if (!entry.kernel) continue;
    entry.run(null as unknown as World, s);
  }
}

/** A fresh work copy (the guide clones the live one into it). */
export function cloneWork(w: BallWorkFields): BallWorkFields {
  return { ...emptyWork(), ...w, request: null };
}

// ------------------------------------------------------------------
// Block <-> work copy ($82:F030 / $82:F1E3)
// ------------------------------------------------------------------

/** The ball entity (the world's only one in phase 4). */
export function ballEntity(world: World): import('koota').Entity {
  const e = world.queryFirst(BallWork);
  if (e === undefined) throw new Error('no ball entity');
  return e;
}

/** $82:F030: the block traits -> the work copy. */
function loadBallWork(world: World, w: BallWorkFields): void {
  const e = ballEntity(world);
  const pos = e.get(BallPos)!;
  const vel = e.get(BallVel)!;
  const air = e.get(BallAir)!;
  const spin = e.get(BallSpin)!;
  const mode = e.get(BallMode)!;
  const holed = e.get(BallHoled)!;
  const heading = e.get(BallHeading)!;
  const still = e.get(StillCount)!;
  const mod = e.get(Modifier)!;
  w.xc = pos.xc; w.xf = pos.xf; w.yc = pos.yc; w.yf = pos.yf; w.z = pos.z;
  w.vx = vel.vx; w.vy = vel.vy; w.vz = vel.vz;
  w.air = air.air;
  w.spinX = spin.sx; w.spinY = spin.sy; w.spinPending = spin.pending;
  w.mode = mode.mode;
  w.holed = holed.holed;
  w.lastDeg = heading.last;
  w.over = still.over;
  w.frames = still.frames;
  w.modifierKind = mod.kind;
  w.modifierWindow = mod.window;
  w.modifierTimer = mod.timer;
  // $DA2C <- block $D886 (a scratch the step never reads; kept for the
  // round trip's shape)
  w.scratch = 0;
  const shot = world.get(Shot)!;
  w.shotAim = shot.aim;
  w.shotElev = shot.elev;
  // the coefficients ($DA30-$DA46) are block-backed at $D922-$D94E; in
  // phase 4 they hold the set-up constants and only the tile handlers
  // mutate the copies, so they stay work-only (deviation noted in
  // docs/engine.md).
}

/** $82:F1E3: the work copy -> the block traits. */
function storeBallWork(world: World, w: BallWorkFields): void {
  const e = ballEntity(world);
  e.set(BallPos, { xc: w.xc, xf: w.xf, yc: w.yc, yf: w.yf, z: w.z });
  e.set(BallVel, { vx: w.vx, vy: w.vy, vz: w.vz });
  e.set(BallAir, { air: w.air });
  e.set(BallSpin, { sx: w.spinX, sy: w.spinY, pending: w.spinPending });
  e.set(BallMode, { mode: w.mode });
  e.set(BallHoled, { holed: w.holed });
  e.set(BallHeading, { deg: w.deg, last: w.lastDeg });
  e.set(StillCount, { over: w.over, frames: w.frames });
  e.set(Modifier, { kind: w.modifierKind, window: w.modifierWindow, timer: w.modifierTimer });
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

/** $81:8751: the previous-frame copy ($D9EC-$DA0B -> $DA0C-$DA2B). */
function copyPrev(w: BallWorkFields): void {
  w.pAir = w.air;
  w.pOnOverlay = w.onOverlay;
  w.pXf = w.xf; w.pXc = w.xc;
  w.pYf = w.yf; w.pYc = w.yc;
  w.pZ = w.z;
  w.pCell = w.cell; w.pShape = w.shape;
  w.pElev = w.elev; w.pQuad = w.quad;
  w.pCode = w.code; w.pGround = w.ground;
  w.pTile = w.tile;
}

/** $81:87FB: $D9EE is cleared unless the tile is in $60-$6F. */
function overlayProbe(w: BallWorkFields): void {
  w.onOverlay = w.tile >= 0x60 && w.tile < 0x70 ? 1 : 0;
}

function highWord(z: number): number {
  return (z >>> 16) & 0xffff;
}

/**
 * $82:DA51: the A/Y modifier arming and countdown (read 2026-11-14,
 * build/engine/disasm; notes/engine-phase5-flow.md). It runs after the
 * step, from the Kirby state code, on the pad of the same frame ($006B),
 * so a press reaches the physics on the next frame's step.
 *
 * - While the window $DA78 is open (22 frames) a press is ignored and the
 *   window and timer count down; the timer running out disarms.
 * - A ($006B & $0080): sfx $26; the hop pose (13) when grounded, or in the
 *   air with no spin pending ($82:DA9B-$82:DAAE); kind 0.
 * - Y ($4000): kind 2, no sound, no pose.
 * - Either way: timer 15 in the air, 3 on the ground; window 22; and the
 *   arming is dropped when |vx| + |vy| >= $3001 or |vz| >= $3801.
 *
 * Returns what the caller's BEQ tests ($82:CE02): true when the bonus may
 * apply this frame — on the arming frame, or while counting down with the
 * timer still above 0.
 */
function armModifier(world: World, w: BallWorkFields): boolean {
  if ((w.lost & 1) !== 0 || w.holed !== 0) return false;
  if (w.modifierWindow !== 0) {
    w.modifierWindow -= 1;
    w.modifierTimer -= 1;
    if (w.modifierTimer < 0) {
      w.modifierTimer = 0; // $82:DA79: INC back to 0
      w.modifierKind = -1; // $82:DA7C: disarmed
      return false; // INC A -> 0
    }
    return w.modifierTimer !== 0; // the flags of DEC $DA7A
  }
  const pressed = world.get(Pad)!.pressed;
  if ((pressed & 0x4080) === 0) return false; // $82:DB1C: LDA $DA78 (0)
  if ((pressed & 0x0080) !== 0) {
    emit(world, { frame: world.get(Time)!.frame }, 'modifier', 0x26);
    if (w.air === 0 || (w.spinX | w.spinY) === 0) w.hopRequest = 1; // $82:DAAE
    w.modifierKind = 0;
  } else {
    w.modifierKind = 2;
  }
  w.modifierTimer = w.air !== 0 ? 15 : 3; // $82:DAC6 / $82:DACB
  w.modifierWindow = 0x16; // $82:DAE6
  const h = Math.abs(s16(w.vx)) + Math.abs(s16(w.vy));
  if (h >= 0x3001 || Math.abs(s16(w.vz)) >= 0x3801) w.modifierKind = -1; // $82:DB16
  return true; // $82:DB1C: LDA $DA78 (22)
}

/**
 * $82:DB20: on a bounce, step hit or wall hit of this step ($DA4E | $DA50 |
 * $DA52) with a modifier armed, each non-zero velocity component gets
 * v x k / 256 added ($80:A342, bits 8-23), k = $82:DB75[$DA76]: +39 (A),
 * -25 (Y). The kind stays armed.
 */
function applyModifier(ctx: Ctx, w: BallWorkFields): void {
  if ((w.bounced | w.hitStep | w.hitWall) === 0) return;
  if (w.modifierKind < 0) return;
  const k = ctx.rules.table('buttonModifier')[w.modifierKind >> 1];
  if (w.vx !== 0) w.vx = wrap16(w.vx + s16(mul16x8(w.vx, k)));
  if (w.vy !== 0) w.vy = wrap16(w.vy + s16(mul16x8(w.vy, k)));
  if (w.vz !== 0) w.vz = wrap16(w.vz + s16(mul16x8(w.vz, k)));
}
