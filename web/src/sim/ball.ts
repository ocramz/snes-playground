// One frame of the ball, ported from docs/physics.md and the 65816 it
// describes: sub_ball_physics_step $81:801C and the routines it calls. The
// state names keep the ROM's work-copy address so a reader can look a field up
// in docs/physics.md.

import { abs16, hiWord, mulQ15, mulQ15s, s16, u16 } from './fixed';
import { atan2Deg, cosDeg, sinDeg } from './trig';
import { copyProbe, emptyProbe, type Probe, Terrain } from './terrain';
import type { Rom } from './tables';

export const STEP_HALF = 0x2d41; // half a height step
export const STEP = 0x5a82; // one height step, 16.16
export const FALL_LIMIT = 0xffef; // high word of z below which the ball is lost

export type BallEvent =
  | { type: 'bounce'; vz: number; code: number }
  | { type: 'stepHit' }
  | { type: 'wallHit' }
  | { type: 'launch' }
  | { type: 'lost' }
  | { type: 'hop' };

/** What the ball needs from the rest of the hole. */
export interface BallWorld {
  terrain: Terrain;
  /** Enemy hover height in steps for the enemy on this cell (0 = grounded). */
  enemyHeight(idx: number): number;
  /** The ball has taken the untaken enemy on this cell. */
  takeEnemy(idx: number): void;
  /** Is the enemy on this cell still untaken? */
  enemyUntaken(idx: number): boolean;
}

export class Ball {
  // ---- position: cell + 16-bit fraction, height 16.16 ------------------
  xc = 0; xf = 0; yc = 0; yf = 0; z = 0;
  // ---- velocity, signed 16-bit, fractions of a cell per frame ------------
  vx = 0; vy = 0; vz = 0;
  air = false; // $D9EC
  mode = 0; // $D9C8
  heading = 0; // $D9DA
  lastHeading = 0; // $D9E2
  airFrames = 0; // $DA48
  // ---- shot state ---------------------------------------------------------
  aim = 0; // $D9B4
  elevation = 0; // $D9B6, 0 grounder, 60 fly shot
  spinX = 0; // $D9CC
  spinY = 0; // $D9CE
  spinPending = 0; // $D9D0
  lockout = 0; // $6A7A
  holed = 0; // $DA4A
  lost = false; // $D9D2 bit 0
  latch = false; // $6A68,X: an enemy hit counts once per pass
  // ---- A / Y modifiers ($82:DA51) ---------------------------------------
  modKind = -1; // $DA76
  modWindow = 0; // $DA78
  modTimer = 0; // $DA7A
  // ---- coefficients ($DA30-$DA42), reset every airborne frame -----------
  gravity = 0; // $DA38
  friction = 0; // $DA3A
  dampXY = 0; // $DA3C
  dampZ = 0; // $DA3E
  stepDampXY = 0; // $DA40
  stepDampZ = 0; // $DA42
  defaultDampXY = 0; // $DA30
  defaultDampZ = 0; // $DA32
  restSpeed = 1; // $DA46
  fricIdx = 0; // $6A72 / 2: row in the mode tables
  // ---- probe results ------------------------------------------------------
  cur: Probe = emptyProbe();
  prev: Probe = emptyProbe();
  prevAir = false;
  pxc = 0; pxf = 0; pyc = 0; pyf = 0; pz = 0; // previous-frame position
  // ---- per-frame flags ---------------------------------------------------
  bounced = false; // $DA4E
  stepHit = false; // $DA50
  wallHit = false; // $DA52
  stepEdge = -1; // $D9E4
  wallEdge = -1; // $D9E6
  stepHeight = 0; // $DA4C
  dirOfMotion = -1; // $6A78
  hitStop = 0; // frames the game waits ($81:8C79 / $81:8C48)
  squash = 0; // $6A6E
  events: BallEvent[] = [];

  constructor(readonly rom: Rom) {
    this.reset();
  }

