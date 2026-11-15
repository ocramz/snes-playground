/**
 * The special-tile dispatch ($81:811B land, $81:8436 hit-from-the-side) and
 * the handlers (docs/tiles.md). Each handler mirrors its ROM routine; the
 * return value routes the step: `landing` / `rolling` continue into the
 * default chain (optionally from its midpoint), `done` ends the dispatch.
 *
 * Five groups are stubbed with the reason in `stubbed`: their ROM helpers
 * reach the thread-object system or undocumented tables. They are excluded
 * from the exact trace tests per plans risk 5 and listed in docs/engine.md.
 * Every other group is a port of the disassembly.
 */
import { s16, wrap16, mulFloor, mulQ15s, atan2Deg } from '../fixed';
import type { Ctx, Work } from './context';
import type { RollModifier } from './roll';
import { restorePrev } from './wall-step';
import { updateHeading } from './reflect';
import { outlineWall } from './outline';
import { cupLand, cupHit } from './cup';
import { enemyDispatch } from './enemy';
import { bumperLand, bumperHitSide, bobLand, bobHitSide, volcanoLand, volcanoHitSide, hazard05 } from './hazards';
import { rotateBy, turnToDir } from './turn';
import { warpLand, warpHit } from './warp';
import { LANDING, ROLLING, DONE, type DispatchOutcome } from './types';
export type { DispatchOutcome };

export { dispatchLanding, finishLanding, stepHitStop, type LandingOutcome } from './landing';
export { classIndex, rollDefault } from './roll';
export { stepBounce, wallBounce, launch } from './wall-step';

/**
 * The shot guide's own tile table, $81:B455 (tables.json `guideTiles`,
 * read 2026-11-14): it knows only the play-area outline ($28-$2D, class 1)
 * and the surface overlay ($60-$6F, class 2); every other tile — pillars,
 * enemies, the cup, friction, boosts, kickers — is plain ground to it.
 */
export function guideSeesTile(ctx: Ctx, tile: number): boolean {
  return ctx.rules.table('guideTiles')[tile & 0xff] !== 0;
}

/** $81:811B: the landing dispatch, on the tile the ball landed on. */
export function landDispatch(ctx: Ctx, w: Work, _modifier: RollModifier): DispatchOutcome {
  if (ctx.presentation === false && !guideSeesTile(ctx, w.tile)) return LANDING; // the guide
  switch (ctx.rules.landHandler(w.tile)) {
    case 'land':
      return LANDING;
    case 'landClear':
      // $81:88F9: STZ $6A68 (the enemy/pillar latch), $6A42 (the warp's),
      // $69D8; then the default landing handler
      w.enemyLatch = 0;
      w.warpLatch = 0;
      return LANDING;
    case 'pillar':
      return pillarShared(ctx, w, LANDING);
    case 'rough':
      return roughLand(ctx, w);
    case 'hazard05':
      return hazard05(w, 'land'); // $82:A55E (not the $1C family's $82:936A)
    case 'rough05':
      return rough05Entry(ctx, w, 'land', false);
    case 'hazard80':
      return bumperLand(ctx, w);
    case 'hazard90':
      return bobLand(ctx, w, false);
    case 'hazardA2':
      return bobLand(ctx, w, true);
    case 'hazardAC':
      return volcanoLand(ctx, w);
    case 'rough05b':
      return rough05Entry(ctx, w, 'land', true);
    case 'cup':
      return cupLand(ctx, w);
    case 'kicker':
      return kickerLand(ctx, w);
    case 'arrowNS':
    case 'arrowEW':
      return arrowLand(ctx, w);
    case 'snap':
      return snapLand(ctx, w);
    case 'friction':
      frictionTile(ctx, w);
      return LANDING; // $82:8F99 -> JML $81:8905
    case 'outlineWall':
      return outlineWallLand(ctx, w);
    case 'boostN':
      return boostLand(ctx, w, 'vy-');
    case 'boostE':
      return boostLand(ctx, w, 'vx+');
    case 'boostS':
      return boostLand(ctx, w, 'vy+');
    case 'boostW':
      return boostLand(ctx, w, 'vx-');
    case 'enemy':
      return enemyDispatch(ctx, w);
    case 'warp':
      return warpLand(ctx, w);
    default:
      return stubbed(ctx.rules.landHandler(w.tile), LANDING);
  }
}

