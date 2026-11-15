/**
 * The copy abilities' own code (notes/port-v2-phase5-abilities.md; read
 * 2026-11-15): three jump tables keyed on the ability worn `$D9C6` —
 * the setup `$82:C90A` (once, after the transformation), the airborne
 * handler `$82:CDE8` and the ground handler `$82:D572` (once per roll
 * iteration, from Kirby's state code `$82:CDBB`, after the physics step).
 * Entry 0 of the two per-iteration tables is the plain code ($82:CDFF /
 * $82:D588: the A/Y modifier and the bounce pose), which the step runs
 * itself: a handler returns `PLAIN` to fall through to it.
 *
 * The handlers write the work copy and these facts, which the step's
 * systems turn into world effects:
 *   poseState     $D7D4: Kirby's state (-1 none; the last write wins)
 *   abilityVar    $D75A, abilityDir $D75E: the poses' switch variables
 *   block6a       $DA6A: the ball's sprite index while the ability shows
 *   abilitySfx    inline sound requests ($80:B542), in order
 *   abilitySpawn  thread objects spawned ($80:DFBA / $80:E4F2), by type
 *   destroyCell   Spark's `$82:EE9A`: the actor cell it destroyed
 *   relaunch      Hi-Jump's `$81:BA0E`: the aim and the elevation (65)
 *                 the shot keeps
 *
 * Group A here (the setup sets the motion, the mode rows do the rest):
 * Stone 1, Needle 4, Spark 7, Hi-Jump 8, Freeze 9.
 */
import { s16, wrap16, mulFloor, mid16 } from '../fixed';
import { cosDeg, sinDeg } from './trig';
import { rotateBy } from './turn';
import { curveCore } from './roll';
import type { Ctx, Work } from './context';
import { launchVelocity } from './shot';
import { thaw } from './water';

/** A per-iteration handler that defers to the plain code ($82:CDFF / $82:D588). */
export const PLAIN = 'plain';
/** The handler ran (the plain code does not). */
export const HANDLED = 'handled';
export type HandlerResult = typeof PLAIN | typeof HANDLED;

/** The pad as the state code reads it: held $0067, pressed $006B. */
export interface AbilityPad {
  held: number;
  pressed: number;
}

/** `$80:DC1D`[ability]: the airborne gravity the setup loads into $DA38. */
function abilityGravity(ctx: Ctx, ability: number): number {
  return ctx.rules.table('abilityGravity')[ability];
}

/** `$82:EDB5`: 1 when the heading is in [136, 316) degrees (unsigned), else 0. */
export function headingHalf(w: Work): number {
  return w.deg >= 0x88 && w.deg < 0x13c ? 1 : 0;
}

/** z at or below the ground: the unsigned 32-bit compare ground >= z. */
function atOrBelowGround(w: Work): boolean {
  return (w.ground >>> 0) >= (w.z >>> 0);
}

// ------------------------------------------------------------------
// The trigger `$82:C875` and the transformation `$82:D9D2`
// ------------------------------------------------------------------

/**
 * `$82:C875`'s gates (1P: the ball is the player's): B newly pressed, not
 * holed, not lost, moving, not in the water, a stock, the shot's latch not
 * yet used.
 */
export function triggerGates(w: Work, pressed: number): boolean {
  if ((pressed & 0x8000) === 0) return false;
  if (w.holed !== 0) return false;
  if ((w.lost & 1) !== 0) return false;
  if ((w.vx | w.vy | w.vz) === 0) return false;
  if (w.onOverlay !== 0) return false;
  if (w.stock === 0) return false;
  return s16(w.latch) >= 0;
}

/**
 * `$82:C8AD`-`$82:C8CE` and the transformation `$82:D9D2` up to its wait:
 * the latch spent, the heading back to the last moving one, the ability
 * worn and its mode (the block's too, at once: the transformation's script
 * switches on it), object $15 at Kirby, state 8, `$D76C` + 1; the poses'
 * switch variables by `$82:D9FF` (Stone and Needle the heading's half
 * `$82:EDB5`; Parasol spawns object $34 and, as the rest, takes the 16-way
 * heading `$D9DE`); sfx $2E. The 48 frames follow (the `transform` stall).
 */
export function transform(w: Work): void {
  w.latch = wrap16(w.latch - 1);
  w.deg = w.lastDeg; // $D9DA = $D9E2
  if (w.stock >= 0x0b) throw new Error(`$82:C900: ability ${w.stock} hangs`);
  w.worn = w.stock;
  w.mode = w.stock;
  w.d76c = 0; // STZ $D76C,X (and the block's $D872, clear already)
  w.abilitySpawn.push(0x15); // $80:E4B6 at Kirby's screen position
  w.poseState = 8;
  w.d76c = wrap16(w.d76c + 1);
  let v: number;
  if (w.worn === 1 || w.worn === 4) {
    v = headingHalf(w); // $82:DA24
  } else {
    if (w.worn === 2) w.abilitySpawn.push(0x34); // $82:DA15, its $531C = 0
    v = w.dir16; // $82:DA2A
  }
  w.abilityVar = v;
  w.abilityDir = v;
  w.abilitySfx.push(0x2e);
}

/**
 * The end of the 48 frames (`$82:DA44`) and the trigger's tail (`$82:C8D2`):
 * `$D76C` = 0, state 3, the A/Y modifier off, the ice thawed unless the new
 * ability is Freeze, the still gate cleared, the spin cleared unless Spark.
 * The ability's setup follows.
 */
export function afterTransform(ctx: Ctx, w: Work): void {
  w.d76c = 0;
  w.poseState = 3;
  w.modifierKind = -1;
  w.modifierWindow = 0;
  if (w.waterFreeze !== 0 && w.mode !== 9) thaw(ctx, w);
  w.stillGate = 0;
  if (w.worn !== 7) {
    w.spinPending = 0;
    w.spinX = 0;
    w.spinY = 0;
  }
}

// ------------------------------------------------------------------
// The water drops: an ability or a hit code entering the water
// ------------------------------------------------------------------

/** `$82:D923` (worn 1-10 entering the water): airborne, gravity $FFC0, state 19, mode and worn 0. */
export function abilityWaterDrop(ctx: Ctx, w: Work): void {
  w.air = 1;
  w.gravity = ctx.rules.table('ballGravity')[0];
  w.d76c = wrap16(w.d76c + 1);
  w.poseState = 0x13;
  w.block6a = 0;
  w.mode = 0;
  w.worn = 0;
  w.stillGate = 0;
}

/** `$82:E1A7` (a hit code entering the water): state 19, mode and worn 0. */
export function codeWaterDrop(w: Work): void {
  w.d76c = wrap16(w.d76c + 1);
  w.d79a = 0;
  w.poseState = 0x13;
  w.block6a = 0;
  w.mode = 0;
  w.worn = 0;
}

