// One hole as a game: the shot flow (aim, spin, power), the roll, the
// enemies, the cup and the score. Pure TypeScript, deterministic, one tick per
// 60 Hz frame. The ball itself is src/sim/ball.ts.

import { Ball, type BallWorld } from './ball';
import { Camera, SHOT_VIEW_X, SHOT_VIEW_Y } from './camera';
import { computeGuide, type Guide } from './guide';
import { project } from '../render/projection';
import { launchVelocity, shotPower, shotSpin } from './shot';
import { Terrain } from './terrain';
import type { CourseJson, Rom } from './tables';

export interface Pad {
  left: boolean; right: boolean; up: boolean; down: boolean;
  a: boolean; b: boolean; y: boolean;
}

export const emptyPad = (): Pad => ({ left: false, right: false, up: false, down: false, a: false, b: false, y: false });

export type Stage =
  | 'intro' | 'aim' | 'spin' | 'power' | 'curl' | 'roll' | 'rest'
  | 'cupReveal' | 'sink' | 'lost' | 'done' | 'fail';

/** Sound effect ids as the game numbers them (tools/web_audio_map.json). */
export const SFX = {
  bounceHard: 1, bounceMid: 2, bounceSoft: 3, stepHit: 4, wall: 7,
  lost: 0x10, launch: 0x18, cupAppears: 0x1c, hop: 0x26, aimTick: 0x34,
  spinTick: 0x3d, spinCentre: 0x42, enemy: 0x4f, confirm: 0x03,
} as const;

export type SimEvent =
  | { type: 'sfx'; id: number }
  | { type: 'enemy'; index: number; left: number }
  | { type: 'cup'; index: number }
  | { type: 'launch' }
  | { type: 'hop'; air: boolean }
  | { type: 'holed' }
  | { type: 'stage'; stage: Stage };

export interface Enemy {
  idx: number; col: number; row: number; tile: number;
  taken: boolean; cup: boolean;
}

const MAX_HP = 4;
const CURL_FRAMES = 23; // measured: the A that sets the power at 2960 launches at 2983
const REST_FRAMES = 30; // |vx|+|vy| < 1 for 30 frames ends the shot ($D9BE)
/**
 * After the A that confirms the aim, measured on the real game (A at frame 2800, hole 1):
 * the "1" appears at +46, the panel at +66, the selectors answer from +70, and the
 * meter starts 5 frames after the A that leaves the spin stage. The first A of the
 * four-press script (2840) did nothing at all.
 */
export const SPIN_ONE = 46;
export const SPIN_PANEL = 66;
export const SPIN_READY = 70;
const METER_START = 5;
/** Frames after the A before the camera starts toward the shot view (real: A at 2800, first step at 2805). */
const PAN_DELAY = 5;
const REST_WAIT = 35; // measured: $D9BE set at 3474, the next aim (state 4) at 3509
/**
 * A shot from shootNow (the hand-gesture page) launches this many frames after Kirby
 * starts to curl: the length of the curl clip (`curl_into_ball_*`, 35 frames). The
 * keyboard path goes through the spin stage, where the curl is long over by the time
 * of the power A, and keeps CURL_FRAMES. Not a measurement: the game has no such path.
 */
export const HAND_CURL_FRAMES = 35;

export class HoleSim implements BallWorld {
  readonly terrain: Terrain;
  readonly ball: Ball;
  readonly enemies: Enemy[] = [];
  readonly events: SimEvent[] = [];
  readonly tee: { col: number; row: number };
  readonly camera: Camera;
  /** the shot guide for the aim stage; the camera looks at its end */
  guide: Guide | null = null;
  private guideKey = '';
  /** a world without enemies: the guide's ball must not take any */
  private readonly guideWorld: BallWorld;
  /** the camera has arrived at the shot view and Kirby curls up (docs/web-demo.md) */
  curlStarted = false;