/** $81:8436: the hit-from-the-side dispatch (the rolling path). */
export function hitDispatch(ctx: Ctx, w: Work, _modifier: RollModifier): DispatchOutcome {
  if (ctx.presentation === false && !guideSeesTile(ctx, w.tile)) return ROLLING; // the guide
  switch (ctx.rules.hitHandler(w.tile)) {
    case 'roll':
      return ROLLING;
    case 'rollClear':
      // $81:8A47: STZ $6A68, $6A36, $6A42 (the warp's latch), $69D8; then
      // the default roll
      w.enemyLatch = 0;
      w.warpLatch = 0;
      return ROLLING;
    case 'pillarHit':
      return pillarShared(ctx, w, ROLLING);
    case 'roughHit':
      frictionAltHit(ctx, w);
      return ROLLING;
    case 'hazard05Hit':
      return hazard05(w, 'hit'); // $82:A576: the default landing after, from this side too
    case 'rough05Hit':
      return rough05Entry(ctx, w, 'hit', false);
    case 'hazard80Hit':
      return bumperHitSide(ctx, w);
    case 'hazard90Hit':
      return bobHitSide(ctx, w, false);
    case 'hazardA2Hit':
      return bobHitSide(ctx, w, true);
    case 'hazardACHit':
      return volcanoHitSide(ctx, w);
    case 'rough05bHit':
      return rough05Entry(ctx, w, 'hit', true);
    case 'cupHit':
      return cupHit(ctx, w);
    case 'kickerHit':
      return kickerHit(ctx, w);
    case 'arrowNSHit':
    case 'arrowEWHit':
      return arrowHit(ctx, w);
    case 'snapHit':
      return snapHit(ctx, w);
    case 'frictionHit':
      frictionTile(ctx, w);
      return ROLLING; // $82:8FA0 -> JML $81:8A56
    case 'outlineWallHit':
      return outlineWallHit(ctx, w);
    case 'boostNHit':
      return boostHit(ctx, w, 'vy');
    case 'boostEHit':
      return boostHit(ctx, w, 'vx');
    case 'boostSHit':
      return boostHit(ctx, w, 'vx');
    case 'boostWHit':
      return boostHit(ctx, w, 'vy');
    case 'enemy':
      return enemyDispatch(ctx, w);
    case 'enemyRollAlt':
      // $82:8963: JML $81:8A56 - tiles $4D-$52 (the hovering enemies) are
      // never tested from the rolling path
      return ROLLING;
    case 'warpHit':
      return warpHit(ctx, w);
    default:
      return stubbed(ctx.rules.hitHandler(w.tile), ROLLING);
  }
}

/**
 * The stubbed groups, with the reason each is out of phase 4's reach:
 * - toggle70-7B (+hits): the gate reads the direction map at $88:9190
 *   ($82:A086) and applies via $82:A0D9/$82:A0F9 — not read.
 * - overlay ($60-$6F, +hits): enter/leave tracking ($82:80F6) — not read;
 *   the $D9EE flag itself IS ported (the $82:C85F probe wrapper).
 * (The hazards, $05, $80-$A2 and $AC-$AE, are ported in phase 6: hazards.ts.)
 * - unk58/unk5a/unk5c (+hits): handlers located, not read
 *   (docs/tiles.md "Not established"). (The warps $B0-$B9 are ported:
 *   warp.ts.)
 * Each returns its group's default routing so an unported tile behaves
 * like plain ground.
 */