// ------------------------------------------------------------------
// The hit codes `$82:DE32` (Kirby state code B; 1P: 15, 19, 20)
// ------------------------------------------------------------------

/**
 * `$82:DE5E`[code - 12], airborne. 15 (a volcano's base; 12 shares it, 2P):
 * thrown with state 40 until the first bounce, then state 41, objects $1D
 * and $1E and 41 more iterations; 19 (the `$05` row, the UFO's object hit):
 * until the first bounce; 20 (a bumper, the cone): one step. Then state
 * 14 and the mode and the worn code 0. The others are 2P's.
 */
export function codeAir(w: Work): HandlerResult {
  switch (w.worn) {
    case 0x0c:
    case 0x0f: return code15Air(w);
    case 0x13:
      if (w.d784 !== 0) {
        w.d784 = wrap16(w.d784 - 1);
        return HANDLED;
      }
      if (w.bounced === 0) return HANDLED;
      endCode(w);
      return HANDLED;
    case 0x14:
      w.worn = 0;
      w.mode = 0;
      return HANDLED;
    default:
      throw new Error(`hit code ${w.worn}: 2P only, not ported (step 9)`);
  }
}

/** `$82:DFD2`[code - 12], on the ground. */
export function codeGround(w: Work): HandlerResult {
  switch (w.worn) {
    case 0x0c:
    case 0x0f:
      if (w.mode === 0) return HANDLED; // $82:DFE6: RTL
      w.d784 = wrap16(w.d784 - 1);
      if (s16(w.d784) >= 0) return HANDLED;
      endCode(w);
      return HANDLED;
    case 0x13:
    case 0x14:
      w.worn = 0;
      w.mode = 0;
      return HANDLED;
    default:
      throw new Error(`hit code ${w.worn}: 2P only, not ported (step 9)`);
  }
}

/** `$82:DE73`: code 15 airborne. */
function code15Air(w: Work): HandlerResult {
  if (w.mode === 0) return PLAIN; // JML $82:CDFF
  if (w.d788 !== 0) {
    // $82:DEB5: the 41 frames after the bounce
    w.d784 = wrap16(w.d784 - 1);
    if (s16(w.d784) >= 0) return HANDLED;
    endCode(w);
    return HANDLED;
  }
  if (w.bounced === 0) return HANDLED;
  w.d788 = 1;
  w.poseState = 0x29;
  w.abilitySpawn.push(0x1d, 0x1e);
  w.d784 = 0x28;
  return HANDLED;
}

/** State 14, the index 0, the mode and the code 0. */
function endCode(w: Work): void {
  w.poseState = 0x0e;
  w.block6a = 0;
  w.mode = 0;
  w.worn = 0;
}

// ------------------------------------------------------------------
// The setup `$82:C90A`
// ------------------------------------------------------------------

/**
 * `$82:C90A`[ability]: the ability's setup, after the transformation.
 * Returns the frames of a wait inside it (`$80:8FB6`), 0 none; the part
 * after the wait is `abilitySetupTail` (w.setupTail).
 */
export function abilitySetup(ctx: Ctx, w: Work): number {
  switch (w.worn) {
    case 1: stoneSetup(ctx, w); return 0;
    case 2: return parasolSetup(ctx, w);
    case 3: fireballSetup(ctx, w); return 0;
    case 4: needleSetup(ctx, w); return 0;
    case 5: tornadoSetup(ctx, w); return 0;
    case 6: wheelSetup(ctx, w); return 0;
    case 7: sparkSetup(ctx, w); return 0;
    case 8: hiJumpSetup(ctx, w); return 0;
    case 9: freezeSetup(ctx, w); return 0;
    case 10: return ufoSetup(ctx, w);
    default: throw new Error(`ability ${w.worn}: setup not ported`);
  }
}

/** The setup's part after its wait. */
export function abilitySetupTail(_ctx: Ctx, w: Work): void {
  w.setupTail = 0;
  if (w.worn === 2) w.abilitySpawn.push(0x33); // $82:C9AB: the parasol, object 51
  if (w.worn === 10) w.ufoLive = 1; // $82:CDAF: object 49's $531C = 0
}

/** `$82:CDE8`[worn]: airborne, once per roll iteration. */
export function abilityAir(ctx: Ctx, w: Work, pad: AbilityPad): HandlerResult {
  switch (w.worn) {
    case 0: return PLAIN;
    case 1: return stoneAir(ctx, w);
    case 2: return parasolAir(ctx, w, pad);
    case 3: return fireballAir(ctx, w);
    case 4: return needleAir(ctx, w);
    case 5: return tornadoAir(ctx, w, pad);
    case 6: return wheelAir(ctx, w);
    case 7: return sparkAir(w);
    case 8: return hiJumpAir(w);
    case 9: return freezeAir(w);
    case 10: return ufoAir(ctx, w, pad);
    default: throw new Error(`ability ${w.worn}: airborne handler not ported`);
  }
}

/** `$82:D572`[worn]: on the ground, once per roll iteration. */
export function abilityGround(ctx: Ctx, w: Work, pad: AbilityPad): HandlerResult {
  switch (w.worn) {
    case 0: return PLAIN;
    case 1: stoneGround(w); return HANDLED;
    case 2: return parasolGround(w);
    case 3: return fireballGround(ctx, w);
    case 4: needleGround(w); return HANDLED;
    case 5: return tornadoGround(ctx, w, pad);
    case 6: return wheelGround(ctx, w);
    case 7: return HANDLED; // $82:D826: RTL (no A/Y arming)
    case 8: return PLAIN; // $82:D827: JMP $D588
    case 9: freezeGround(ctx, w); return HANDLED;
    case 10: return ufoGround(ctx, w, pad);
    default: throw new Error(`ability ${w.worn}: ground handler not ported`);
  }
}

// ------------------------------------------------------------------
// Stone (1)
// ------------------------------------------------------------------

/** `$82:C921`: in the air it drops (vx = vy = 0, vz -$800); gravity $FF80. */
function stoneSetup(ctx: Ctx, w: Work): void {
  if (w.air !== 0) {
    w.vx = 0;
    w.vy = 0;
    w.vz = 0xf800;
  }
  w.block6a = wrap16(w.abilityVar + 2);
  w.abilityDir = 0;
  w.gravity = abilityGravity(ctx, 1);
  w.d770 = 0;
  w.d772 = 0;
  w.d776 = 1;
  w.poseState = 0x14;
  w.abilitySfx.push(0x69);
}