  stage: Stage = 'aim';
  stageTimer = 0;
  /** frames of the hole intro (Kirby flies in on the warp star); see startIntro */
  private introFrames = 0;
  /** frames since the A that confirmed the aim, through spin, power and curl */
  shotAge = 0;
  frame = 0;
  // shot input state
  aim = 0; // $D9B4, degrees
  elevation = 0; // $D9B6: 0 grounder, 60 fly shot
  side = 6; // $6B50
  topBack = 6; // $6B52
  meter = 0; // $6B3A
  /** the meter one and two ticks ago: the game draws its gauge one frame and the face two behind it */
  meter1 = 0;
  meter2 = 0;
  meterDir = 1;
  power = 0; // $6ADC
  // score
  strokes = 0;
  hp = MAX_HP;
  stars = 0;
  // where the ball rests between shots
  rest = { xc: 0, xf: 0x8000, yc: 0, yf: 0x8000 };

  private prevPad = emptyPad();
  private turnHeld = 0;
  private sideHeld = 0;
  private tbTimer = 0;
  private tbDir = -1;
  private restCount = 0;
  private rollTicks = 0;
  private cupShown = false;
  private tbPause = 0;
  private pending: { vx: number; vy: number; vz: number; spin: ReturnType<typeof shotSpin> } | null = null;
  /** the shot in flight came from shootNow: launch HAND_CURL_FRAMES after the curl starts */
  handShot = false;
  /** a shot asked for by requestShot, taken by the next tick of the aim stage */
  private shotRequest: number | null = null;

  constructor(readonly rom: Rom, readonly course: CourseJson) {
    this.terrain = new Terrain(rom, course);
    this.ball = new Ball(rom);
    const t = course.tee ?? { x: 0, y: 0 };
    this.tee = { col: t.x, row: t.y };
    this.camera = new Camera(course.bitmap.h);
    this.guideWorld = { terrain: this.terrain, enemyHeight: () => 0, enemyUntaken: () => false, takeEnemy: () => undefined };
    for (const e of course.enemies) {
      this.enemies.push({ idx: e.y * course.w + e.x, col: e.x, row: e.y, tile: e.tile, taken: false, cup: false });
    }
    this.resetShot();
  }

  /** Back on the tee, full tomatoes. */
  restart(): void {
    this.terrain.tile.set(this.course.tile);
    for (const e of this.enemies) { e.taken = false; e.cup = false; }
    this.strokes = 0; this.hp = MAX_HP; this.stars = 0;
    this.rest = { xc: this.tee.col, xf: 0x8000, yc: this.tee.row, yf: 0x8000 };
    this.aim = 0; this.elevation = 0;
    this.ball.reset();
    this.ball.place(this, this.rest.xc, this.rest.xf, this.rest.yc, this.rest.yf);
    const k = this.kirby();
    this.camera.snap(k.x, k.yFlip); // hole start: Kirby in the middle ($80:C4A7)
    this.camera.observe(k.x, k.yFlip);
    this.guideKey = '';
    this.curlStarted = false;
    this.handShot = false;
    this.shotRequest = null;
    this.pending = null;
    this.setStage('aim');
  }

  /**
   * Play the hole intro first: nothing answers for `frames` ticks, then the aim stage
   * starts (the real game: the hole's song at frame 2169 of the c1n run, the aim, Kirby's
   * state 4, at 2337, 168 frames later; docs/web-demo.md). The camera stays where
   * restart() put it, Kirby in the middle, which is where the game has it all along.
   */
  startIntro(frames: number): void {
    this.introFrames = frames;
    this.setStage('intro');
  }

  private resetShot(): void {
    this.restart();
  }