const stubbedSeen = new Set<string>();
function stubbed(name: string, fallback: DispatchOutcome): DispatchOutcome {
  if (!stubbedSeen.has(name)) stubbedSeen.add(name);
  return fallback;
}

// --- friction tiles ($20-$24: land $82:8F77, hit $82:8F9D) ---

function frictionTile(ctx: Ctx, w: Work): void {
  // $82:8FA4
  if (w.mode === 0x0a) return;
  w.rollMu = ctx.rules.const_('frictionTileMu'); // $0800
  if (w.tile === 0x24) {
    w.dampXY = ctx.rules.const_('frictionTileDampXY');
    w.dampZ = ctx.rules.const_('frictionTileDampZ');
  } else {
    w.dampXY = ctx.rules.const_('roughDampXY2');
    w.dampZ = w.mode === 6 ? ctx.rules.const_('roughDampZ6') : ctx.rules.const_('roughDampZ');
  }
  // $82:8F87: sfx $1A when the ball is at/under the surface and vz >= -$100
  if (grounded(w) && w.vz < 0xff00) w.tailSfx = 0x001a;
}

// --- the rough tile $04 ($82:8EFB land / $82:8F30 hit) ---

function roughLand(ctx: Ctx, w: Work): DispatchOutcome {
  if (!grounded(w)) return LANDING; // BCC $8F2C: straight to the default
  if (w.mode !== 0x0a) {
    setRoughCoeffs(ctx, w, ctx.rules.table('frictionAltMode')[w.mode]);
    // $6A6C = (vz below -$0400 ? 1 : 0) + $5F
    const a = w.vz !== 0 && w.vz < 0xfc00 ? 1 : 0;
    w.tailSfx = wrap16(a + 0x005f);
  }
  return LANDING;
}

function frictionAltHit(ctx: Ctx, w: Work): void {
  // $82:8F30: the hit-side $04 handler
  if (w.mode === 0x0a) return;
  const idx = ctx.rules.table('frictionAltIndex')[w.mode];
  setRoughCoeffs(ctx, w, idx);
  if (w.pTile !== 0x04) w.tailSfx = 0x0060; // $82:8F44
}

function setRoughCoeffs(ctx: Ctx, w: Work, idx: number): void {
  w.rollMu = ctx.rules.table('roughFriction')[idx];
  w.dampXY = ctx.rules.table('roughDampXY')[idx];
  w.dampZ = ctx.rules.table('roughDampZ')[idx];
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
}

/** $82:9E84: z at or below the surface (the ROM's carry set). */
function grounded(w: Work): boolean {
  return w.ground >= w.z;
}

// --- the rough/hazard-05 family ($05, $1C, $1D) ---

function rough05Entry(ctx: Ctx, w: Work, side: 'land' | 'hit', swapped: boolean): DispatchOutcome {
  const table = side === 'land' ? 'hazard05Mode' : 'hazard05ModeHit';
  if (w.mode === 0x0a) return side === 'land' ? LANDING : ROLLING;
  if (side === 'land' && !grounded(w)) return LANDING;
  rough05Consequence(ctx, w, ctx.rules.table(table)[w.mode], swapped);
  return side === 'land' ? LANDING : ROLLING;
}

/**
 * $82:936A/$82:93B6 + $82:93DA: the rough tiles' recovery launch — the
 * ball is thrown up out of the sunken cell by an amount depending on its
 * depth below ground + 3 steps and its speed; a slow ball is also given a
 * minimum horizontal speed along its heading ($81:94B0, $01C0 = 448).
 * Unexercised by the course-1 traces (no $05/$1C/$1D on hole 1).
 */