/**
 * `$82:CE2B`: on a bounce (a damped one: a short fall comes to rest in the
 * landing and goes to the ground handler). On a friction tile `$20-$24`
 * the first bounce of the activation rebounds (vz $300, sfx $1A); else the
 * ball stops on the ground (sfx $09 and object $1C unless on `$05`) and
 * the ground handler runs.
 */
function stoneAir(ctx: Ctx, w: Work): HandlerResult {
  if (w.bounced === 0) return HANDLED;
  // $82:CE31: $D788,X = 1 (2P: the other ball's hit code reads it)
  if (w.tile >= 0x20 && w.tile < 0x25) {
    w.d776 = wrap16(w.d776 - 1);
    if (s16(w.d776) >= 0) {
      w.vz = 0x0300;
      w.abilitySfx.push(0x1a);
      return HANDLED;
    }
  }
  w.air = 0;
  w.vz = 0;
  w.z = w.ground; // $D9FA:$D9F8 = $DA08:$DA06
  w.poseState = 0x14;
  w.abilityDir = w.code;
  if (w.tile !== 0x05) {
    w.abilitySfx.push(0x09);
    w.abilitySpawn.push(0x1c);
  }
  void ctx;
  stoneGround(w); // JMP $D591
  return HANDLED;
}

/**
 * `$82:D591`: the first ground iteration of the activation stops the ball
 * (vx = vy = 0, $D770 + 1); then the pose follows the surface code — on
 * the faceted shapes `$08-$0B` only once the code has held for 5 iterations
 * ($D772).
 */
function stoneGround(w: Work): void {
  if (w.d770 === 0) {
    w.vx = 0;
    w.vy = 0;
    w.d770 += 1;
  }
  if (w.shape >= 8 && w.shape < 0x0c) {
    if (w.d772 === 0) {
      if (w.code !== w.pCode) w.d772 += 1;
      return;
    }
    if (w.d772 !== 6) {
      w.d772 += 1;
      if (w.code !== w.pCode) w.d772 = 1;
      return;
    }
  }
  w.abilityDir = w.code; // $82:D5CC
  w.poseState = 0x14;
  w.d772 = 0;
}

// ------------------------------------------------------------------
// Needle (4)
// ------------------------------------------------------------------

/**
 * `$82:CAA5`: on the ground the pose takes the surface code. In the air at
 * or below the ground the ball stops there — with the ROM's slip: the
 * ground's high word goes into z's LOW word (`$82:CAD2 STA $D9F8`, meant
 * $D9FA), so the ball, still airborne, lands on the next iteration.
 */
function needleSetup(ctx: Ctx, w: Work): void {
  if (w.air === 0) {
    w.abilityDir = w.code;
  } else {
    w.abilityDir = 0;
    if (atOrBelowGround(w)) {
      w.vx = 0;
      w.vy = 0;
      w.vz = 0;
      // $D9F8 = $DA06, then $D9F8 = $DA08: z's high word stays
      w.z = ((w.z & 0xffff0000) | ((w.ground >>> 16) & 0xffff)) | 0;
    }
  }
  w.block6a = wrap16(w.abilityVar + 4);
  w.gravity = abilityGravity(ctx, 4);
  w.d770 = 0;
  w.poseState = 0x16;
  w.abilitySfx.push(0x4e);
}

/** `$82:D030`: on a bounce: the pose by the code, grounded, sfx $3C, then the ground handler. */
function needleAir(_ctx: Ctx, w: Work): HandlerResult {
  if (w.bounced === 0) return HANDLED;
  w.abilityDir = w.code;
  w.air = 0;
  w.abilitySfx.push(0x3c);
  needleGround(w);
  return HANDLED;
}

/**
 * `$82:D643`: vz 0, and the ball sticks (vx = vy = 0) — except in a boost
 * panel's middle band (`$82:D96A`: tiles `$30-$3B` whose fraction gate
 * `$82:9E96` passes) and, after the first stick, on the toggled-impulse
 * tiles `$70-$7B` (`$82:D986`, $D770).
 */
function needleGround(w: Work): void {
  w.vz = 0;
  if (w.tile >= 0x30 && w.tile < 0x3c && s16(wrap16(boostGateFraction(w) - 0x4000)) >= 0) return;
  if (w.tile >= 0x70 && w.tile < 0x7c) {
    if (w.d770 !== 0) return;
    w.d770 += 1;
  }
  w.vx = 0;
  w.vy = 0;
}

/** `$82:9EAB`: the boost panel's gate tests xf on the N/S panels, yf on the E/W ones. */
export function boostGateFraction(w: Work): number {
  const idx = w.tile - 0x30;
  const testX = idx === 0 || idx === 2 || idx === 4 || idx === 5 || idx === 8 || idx === 9;
  return testX ? w.xf : w.yf;
}

// ------------------------------------------------------------------
// Spark (7)
// ------------------------------------------------------------------

/**
 * `$82:CC0E`: objects $25, $26, $24; with a spin still pending (the
 * trigger keeps Spark's) the roll pose by it ($82:C808); sfx $59. Kirby's
 * state stays the transformation's 3.
 */
function sparkSetup(ctx: Ctx, w: Work): void {
  w.block6a = 0;
  w.gravity = abilityGravity(ctx, 7);
  w.abilitySpawn.push(0x25, 0x26, 0x24);
  if ((w.spinX | w.spinY) !== 0) w.rollPoseFromSpin = 1;
  w.abilitySfx.push(0x59);
}

/** `$82:D1AA`: a bounce shows the roll pose; no A/Y arming in the air or ($82:D826) on the ground. */
function sparkAir(w: Work): HandlerResult {
  if (w.bounced !== 0) w.poseState = 0x0e;
  return HANDLED;
}

/**
 * `$82:EE9A`, Spark's destroy: from the pillar's handler ($82:961B) and the
 * volcano cone's ($82:86D3). In mode 7 the cell's actor record is unlinked
 * and its layer-2 tile cleared; the caller then breaks the actor. Returns
 * whether it did (the ROM's carry).
 */
export function sparkDestroy(w: Work): boolean {
  if (w.mode !== 7) return false;
  w.destroyCell = w.cell;
  return true;
}

// ------------------------------------------------------------------
// Hi-Jump (8)
// ------------------------------------------------------------------

/**
 * `$82:CC43`: a relaunch along the heading at 65 degrees with P = $11A9
 * ($81:BA0E; the grounder flag $6AD8 cleared, $D9B4/$D9B6 kept for the
 * shot); airborne, $D762 = 1 (state 25's script clears it, which ends the
 * mode); six objects $23 ($531C 20, 16, ... 0); sfx $1B.
 */