  /** Normal ball, no copy ability (sub_ball_setup defaults, $80:C6xx). */
  reset(): void {
    const c = this.rom.c;
    this.mode = 0;
    this.defaultDampXY = c.bounceDampXY;
    this.defaultDampZ = c.bounceDampZ;
    this.dampXY = c.bounceDampXY;
    this.dampZ = c.bounceDampZ;
    this.stepDampXY = c.stepDamp;
    this.stepDampZ = c.stepDampZ;
    this.restSpeed = c.restSpeed;
    this.gravity = this.rom.ballGravity[0];
    this.friction = c.rollFrictionDefault;
    this.modKind = -1; this.modWindow = 0; this.modTimer = 0;
    this.lockout = 0; this.holed = 0; this.lost = false; this.latch = false;
    this.air = false; this.vx = this.vy = this.vz = 0;
    this.spinX = this.spinY = this.spinPending = 0;
    this.airFrames = 0;
  }

  /** Put the ball down, still, on the ground at a cell + fraction. */
  place(w: BallWorld, xc: number, xf: number, yc: number, yf: number): void {
    this.xc = xc; this.xf = xf; this.yc = yc; this.yf = yf;
    w.terrain.probe(xc, yc, xf, yf, this.cur);
    this.z = this.cur.ground;
    copyProbe(this.prev, this.cur);
    this.vx = this.vy = this.vz = 0;
    this.air = false;
    this.airFrames = 0;
    this.lost = false;
  }

  // ====================================================================
  // helpers on the position
  // ====================================================================

  private addX(v: number): void {
    const t = this.xc * 65536 + this.xf + v;
    this.xc = Math.floor(t / 65536);
    this.xf = t - this.xc * 65536;
  }
  private addY(v: number): void {
    const t = this.yc * 65536 + this.yf + v;
    this.yc = Math.floor(t / 65536);
    this.yf = t - this.yc * 65536;
  }

  private savePrev(): void {
    this.prevAir = this.air;
    this.pxc = this.xc; this.pxf = this.xf; this.pyc = this.yc; this.pyf = this.yf;
    this.pz = this.z;
    copyProbe(this.prev, this.cur);
  }

  /** $81:87B2: put x, y and the probe fields back; z and velocity stay. */
  private restorePrev(): void {
    this.xc = this.pxc; this.xf = this.pxf; this.yc = this.pyc; this.yf = this.pyf;
    copyProbe(this.cur, this.prev);
  }

  private heading_(): void {
    // $81:8E60
    if (this.vx === 0 && this.vy === 0) {
      this.heading = this.lastHeading;
    } else {
      this.heading = atan2Deg(this.rom, this.vx, this.vy);
      this.lastHeading = this.heading;
    }
  }

  private doProbe(w: BallWorld): void {
    w.terrain.probe(this.xc, this.yc, this.xf, this.yf, this.cur);
  }

  // ====================================================================
  // $82:DA51 and $82:DB20: the A / Y presses
  // ====================================================================

  /**
   * Arm or run down the A (hop) / Y (brake) modifier. `a` and `y` are the
   * newly pressed buttons this frame. Returns true when a hop starts.
   */
  buttons(a: boolean, y: boolean): boolean {
    if (this.lost || this.holed) return false;
    if (this.modWindow !== 0) {
      this.modWindow -= 1;
      this.modTimer -= 1;
      if (this.modTimer < 0) {
        this.modTimer = 0;
        this.modKind = -1;
      }
      return false;
    }
    if (!a && !y) return false;
    const hop = a;
    this.modKind = a ? 0 : 2;
    this.modTimer = this.air ? 15 : 3;
    this.modWindow = 22;
    // Too fast: no effect ($82:DB03-$82:DB19).
    const sp = abs16(this.vx) + abs16(this.vy);
    if (sp >= 0x3001 || abs16(this.vz) >= 0x3801) this.modKind = -1;
    return hop;
  }

  /** $82:DB20: on a bounce, step or wall event the speeds grow or shrink. */
  private applyButtonBounce(): void {
    // docs/physics.md also lists walls ($DA52). The game does not apply it on
    // the outline wall: a hop pressed 2 frames before a wall hit left the speed
    // unchanged (trace web_a135).
    if (!(this.bounced || this.stepHit)) return;
    if (this.modKind < 0) return;
    const k = this.rom.buttonMod[this.modKind >> 1];
    if (this.vx !== 0) this.vx = s16(this.vx + Math.floor((this.vx * k) / 256));
    if (this.vy !== 0) this.vy = s16(this.vy + Math.floor((this.vy * k) / 256));
    if (this.vz !== 0) this.vz = s16(this.vz + Math.floor((this.vz * k) / 256));
  }