function rough05Consequence(ctx: Ctx, w: Work, modeValue: number, swapped: boolean): void {
  if (modeValue === 0) return;
  // $82:936A: the position window ($1D swaps the axes)
  const xf = swapped ? w.yf : w.xf;
  const yf = swapped ? w.xf : w.yf;
  if (!(xf >= 0x5800 && xf < 0xa000 && yf >= 0x0800 && yf < 0xffff)) return;
  // $82:93DA: depth = ground + heightZ(3) - z, as a 32-bit value
  const depth = w.ground + ctx.rules.heightZ(3) - w.z;
  if (depth < 0) return;
  const scaled = depth * 16; // ASL x4
  const speed = Math.abs(s16(w.vx)) + Math.abs(s16(w.vy));
  const idx = Math.min(7, (speed >> 8) & 0xff);
  const scale = ctx.rules.const_('hazard05Div');
  // $80:A453 = the unsigned 16x16 -> 32 product; the code takes bits 8-23
  // of (scale x idx), adds the scaled depth, then multiplies by modeValue
  // and adds the low 16 bits to vz.
  const t = wrap16(Math.floor((scale * idx) / 0x10000) + scaled);
  w.vz = wrap16(w.vz + wrap16(Math.floor(s16(modeValue) * t)));
  w.air = 1;
  w.tailSfx = 0x006f; // $82:A5A3
  if (t >= 0x60) {
    w.vz = wrap16(w.vz + s16(w.gravity));
    if (w.vz < 0) return;
  }
  if (Math.abs(s16(w.vx)) + Math.abs(s16(w.vy)) < 0x0140) {
    w.vx = mulFloor(sinOf(ctx, w.deg), 0x01c0);
    w.vy = mulFloor(cosOf(ctx, w.deg), 0x01c0);
  }
}

function sinOf(ctx: Ctx, deg: number): number {
  return ctx.rules.table('sinDeg')[deg];
}
function cosOf(ctx: Ctx, deg: number): number {
  return ctx.rules.table('sinDeg')[(deg + 90) % 450];
}

// --- boost panels ($30-$3B) ---

/** $82:9EAB: which fraction the panel's gate tests, by tile - $30. */
function boostGateAxis(w: Work): number {
  const idx = w.tile - 0x30;
  const testX = idx === 0 || idx === 2 || idx === 4 || idx === 5 || idx === 8 || idx === 9;
  return testX ? w.xf : w.yf;
}

function boostLand(ctx: Ctx, w: Work, dir: 'vx+' | 'vx-' | 'vy+' | 'vy-'): DispatchOutcome {
  // $82:9DB3+: gates then the fixed delta, then the default landing.
  if (!grounded(w)) return LANDING; // $82:9E76 BCC
  if (modeImmune(w)) return LANDING; // $82:9E85
  if (s16(wrap16(boostGateAxis(w) - 0x4000)) < 0) return LANDING; // $82:9E9A BMI
  const delta = dir === 'vx+' || dir === 'vy+' ? ctx.rules.const_('boostE') : ctx.rules.const_('boostW');
  if (dir === 'vx+' || dir === 'vx-') w.vx = wrap16(w.vx + delta);
  else w.vy = wrap16(w.vy + delta);
  resetCoeffs(ctx, w);
  return LANDING;
}

function boostHit(ctx: Ctx, w: Work, axis: 'vx' | 'vy'): DispatchOutcome {
  // $82:9CBF+ (the four variants differ only in the axes)
  if (modeImmune(w)) return ROLLING;
  if (s16(wrap16(boostGateAxis(w) - 0x4000)) < 0) return ROLLING;
  const other: 'vx' | 'vy' = axis === 'vx' ? 'vy' : 'vx';
  const otherV = w[other];
  const mag = otherV >= 0 ? otherV : wrap16(-s16(otherV));
  if (mag < ctx.rules.const_('boostStraight')) {
    // a straight hit: the other axis stops, this axis launches to
    // ±(boostBig - 1) in the ball's own sign ($82:9E43/$82:9E48)
    w[other] = 0;
    const big = ctx.rules.const_('boostBig');
    const bigNeg = ctx.rules.const_('boostBigNeg');
    w[axis] = w[axis] >= 0 ? big - 1 : bigNeg + 1;
    w.boostFlash = w[axis]; // $6A28 (presentation; phase 5)
  } else {
    const delta =
      w[axis] < 0 ? ctx.rules.const_('boostSmallNeg') : ctx.rules.const_('boostSmall');
    w[other] = wrap16(w[other] + delta);
    resetCoeffs(ctx, w);
  }
  return ROLLING;
}