  // ---- BallWorld -----------------------------------------------------------
  enemyHeight(): number { return 0; }
  enemyUntaken(idx: number): boolean {
    const e = this.enemies.find((q) => q.idx === idx);
    return !!e && !e.taken;
  }
  takeEnemy(idx: number): void {
    const e = this.enemies.find((q) => q.idx === idx);
    if (!e || e.taken) return;
    e.taken = true;
    this.stars += 1;
    this.hp = Math.min(MAX_HP, this.hp + 1);
    const left = this.enemies.filter((q) => !q.taken).length;
    this.events.push({ type: 'sfx', id: SFX.enemy });
    this.events.push({ type: 'enemy', index: this.enemies.indexOf(e), left });
    if (left === 1) {
      // $82:8AEE-$82:8B5C: the last enemy left becomes the cup
      const last = this.enemies.find((q) => !q.taken)!;
      last.cup = true;
      this.terrain.tile[last.idx] = 0x08;
      this.events.push({ type: 'cup', index: this.enemies.indexOf(last) });
      this.events.push({ type: 'sfx', id: SFX.cupAppears });
      this.cupShown = true; // the physics waits while the cup appears
    }
  }

  // ---- the tick --------------------------------------------------------------

  private setStage(s: Stage): void {
    this.stage = s;
    this.stageTimer = 0;
    this.events.push({ type: 'stage', stage: s });
  }

  private sfx(id: number): void { this.events.push({ type: 'sfx', id }); }

  /** One 60 Hz tick with the pad as held this frame. */
  tick(pad: Pad): void {
    this.events.length = 0;
    this.frame += 1;
    this.stageTimer += 1;
    this.meter2 = this.meter1;
    this.meter1 = this.meter;
    if (this.stage === 'spin' || this.stage === 'power' || this.stage === 'curl') this.shotAge += 1;
    const pressed: Pad = {
      left: pad.left && !this.prevPad.left, right: pad.right && !this.prevPad.right,
      up: pad.up && !this.prevPad.up, down: pad.down && !this.prevPad.down,
      a: pad.a && !this.prevPad.a, b: pad.b && !this.prevPad.b, y: pad.y && !this.prevPad.y,
    };
    this.prevPad = { ...pad };

    if (this.stage !== 'aim') this.shotRequest = null;
    switch (this.stage) {
      case 'intro':
        if (this.stageTimer > this.introFrames) this.setStage('aim');
        break;
      case 'aim': this.tickAim(pad, pressed); break;
      case 'spin': this.tickSpin(pad, pressed); break;
      case 'power': this.tickPower(pressed); break;
      case 'curl': this.tickCurl(); break;
      case 'roll': this.tickRoll(pressed); break;
      case 'rest':
        if (this.stageTimer >= REST_WAIT) this.afterShot();
        break;
      case 'cupReveal':
        if (this.stageTimer >= 90) { this.camera.ease(); this.setStage('roll'); }
        break;
      case 'sink':
        if (this.stageTimer >= 90) this.setStage('done');
        break;
      case 'lost':
        if (this.stageTimer >= 60) this.afterLost();
        break;
      default: break;
    }
    this.tickCamera();
  }

  // ---- camera ----------------------------------------------------------------

  /** Kirby's projected position, with y counted up from the bottom of the bitmap ($DA58, $DA5C). */
  kirby(): { x: number; yFlip: number } {
    const b = this.ball;
    const p = project(this.course.word7, b.xc, b.xf, b.yc, b.yf, b.z);
    return { x: p.x, yFlip: this.course.bitmap.h - p.y };
  }

  /** The guide for the current aim, recomputed when the aim changes. */
  private updateGuide(): Guide {
    const r = this.rest;
    const key = `${r.xc},${r.xf},${r.yc},${r.yf},${this.aim},${this.elevation}`;
    if (!this.guide || key !== this.guideKey) {
      this.guideKey = key;
      this.guide = computeGuide(this.rom, this.guideWorld, this.course.word7, {
        xc: r.xc, xf: r.xf, yc: r.yc, yf: r.yf, aim: this.aim, elevation: this.elevation, side: 6, topBack: 6,
      });
    }
    return this.guide;
  }