  // ====================================================================
  // the frame
  // ====================================================================

  /** $81:801C. Returns the events of this frame in `this.events`. */
  step(w: BallWorld, pad = { a: false, y: false }): void {
    this.events.length = 0;
    this.hitStop = 0;
    if (this.buttons(pad.a, pad.y)) this.events.push({ type: 'hop' });

    this.bounced = this.stepHit = this.wallHit = false;
    this.savePrev();
    this.heading = -1;
    if (this.air) this.airborne(w);
    else this.rolling(w);
    this.applyButtonBounce();
    // $81:9BE5: the bounce sound depends on the speed it leaves with
    if (this.bounced && this.air && this.vz >= 0) {
      this.events.push({ type: 'bounce', vz: this.vz, code: this.cur.code });
    }
  }

  // ---- airborne ($81:803D) ----------------------------------------------

  private airborne(w: BallWorld): void {
    // $81:8805: integrate, then drag
    this.addX(this.vx);
    this.addY(this.vy);
    this.z += this.vz;
    if (this.mode !== 0x0a) {
      this.vx = this.drag(this.vx);
      this.vy = this.drag(this.vy);
    }
    this.heading_();
    this.airFrames += 1;
    this.doProbe(w);
    // the factors a friction tile overrode last frame are restored
    this.dampXY = this.defaultDampXY;
    this.dampZ = this.defaultDampZ;

    if (this.z < 0) {
      // $81:89AA
      if (Math.floor(this.z / 65536) < FALL_LIMIT - 0x10000) {
        this.lost = true;
        this.vx = this.vy = this.vz = 0;
        this.events.push({ type: 'lost' });
        return;
      }
      this.gravityStep();
      return;
    }

    this.edgeCrossing(w.terrain);
    // A wall flag was crossed and the ball is under half a step above the
    // ground it left: wall bounce.
    if (this.wallEdge >= 0) {
      const above = this.z - this.prev.ground;
      if (above < STEP_HALF) {
        this.airHit(w);
        return;
      }
    }
    this.wallEdge = -1;
    if (this.stepHeight > 0 && this.z < this.cur.ground) {
      this.airHit(w);
      return;
    }
    this.landingDispatch(w);
  }

  /** v -= sign(v) * ((|v| + $80) >> 8), $81:885C. */
  private drag(v: number): number {
    if (v < 0) return s16(v + ((((-v) & 0xffff) + 0x80) >> 8));
    return s16(v - (((v + 0x80) >> 8) & 0xff));
  }

  /** $81:899F: only gravity. */
  private gravityStep(): void {
    this.vz = s16(this.vz + this.gravity);
  }

  /** $81:88AF: a wall or a step hit in the air. */
  private airHit(w: BallWorld): void {
    void w;
    this.latch = false;
    if (this.wallEdge >= 0) {
      this.wallBounce();
      this.wallHit = true;
      this.events.push({ type: 'wallHit' });
      this.gravityStep();
      return;
    }
    this.stepBounce();
    this.stepHit = true;
    this.spinX = this.spinY = this.spinPending = 0;
    this.vz = mulQ15s(this.vz, this.stepDampZ);
    if (this.mode === 0 || this.mode === 7) this.hitStopStep();
    this.events.push({ type: 'stepHit' });
    this.gravityStep();
  }

  // ---- landing dispatch ($81:811B) ---------------------------------------

  private landingDispatch(w: BallWorld): void {
    const tile = this.cur.tile;
    if (tile >= 0x40 && tile <= 0x57 && (tile <= 0x52 || tile === 0x57)) {
      this.enemyTile(w);
      this.landDefault();
    } else if (tile >= 0x28 && tile <= 0x2d) {
      // $82:8FF1: the outline wall acts on a ball within half a step of the ground
      if (this.z - this.cur.ground < STEP_HALF) this.outlineWall(w);
      if (this.wallHit) {
        this.gravityStep(); // $82:9015: JML $81:899F
        return;
      }
      this.landDefault();
    } else if (tile === 0x08) {
      this.cupLand();
    } else if (tile === 0x02) {
      this.pillarLand(w);
    } else {
      if (tile === 0) this.latch = false; // $81:88F9
      this.landDefault();
    }
  }