function modeImmune(w: Work): boolean {
  return w.mode === 5 || w.mode === 6 || w.mode === 0x0a;
}

function resetCoeffs(ctx: Ctx, w: Work): void {
  w.rollMu = ctx.rules.const_('boostResetMu');
  w.dampXY = ctx.rules.const_('boostResetDampXY');
  w.dampZ = ctx.rules.const_('boostResetDampZ');
}

// --- kicker ($10-$13) ---

function kickerLand(ctx: Ctx, w: Work): DispatchOutcome {
  // $82:A7DD: only when the ball is at or below the surface
  if (!grounded(w)) return LANDING;
  if (ctx.rules.table('kickerMode')[w.mode] === 0) return LANDING;
  return kickerApply(ctx, w, LANDING);
}

function kickerHit(ctx: Ctx, w: Work): DispatchOutcome {
  if (ctx.rules.table('kickerModeHit')[w.mode] === 0) return ROLLING;
  return kickerApply(ctx, w, ROLLING);
}

function kickerApply(ctx: Ctx, w: Work, out: DispatchOutcome): DispatchOutcome {
  // $82:A7FE+: the kick = mul16x8(vz, min), clamped to max — and when
  // clamped the value becomes min again, with the compare's carry still
  // set (it adds one more in the ADC paths, and none in the SBC paths).
  const x = w.mode === 6 ? 2 : 0;
  if (w.mode === 6) w.rollMu = 0x0100;
  const min = ctx.rules.table('kickerMin')[x];
  const max = ctx.rules.table('kickerMax')[x];
  let kick = wrap16(Math.floor((s16(w.vz) * min) / 256));
  let clamped = false;
  if (kick >= max) {
    kick = min;
    clamped = true;
  }
  const carry = clamped ? 1 : 0;
  switch (w.tile - 0x10) {
    case 0: w.vy = wrap16(w.vy + kick + carry); break; // ADC
    case 1: w.vx = wrap16(w.vx + kick + carry); break;
    case 2: w.vx = wrap16(w.vx - kick - (clamped ? 0 : 1)); break; // SBC
    case 3: w.vy = wrap16(w.vy - kick - (clamped ? 0 : 1)); break;
  }
  updateHeading(ctx.rules, w);
  if (w.mode !== 6) w.dampXY = ctx.rules.const_('kickerDamp');
  return { next: out.next, entry: 'grounded' }; // JML $81:892B
}

// --- arrow panels ($14-$17: land $82:A6C7/$82:A70B, hit $82:A74F/$82:A783) ---

/**
 * The handlers' position window: the long axis in [$2800, $DFFF), the narrow
 * one in [$4800, $B7FF) on landing, [$6000, $9FFF) from the side. The N/S
 * arrows ($14, $16) are narrow in x, the E/W ones ($15, $17) in y.
 */
function arrowWindow(w: Work, narrowLo: number, narrowHi: number): boolean {
  const ns = ((w.tile - 0x14) & 1) === 0;
  const narrow = ns ? w.xf : w.yf;
  const long = ns ? w.yf : w.xf;
  return narrow >= narrowLo && narrow < narrowHi && long >= 0x2800 && long < 0xdfff;
}

