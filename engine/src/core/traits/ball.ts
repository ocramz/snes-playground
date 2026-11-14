/**
 * The ball's state, in the two layers the original keeps (physics.md "The
 * ball's state"):
 *
 * - the per-player block ($D87A-$D96E, one word per field per player) is the
 *   persistent state — the SoA traits below;
 * - the work copy ($D9C6-$DA6E) is what the physics step runs on — the AoS
 *   `BallWork` trait, filled by `load-ball-work` and written back by
 *   `store-ball-work` (items 11 and 28 of the schedule).
 *
 * Word fields are kept as the raw unsigned 16-bit patterns the 65816 holds;
 * signed reads go through `s16` (fixed.ts). `z` is the one 32-bit field
 * ($D9F8:$D9FA), kept as a signed 32-bit JS number.
 */
import { trait } from 'koota';

/** x: cell column ($D9F2) and 16-bit fraction ($D9F0); y likewise. */
export const BallPos = trait({ xc: 0, xf: 0, yc: 0, yf: 0, z: 0 });
/** $D9D4/D9D6/D9D8: fractions of a cell per frame; z in 16.16. */
export const BallVel = trait({ vx: 0, vy: 0, vz: 0 });
/** $D9EC. */
export const BallAir = trait({ air: 0 });
/** $D9CC/$D9CE/$D9D0: fly-shot impulse, grounder curve rate, pending flag. */
export const BallSpin = trait({ sx: 0, sy: 0, pending: 0 });
/** $D9C8: 0 normal, 1-21 the copy-ability modes; always 0 for now. */
export const BallMode = trait({ mode: 0 });
/** $DA4A: 1 holed, 2 once the hole-out has run. */
export const BallHoled = trait({ holed: 0 });
/** $D9DA (heading, degrees 0-359), $D9E2 (last heading while moving). */
export const BallHeading = trait({ deg: 0, last: 0 });
/** $D9BE/$D9C0: shot over, still-frame count ($81:A5CD). */
export const StillCount = trait({ over: 0, frames: 0 });
/** $DA76/$DA78/$DA7A: the A/Y modifier kind, window and timer ($82:DA51). */
export const Modifier = trait({ kind: -1, window: 0, timer: 0 });

/**
 * The work copy. Field names follow the RAM map in docs/physics.md; the
 * comment on each gives its address. Everything is reset or overwritten by
 * the step's prologue except where noted, mirroring the partial resets of
 * the original.
 */
export interface BallWorkFields {
  // --- position and velocity (mirrors of the block, plus the probe) ---
  xc: number; xf: number; // $D9F2 / $D9F0
  yc: number; yf: number; // $D9F6 / $D9F4
  z: number; // $D9FA:$D9F8, 32-bit
  vx: number; vy: number; vz: number; // $D9D4 / $D9D6 / $D9D8
  air: number; // $D9EC

  // --- the terrain probe ($81:9479) and its previous frame ($81:8751) ---
  cell: number; shape: number; // $D9FC / $D9FE
  elev: number; quad: number; // $DA00 / $DA02
  code: number; // $DA04, the quadrant's surface code 0-8
  ground: number; // $DA08:$DA06, 32-bit
  tile: number; // $DA0A
  onOverlay: number; // $D9EE: set while the tile is in $60-$6F ($82:C85F)
  pAir: number; pOnOverlay: number; // $DA0C / $DA0E
  pXf: number; pXc: number; // $DA10 / $DA12
  pYf: number; pYc: number; // $DA14 / $DA16
  pZ: number; // $DA1A:$DA18
  pCell: number; pShape: number; // $DA1C / $DA1E
  pElev: number; pQuad: number; // $DA20 / $DA22
  pCode: number; // $DA24
  pGround: number; // $DA28:$DA26
  pTile: number; // $DA2A
  scratch: number; // $DA2C (loaded from block $D886, no reader found)

  // --- heading ($81:8E60) ---
  deg: number; // $D9DA ($FFFF = invalid, recomputed)
  dir16: number; // $D9DE
  dir32: number; // $D9E0
  lastDeg: number; // $D9E2

  // --- spin ($D9CC/$D9CE/$D9D0) ---
  spinX: number; spinY: number; spinPending: number;

  // --- flags ---
  mode: number; // $D9C8: 0 normal, 1-21 the copy abilities (block $D886)
  /** Mirrors of the Shot trait ($D9B4/$D9B6), set by load-ball-work; the
   *  ROM keeps them outside the work copy but every kernel that needs them
   *  sits in this step. */
  shotAim: number; // $D9B4, degrees
  shotElev: number; // $D9B6: 0 grounder, 60 fly shot
  lost: number; // $D9D2 bit 0: fell below -$11_0000
  lodgeTimer: number; // $D9EA: the $1C/$1D... lodge wiggle counter ($81:93A5)
  wallCode: number; // $6A18: the outline wall's last connection code
  wallVariant: number; // $0E scratch of the outline wall (sfx variant)
  wallTileRef: number; // $10 scratch: the tile whose line reflected
  /** Engine plumbing: a hit-stop request the stall runner consumes. */
  request: { frames: number; state: number; after: 'landing' | 'stepHit' } | null;

  // --- coefficients ($DA30-$DA46; block-backed at $D922-$D94E) ---
  bounceSrcX: number; // $DA30
  bounceSrcZ: number; // $DA32
  stepSrcX: number; // $DA34
  stepSrcZ: number; // $DA36
  gravity: number; // $DA38
  rollMu: number; // $DA3A
  dampXY: number; // $DA3C
  dampZ: number; // $DA3E
  stepDamp: number; // $DA40
  stepDampZ: number; // $DA42
  pad44: number; // $DA44 ($00A0 at set-up, no reader found)
  restSpeed: number; // $DA46