  /** $81:8905: gravity above the ground, a bounce below it. */
  landDefault(): void {
    if (this.lockout !== 0) {
      this.lockout += 1;
      if (this.lockout >= 3) this.lockout = 0;
      this.gravityStep();
      return;
    }
    if (this.z >= this.cur.ground) {
      this.gravityStep();
      return;
    }
    // loc_bounce $81:891B
    this.z = this.cur.ground;
    if (this.mode !== 0x0a) this.reflect(this.cur.code);
    this.bounced = true;
    if (this.mode === 0 || this.mode === 7) {
      this.hitStopLand();
      // $81:8CE2: the fly-shot spin is one impulse at the first landing
      if (this.elevation !== 0 && this.spinPending !== 0) {
        this.vx = s16(this.vx + this.spinX);
        this.vy = s16(this.vy + this.spinY);
        this.spinPending = this.spinX = this.spinY = 0;
      }
    }
    this.spinPending = 0; // $895F: spin is spent at the first landing
    if (this.airFrames < this.rom.c.bounceMinFrames) {
      // comes to rest vertically, rolls from here ($81:896B)
      this.air = false;
      this.vz = 0;
      this.airFrames = 0;
      return;
    }
    this.vx = mulQ15s(this.vx, this.dampXY);
    this.vy = mulQ15s(this.vy, this.dampXY);
    this.vz = mulQ15s(this.vz, this.dampZ);
    this.airFrames = 0;
    this.gravityStep();
  }

  /** $81:8C79: 4 frames of hit-stop on a hard landing. */
  private hitStopLand(): void {
    if (Math.abs(this.vz) >= 0x900) {
      this.hitStop = 4;
      this.squash = this.cur.code;
    }
  }

  /** $81:8C48: 2 frames when a step is hit hard on the N or E side. */
  private hitStopStep(): void {
    if (this.stepEdge >= 2) return;
    if (abs16(this.vx) + abs16(this.vy) < 0x300) return;
    this.hitStop = 2;
    this.squash = this.stepEdge + 9;
  }

  // ---- rolling ($81:80B5) --------------------------------------------------

  private rolling(w: BallWorld): void {
    // $81:89C2: x and y move, z is the ground of the last probe
    this.addX(this.vx);
    this.addY(this.vy);
    this.z = this.cur.ground;
    this.heading_();
    this.doProbe(w);
    // class index: shapes $08-$0B are forced to code 9
    let code = this.cur.code;
    if (this.cur.shape >= 8 && this.cur.shape < 0x0c) code = 9;
    const cls = this.rom.frictionClass[code]; // 0, 2, 4 or 6
    this.fricIdx = this.mode * 4 + (cls >> 1);
    this.friction = this.rom.rollFriction[this.fricIdx];

    this.edgeCrossing(w.terrain);
    if (this.wallEdge >= 0 || this.stepHeight !== 0) {
      this.rollEdgeEvent(w);
      return;
    }
    this.rollHitDispatch(w);
  }

  /** $81:8A03: a wall, a step up or a step down while rolling. */
  private rollEdgeEvent(w: BallWorld): void {
    void w;
    this.latch = false;
    if (this.wallEdge >= 0) {
      this.wallBounce();
      this.wallHit = true;
      this.events.push({ type: 'wallHit' });
      return;
    }
    if (this.stepHeight >= 0) {
      this.stepBounce();
      this.stepHit = true;
      this.spinX = this.spinY = this.spinPending = 0;
      if (this.mode === 0 || this.mode === 7) this.hitStopStep();
      this.events.push({ type: 'stepHit' });
      return;
    }
    this.launch(this.prev.code);
  }

  /** $81:8436: the tile under a rolling ball. */
  private rollHitDispatch(w: BallWorld): void {
    const tile = this.cur.tile;
    if (tile === 0) {
      this.latch = false;
      this.rollStep(w);
    } else if (tile >= 0x40 && tile <= 0x57 && (tile <= 0x52 || tile === 0x57)) {
      this.enemyTile(w);
      this.rollStep(w);
    } else if (tile >= 0x28 && tile <= 0x2d) {
      this.outlineWall(w);
      if (!this.wallHit) this.rollStep(w);
    } else if (tile === 0x08) {
      this.cupRoll(w);
    } else if (tile === 0x02) {
      this.pillarHit(w);
    } else {
      this.rollStep(w);
    }
  }