function arrowLand(ctx: Ctx, w: Work): DispatchOutcome {
  // $82:A6C7/$82:A70B: at or under the surface, inside the window; outside
  // the gate the latch clears ($82:A701). Then JML $81:8905.
  if (!grounded(w) || !arrowWindow(w, 0x4800, 0xb7ff)) {
    w.enemyLatch = 0;
    return LANDING;
  }
  if (ctx.rules.table('arrowMode')[w.mode] !== 0) arrowTurn(ctx, w); // $80:DE4D
  return LANDING;
}

function arrowHit(ctx: Ctx, w: Work): DispatchOutcome {
  // $82:A74F/$82:A783: no height test, a narrower window; JML $81:8A56
  if (!arrowWindow(w, 0x6000, 0x9fff)) {
    w.enemyLatch = 0;
    return ROLLING;
  }
  if (ctx.rules.table('arrowModeHit')[w.mode] !== 0) arrowTurn(ctx, w); // $80:DE79
  return ROLLING;
}

/**
 * $82:A7B7: once per pass (the latch $6A68, shared with the enemies and the
 * pillar), $82:ECFC turns the velocity to the arrow's heading — a rotation by
 * (heading - $D9DA) through $82:ED3B/$82:ED4C, so the speed is kept — and
 * zeroes the cross axis (vx for N/S, vy for E/W), then $81:8E60. The spin is
 * cleared and the step's tail plays $0C ($6A6C).
 */
function arrowTurn(ctx: Ctx, w: Work): void {
  if (w.enemyLatch !== 0) return;
  w.enemyLatch += 1;
  turnToDir(ctx, w, (w.tile - 0x14) & 3); // $82:ECFC
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
  w.tailSfx = 0x000c;
}

// --- snap ($18-$1B) ---

function snapLand(ctx: Ctx, w: Work): DispatchOutcome {
  // $82:A5B1
  if (w.mode === 0x0a) return LANDING;
  if (!grounded(w)) return LANDING;
  if (snapGate(ctx, w) < 0) return LANDING;
  w.air = 0;
  w.z = w.ground;
  w.vz = 0;
  return snapApply(ctx, w, LANDING);
}

function snapHit(ctx: Ctx, w: Work): DispatchOutcome {
  if (w.mode === 0x0a) return ROLLING;
  if (snapGate(ctx, w) !== 0) return ROLLING;
  return snapApply(ctx, w, ROLLING);
}

/** $82:A692: the snap's extra gate. Unread; returns "pass" (flagged). */
function snapGate(_ctx: Ctx, _w: Work): number {
  return 0;
}

function snapApply(_ctx: Ctx, w: Work, out: DispatchOutcome): DispatchOutcome {
  // $82:A5F7+: the four per-tile impulses (clamped directional deltas;
  // the jump table at $82:A629, byte-exact values pending a trace)
  const imp = (v: number, delta: number, floor: number): number => {
    const r = wrap16(v + delta);
    return s16(r) < s16(floor) ? floor : r;
  };
  switch (w.tile - 0x18) {
    case 0: w.vy = imp(w.vy, -0x0300, 0xe000); break;
    case 1: w.vx = imp(w.vx, 0x0300, 0xe000); break;
    case 2: w.vy = imp(w.vy, 0x0300, 0xe000); break;
    case 3: w.vx = imp(w.vx, -0x0300, 0xe000); break;
  }
  w.tailSfx = 0x0011; // $82:A608 (the latch and sfx $3D are phase 5/6)
  return out;
}

// --- outline wall ($28-$2D) ---

function outlineWallLand(ctx: Ctx, w: Work): DispatchOutcome {
  // $82:8FF1: the wall acts within half a step of the ground; a hit ends
  // the landing with the gravity tail ($82:9015 JML $81:899F)
  const d = w.z - w.ground;
  if (d < 0 || d < 0x2d41) outlineWall(ctx, w);
  if (w.hitWall !== 0) return { next: 'landing', entry: 'gravityOnly' };
  return LANDING;
}

function outlineWallHit(ctx: Ctx, w: Work): DispatchOutcome {
  outlineWall(ctx, w); // $82:8FE3: unconditional on the rolling path
  if (w.hitWall !== 0) return DONE;
  return ROLLING;
}

