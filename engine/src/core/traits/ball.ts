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
/** $D872 (block) / $D9EE (work): the ball is in the water ($82:80F6; sim/water.ts). */
export const BallWet = trait({ wet: 0 });
/** $D9CC/$D9CE/$D9D0: fly-shot impulse, grounder curve rate, pending flag. */
export const BallSpin = trait({ sx: 0, sy: 0, pending: 0 });
/**
 * $D85A (block) / $D9C8 (work): the ball mode, 0 normal, 1-10 the copy
 * ability in use (its number, `$82:C8B6`), 12-21 a hit code a reaction left
 * (`$82:DBBB`); it selects the per-mode table rows. The block-work pairing
 * is `$82:EFEA` / `$82:F17A` (notes/port-v2-phase5-abilities.md).
 */
export const BallMode = trait({ mode: 0 });
/**
 * The copy ability's other block words (work copy in parentheses):
 * `$D856` (`$D9C6`) the ability worn, or a hit code, which picks the Kirby
 * state code's handlers and can outlive the mode; `$D85E` (`$D9CA`) the
 * shot's use latch, 0 at the set-up and at a take, -1 once used. The stock
 * `$D852` (`$D9C4`) is `StockedAbility` (counters.ts).
 */
export const BallAbility = trait({ worn: 0, latch: 0 });
/** $DA4A: 1 holed (in the cup), 2 once the ball has sunk ($82:AE61). */
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
  onOverlay: number; // $D9EE: in the water (block $D872); the water's handlers set it, the probe clears it off $60-$6F ($81:87FB)
  pAir: number; pOnOverlay: number; // $DA0C / $DA0E
  pXf: number; pXc: number; // $DA10 / $DA12
  pYf: number; pYc: number; // $DA14 / $DA16
  pZ: number; // $DA1A:$DA18
  pCell: number; pShape: number; // $DA1C / $DA1E
  pElev: number; pQuad: number; // $DA20 / $DA22
  pCode: number; // $DA24
  pGround: number; // $DA28:$DA26
  pTile: number; // $DA2A
  scratch: number; // $DA2C: block $D886, the heading stored by the last step ($82:F1CE); the warp's $82:AC4C reads it

  // --- heading ($81:8E60) ---
  deg: number; // $D9DA ($FFFF = invalid, recomputed)
  dir16: number; // $D9DE
  dir32: number; // $D9E0
  lastDeg: number; // $D9E2

  // --- spin ($D9CC/$D9CE/$D9D0) ---
  spinX: number; spinY: number; spinPending: number;

  // --- flags ---
  mode: number; // $D9C8: 0 normal, 1-10 the copy abilities, 12-21 hit codes (block $D85A)
  stock: number; // $D9C4: the stocked ability (block $D852)
  worn: number; // $D9C6: the ability worn, or a hit code (block $D856)
  latch: number; // $D9CA: the shot's use latch, 0 or -1 (block $D85E)
  /** $D75A,X / $D75E,X: Kirby's ability poses' switch variables (a variant:
   *  the heading's half `$82:EDB5`, the UFO's pose; a direction: the surface
   *  code or the 16-way heading). Persistent; the view reads them (Pose). */
  abilityVar: number;
  abilityDir: number;
  /**
   * The abilities' shared words `$D762`-`$D77A`: single words (no player
   * index), outside the work copy, and kept by the shot's set-up (it clears
   * only $D768/$D76A); each setup initialises what it reads. By ability:
   *
   *   $D762  Fireball full-speed frames (20); Wheel decel frames (3, $FFFF
   *          stopped); Tornado burst frames (8); Parasol 1; Hi-Jump's flight
   *          (state 25's script clears it); UFO's timer (615 / 12 / 15 / 60)
   *   $D764/$D766  Wheel: the velocity along the heading at its speed
   *   $D770  Stone's first ground iteration done; Needle's one stick on
   *          $70-$7B; Wheel's hop done; Tornado's held L/R; Parasol closed
   *   $D772/$D774  Stone's pose count ($D772); Fireball's -$100 and Wheel's
   *          -200 along the heading; Tornado's saved |vx|, |vy|
   *   $D776  Stone's rebounds left; Fireball's decel frames (10); Wheel's
   *          speed; Tornado's pose speed; UFO's HUD countdown (600)
   *   $D778  Wheel's last $69D8; Parasol's phase (0 rolling, 1 open, 2 slow)
   *   $D77A  Wheel: $FFFF on the ground last frame; UFO's phase (0 flying,
   *          1 the B exit, 2 falling)
   */
  d762: number; d764: number; d766: number;
  d770: number; d772: number; d774: number; d776: number; d778: number; d77a: number;
  /** $D76C,X: counted by the transformation (0 after it), the water drop and the ends (Kirby's scripts and objects read it). */
  d76c: number;
  /** $D784,X / $D788,X: a hit code's own counter (19: 1; 15: 40 after the bounce) and code 15's bounce done. */
  d784: number;
  d788: number;
  /** $D79A,X: cleared by a hit code's water drop ($82:E1A7; its reader is 2P). */
  d79a: number;
  /** The trigger's transformation ran: the setup follows the 48 frames. */
  setupPending: number;
  /** The setup waited: its tail follows the wait (sim/abilities.ts abilitySetupTail). */
  setupTail: number;
  /** Mirrors of the Shot trait ($D9B4/$D9B6), set by load-ball-work; the
   *  ROM keeps them outside the work copy but every kernel that needs them
   *  sits in this step. */
  shotAim: number; // $D9B4, degrees
  shotElev: number; // $D9B6: 0 grounder, 60 fly shot
  rollTB: number; // $6B58: the top/back selector latched at the shot (the water's skips, $82:8228)
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
  classIndex: number; // $6A72: mode * 8 + $81:8C12[code] (a byte index)

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

  boostFlash: number; // $6A28: a straight boost hit's launch speed, 0 otherwise; object 112's hum runs while it is set (systems/boost-hum.ts)
  /** The $DA0A the aim's guide left in the game's work copy (sim/guide.ts), and
   *  whether it is still there (until the next step's load, $82:F030). The
   *  boost hum reads it; the step itself never does. */
  guideTile: number;
  guideLeft: number;
  /** $68F0: the fly shot's first-bounce sound offset (object 25, $84:88D2);
   *  the tail plays it + 4 and the object ends there. */
  spinBounceSfx: number;
  stillGate: number; // $D9C2: the hazard path's still-count gate
  over: number; // $D9BE: shot over (mirrors StillCount)
  frames: number; // $D9C0: the still count (mirrors StillCount)
  modifierKind: number; // $DA76
  modifierWindow: number; // $DA78
  modifierTimer: number; // $DA7A

  // --- the copy abilities' facts (sim/abilities.ts; cleared per step) ---
  /** $D7D4: Kirby's state the ability code wrote last, -1 none. */
  poseState: number;
  /** Inline sound requests ($80:B542), in order. */
  abilitySfx: number[];
  /** Thread objects spawned ($80:DFBA / $80:E4F2), by type. */
  abilitySpawn: number[];
  /** Spark's `$82:EE9A`: the cell whose actor it destroyed, -1 none. */
  destroyCell: number;
  /** Hi-Jump's relaunch: the shot's aim and elevation become w.shotAim / w.shotElev, the grounder flag 0. */
  relaunch: number;
  /** Spark's setup with a spin pending: the roll pose by the spin ($82:C808). */
  rollPoseFromSpin: number;
  /** A palette set loaded ($80:D2FE: Fireball's 5), -1 none. */
  paletteSet: number;
  /** Object 49 (the UFO's body) runs its per-frame code: its $531C cleared by the setup's tail. */
  ufoLive: number;
  /** Object 51 (the parasol): its variant 0-2 (Parasol's phase $D778), 3 falling, -2 just spawned, -1 none. */
  parasol: number;

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

  // --- enemy hit state ($6A68/$6A0C are per-player) ---
  enemyLatch: number; // $6A68 (shared with the pillar's bounce, $82:9566)
  enemyHitMark: number; // $6A0C
  /** A fact: the enemy hit test passed with the latch clear; the cell + 1
   *  ($D9FC), for the take ($82:8A2E) that follows the tile dispatch. */
  enemyHit: number;
  /** The ability enemy's take waiting out its 4 frames: its cell + 1, 0 none ($82:8A83). */
  takePending: number;
  /** A fact: the hole-out test passed this step ($82:AE2E, holed 0 -> 1). */
  holedIn: number;
  /** A fact: the sink ended this step ($82:AEC1, holed 1 -> 2). */
  sunk: number;
  /** A fact: a sound a tile handler requests inline ($80:B542), not
   *  through the step's tail (the pillar's $71, a bumper's $6F); $FFFF none. */
  sfxNow: number;

  // --- the warps (sim/warp.ts) ---
  /** $6A42: one warp per visit (per player). */
  warpLatch: number;
  /** A fact: a warp's handler passed, the `warp` entry moves the ball ($82:AA02). */
  warpPending: number;
  /** A fact: the warp was landed on at |vz| >= $900 (Kirby's state $0C, $82:A9C9). */
  warpSquash: number;

  // --- the hazards (sim/hazards.ts) ---
  /** $6A22: one hit per pass, shared by the bumper families. */
  hazLatch: number;
  /** $6A24: the axes the last box test passed ($82:96BA). */
  hazAxes: number;
  /** $69C6: the volcano base's latch (per player). */
  volLatch: number;
  /** Facts: $D780, the reaction the roll loop runs after the step (0 none;
   *  $14 a bumper, $13 the $05 tile, $0F a volcano's base); the tomatoes
   *  queued (`$83:ABC5`); the effect objects $2F spawned ($82:EED8). */
  hurt: number;
  tomatoLoss: number;
  hazardHit: number;

  // --- the snap panels (sim/dispatch.ts, systems/snap-trail.ts) ---
  /** A fact: a snap push ran this step, its `STZ $699A` (object 61's keep-alive). */
  snapKeep: number;
  /** A fact: a snap push found the latch clear and spawned object 61 ($82:A60E). */
  snapSpawn: number;

  // --- the water $60-$6F (sim/water.ts; docs/tiles.md "Water") ---
  /** The block's `$D872` as the last load found it: the guide starts from it
   *  ($81:A9D6) and its rolling path tests it ($81:B29D). */
  blockWet: number;
  /** $69CC: the region test, 0 dry, 1 shallow, 2 deep ($82:83DD). */
  waterRegion: number;
  /** $69D0:$69CE: the level ($82:83B9), 32-bit; the guide zeroes it every step ($81:AF82). */
  waterLevel: number;
  /** $69D4:$69D2 and $69D6: the ground and the surface code a handler found
   *  ($82:80FF); the ground projection reads them on water ($81:A4B7). */
  waterGround: number;
  waterCode: number;
  /** $69D8: the ball rides the level (modes 6, 9 and 10). */
  waterWalk: number;
  /** $69DA: Freeze (mode 9) has iced the water. */
  waterFreeze: number;
  /** $69DC: the skips left, $FFFF none ($82:8228). */
  waterSkips: number;
  /** Facts, for the step's effects: the effect object a handler spawned
   *  (53-57, 0 none; $82:8604, $82:82A3, $82:8515); the pair of object 67s
   *  ($82:85DD); Kirby's palette written ($82:8604: -1 not, 0 dry, 1 wet); the
   *  effects stopped ($80:B542 with 0); the frozen frame (JML $80:8F78); Kirby's
   *  state 14 ($82:82B9). */
  waterSplash: number;
  waterBubbles: number;
  waterPalette: number;
  waterSilence: number;
  waterWait: number;
  kirbyRoll: number;
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
  mode: 0, stock: 0, worn: 0, latch: 0,
  abilityVar: 0, abilityDir: 0, d76c: 0, d784: 0, d788: 0, d79a: 0, setupPending: 0, setupTail: 0,
  d762: 0, d764: 0, d766: 0, d770: 0, d772: 0, d774: 0, d776: 0, d778: 0, d77a: 0,
  poseState: -1, abilitySfx: [], abilitySpawn: [], destroyCell: -1, relaunch: 0, rollPoseFromSpin: 0, paletteSet: -1, ufoLive: 0, parasol: -1,
  shotAim: 0, shotElev: 0, rollTB: 6,
  lost: 0, lodgeTimer: 0, wallCode: 0, wallVariant: 0, wallTileRef: 0,
  request: null,
  bounceSrcX: 0x7d6f, bounceSrcZ: 0x5332,
  stepSrcX: 0x5332, stepSrcZ: 0x6665, // $80:DD13, $80:DD15 ($80:C688)
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
  enemyLatch: 0, enemyHitMark: 0, enemyHit: 0, takePending: 0, holedIn: 0, sunk: 0, sfxNow: 0xffff,
  warpLatch: 0, warpPending: 0, warpSquash: 0,
  hazLatch: 0, hazAxes: 0, volLatch: 0, hurt: 0, tomatoLoss: 0, hazardHit: 0,
  snapKeep: 0, snapSpawn: 0,
  blockWet: 0, waterRegion: 0, waterLevel: 0, waterGround: 0, waterCode: 0,
  waterWalk: 0, waterFreeze: 0, waterSkips: 0,
  waterSplash: 0, waterBubbles: 0, waterPalette: -1, waterSilence: 0, waterWait: 0, kirbyRoll: 0,
  hopRequest: 0,
  bouncePose: 0,
  fellOut: 0,
  fallTimer: 0xf0,
  boostFlash: 0,
  guideTile: 0,
  guideLeft: 0,
  spinBounceSfx: 0,
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