  /** $81:8A56: crest launch, modifiers, friction, slope, curve. */
  rollStep(w: BallWorld): void {
    if (this.mode === 0x0a) return;
    this.lockout = 0; // $81:980B starts with STZ $6A7A
    const crest = this.crestLaunch();
    if (crest >= 0) {
      this.launch(crest);
      return;
    }
    const rom = this.rom;
    let skip = false;
    let fric = this.friction;
    if (this.modKind >= 0) {
      if (this.modKind === 0) {
        if (this.modTimer !== 0) skip = true;
      } else if (this.modTimer === 0) {
        skip = true;
      } else {
        fric = u16(fric + 0x1100);
      }
    }
    if (!skip) {
      this.vx = this.frictionAxis(this.vx, cosDeg(rom, this.heading), fric);
      // slope acceleration along x
      const code = this.cur.code;
      const g = rom.ballGravity[this.fricIdx];
      const sx = rom.slopeX[code];
      if (sx !== 0) this.vx = s16(this.vx + mulQ15(g, sx));
      this.vy = this.frictionAxis(this.vy, sinDeg(rom, this.heading), fric);
      const sy = rom.slopeY[code];
      if (sy !== 0) this.vy = s16(this.vy + mulQ15(g, sy));
    }
    this.curve();
    void w;
  }

  /** $81:8A8B-$81:8ADE: one axis of rolling friction. */
  private frictionAxis(v: number, cs: number, mu: number): number {
    const prod = cs * mu;
    // (prod * 2) >> 16 as a 16-bit value
    const p = u16(Math.floor((prod * 2) / 65536));
    let r: number;
    if (cs >= 0) r = ((u16(p + 0x80) >> 8) & 0xff);
    else r = (u16(p + 0xff80) >> 8) | 0xff00;
    if (r === 0) return v;
    const uv = u16(v);
    if (v >= 0) {
      const d = uv - r;
      return d < 0 ? 0 : d;
    }
    const d = uv - r;
    return d < 0 ? s16(d) : 0;
  }

  /** $81:8D17: a grounder's curve rotates the velocity. */
  private curve(): void {
    if (this.elevation !== 0 || this.spinPending === 0 || this.spinX === 0) return;
    const om = this.spinX;
    this.vx = s16(this.vx + hiWord(-om - 1, this.vy));
    this.vy = s16(this.vy + hiWord(om, this.vx));
  }

  // ---- launch and crest ----------------------------------------------------

  /** $81:980B, the part where no cell edge was crossed. */
  private crestLaunch(): number {
    if (this.dirOfMotion >= 0) return -1; // cross-cell crest rules: not ported
    if (this.cur.code === this.prev.code) return -1;
    if (this.rom.crest[this.cur.shape] === 0) return -1;
    this.lockout = 1;
    return this.prev.code;
  }

  /** loc_launch $81:8B78: the ball leaves the ground. */
  launch(oldCode: number): void {
    const rom = this.rom;
    let vz = s16(hiWord(this.vx, rom.launchX[oldCode]) + hiWord(this.vy, rom.launchY[oldCode]));
    if (this.cur.code !== 0 && (this.prev.shape & 0x10) === 0) vz = Math.floor(vz / 2);
    this.vz = vz;
    this.air = true;
    this.events.push({ type: 'launch' });
  }

  // ---- reflection -----------------------------------------------------------

  /**
   * $81:9444 + $81:8DAF: v <- M v with M a Householder matrix about the
   * surface normal. Zero entries are skipped; each product is mulQ15.
   */
  reflect(index: number): void {
    const rom = this.rom;
    const o = rom.reflectIndex[index] / 2; // word offset of the 3x3 matrix
    const m = rom.reflect;
    const vx = this.vx, vy = this.vy, vz = this.vz;
    const row = (a: number, b: number, c: number): number => {
      let s = 0;
      const t0 = m[o + a], t1 = m[o + b], t2 = m[o + c];
      if (t0 !== 0) s += mulQ15(vx, t0);
      if (t1 !== 0) s += mulQ15(vy, t1);
      if (t2 !== 0 && this.air) s += mulQ15(vz, t2);
      return s16(s);
    };
    // The ROM loads the matrix symmetrically: row i, column j of the stored
    // words (only 6 of 9 are read).
    const nx = row(0, 1, 2);
    const ny = row(1, 4, 5);
    const nz = this.air ? row(2, 5, 8) : this.vz;
    this.vx = nx; this.vy = ny; this.vz = nz;
  }