  private tickCamera(): void {
    const cam = this.camera;
    const H = this.course.bitmap.h;
    const k = this.kirby();
    switch (this.stage) {
      case 'aim': {
        // the aim loop pans every frame to where the guide's path ends ($81:A7B5, target $6AAA/$6AAC)
        const g = this.updateGuide();
        cam.pan(g.end.x, H - g.end.y);
        break;
      }
      case 'spin':
      case 'power':
      case 'curl':
        if (!this.curlStarted && this.shotAge >= PAN_DELAY) {
          // $81:BEB4: Kirby plus an offset by aim quarter; the curl starts when the camera is there
          const q = this.aim >= 270 ? 3 : this.aim >= 180 ? 2 : this.aim >= 90 ? 1 : 0;
          if (cam.pan(k.x + SHOT_VIEW_X[q], k.yFlip + SHOT_VIEW_Y[q])) this.curlStarted = true;
        }
        break;
      case 'roll': {
        const b = this.ball;
        // $80:B961: the camera follows while the ball moves and the shot is not over
        if (b.vx !== 0 || b.vy !== 0 || b.vz !== 0) cam.follow(k.x, k.yFlip);
        break;
      }
      case 'cupReveal': {
        // $82:8B5C pans to the cup
        const e = this.enemies.find((q) => q.cup);
        if (e) {
          const c = project(this.course.word7, e.col, 0x8000, e.row, 0x8000, 0);
          cam.pan(c.x, H - c.y);
        }
        break;
      }
      default: break;
    }
    cam.observe(k.x, k.yFlip);
  }

  // ---- aiming ---------------------------------------------------------------

  private tickAim(pad: Pad, pressed: Pad): void {
    if (this.shotRequest !== null) {
      const m = this.shotRequest;
      this.shotRequest = null;
      this.shootFromAim(m);
      return;
    }
    // Measured: a press turns 1 degree at once; held 17 frames, it turns 3
    // degrees every 3 frames. Left turns toward +y (the angle grows).
    const dir = pad.left ? 1 : pad.right ? -1 : 0;
    if (dir === 0) this.turnHeld = 0;
    else {
      if (pressed.left || pressed.right || this.turnHeld === 0) this.turn(dir * 1);
      this.turnHeld += 1;
      if (this.turnHeld >= 17 && (this.turnHeld - 17) % 3 === 0) this.turn(dir * 3);
    }
    if (pressed.up) this.elevation = 60;
    if (pressed.down) this.elevation = 0;
    if (pressed.a) {
      this.side = 6; this.topBack = 6; this.tbTimer = 0; this.tbDir = -1; this.tbPause = 0;
      this.sideHeld = 0;
      this.shotAge = 0;
      this.curlStarted = false;
      this.sfx(SFX.confirm);
      this.setStage('spin');
    }
  }

  private turn(d: number): void {
    this.aim = (((this.aim + d) % 360) + 360) % 360;
  }

  /** Set the aim directly (another input method than Left/Right). Only in the aim stage. */
  setAim(deg: number): void {
    if (this.stage !== 'aim') return;
    this.aim = (((Math.round(deg) % 360) + 360) % 360);
  }

  /**
   * Shoot from the aim stage with the meter at `meter` (0-63), no spin, on the next tick:
   * what the power A does (tickPower), without the spin and power stages. The camera
   * pans to the shot view and Kirby curls as after the first A; the ball goes
   * HAND_CURL_FRAMES after the curl starts. Taken inside the tick so that its events
   * (the launch sound, the stage change) reach the scene. False when not in the aim stage.
   */
  requestShot(meter: number): boolean {
    if (this.stage !== 'aim') return false;
    this.shotRequest = Math.max(0, Math.min(63, Math.round(meter)));
    return true;
  }

