/**
 * The special-tile dispatch ($81:811B land, $81:8436 hit-from-the-side) and
 * the handlers (docs/tiles.md). Each handler mirrors its ROM routine; the
 * return value routes the step: `landing` / `rolling` continue into the
 * default chain (optionally from its midpoint), `done` ends the dispatch.
 *
 * One group is stubbed, with the reason in `stubbed` (`$58`/`$59`, 2P holes
 * only); it is listed in docs/engine.md. Every other group is a port of the
 * disassembly.
 */
import { s16, wrap16, mulFloor, mulQ15s, mul16x8, atan2Deg } from '../fixed';
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
import { waterLand, waterHit } from './water';
import { sparkDestroy } from './abilities';
import { swirlLand, swirlHit, switchLand, switchHit, waterSwitchLand, waterSwitchHit } from './switches';
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
    case 'overlay':
      return waterLand(ctx, w, _modifier); // $82:80F6
    case 'switch':
      return switchLand(ctx, w); // $82:A1B1
    case 'waterSwitch':
      return waterSwitchLand(ctx, w); // $82:A3EB
    default: {
      const name = ctx.rules.landHandler(w.tile);
      if (name.startsWith('toggle')) return swirlLand(ctx, w); // $82:9FD1-$82:A082
      return stubbed(name, LANDING);
    }
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
      return boostHit(ctx, w, 'vy', -1);
    case 'boostEHit':
      return boostHit(ctx, w, 'vx', 1);
    case 'boostSHit':
      return boostHit(ctx, w, 'vy', 1);
    case 'boostWHit':
      return boostHit(ctx, w, 'vx', -1);
    case 'enemy':
      return enemyDispatch(ctx, w);
    case 'enemyRollAlt':
      // $82:8963: JML $81:8A56 - tiles $4D-$52 (the hovering enemies) are
      // never tested from the rolling path
      return ROLLING;
    case 'warpHit':
      return warpHit(ctx, w);
    case 'overlayHit':
      return waterHit(ctx, w); // $82:8000
    case 'switchHit':
      return switchHit(ctx, w); // $82:A175
    case 'waterSwitchHit':
      return waterSwitchHit(ctx, w); // $82:A43E
    default: {
      const name = ctx.rules.hitHandler(w.tile);
      if (name.startsWith('toggle')) return swirlHit(ctx, w); // $82:9EF9-$82:9FCD
      return stubbed(name, ROLLING);
    }
  }
}

/**
 * The one stubbed group: switch58 (+hit), `$58`/`$59` ($82:A25D/$82:A2F5),
 * the `$6A2E` switch with its three uses and object 101's sequence. It is
 * read (notes/port-v2-phase6-switches.md) but only the 2P holes 132-143 and
 * 196-207 have it, so it waits for step 9; it returns its group's default
 * routing, so the tile behaves like plain ground. (The swirls and the
 * switches `$5A-$5D` are switches.ts, port_v2 phase 6; the water water.ts.)
 */
const stubbedSeen = new Set<string>();
function stubbed(name: string, fallback: DispatchOutcome): DispatchOutcome {
  if (!stubbedSeen.has(name)) stubbedSeen.add(name);
  return fallback;
}

// --- friction tiles ($20-$24: land $82:8F77, hit $82:8F9D) ---

function frictionTile(ctx: Ctx, w: Work): void {
  // $82:8FA4 (JSR from both sides): mode $0A keeps the coefficients
  if (w.mode !== 0x0a) {
    w.rollMu = ctx.rules.const_('frictionTileMu'); // $0800
    if (w.tile === 0x24) {
      w.dampXY = ctx.rules.const_('frictionTileDampXY');
      w.dampZ = ctx.rules.const_('frictionTileDampZ');
    } else {
      w.dampXY = ctx.rules.const_('roughDampXY2');
      w.dampZ = w.mode === 6 ? ctx.rules.const_('roughDampZ6') : ctx.rules.const_('roughDampZ');
    }
  }
  // $82:8F87 (the land side, after the JSR, in every mode): sfx $1A when the
  // ball is at/under the surface and vz >= -$100
  if (grounded(w) && w.vz < 0xff00) w.tailSfx = 0x001a;
}

// --- the rough tile $04 ($82:8EFB land / $82:8F30 hit) ---

/**
 * $82:8EFB, the land side: at or under the surface, the coefficients by
 * `$80:DDF5`[mode], then the tail sound from vz ($82:8F17): $5F at rest,
 * none while falling slower than $400 (vz in [$FC00, $FFFF], `BCS $8F2C`),
 * else $60. No mode is singled out (web_rough_land/_soft/_hard).
 */