  private wallBounce(): void {
    this.restorePrev();
    this.reflect(9 + this.wallEdge);
  }

  /** $81:93D1: back to the previous cell, against the edge, reflected. */
  private stepBounce(): void {
    this.restorePrev();
    switch (this.stepEdge) {
      case 0: this.yf = 0xffff; break;
      case 1: this.xf = 0; break;
      case 2: this.yf = 0; break;
      default: this.xf = 0xffff; break;
    }
    this.reflect(9 + this.stepEdge);
    const e = this.stepEdge;
    if (this.rom.stepMaskX[e] !== 0) this.vx = s16(mulQ15(this.stepDampXY, this.vx));
    if (this.rom.stepMaskY[e] !== 0) this.vy = s16(mulQ15(this.stepDampXY, this.vy));
  }

  // ---- cell edges ($81:9001) -------------------------------------------------

  private edgeCrossing(t: Terrain): void {
    this.stepEdge = -1;
    this.wallEdge = -1;
    this.dirOfMotion = -1;
    this.stepHeight = 0;
    const cur = this.cur, prev = this.prev;
    if (cur.shape === 0 && prev.shape === 0) return;
    const dRow = prev.row - cur.row; // Y in the ROM
    const dCol = prev.col - cur.col; // A in the ROM
    if (dCol === 0 && dRow === 0) return;

    if (dCol === 0 || dRow === 0) {
      // one axis: the ball entered `cur` through the edge `entry`
      let entry: number;
      if (dCol > 0) { this.dirOfMotion = 3; entry = 1; } // moved -x, enters by E
      else if (dCol < 0) { this.dirOfMotion = 1; entry = 3; } // moved +x, enters by W
      else if (dRow < 0) { this.dirOfMotion = 2; entry = 0; } // moved +y, enters by N
      else { this.dirOfMotion = 0; entry = 2; } // moved -y, enters by S
      const exit = entry ^ 2;
      const step = this.edgeStep(t, prev.shape, prev.elev, exit, cur.shape, cur.elev, entry);
      this.stepHeight = step;
      if (step !== 0) this.stepEdge = entry;
      if (t.wallFlag(prev.idx, exit)) this.wallEdge = entry;
      return;
    }

    // Both axes changed in one frame: go through the neighbour the path
    // crossed first. The ROM picks it with a cross product ($81:9286); the
    // same choice from the segment's parameter at each grid line.
    const dx = (this.xc * 65536 + this.xf) - (this.pxc * 65536 + this.pxf);
    const dy = (this.yc * 65536 + this.yf) - (this.pyc * 65536 + this.pyf);
    const xLine = dx > 0 ? (this.xc * 65536) : (this.pxc * 65536); // grid line crossed in x
    const yLine = dy > 0 ? (this.yc * 65536) : (this.pyc * 65536);
    const tx = (xLine - (this.pxc * 65536 + this.pxf)) / dx;
    const ty = (yLine - (this.pyc * 65536 + this.pyf)) / dy;
    const xFirst = tx <= ty;
    const xEntry = dCol > 0 ? 1 : 3;
    const yEntry = dRow < 0 ? 0 : 2;
    const mid = { col: xFirst ? cur.col : prev.col, row: xFirst ? prev.row : cur.row };
    const midShape = t.inGrid(mid.col, mid.row) ? t.shape[mid.row * t.w + mid.col] : 0;
    const midElev = midShape ? t.elev[mid.row * t.w + mid.col] : 0;
    const midIdx = t.inGrid(mid.col, mid.row) ? mid.row * t.w + mid.col : -1;
    const e1 = xFirst ? xEntry : yEntry;
    const e2 = xFirst ? yEntry : xEntry;
    this.dirOfMotion = 4 + (dCol > 0 ? 1 : 0) + (dRow < 0 ? 2 : 0);

    const s1 = this.edgeStep(t, prev.shape, prev.elev, e1 ^ 2, midShape, midElev, e1);
    if (s1 !== 0) {
      if (s1 < 0 && t.wallFlag(prev.idx, e1 ^ 2)) this.wallEdge = e1;
      this.stepEdge = e1;
      this.stepHeight = s1;
      return;
    }
    if (t.wallFlag(prev.idx, e1 ^ 2)) this.wallEdge = e1;
    const s2 = this.edgeStep(t, midShape, midElev, e2 ^ 2, cur.shape, cur.elev, e2);
    this.stepHeight = s2;
    if (s2 !== 0) this.stepEdge = e2;
    if (this.wallEdge < 0 && t.wallFlag(midIdx, e2 ^ 2)) this.wallEdge = e2;
  }