  private shootFromAim(meter: number): void {
    this.side = 6; this.topBack = 6;
    this.meter = this.meter1 = this.meter2 = meter;
    this.meterDir = 1;
    this.power = shotPower(this.rom, this.meter, this.elevation !== 0);
    const v = launchVelocity(this.rom, this.power, this.aim, this.elevation);
    const spin = shotSpin(this.rom, this.power, this.aim, this.elevation, this.side, this.topBack);
    this.pending = { ...v, spin };
    this.strokes += 1;
    this.hp = Math.max(0, this.hp - 1);
    this.shotAge = 0;
    this.curlStarted = false;
    this.handShot = true;
    this.sfx(SFX.launch);
    this.setStage('curl');
  }

  // ---- spin -----------------------------------------------------------------

  private tickSpin(pad: Pad, pressed: Pad): void {
    // Kirby curls and the panel opens first; nothing answers before SPIN_READY
    if (this.shotAge < SPIN_READY) {
      if (pressed.b) this.setStage('aim');
      if (this.shotAge === SPIN_READY - 1) this.tbTimer = 2; // the first top/back step comes at SPIN_READY
      return;
    }
    // side: one step per 8 frames while Left/Right is held ($81:C12E)
    const dir = pad.left ? -1 : pad.right ? 1 : 0;
    if (dir === 0) this.sideHeld = 0;
    else {
      if (this.sideHeld % 8 === 0) this.side = Math.max(0, Math.min(12, this.side + dir));
      this.sideHeld += 1;
    }
    // top/back moves by itself in a fly shot: one step every 3 frames, 6 -> 0
    // -> 12 -> 0 ..., pausing twice as long at 0, 6 and 12 ($81:C170)
    if (this.elevation !== 0) {
      if (this.tbPause > 0) {
        this.tbPause -= 1;
      } else {
        this.tbTimer += 1;
        if (this.tbTimer >= 3) {
          this.tbTimer = 0;
          this.topBack += this.tbDir;
          if (this.topBack <= 0) { this.topBack = 0; this.tbDir = 1; }
          if (this.topBack >= 12) { this.topBack = 12; this.tbDir = -1; }
          if (this.topBack === 0 || this.topBack === 6 || this.topBack === 12) {
            this.tbPause = 6;
            this.sfx(this.topBack === 6 ? SFX.spinCentre : SFX.spinTick);
          }
        }
      }
    }
    if (pressed.a) {
      this.meter = 0; this.meterDir = 1; this.meter1 = 0; this.meter2 = 0;
      this.sfx(SFX.confirm);
      this.setStage('power');
    } else if (pressed.b) {
      this.setStage('aim');
    }
  }

  // ---- power ----------------------------------------------------------------

  private tickPower(pressed: Pad): void {
    if (this.stageTimer < METER_START) return; // measured: the meter starts 5 frames after the A
    // the meter counts up to $6B3C (63) and back, one step a frame (measured). If A is
    // not pressed it shoots by itself when the meter is back at 0 (frame 3250 -> launch 3274)
    this.meter += this.meterDir;
    if (this.meter >= 63) { this.meter = 63; this.meterDir = -1; }
    let auto = false;
    if (this.meter <= 0) { this.meter = 0; if (this.meterDir < 0) auto = true; this.meterDir = 1; }
    if (pressed.a || auto) {
      this.power = shotPower(this.rom, this.meter, this.elevation !== 0);
      const v = launchVelocity(this.rom, this.power, this.aim, this.elevation);
      const spin = shotSpin(this.rom, this.power, this.aim, this.elevation, this.side, this.topBack);
      this.pending = { ...v, spin };
      this.strokes += 1;
      this.hp = Math.max(0, this.hp - 1);
      this.sfx(SFX.launch);
      this.setStage('curl');
    } else if (pressed.b) {
      this.setStage('spin');
    }
  }