function hiJumpSetup(ctx: Ctx, w: Work): void {
  w.shotAim = w.deg;
  w.shotElev = 0x41;
  w.relaunch = 1;
  launchVelocity(ctx.rules, w, 0x11a9, 0x41);
  w.abilityDir = w.dir16; // $D75E = $D9DE
  w.abilityVar = headingHalf(w);
  w.block6a = wrap16(w.abilityVar + 6);
  w.gravity = abilityGravity(ctx, 8);
  w.poseState = 0x18;
  w.air = 1;
  w.d762 = 1;
  for (let i = 0; i < 6; i++) w.abilitySpawn.push(0x23);
  w.abilitySfx.push(0x1b);
}

/**
 * `$82:D1B9`: after the mode's end the plain code; a step hit ($DA50) or a
 * pillar's or a volcano cone's ($DA54) clears $D762; with $D762 0 the
 * mode ends (mode 0, $DA6A 0, state 14; the ability stays worn). Rising
 * slower than $200 the pose is 25.
 */
function hiJumpAir(w: Work): HandlerResult {
  if (w.mode === 0) return PLAIN; // $82:D1BE JMP $CDFF
  if ((w.fact4 | w.hitStep) !== 0) w.d762 = 0;
  if (w.d762 === 0) {
    w.mode = 0;
    w.block6a = 0;
    w.poseState = 0x0e;
    return HANDLED;
  }
  if (s16(w.vz) >= 0 && w.vz < 0x200) w.poseState = 0x19;
  return HANDLED;
}

// ------------------------------------------------------------------
// Freeze (9)
// ------------------------------------------------------------------

/** `$82:CCAE`: the pose by the surface (0 in the air); object $1B; $DA6A $0F; state 36; sfx $14. */
function freezeSetup(ctx: Ctx, w: Work): void {
  w.abilityDir = w.air !== 0 ? 0 : w.code;
  w.abilitySpawn.push(0x1b);
  w.block6a = 0x000f;
  w.gravity = abilityGravity(ctx, 9);
  w.poseState = 0x24;
  w.abilitySfx.push(0x14);
}

/** `$82:D1FC`: a bounce lands dead (vz 0, grounded). */
function freezeAir(w: Work): HandlerResult {
  if (w.bounced !== 0) {
    w.vz = 0;
    w.air = 0;
  }
  return HANDLED;
}

/**
 * `$82:D82A`: the pose by the surface, vz 0. Stopped on its own ice
 * ($69DA) the ice gives way (the thaw `$82:D9C2`, sfx $4D unless the water
 * is off), and a ball riding the level ($69D8) sinks: in the water, state
 * 19, mode and ability 0, airborne ($D76C + 1).
 */
function freezeGround(ctx: Ctx, w: Work): void {
  w.abilityDir = w.code;
  w.vz = 0;
  if ((w.vx | w.vy | w.vz) !== 0) return; // 2P also ORs the other ball's ($17FF)
  if (w.waterFreeze === 0) return;
  thaw(ctx, w);
  if (w.waterWalk === 0) return;
  if (ctx.course.waterOff) return;
  w.onOverlay = 1;
  w.gravity = ctx.rules.table('ballGravity')[0];
  w.d76c = wrap16(w.d76c + 1);
  w.poseState = 0x13;
  w.block6a = 0;
  w.mode = 0;
  w.worn = 0;
  w.air = wrap16(w.air + 1);
}

// ------------------------------------------------------------------
// Shared pieces of group B
// ------------------------------------------------------------------

/** `$81:97A9` along the heading $D9DA: (cos, sin) x speed, floor(/2^15). */
function alongHeading(ctx: Ctx, w: Work, speed: number): [number, number] {
  return [mulFloor(cosDeg(ctx.rules, w.deg), speed), mulFloor(sinDeg(ctx.rules, w.deg), speed)];
}

/** max(|vx|, |vy|), the magnitudes unsigned (EOR #$FFFF / INC A). */
function maxAbs(w: Work): number {
  const ax = s16(w.vx) < 0 ? wrap16(-s16(w.vx)) : w.vx;
  const ay = s16(w.vy) < 0 ? wrap16(-s16(w.vy)) : w.vy;
  return ax > ay ? ax : ay;
}

/** `$82:D954` / `$82:D94F`: the tile / the last tile is a kicker `$10-$13`. */
function onKicker(tile: number): boolean {
  return tile >= 0x10 && tile < 0x14;
}

/** `$82:D96A`: on a boost panel's live part (the tile in `$30-$3B`, its fraction gate passing). */
function onBoostLive(w: Work): boolean {
  return w.tile >= 0x30 && w.tile < 0x3c && s16(wrap16(boostGateFraction(w) - 0x4000)) >= 0;
}

/** `$82:D997`: on the rough `$04`, arriving there spawns its dust (object 42); staying, object 42 is told to stop. */
function roughDust(w: Work): void {
  if (w.tile !== 4) return;
  if (w.pTile !== 4) w.abilitySpawn.push(0x2a);
}

// ------------------------------------------------------------------
// Fireball (3)
// ------------------------------------------------------------------

/**
 * `$82:C9D4`: $1F40 along the heading, vz 0, gravity 0; then -$100 along it
 * for 10 iterations after 20 at full speed ($D762, $D776; $D772/$D774);
 * four flames (object $20), palette set 5, state 21, sfx $08; on the rough
 * from the ground its dust.
 */
function fireballSetup(ctx: Ctx, w: Work): void {
  w.vz = 0;
  w.abilityDir = w.dir16;
  [w.vx, w.vy] = alongHeading(ctx, w, 0x1f40);
  const [dx, dy] = alongHeading(ctx, w, 0x0100);
  w.d772 = wrap16(-s16(dx));
  w.d774 = wrap16(-s16(dy));
  w.gravity = abilityGravity(ctx, 3);
  w.block6a = ctx.rules.table('fireballIndex')[w.dir16 & 0x0f];
  for (let i = 0; i < 4; i++) w.abilitySpawn.push(0x20);
  w.d762 = 0x14;
  w.d776 = 0x0a;
  w.paletteSet = 5;
  w.poseState = 0x15;
  w.abilitySfx.push(0x08);
  if (w.air === 0 && w.tile === 4) w.abilitySpawn.push(0x2a);
}

/** `$82:CF91`: after the mode's end the plain code; else the shared body `$82:CF99`. */
function fireballAir(ctx: Ctx, w: Work): HandlerResult {
  if (w.mode === 0) return PLAIN;
  fireballBody(ctx, w);
  return HANDLED;
}

/** `$82:D629`: after the mode's end the plain code; the rough's dust, then the body. */
function fireballGround(ctx: Ctx, w: Work): HandlerResult {
  if (w.mode === 0) return PLAIN;
  roughDust(w);
  fireballBody(ctx, w);
  return HANDLED;
}