  // --- counters ---
  airFrames: number; // $DA48, frames since the last bounce
  holed: number; // $DA4A
  launchLock: number; // $6A7A: the post-crest-launch bounce lock-out
  tailSfx: number; // $6A6C: the sfx id the step tail plays ($81:9BE5), $FFFF none
  hitStopLatch: number; // $6A70: a hit-stop already ran this step
  lock6a6e: number; // $6A6E (hit-stop scratch, presentation)
  classIndex: number; // $6A72: mode * 8 + friction class * 2

  // --- the facts (one step, physics.md event table) ---
  stepHeight: number; // $DA4C: the edge step, half steps
  bounced: number; // $DA4E
  hitStep: number; // $DA50
  hitWall: number; // $DA52
  fact4: number; // $DA54 (cleared with the others, no reader found)

  // --- edge crossing ($81:9001) ---
  moveDir: number; // $6A78: 0-7 the crossing taken, $FFFF none
  diagPick: number; // $6A74: which diagonal of a corner crossing
  crossAxis: number; // $6A76: the second axis of a diagonal crossing
  edge: number; // $D9E4: the edge of a step crossed, else $FFFF
  wallEdge: number; // $D9E6: the edge of a wall flag crossed, else $FFFF
  wallDir: number; // $D9E8 ($81:92D0 table, reader unknown)

  // --- screen position ($DA56-$DA68, presentation; written by $82:F53D) ---
  screenX: number; screenY: number; // $DA58 / $DA5C

  // --- per-player scratch the block round-trips ($82:F030/$82:F1E3) ---
  block6a: number; // $DA6A (block $D95E)
  block6c: number; // $DA6C (block $D962)
  block6e: number; // $DA6E (block $D966)
  ecdd: number; // $ECDD via block $D9A2

  // --- cup state ($6B7E/$6B80/$6B82; the cup handler's own globals) ---
  cupDepthScratch: number; // $6B7E: the last depth, $FFFF none
  cupGround: number; // $6B82:$6B80: the recorded ground while sinking

  boostFlash: number; // $6A28: the boost panel's pending impulse (phase 5)
  stillGate: number; // $D9C2: the hazard path's still-count gate
  over: number; // $D9BE: shot over (mirrors StillCount)
  frames: number; // $D9C0: the still count (mirrors StillCount)
  modifierKind: number; // $DA76
  modifierWindow: number; // $DA78
  modifierTimer: number; // $DA7A

  /** A fact for update-pose: the A arming asked for the hop pose ($82:DAAE). */
  hopRequest: number;
  /** A fact for update-pose: an airborne bounce shows the roll pose ($82:CE24). */
  bouncePose: number;
  /** The fall below z -$11_0000 stopped the ball ($81:89B2). The ROM shares
   *  $D9D2 bit 0 with the projection's "below zero" flag; this keeps the
   *  step's own case apart. */
  fellOut: number;
  /** $6A88: the lost ball's countdown to "shot over" ($81:A15C; $F0 idle). */
  fallTimer: number;

  // --- enemy hit state ($6A68/$6A0C are per-player; phase 6 wires the take) ---
  enemyLatch: number; // $6A68
  enemyHitMark: number; // $6A0C
}

export const emptyWork = (): BallWorkFields => ({
  xc: 0, xf: 0, yc: 0, yf: 0, z: 0,
  vx: 0, vy: 0, vz: 0, air: 0,
  cell: 0, shape: 0, elev: 0, quad: 0, code: 0, ground: 0, tile: 0, onOverlay: 0,
  pAir: 0, pOnOverlay: 0, pXf: 0, pXc: 0, pYf: 0, pYc: 0, pZ: 0,
  pCell: 0, pShape: 0, pElev: 0, pQuad: 0, pCode: 0, pGround: 0, pTile: 0,
  scratch: 0,
  deg: 0xffff, dir16: 0, dir32: 0, lastDeg: 0,
  spinX: 0, spinY: 0, spinPending: 0,
  mode: 0, shotAim: 0, shotElev: 0,
  lost: 0, lodgeTimer: 0, wallCode: 0, wallVariant: 0, wallTileRef: 0,
  request: null,
  bounceSrcX: 0x7d6f, bounceSrcZ: 0x5332,
  stepSrcX: 0x3fff, stepSrcZ: 0x6665,
  gravity: 0xffc0, rollMu: 0x0c00, dampXY: 0x7d6f, dampZ: 0x5332,
  stepDamp: 0x5332, stepDampZ: 0x6665,
  pad44: 0x00a0, restSpeed: 1,
  airFrames: 0, holed: 0, launchLock: 0, tailSfx: 0xffff, hitStopLatch: 0, lock6a6e: 0, classIndex: 0,
  stepHeight: 0, bounced: 0, hitStep: 0, hitWall: 0, fact4: 0,
  moveDir: 0xffff, diagPick: 0, crossAxis: 0,
  edge: 0xffff, wallEdge: 0xffff, wallDir: 0,
  screenX: 0, screenY: 0,
  block6a: 0, block6c: 0xffff, block6e: 0, ecdd: 0,
  cupDepthScratch: 0, cupGround: 0,
  enemyLatch: 0, enemyHitMark: 0,
  hopRequest: 0,
  bouncePose: 0,
  fellOut: 0,
  fallTimer: 0xf0,
  boostFlash: 0,
  stillGate: 0,
  over: 0, frames: 0,
  modifierKind: -1, modifierWindow: 0, modifierTimer: 0,
});

/**
 * The AoS work trait: one instance per ball entity, mutated in place by
 * the kernels. AoS because the kernels need a stable object to thread
 * through (a SoA `get` returns a copy, plans risk 7).
 */
export const BallWork = trait(emptyWork);