function roughLand(ctx: Ctx, w: Work): DispatchOutcome {
  if (!grounded(w)) return LANDING; // BCC $8F2C: straight to the default
  setRoughCoeffs(ctx, w, ctx.rules.table('frictionAltMode')[w.mode]);
  if (w.vz === 0) w.tailSfx = 0x005f;
  else if (w.vz < 0xfc00) w.tailSfx = 0x0060;
  return LANDING;
}

function frictionAltHit(ctx: Ctx, w: Work): void {
  // $82:8F30: the hit-side $04 handler, by `$80:DE21`[mode] (web_rough_roll)
  setRoughCoeffs(ctx, w, ctx.rules.table('frictionAltIndex')[w.mode]);
  if (w.pTile !== 0x04) w.tailSfx = 0x0060; // $82:8F44
}

/**
 * $82:8F4E: X = 0 or 2 is a byte offset into three 2-word tables
 * ($80:DD71 friction, $DD75 dampXY, $DD79 dampZ: mode 0 reads $6800 /
 * $6665 / $20C4), and the spin goes. `LDY $D9C8 / CMP #5 / LSR` compares
 * the friction just loaded, never 5, so the halving never runs.
 */
function setRoughCoeffs(ctx: Ctx, w: Work, idx: number): void {
  w.rollMu = ctx.rules.table('roughFriction')[idx >> 1];
  w.dampXY = ctx.rules.table('roughDampXY')[idx >> 1];
  w.dampZ = ctx.rules.table('roughDampZ')[idx >> 1];
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

/**
 * $82:9DB3/$9DD7/$9DFB/$9E1F, landed on: the gates, then the fixed delta,
 * then the default landing. Every exit clears $6A28 (object 112's hum,
 * systems/boost-hum.ts).
 */
function boostLand(ctx: Ctx, w: Work, dir: 'vx+' | 'vx-' | 'vy+' | 'vy-'): DispatchOutcome {
  w.boostFlash = 0; // $82:9DD0 etc.: STZ $6A28 on every path
  if (!grounded(w)) return LANDING; // $82:9E76 BCC
  if (modeImmune(w)) return LANDING; // $82:9E85
  if (s16(wrap16(boostGateAxis(w) - 0x4000)) < 0) return LANDING; // $82:9E9A BMI
  const delta = dir === 'vx+' || dir === 'vy+' ? ctx.rules.const_('boostE') : ctx.rules.const_('boostW');
  if (dir === 'vx+' || dir === 'vx-') w.vx = wrap16(w.vx + delta);
  else w.vy = wrap16(w.vy + delta);
  resetCoeffs(ctx, w);
  return LANDING;
}

/** |v| of a 16-bit pattern, unsigned (EOR #$FFFF / INC A). */
function abs16(v: number): number {
  const x = s16(v);
  return x < 0 ? wrap16(-x) : x;
}

/**
 * $82:9CBF (N) / $9CFC (E) / $9D39 (S) / $9D76 (W), rolled onto. `axis` is
 * the panel's own velocity component and `sign` its direction (the X that
 * $82:9E43 / $82:9E48 pass): N vy -, E vx +, S vy +, W vx -. Read
 * 2026-11-15 (notes/port-v2-phase1-courses.md):
 * - the gates (mode, $82:9E9A) fail: $6A28 = 0, the roll goes on;
 * - a straight hit (|other| < boostStraight, $82:9CBD): the other component
 *   stops, and if |axis| < boostBig the ball launches along the panel at
 *   ±(boostBig - 1), $D9D0 = 0 and $6A28 = that speed (the hum's switch),
 *   and the handler returns (RTL): no roll this step, only the tail;
 * - otherwise ($6A28 = 0): the panel's component gets ±boostSmall, the
 *   coefficients are reset, and the roll goes on ($81:8A56).
 */
function boostHit(ctx: Ctx, w: Work, axis: 'vx' | 'vy', sign: 1 | -1): DispatchOutcome {
  if (modeImmune(w) || s16(wrap16(boostGateAxis(w) - 0x4000)) < 0) {
    w.boostFlash = 0; // $82:9CF5
    return ROLLING;
  }
  const other: 'vx' | 'vy' = axis === 'vx' ? 'vy' : 'vx';
  if (abs16(w[other]) < ctx.rules.const_('boostStraight')) {
    w[other] = 0; // STZ
    if (abs16(w[axis]) < ctx.rules.const_('boostBig')) {
      // $82:9E5B-$82:9E6B
      w.spinPending = 0; // STZ $D9D0
      const v = wrap16(sign > 0 ? ctx.rules.const_('boostBig') - 1 : ctx.rules.const_('boostBigNeg') + 1);
      w.boostFlash = v; // STA $6A28
      w[axis] = v;
      return DONE; // RTL from the handler: $81:8103 goes on to $81:8D52 and the tail
    }
    w.boostFlash = 0; // $82:9E71
  }
  w[axis] = wrap16(w[axis] + (sign > 0 ? ctx.rules.const_('boostSmall') : ctx.rules.const_('boostSmallNeg')));
  resetCoeffs(ctx, w); // JSR $9EE3
  w.boostFlash = 0; // STZ $6A28
  return ROLLING; // JML $81:8A56
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

/**
 * $82:A88C, the kicker rolled onto: with the ball moving, a push along the
 * kicker ($10 -y, $11 +x, $12 +y, $13 -x: the angles 270, 0, 90, 180 of
 * $82:A8B3's branches) of `kickerTurn`'s size, halved when the ball runs
 * against it; then the heading ($81:8E60) and the roll ($81:8A56).
 */
function kickerHit(ctx: Ctx, w: Work): DispatchOutcome {
  if (ctx.rules.table('kickerModeHit')[w.mode] === 0) return ROLLING;
  if ((w.vx | w.vy) === 0) return ROLLING; // $82:A8A0
  const t = w.tile - 0x10;
  let k = kickerTurn(w, [270, 0, 90, 180][t]);
  switch (t) {
    case 0: if (s16(w.vy) >= 0) k >>= 1; w.vy = wrap16(w.vy - k); break; // $A8F0
    case 1: if (s16(w.vx) < 0) k >>= 1; w.vx = wrap16(w.vx + k); break; // $A8BB
    case 2: if (s16(w.vy) < 0) k >>= 1; w.vy = wrap16(w.vy + k); break; // $A8E2
    case 3: if (s16(w.vx) >= 0) k >>= 1; w.vx = wrap16(w.vx - k); break; // $A8C9
  }
  updateHeading(ctx.rules, w);
  return ROLLING;
}

/**
 * $82:A90F: the push's size from the angle between the heading ($D9DA) and
 * the kicker's, folded to 0-180, and the friction it leaves:
 * - mode 6 (Wheel): angle x $18 >> 8, friction $0100;
 * - otherwise angle x $58 >> 8, friction $1000, or $1800 with the push
 *   capped at $70 for an angle in [$17, $9D);
 * - mode 2 (Parasol) adds the friction it had to that.
 * ($80:A378, read at $389F: bits 8-23.)
 */
function kickerTurn(w: Work, angle: number): number {
  let d = s16(wrap16(w.deg - angle));
  if (d < 0) d = -d;
  if (d >= 180) d = 360 - d;
  if (w.mode === 6) {
    w.rollMu = 0x0100;
    return (d * 0x18) >> 8;
  }
  const old = w.rollMu;
  let k = (d * 0x58) >> 8;
  let mu = 0x1000;
  if (d >= 0x17 && d < 0x9d) {
    mu = 0x1800;
    if (k >= 0x70) k = 0x70;
  }
  w.rollMu = w.mode === 2 ? wrap16(mu + old) : mu;
  return k;
}

/**
 * $82:A7FE-$82:A884, the kicker's push on the land side. X = 0, or 2
 * in mode 6 (Wheel, with `$DA3A` = $0100): a byte offset, so the bounds are
 * `$80:DDE3`/`$DDE5` [X >> 1]: 25 / 200, or 200 / 6. The kick is vz x the
 * signed low byte of the first ($80:A342: mode 6's $C8 is -56), read at
 * $389F; at or over the second (unsigned) it is the first instead. The
 * tile's jump (`SEC / SBC #$10 / CMP #4 / ASL`) leaves the carry clear, so
 * the push is v + kick ($10, $11: ADC) or v - kick - 1 ($12, $13: SBC).
 */
function kickerApply(ctx: Ctx, w: Work, out: DispatchOutcome): DispatchOutcome {
  const x = w.mode === 6 ? 2 : 0;
  if (w.mode === 6) w.rollMu = 0x0100;
  const min = ctx.rules.table('kickerMin')[x >> 1];
  const max = ctx.rules.table('kickerMax')[x >> 1];
  let kick = mul16x8(w.vz, min);
  if (kick >= max) kick = min;
  // the jump table $82:A843 by the tile: $A869, $A84B, $A85F, $A855
  switch (w.tile - 0x10) {
    case 0: w.vy = wrap16(w.vy - kick - 1); break; // $A869: vy SBC
    case 1: w.vx = wrap16(w.vx + kick); break; // $A84B: vx ADC
    case 2: w.vy = wrap16(w.vy + kick); break; // $A85F: vy ADC
    case 3: w.vx = wrap16(w.vx - kick - 1); break; // $A855: vx SBC
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

// --- the snap panels ($18-$1B: land $82:A5B1, hit $82:A5E6) ---

/**
 * $82:A5B1, landed on: at or under the surface ($82:A5B9, the compare of
 * $82:9E76) and through the gate, the ball is put on the surface at rest
 * vertically ($D9EC = 0, z = ground, vz = 0) and pushed; every other path is
 * the default landing ($81:8905).
 */
function snapLand(ctx: Ctx, w: Work): DispatchOutcome {
  if (w.mode === 0x0a) return LANDING; // $82:A5B7
  if (!grounded(w)) return LANDING; // $82:A5C7 BCC
  if (!snapGate(w)) return LANDING; // $82:A5CC BMI
  w.air = 0; // $82:A5CE
  w.z = w.ground; // $82:A5D1-$82:A5DA
  w.vz = 0; // $82:A5DD
  return snapPush(ctx, w);
}

/** $82:A5E6, rolled onto: the gate, then the push; else the default roll ($81:8A56). */
function snapHit(ctx: Ctx, w: Work): DispatchOutcome {
  if (w.mode === 0x0a) return ROLLING; // $82:A5EC
  if (!snapGate(w)) return ROLLING; // $82:A5F1 BEQ not taken
  return snapPush(ctx, w);
}

/**
 * $82:A692: both fractions in [$2800, $DFFF) and the mode neither 1 nor 4.
 * A failure clears the latch $6A68 (shared with the enemies, the pillar and
 * the arrows), so a pass that leaves the window re-arms the next one. The
 * ROM returns through DEY's flags: Y = 0 pass, $FFFF fail.
 */
function snapGate(w: Work): boolean {
  const inside = (f: number): boolean => f >= 0x2800 && f < 0xdfff;
  if (inside(w.xf) && inside(w.yf) && w.mode !== 1 && w.mode !== 4) return true;
  w.enemyLatch = 0; // $82:A6C2
  return false;
}

/**
 * $82:A5F7: one push per frame in the window. `STZ $699A` keeps object 61
 * (the star trail, systems/snap-trail.ts) alive; once per pass (the latch
 * $6A68) the tail plays $11 and object 61 is spawned ($80:DFBA, A = $3D).
 * Then the jump table $82:A629 by tile - $18 adds $300 along the panel:
 *
 *   $18 $A631  vy + $FD00; a negative sum below $E000 (u16) -> $E000
 *   $19 $A65A  vx + $0300; a positive sum >= $2000 -> A = $2000, but
 *              `BRA $A681` at $A66B skips the store: vx is left unchanged
 *   $1A $A644  vy + $0300; a positive sum >= $2000 -> $2000
 *   $1B $A66D  vx + $FD00; a negative sum below $E000 -> $E000
 *
 * The tests are BPL/BMI on the 16-bit sum, so a sum that wraps the sign is
 * stored as it is. Then the heading ($81:8E60), the spin cleared, and the
 * rolling default ($81:8A56) — from the landing path too.
 */
function snapPush(ctx: Ctx, w: Work): DispatchOutcome {
  w.snapKeep = 1; // $82:A5F7 STZ $699A
  if (w.enemyLatch === 0) {
    w.enemyLatch += 1; // $82:A602
    w.tailSfx = 0x0011; // $82:A608
    w.snapSpawn += 1; // $82:A60E: object 61
  }
  switch (w.tile - 0x18) {
    case 0: w.vy = snapDown(w.vy); break;
    case 1: {
      const r = wrap16(w.vx + 0x0300); // $82:A65E
      if ((r & 0x8000) !== 0 || r < 0x2000) w.vx = r; // $82:A661 BMI / $82:A666 BCC -> STA
      break; // else $82:A66B BRA $A681: no store
    }
    case 2: {
      const r = wrap16(w.vy + 0x0300); // $82:A648
      w.vy = (r & 0x8000) !== 0 || r < 0x2000 ? r : 0x2000; // $82:A64B-$82:A655
      break;
    }
    case 3: w.vx = snapDown(w.vx); break;
  }
  updateHeading(ctx.rules, w); // $82:A681 JSL $81:8E60
  w.spinX = 0; // $82:A685
  w.spinY = 0;
  w.spinPending = 0;
  return ROLLING; // $82:A68E JML $81:8A56
}

/** $82:A631 / $82:A66D: + $FD00, a negative sum floored at $E000. */
function snapDown(v: number): number {
  const r = wrap16(v + 0xfd00);
  return (r & 0x8000) === 0 || r >= 0xe000 ? r : 0xe000;
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
 *   land: above the top, or outside the footprint, or Spark's destroy
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
  // $82:961B -> $82:EE9A: Spark (mode 7) destroys the tree: the actor
  // unlinked, the layer-2 tile cleared, object 72 told to break ($531C =
  // $FFFF), sfx $3A inline; then the latch is cleared and the plain
  // landing or roll goes on, with no push and no spin cleared
  if (sparkDestroy(w)) {
    w.abilitySfx.push(0x3a);
    w.enemyLatch = 0; // $82:9572 / $82:959C
    return out;
  }
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