/**
 * `$82:CF99`: a step, wall or object hit ends it with a hop (sfx $0E, vz
 * $100, airborne); the full-speed iterations (a landing puts it on the
 * ground); then -$100 along the heading each iteration, and the end:
 * gravity $FFC0, mode 0, the index 0, state 14, objects $1D and $1E (the
 * ability stays worn).
 */
function fireballBody(ctx: Ctx, w: Work): void {
  if ((w.hitStep | w.hitWall | w.fact4) !== 0) {
    w.abilitySfx.push(0x0e);
    w.vz = 0x0100;
    w.air = 1;
    fireballEnd(ctx, w);
    return;
  }
  if (w.d762 !== 0) {
    w.d762 = wrap16(w.d762 - 1);
    w.abilityDir = w.dir16;
    if (w.bounced !== 0) {
      w.air = 0;
      w.z = w.ground;
    }
    return;
  }
  w.vx = wrap16(w.vx + w.d772);
  w.vy = wrap16(w.vy + w.d774);
  w.d776 = wrap16(w.d776 - 1);
  if (w.d776 !== 0) return;
  fireballEnd(ctx, w);
}

/** `$82:CFF9`. */
function fireballEnd(ctx: Ctx, w: Work): void {
  w.gravity = ctx.rules.table('ballGravity')[0];
  w.mode = 0;
  w.block6a = 0;
  w.poseState = 0x0e;
  w.abilitySpawn.push(0x1d, 0x1e);
}

// ------------------------------------------------------------------
// Wheel (6)
// ------------------------------------------------------------------

/** The Wheel's speed: 6000, or 5000 on a kicker. */
function wheelSpeed(tile: number): number {
  return onKicker(tile) ? 0x1388 : 0x1770;
}

/** `$82:D197`: the speed, its velocity along the heading ($D764/$D766), driven. */
function wheelDrive(ctx: Ctx, w: Work, speed: number): void {
  w.d776 = speed;
  [w.d764, w.d766] = alongHeading(ctx, w, speed);
  w.vx = w.d764;
  w.vy = w.d766;
}

/**
 * `$82:CB77`: the speed along the heading; on the ground driven at once
 * (vz 0; the rough's dust), state 26, in the air the velocity is kept,
 * state 27. Gravity $FF90; $D762 = 3; sfx $78.
 */
function wheelSetup(ctx: Ctx, w: Work): void {
  w.d776 = wheelSpeed(w.tile);
  [w.d764, w.d766] = alongHeading(ctx, w, w.d776);
  let state = 0x1b;
  if (w.air === 0) {
    w.vx = w.d764;
    w.vy = w.d766;
    w.vz = 0;
    if (w.tile === 4) w.abilitySpawn.push(0x2a);
    state = 0x1a;
  }
  w.poseState = state;
  w.d77a = 0;
  w.d772 = 0;
  w.d774 = 0;
  w.d762 = 3;
  w.abilityDir = w.dir16;
  w.gravity = abilityGravity(ctx, 6);
  w.d778 = w.waterWalk;
  w.abilitySfx.push(0x78);
}

/**
 * `$82:D05A`: stopped ($D762 < 0): the hop, then at its landing the end. A
 * step, wall or object hit stops it. Leaving the ground: state 27 and -200
 * along the heading for 3 iterations. A bounce drives it again (from the
 * water's level: object $41, 6000).
 */
function wheelAir(ctx: Ctx, w: Work): HandlerResult {
  if (w.mode === 0) return PLAIN;
  if (s16(w.d762) < 0) {
    if (w.d770 === 0) wheelHop(ctx, w);
    else wheelLanded(w);
    w.abilityDir = w.dir16;
    return HANDLED;
  }
  if (w.fact4 !== 0 || (w.hitStep | w.hitWall) !== 0) {
    w.d762 = 0xffff;
    w.d770 = 0;
    w.vy = 0;
    w.vx = 0;
    w.abilityDir = w.dir16;
    return HANDLED;
  }
  if (w.d77a !== 0) {
    w.poseState = 0x1b;
    w.d77a = 0;
    const [dx, dy] = alongHeading(ctx, w, 0xc8);
    w.d772 = wrap16(-s16(dx));
    w.d774 = wrap16(-s16(dy));
  }
  if (w.bounced !== 0) {
    w.d762 = 3;
    let speed: number;
    if (w.waterFreeze === 0 && w.waterWalk !== 0) {
      w.abilitySpawn.push(0x41);
      speed = 0x1770;
    } else {
      speed = wheelSpeed(w.tile);
    }
    wheelDrive(ctx, w, speed);
    w.abilityDir = w.dir16;
    return HANDLED;
  }
  if (w.d762 !== 0) {
    w.vx = wrap16(w.vx + w.d772);
    w.vy = wrap16(w.vy + w.d774);
    w.d762 = wrap16(w.d762 - 1);
  }
  w.abilityDir = w.dir16;
  return HANDLED;
}

/** `$82:D115`: the hop: vz $0A00, airborne, state 28, gravity $FFC0. */
function wheelHop(ctx: Ctx, w: Work): void {
  w.vz = 0x0a00;
  w.air = 1;
  w.poseState = 0x1c;
  w.gravity = ctx.rules.table('ballGravity')[0];
  w.d770 = wrap16(w.d770 + 1);
}

/** `$82:D136`: the hop's landing ends the mode (state 14, the index 0; the ability stays worn). */
function wheelLanded(w: Work): void {
  if (w.bounced === 0) return;
  w.mode = 0;
  w.poseState = 0x0e;
  w.block6a = 0;
}

/**
 * `$82:D7A8`: stopped: as in the air; a step, wall or object hit stops it
 * (airborne: the hop follows); riding onto the water's level (object $42);
 * state 26; onto or off a kicker the speed changes; the first iteration on
 * the ground drives it again; $D77A = $FFFF; the rough's dust.
 */
function wheelGround(ctx: Ctx, w: Work): HandlerResult {
  if (w.mode === 0) return PLAIN;
  if (s16(w.d762) < 0) {
    if (w.d770 === 0) wheelHop(ctx, w);
    else wheelLanded(w);
    w.abilityDir = w.dir16;
    return HANDLED;
  }
  if ((w.hitStep | w.hitWall | w.fact4) !== 0) {
    w.d762 = 0xffff;
    w.d770 = 0;
    w.air = wrap16(w.air + 1);
    w.vx = 0;
    w.vy = 0;
  } else {
    if (w.waterWalk !== 0 && w.waterWalk !== w.d778) w.abilitySpawn.push(0x42);
    w.d778 = w.waterWalk;
    w.poseState = 0x1a;
    // $82:D17D: onto a kicker 5000, off one 6000
    if (onKicker(w.tile)) {
      if (!onKicker(w.pTile)) wheelDrive(ctx, w, 0x1388);
    } else if (onKicker(w.pTile)) {
      wheelDrive(ctx, w, 0x1770);
    }
    if (w.pAir !== 0) {
      w.vx = w.d764;
      w.vy = w.d766;
    }
    w.d77a = 0xffff;
  }
  w.abilityDir = w.dir16;
  roughDust(w);
  return HANDLED;
}