  private tickCurl(): void {
    if (this.handShot) {
      // count from the frame the camera arrived and Kirby started to curl
      if (!this.curlStarted) { this.stageTimer = 0; return; }
      if (this.stageTimer < HAND_CURL_FRAMES) return;
      this.handShot = false;
    } else if (this.stageTimer < CURL_FRAMES) return;
    const p = this.pending!;
    const b = this.ball;
    b.vx = p.vx; b.vy = p.vy; b.vz = p.vz;
    b.air = this.elevation !== 0;
    b.airFrames = 0;
    b.aim = this.aim; b.elevation = this.elevation;
    b.spinX = p.spin.spinX; b.spinY = p.spin.spinY; b.spinPending = p.spin.pending;
    b.modKind = -1; b.modWindow = 0; b.modTimer = 0;
    this.restCount = 0;
    this.rollTicks = 0;
    this.pending = null;
    this.events.push({ type: 'launch' });
    const q = this.aim >= 270 ? 3 : this.aim >= 180 ? 2 : this.aim >= 90 ? 1 : 0;
    this.camera.launch(SHOT_VIEW_X[q], SHOT_VIEW_Y[q]);
    this.setStage('roll');
  }

  // ---- the roll ---------------------------------------------------------------

  private tickRoll(pressed: Pad): void {
    const b = this.ball;
    b.step(this, { a: pressed.a, y: pressed.y });
    for (const ev of b.events) {
      switch (ev.type) {
        case 'bounce':
          this.sfx(ev.vz >= 0x500 ? SFX.bounceHard : ev.vz >= 0x200 ? SFX.bounceMid : SFX.bounceSoft);
          break;
        case 'stepHit': this.sfx(SFX.stepHit); break;
        case 'wallHit': this.sfx(SFX.wall); break;
        case 'hop': this.sfx(SFX.hop); this.events.push({ type: 'hop', air: b.air }); break;
        case 'lost':
          this.hp = Math.max(0, this.hp - 1);
          this.sfx(SFX.lost);
          this.setStage('lost');
          return;
        default: break;
      }
    }
    if (b.holed) {
      this.events.push({ type: 'holed' });
      this.setStage('sink');
      return;
    }
    if (this.cupShown) { this.cupShown = false; this.setStage('cupReveal'); return; }
    // the shot is over when the ball has been (nearly) still for 30 frames
    if (!b.air && Math.abs(b.vx) + Math.abs(b.vy) < b.restSpeed) this.restCount += 1;
    else this.restCount = 0;
    // safety: a ball that never settles (a bounce loop in the dish) ends the shot after 30 s
    this.rollTicks += 1;
    if (this.restCount >= REST_FRAMES || this.rollTicks > 1800) {
      if (this.rollTicks > 1800) { b.vx = b.vy = b.vz = 0; b.air = false; }
      this.rest = { xc: b.xc, xf: b.xf, yc: b.yc, yf: b.yf };
      this.setStage('rest');
    }
  }

  private afterShot(): void {
    if (this.hp <= 0) { this.setStage('fail'); return; }
    this.setStage('aim');
  }

  private afterLost(): void {
    if (this.hp <= 0) { this.setStage('fail'); return; }
    // back to where the shot was taken from
    this.ball.place(this, this.rest.xc, this.rest.xf, this.rest.yc, this.rest.yf);
    this.setStage('aim');
  }

  /**
   * The 32-sector direction of the aim: `$81:BB4A` puts (360 - phi + 112) mod 360
   * in `$6ABE` and `$81:BCA0` reads `$81:8E98[$6ABE]`. Kirby's pose switches on
   * its halves (`$7E:D7CC`, 16 shot angles) and quarters (`$7E:D7C4`, 8 facings).
   * Recorded: phi = 0 -> `$6ABE` 112, `$D7C4` 2, `$D7CC` 5.
   */
  get facing32(): number { return this.rom.degToDir32[(472 - this.aim) % 360]; }
  /** Kirby's facing, 8 directions (`$D7C4`): 0 up-right, 1 right, 2 down-right, 3 down (toward the camera) ... 7 up. */
  get facing(): number { return this.facing32 >> 2; }
  /** The shot angle in 16 directions (`$7E:D7CC`) for the curl and the unroll. */
  get shotAngle16(): number { return this.facing32 >> 1; }
}