  /** $81:925E, signed half steps: surface of the new cell at its entry edge
   *  minus the old cell's at the matching exit edge. */
  private edgeStep(t: Terrain, oShape: number, oElev: number, oEdge: number,
                   nShape: number, nElev: number, nEdge: number): number {
    const a = t.edgeLevel(oShape, oElev, oEdge);
    const b = t.edgeLevel(nShape, nElev, nEdge);
    return s16(b - a);
  }

  // ====================================================================
  // special tiles of hole 1
  // ====================================================================

  /** $82:8967 / $82:8990: enemy cells. */
  private enemyTile(w: BallWorld): void {
    const hit = this.enemyHitTest(w);
    if (hit) {
      if (!this.latch) {
        this.latch = true;
        if (w.enemyUntaken(this.cur.idx)) w.takeEnemy(this.cur.idx);
      }
    } else {
      this.latch = false;
    }
  }

  private enemyHitTest(w: BallWorld): boolean {
    if (this.xf < 0x4000 || this.xf >= 0xc000) return false;
    if (this.yf < 0x4000 || this.yf >= 0xc000) return false;
    if (!this.air) return true;
    const h = w.terrain.baseZ(w.enemyHeight(this.cur.idx));
    const hi = h + this.cur.ground + STEP;
    const lo = h + this.cur.ground - STEP_HALF;
    return this.z < hi && this.z >= lo;
  }

  /**
   * The play-area outline, tiles $28-$2D ($82:9019). Each is a line through
   * the cell; a ball that crosses it is reflected without loss and put back
   * where it was. Lines in cell coordinates:
   *   $28 x = .5   $29 y = .5   $2A x+y = .5
   *   $2B y-x = .5   $2C x+y = 1.5   $2D y-x = -.5
   */
  private outlineWall(w: BallWorld): void {
    const t = w.terrain;
    const side = (tile: number, xf: number, yf: number): number => {
      const x = xf / 65536, y = yf / 65536;
      switch (tile - 0x28) {
        case 0: return x - 0.5;
        case 1: return y - 0.5;
        case 2: return x + y - 0.5;
        case 3: return y - x - 0.5;
        case 4: return x + y - 1.5;
        default: return y - x + 0.5;
      }
    };
    const cells: { col: number; row: number }[] = [{ col: this.cur.col, row: this.cur.row }];
    if (this.prev.col !== this.cur.col || this.prev.row !== this.cur.row) {
      cells.push({ col: this.prev.col, row: this.prev.row });
    }
    for (const c of cells) {
      if (!t.inGrid(c.col, c.row)) continue;
      const tile = t.tile[c.row * t.w + c.col];
      if (tile < 0x28 || tile > 0x2d) continue;
      // previous and current position in this cell's coordinates
      const px = (this.pxc - c.col) * 65536 + this.pxf;
      const py = (this.pyc - c.row) * 65536 + this.pyf;
      const cx = (this.xc - c.col) * 65536 + this.xf;
      const cy = (this.yc - c.row) * 65536 + this.yf;
      const sp = side(tile, px, py);
      const sc = side(tile, cx, cy);
      if ((sp >= 0) === (sc >= 0)) continue;
      // where along the move does the line cross, and is that inside the cell?
      const k = sp / (sp - sc);
      const ix = px + (cx - px) * k;
      const iy = py + (cy - py) * k;
      if (ix < 0 || ix > 65536 || iy < 0 || iy > 65536) continue;
      // $82:ECD7: x, y and z go back (the ball is not allowed through), then
      // the probe fields ($81:87CA)
      this.restorePrev();
      this.z = this.pz;
      const vx = this.vx, vy = this.vy;
      switch (tile - 0x28) {
        case 0: this.vx = s16(-vx); break;
        case 1: this.vy = s16(-vy); break;
        case 2: case 4: this.vx = s16(-vy); this.vy = s16(-vx); break;
        default: this.vx = vy; this.vy = vx; break;
      }
      this.wallHit = true;
      this.events.push({ type: 'wallHit' });
      this.heading_();
      return;
    }
  }