// ------------------------------------------------------------------
// Tornado (5)
// ------------------------------------------------------------------

/**
 * `$82:CB01`: from the ground a hop (vz $0280); 3000 along the heading;
 * gravity $FFE0; objects $21 and $22; state 32; sfx $70.
 */
function tornadoSetup(ctx: Ctx, w: Work): void {
  if (w.air === 0) {
    w.vz = 0x0280;
    w.air = 1;
  }
  [w.vx, w.vy] = alongHeading(ctx, w, 0x0bb8);
  w.gravity = abilityGravity(ctx, 5);
  w.abilityVar = 0;
  w.d762 = 0;
  w.d770 = 0;
  w.block6a = 0x0d;
  w.abilitySpawn.push(0x21, 0x22);
  w.poseState = 0x20;
  w.abilitySfx.push(0x70);
}

/** `$82:D04C`: a landing ends the flight (vz 0, rolling, no bounce); then the ground code. */
function tornadoAir(ctx: Ctx, w: Work, pad: AbilityPad): HandlerResult {
  if (w.bounced !== 0) {
    w.air = 0;
    w.vz = 0;
  }
  return tornadoGround(ctx, w, pad);
}

/**
 * `$82:D65F`: during the burst ($D762) only its countdown, then the saved
 * speeds back; on the ground LEFT / RIGHT held steer (the curve $D9CC =
 * ±$600, `$81:8D21`); a step, wall or object hit: v x 4 for 8 iterations;
 * stopped: the end (mode and worn 0, state 35, or on a boost panel 14);
 * else the pose by the speed (`$82:D790` / `$82:D79C`).
 */
function tornadoGround(ctx: Ctx, w: Work, pad: AbilityPad): HandlerResult {
  if (w.mode === 0) return PLAIN;
  if (w.d762 !== 0) {
    w.d762 = wrap16(w.d762 - 1);
    if (w.d762 !== 0) return HANDLED;
    w.vx = s16(w.vx) < 0 ? wrap16(-s16(w.d772)) : w.d772;
    w.vy = s16(w.vy) < 0 ? wrap16(-s16(w.d774)) : w.d774;
    return HANDLED;
  }
  if (w.air === 0) {
    if ((pad.held & 0x0200) !== 0) {
      if (w.d770 !== 0x0200) {
        w.d770 = 0x0200;
        w.spinX = 0x0600;
      }
      curveCore(w);
    } else if ((pad.held & 0x0100) !== 0) {
      if (w.d770 !== 0x0100) {
        w.d770 = 0x0100;
        w.spinX = 0xfa00;
      }
      curveCore(w);
    } else {
      w.d770 = 0;
    }
  }
  if ((w.hitStep | w.hitWall | w.fact4) !== 0) {
    // $82:D72E: the burst
    const burst = (v: number): [number, number] => {
      const neg = s16(v) < 0;
      const mag = neg ? wrap16(-s16(v)) : v;
      const big = wrap16(mag << 2);
      return [mag, neg ? wrap16(-big) : big];
    };
    [w.d772, w.vx] = burst(w.vx);
    [w.d774, w.vy] = burst(w.vy);
    w.d762 = 8;
    w.d770 = 0;
    return HANDLED;
  }
  if ((w.vx | w.vy) === 0) {
    if (w.holed !== 0) return HANDLED;
    w.mode = 0;
    w.worn = 0;
    if (onBoostLive(w)) {
      w.block6a = 0;
      w.gravity = ctx.rules.table('ballGravity')[0];
      w.poseState = 0x0e;
    } else {
      w.poseState = 0x23;
    }
    return HANDLED;
  }
  const m = maxAbs(w);
  const speeds = ctx.rules.table('tornadoSpeed');
  let k = 0;
  while (k < speeds.length - 1 && !(speeds[k] < m)) k++;
  const pose = ctx.rules.table('tornadoPose')[k];
  w.d776 = pose & 0xff;
  w.poseState = (pose >> 8) + 0x20;
  return HANDLED;
}

// ------------------------------------------------------------------
// Parasol (2)
// ------------------------------------------------------------------

/** `$82:C9B3`: v x 131 / 256 ($80:A378 read at $389F). */
function parasolSlow(w: Work): void {
  w.vx = mid16(w.vx, 0x83);
  w.vy = mid16(w.vy, 0x83);
}

/**
 * `$82:C965`: in the air it opens (v x 131/256, vz -$1C0, gravity 0);
 * the poses by the 16-way heading, the index hidden, state 29; a 9-frame
 * wait, then the parasol (object 51, `abilitySetupTail`).
 */
function parasolSetup(ctx: Ctx, w: Work): number {
  w.d778 = 0;
  if (w.air !== 0) {
    parasolSlow(w);
    w.vz = 0xfe40;
    w.gravity = abilityGravity(ctx, 2);
    w.d770 = 0;
    w.d762 = 1;
    w.d778 = 1;
  }
  w.abilityDir = w.dir16;
  w.abilityVar = w.dir16;
  w.block6a = 0xffff;
  w.poseState = 0x1d;
  w.setupTail = 1;
  return 9;
}

/**
 * `$82:CF3B`: carry set when the ball falls closed: under a step above the
 * ground (or its ground 0, or on `$1C`/`$1D`) it reopens instead (v x
 * 131/256, vz 0, gravity 0); closed, gravity $FFC0.
 */
function parasolFallsClosed(ctx: Ctx, w: Work): boolean {
  const reopen = (): boolean => {
    parasolSlow(w);
    w.vz = 0;
    w.gravity = abilityGravity(ctx, 2);
    w.d770 = 0;
    w.d762 = 1;
    return false;
  };
  if (w.ground === 0 || w.tile === 0x1c || w.tile === 0x1d) return reopen();
  const d = (w.z | 0) - (w.ground | 0);
  if (d >= 0x5a82) return reopen();
  w.d770 = 1;
  w.gravity = ctx.rules.table('ballGravity')[0];
  return true;
}