// --- pillar ($02) ---

/**
 * $82:94D3 (land) / $82:957C (hit), read 2026-11-14: the tree trunk stands
 * three height steps above the ground; its footprint is the middle of the
 * cell ($82:95FD: both fractions in $4000-$BFFE). The latch $6A68 (shared
 * with the enemies) makes one pass count once.
 *
 *   land: above the top, or outside the footprint, or the mode-7 branch
 *         ($82:961B) -> clear the latch; latch set -> nothing; else clear
 *         the spin, then: the top below the previous z ($DA18) -> the
 *         reflection about the quadrant's normal, damped (vx, vy x $4A3C,
 *         vz x $4F5B, $81:9793); otherwise the push-out $82:95A6. Both
 *         INC the latch and $DA54 and play sfx $71 at once.
 *   hit:  outside the footprint, or mode 7 -> clear the latch; latch set
 *         -> nothing; else the push-out, then clear the spin.
 */
function pillarFootprint(w: Work): boolean {
  return w.xf >= 0x4000 && w.xf < 0xbfff && w.yf >= 0x4000 && w.yf < 0xbfff;
}

function pillarShared(ctx: Ctx, w: Work, out: DispatchOutcome): DispatchOutcome {
  const landing = out.next === 'landing';
  const top = (w.ground + ctx.rules.heightZ(3)) | 0;
  if (landing && top < w.z) {
    w.enemyLatch = 0; // $82:9572
    return out;
  }
  if (!pillarFootprint(w)) {
    w.enemyLatch = 0;
    return out;
  }
  if (w.enemyLatch !== 0) return out; // $82:9504 / $82:9587
  // $82:961B -> $82:EE9A: the mode-7 branch (it clears the tile from layer
  // 2) returns "no" outside mode 7; modes are always 0 here
  if (!landing) {
    pillarPush(ctx, w);
    w.spinX = 0;
    w.spinY = 0;
    w.spinPending = 0;
    return out;
  }
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
  if (top >= w.pZ) {
    pillarPush(ctx, w); // $82:9522
    return out;
  }
  // $82:9527: reflect about the quadrant's normal, then damp
  reflectRef(ctx, w, w.quad + 1);
  w.vx = mulQ15s(w.vx, 0x4a3c);
  w.vy = mulQ15s(w.vy, 0x4a3c);
  w.vz = mulQ15s(w.vz, 0x4f5b);
  pillarHitFacts(w); // $82:962F / $82:EED8 are presentation
  return out;
}

/** $82:95A6: rotate away from the trunk, scale by $80:DD6D, restore the previous position. */
function pillarPush(ctx: Ctx, w: Work): void {
  const angle = atan2Deg(wrap16(w.xf ^ 0x8000), wrap16(w.yf ^ 0x8000),
    ctx.rules.table('atanDeg')) - s16(w.deg);
  const [rx, ry] = rotateBy(ctx, w.vx, w.vy, angle);
  w.vx = mulQ15s(rx, 0x55c1); // $80:DD6D
  w.vy = mulQ15s(ry, 0x55c1);
  updateHeading(ctx.rules, w); // $81:8E60
  restorePrev(w); // $81:87B2
  pillarHitFacts(w);
}

function pillarHitFacts(w: Work): void {
  w.fact4 += 1; // $DA54
  w.enemyLatch += 1; // $6A68
  w.sfxNow = 0x0071;
}

function reflectRef(ctx: Ctx, w: Work, index: number): void {
  // $81:9444 + $81:8DAF (reflect.ts), imported via the system's wiring to
  // keep this module's dependency list flat.
  reflectImpl(ctx, w, index);
}

import { reflect } from './reflect';
function reflectImpl(ctx: Ctx, w: Work, index: number): void {
  reflect(ctx.rules, w, index);
}