  /** $82:94D3: a pillar three steps tall (simplified: top and sides). */
  private pillarLand(w: BallWorld): void {
    const top = this.cur.ground + 3 * STEP;
    if (this.z >= top) {
      this.landDefault();
      return;
    }
    // inside the pillar: bounce off it, damped ($4A3C horizontal, $4F5B vertical)
    this.restorePrev();
    this.vx = s16(-mulQ15s(this.vx, 0x4a3c));
    this.vy = s16(-mulQ15s(this.vy, 0x4a3c));
    this.vz = mulQ15s(this.vz, 0x4f5b);
    this.wallHit = true;
    this.events.push({ type: 'wallHit' });
    this.gravityStep();
    void w;
  }

  private pillarHit(w: BallWorld): void {
    this.restorePrev();
    this.vx = s16(-mulQ15s(this.vx, 0x4a3c));
    this.vy = s16(-mulQ15s(this.vy, 0x4a3c));
    this.wallHit = true;
    this.events.push({ type: 'wallHit' });
    void w;
  }

  // ---- the cup ($82:AD8E, $82:AD36, $82:AFE9) -------------------------------

  /** sub_cup_depth $82:AFE9: depth of the dish under the ball, 0 outside. */
  cupDepth(): number {
    const fold = (f: number): number => (f & 0x8000 ? f ^ 0xffff : f);
    const row = (fold(this.yf) >> 10) & 0x1f;
    const col = (fold(this.xf) >> 10) & 0x1f;
    return this.rom.cupDepth[row * 32 + col];
  }

  /** $82:AD36: a ball rolling over the cup. */
  private cupRoll(w: BallWorld): void {
    const depth = this.cupDepth();
    this.cur.ground -= depth; // $82:AFE9 lowers the ground it was asked about
    if (depth === 0) {
      this.holed = 0;
      this.rollStep(w);
      return;
    }
    const sp = abs16(this.vx) + abs16(this.vy);
    if (depth === 0x5000 || sp >= 0x300) {
      // falls in: leaves the ground with no vertical speed ($82:AD7A)
      this.vz = 0;
      this.air = true;
      this.gravityStep();
      return;
    }
    // slow on the rim: pulled toward the centre ($82:AF51), then rolls on
    const pull = (f: number): number => mulQ15(-s16(f ^ 0x8000), 0x600);
    this.vx = s16(this.vx + pull(this.xf));
    this.vy = s16(this.vy + pull(this.yf));
    this.heading_();
    this.rollStep(w);
  }

  /** $82:AD8E: a ball landing on the cup tile. */
  private cupLand(): void {
    if (this.holed) return;
    const depth = this.cupDepth();
    this.cur.ground -= depth;
    if (depth === 0) {
      this.holed = 0;
      this.landDefault();
      return;
    }
    if (depth !== 0x5000) {
      if (this.z >= this.cur.ground) {
        this.holed = 0;
        this.landDefault();
        return;
      }
      // below the dish wall: bounced back up at 3/8 of the speed ($82:AF09)
      const sp = abs16(this.vx) + abs16(this.vy);
      this.vz = s16(hiWord(sp, 0x6000));
      this.vx = s16(hiWord(this.vx, 0x6000));
      this.vy = s16(hiWord(this.vy, 0x6000));
      this.z = this.cur.ground;
      this.gravityStep();
      return;
    }
    if (this.z <= this.cur.ground + 0x4000) {
      // the flat bottom: holed ($82:AE2E)
      this.holed = 1;
      this.air = true;
      this.vx = this.vy = 0;
      this.spinX = this.spinY = this.spinPending = 0;
      return;
    }
    this.holed = 0;
    this.landDefault();
  }
}