/**
 * `$82:CE97`: (mode 0: nothing, no A/Y); just off the ground or falling
 * closed, the ledge test; floating: the poses, the landing (rolling,
 * gravity $FFC0, sfx $3B; on the rough object $2C), vz toward -$1C0 by 24,
 * a step hit drops it straight; LEFT / RIGHT held turn it ±2 degrees.
 */
function parasolAir(ctx: Ctx, w: Work, pad: AbilityPad): HandlerResult {
  if (w.mode === 0) return HANDLED;
  if (w.pAir === 0) {
    if (parasolFallsClosed(ctx, w)) return parasolGround(w);
    return HANDLED;
  }
  if (w.d770 !== 0 && parasolFallsClosed(ctx, w)) return parasolGround(w);
  w.abilityDir = w.dir16;
  w.abilityVar = w.dir16;
  if (w.bounced !== 0) {
    w.air = 0;
    w.vz = 0;
    w.d778 = 2;
    w.gravity = ctx.rules.table('ballGravity')[0];
    w.abilitySfx.push(0x3b);
    if (w.tile === 4) w.abilitySpawn.push(0x2c);
    return HANDLED;
  }
  w.d778 = 1;
  if (s16(w.vz) > s16(0xfe40)) w.vz = wrap16(w.vz + 0xffe8);
  else if (w.vz !== 0xfe40) w.vz = 0xfe40;
  if (w.hitStep !== 0) {
    w.vx = 0;
    w.vy = 0;
  }
  if ((pad.held & 0x0300) !== 0) {
    // $82:CF23: RIGHT wins; $82:ED3B, no heading update
    [w.vx, w.vy] = rotateBy(ctx, w.vx, w.vy, (pad.held & 0x0100) !== 0 ? -2 : 2);
  }
  return HANDLED;
}

/** `$82:D5E9`: (mode 0: nothing) the phase by the speed ($D778: 2 slow or on a boost panel, else 0), the poses. */
function parasolGround(w: Work): HandlerResult {
  if (w.mode === 0) return HANDLED;
  w.d778 = onBoostLive(w) || maxAbs(w) < 0x0200 ? 2 : 0;
  w.abilityDir = w.dir16;
  w.abilityVar = w.dir16;
  return HANDLED;
}

// ------------------------------------------------------------------
// UFO (10)
// ------------------------------------------------------------------

/**
 * `$82:CCE5`: gravity 0, vz 0; the pose by the 8-way heading and its
 * sprite index (`$82:CDB3`), state 37, the phase $D77A 0; objects 49 (held,
 * $531C = $FFFF) and 50; the timer 615 and the HUD's 600; slower than $400
 * it flies at $708 along the heading. On the ground the pose takes the
 * surface code and Kirby rises over 3 waits of 8 frames (`$093E`); then
 * object 49 runs (`abilitySetupTail`).
 */
function ufoSetup(ctx: Ctx, w: Work): number {
  w.gravity = abilityGravity(ctx, 10);
  w.vz = 0;
  w.abilityVar = w.dir16 >> 1;
  w.block6a = ctx.rules.table('ufoIndex')[w.abilityVar & 7];
  w.poseState = 0x25;
  w.d77a = 0;
  w.abilityDir = 0;
  w.ufoLive = 0;
  w.abilitySpawn.push(0x31, 0x32);
  w.d762 = 0x0267;
  w.d776 = 0x0258;
  if (maxAbs(w) < 0x0400) [w.vx, w.vy] = alongHeading(ctx, w, 0x0708);
  w.setupTail = 1;
  if (w.air !== 0) return 0;
  w.abilityDir = w.code;
  return 24; // $80:8FB6 x 3, A = 8
}

/**
 * `$82:D208`: (mode 0: the plain code; sunk: the end) the pose's variant;
 * by the phase $D77A: 0 flying (`$82:D23B`), 1 the B exit (`$82:D32C`),
 * else falling (`$82:D359`).
 */
function ufoAir(ctx: Ctx, w: Work, pad: AbilityPad): HandlerResult {
  if (w.mode === 0) return PLAIN;
  if (w.holed === 2) {
    ufoEnd(ctx, w);
    return HANDLED;
  }
  w.abilityVar = w.dir16 >> 1;
  if (w.d77a === 1) return ufoExiting(ctx, w);
  if (w.d77a !== 0) return ufoFalling(ctx, w);
  // $82:D23B: flying, vz 0
  w.vz = 0;
  const zl = w.z & 0xffff;
  const zh = (w.z >>> 16) & 0xffff;
  const gl = w.ground & 0xffff;
  const gh = (w.ground >>> 16) & 0xffff;
  if (w.pAir === 0 && (gh | gl) !== 0) {
    // just off the ground: back on it unless a step above it ($82:D257
    // subtracts the ground's LOW word from z's high word, as the ROM does)
    const lo = wrap16(zl - gl);
    const hi = wrap16(zh - gl - (zl < gl ? 1 : 0));
    if (s16(hi) < 0 || (hi === 0 && lo < 0x5a82)) {
      w.air = 0;
      return ufoGround(ctx, w, pad);
    }
  }
  // $82:D265: the elevation changed under the ball
  if (w.elev !== w.pElev) {
    if (w.shape >= 4 && w.shape < 0x0c) {
      if (ufoNearRamp(w) === 0) return ufoLand(w);
    } else if (w.z === w.ground) {
      return ufoLand(w);
    }
  }
  // $82:D295
  if (w.pAir === 0) {
    const lo = wrap16(zl - gl);
    const hi = wrap16(zh - gh - (zl < gl ? 1 : 0));
    if (hi === 0 && lo < 0x2d41) {
      if (w.stepHeight === 0) return ufoLand(w);
    } else if (w.shape === 0 && w.pShape >= 2 && w.pShape < 0x10) {
      ufoClimb(ctx, w);
    }
  }
  // $82:D2CE
  const r = ufoHits(w);
  if (r !== 0) {
    if (r !== 2) w.abilityDir = 9;
    w.d77a = 2;
    w.d762 = 0x0c;
    ufoStop(w, 0x27, 0xfc00);
    return HANDLED;
  }
  if (w.bounced !== 0) return ufoLand(w);
  w.abilityDir = 0;
  if (!ufoPad(ctx, w, pad)) return HANDLED;
  w.d77a = 1;
  w.d762 = 0x3c;
  ufoStop(w, 0x26, 0xfd00);
  return HANDLED;
}

/** `$82:D328`: landed. */
function ufoLand(w: Work): HandlerResult {
  w.air = 0;
  return HANDLED;
}

/** `$82:D317`: the state, vz, and no horizontal speed. */
function ufoStop(w: Work, state: number, vz: number): void {
  w.poseState = state;
  w.vz = vz;
  w.vx = 0;
  w.vy = 0;
}

/**
 * `$82:D32C`, after B: over a gap the countdown $D762 (or the ball lost)
 * makes it fall ($D77A 2, vz -$400, state 39, the pose 9); else as falling.
 */
function ufoExiting(ctx: Ctx, w: Work): HandlerResult {
  if (w.shape === 0) {
    let go = (w.lost & 1) !== 0;
    if (!go) {
      w.d762 = wrap16(w.d762 - 1);
      go = w.d762 === 0;
    }
    if (go) {
      w.d77a = wrap16(w.d77a + 1);
      w.vz = 0xfc00;
      w.poseState = 0x27;
      w.abilityDir = 9;
      return HANDLED;
    }
  }
  return ufoFalling(ctx, w);
}

/**
 * `$82:D359`: falling: off the ground last frame vz -$300; an object hit
 * (not the pillar: code 19 then) ends it with vz $600; a landing grounds it.
 */
function ufoFalling(ctx: Ctx, w: Work): HandlerResult {
  if (w.pAir === 0) w.vz = 0xfd00;
  // $D76A: the other ball's contact (2P)
  if (w.fact4 !== 0) {
    if (ufoObjectHit(w) !== 0) {
      w.vz = 0x0600;
      ufoCut(ctx, w);
    }
    return HANDLED;
  }
  if (w.bounced !== 0) w.air = 0;
  return HANDLED;
}

/**
 * `$82:D4A6`: 1 on a step hit, the timer's end ($D762, with the HUD's
 * $D776, counted here) or the pillar; 2 on a wall; else 0 (another
 * object: code 19, `$82:D4FC`).
 */
function ufoHits(w: Work): number {
  if (w.hitStep !== 0) return 1;
  if (w.fact4 !== 0) return ufoObjectHit(w);
  w.d776 = wrap16(w.d776 - 1);
  w.d762 = wrap16(w.d762 - 1);
  if (w.d762 === 0) return 1;
  if (w.hitWall !== 0) return 2;
  return 0; // $D76A: 2P
}

/** `$82:D4FC`: the pillar (tile $02) ends the flight; any other object asks for code 19. */
function ufoObjectHit(w: Work): number {
  if (w.tile === 0x02) return 1;
  w.hurt = 0x13;
  return 0;
}

/** `$82:D4D9`: the mode ends at once (the index 0, gravity $FFC0, state 14, $D76C + 1). */
function ufoCut(ctx: Ctx, w: Work): void {
  w.mode = 0;
  w.block6a = 0;
  w.gravity = abilityGravity(ctx, 0);
  w.poseState = 0x0e;
  w.d76c = wrap16(w.d76c + 1);
}

/**
 * `$82:D515`: B pressed leaves the UFO (with no stock, or the UFO's own
 * stock already used this shot; another stock is the trigger's); else LEFT
 * / RIGHT pressed turn it 90 degrees (RIGHT wins; sfx $72). The roulette
 * tile `$57` case is 2P's.
 */
function ufoPad(ctx: Ctx, w: Work, pad: AbilityPad): boolean {
  if (pad.pressed === 0) return false;
  if ((pad.pressed & 0x8000) !== 0) {
    if (w.stock === 0) return true;
    if (w.stock !== 0x0a) return false;
    return w.latch !== 0;
  }
  if ((pad.pressed & 0x0300) === 0) return false;
  [w.vx, w.vy] = rotateBy(ctx, w.vx, w.vy, (pad.pressed & 0x0100) !== 0 ? -90 : 90);
  w.abilitySfx.push(0x72);
  return false;
}

/**
 * `$82:D388`: the step climb over a gap: by the old shape and quadrant
 * (`$82:D3CD`), z + $200, or z on the base of the elevation above.
 */
function ufoClimb(ctx: Ctx, w: Work): void {
  const b = ctx.rules.table('ufoClimb')[(w.pShape - 2) * 4 + w.pQuad] & 0xff;
  if (b === 0) return;
  if (b === 0xff) {
    w.z = (w.z + 0x0200) | 0;
    return;
  }
  w.z = ctx.rules.heightZ(w.pElev + 1);
}

/**
 * `$82:D405`: on a ramp ($04-$0B), 0 when in its low quadrants (4: S,
 * 5: W, 6: N, 7: E, 8: S W, 9: N W, 10: N E, 11: E S) and under $16A0 above
 * the ground; else 1.
 */
function ufoNearRamp(w: Work): number {
  const low: number[][] = [[2], [3], [0], [1], [2, 3], [0, 3], [0, 1], [1, 2]];
  if (!low[w.shape - 4].includes(w.quad)) return 1;
  const zl = w.z & 0xffff;
  const gl = w.ground & 0xffff;
  const hi = wrap16(((w.z >>> 16) & 0xffff) - ((w.ground >>> 16) & 0xffff) - (zl < gl ? 1 : 0));
  return hi === 0 && wrap16(zl - gl) < 0x16a0 ? 0 : 1;
}

/**
 * `$82:D893`: (mode 0: the plain code) the poses; by the phase: after B
 * the end; falling, the countdown (12 or 15) to the end; flying, the hits
 * (state 39, $D762 15), the pad, and a step down lifts it into the air.
 */
function ufoGround(ctx: Ctx, w: Work, pad: AbilityPad): HandlerResult {
  if (w.mode === 0) return PLAIN;
  w.abilityVar = w.dir16 >> 1;
  w.abilityDir = w.code;
  if (w.d77a === 1) {
    ufoEnd(ctx, w);
    return HANDLED;
  }
  if (w.d77a !== 0) {
    w.d776 = wrap16(w.d776 - 1);
    w.d762 = wrap16(w.d762 - 1);
    if (w.d762 === 0) ufoEnd(ctx, w);
    return HANDLED;
  }
  if (ufoHits(w) !== 0) {
    w.d77a = 2;
    w.d762 = 0x0f;
    w.poseState = 0x27;
    w.vx = 0;
    w.vy = 0;
    return HANDLED;
  }
  if (ufoPad(ctx, w, pad)) {
    w.d77a = 1;
    w.poseState = 0x26;
    w.vx = 0;
    w.vy = 0;
    return HANDLED;
  }
  if (s16(w.stepHeight) < 0) w.air = 1;
  return HANDLED;
}

/** `$82:D8FC`: gravity $FFC0, $D76C + 1, state 14, the index 0, mode 0, every effect stopped (sfx 0). */
function ufoEnd(ctx: Ctx, w: Work): void {
  w.gravity = ctx.rules.table('ballGravity')[0];
  w.d76c = wrap16(w.d76c + 1);
  w.poseState = 0x0e;
  w.block6a = 0;
  w.mode = 0;
  w.abilitySfx.push(0);
}
