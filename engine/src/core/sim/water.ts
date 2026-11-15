/**
 * The water, tiles $60-$6F (read 2026-11-15; docs/tiles.md "Water",
 * notes/port-v2-phase4-water.md): the landing handler `$82:80F6`, the
 * rolling one `$82:8000`, their helpers `$82:8228`-`$82:864D`, and the shot
 * guide's own water model (`$81:B0C4`, `$81:B285`).
 *
 * A water cell has a region ($82:83DD: 0 dry, 1 shallow, 2 deep, by the
 * tile's shape and the fractions) and a level ($82:83B9: the height of its
 * elevation, + 1 on the open water `$61`, + `$57AD`). A ball below the level
 * in the region is in the water (`$D9EE`, block `$D872`): the entry slows it
 * (velocities / 2 shallow, / 8 deep), splashes and freezes one frame, and
 * from then on every frame drags it (v -= v x 6 / 256) until it rises above
 * the level or rolls out of the region. A fast, flat ball skims instead; with
 * top or back spin it skips once or twice first.
 *
 * Kernels: no events. The effects ride the step's facts (`waterSplash`,
 * `waterBubbles`, `waterPalette`, `waterSilence`, `waterWait`, `kirbyRoll`),
 * which the step's `water-effects` entry turns into events and spawns.
 *
 * The ability modes' branches are ported as read and untraced (BallMode is
 * always 0 so far): Wheel (6) and UFO (10, with `$D77A` = 0, which the
 * engine does not keep) ride the level (`$69D8`); Freeze (9) ices the water
 * (`$69DA`). In 1P the other player's block is empty, so Freeze's reaction
 * for a ball in the water (`$D780,X` = `$15`, `$82:81A7`) never fires.
 */
import { s16, wrap16, mulFloor, mulHiU, mul16x8 } from '../fixed';
import type { Ctx, Work } from './context';
import type { RollModifier } from './roll';
import { cosDeg, sinDeg } from './trig';
import { LANDING, ROLLING, DONE, type DispatchOutcome } from './types';

/** $60-$6F. */
export function isWaterTile(t: number): boolean {
  return t >= 0x60 && t < 0x70;
}

/** $82:C85F: the probe's test, the water's tile and the water on. */
export function onWater(ctx: Ctx, tile: number): boolean {
  return !ctx.course.waterOff && isWaterTile(tile);
}

// --- the region ($82:83DD) ---

/** $82:842A: a straight rim; `a` is the fraction across it, toward the water. */
function rimEdge(a: number): number {
  return a < 0xe000 ? 2 : 0;
}

/** $82:8468: an outer corner, by the two fractions. */
function rimCorner(x: number, y: number): number {
  if (x >= 0xf000 || y >= 0xf000) return 0;
  if (x >= 0xe000 || y >= 0xe000) return 1;
  return 2;
}

/** $82:84C5: an inner corner. */
function rimInner(x: number, y: number): number {
  if (x >= 0xf000 && y >= 0xf000) return 0;
  if (x < 0xe000) return 2;
  if (y >= 0xe000) return 1;
  return 2;
}

/**
 * $82:83DD: `$69CC` for the probe's tile and the ball's fractions; the
 * returned value is what the callers' BNE tests. `$60`, `$62` and `$63` hang
 * the game (`$82:840E BRA $840E`) and so does a tile outside `$60-$6F`
 * (`$82:83E7`); no hole has them, and the engine reads them as dry.
 */
export function waterRegion(w: Work): number {
  const xf = wrap16(w.xf);
  const yf = wrap16(w.yf);
  const nx = wrap16(-xf);
  const ny = wrap16(-yf);
  let r: number;
  switch (w.tile - 0x60) {
    case 0x1: r = 2; break; // $82:848C: open water
    case 0x4: r = rimEdge(yf); break; // $82:8410
    case 0x5: r = rimEdge(nx); break; // $82:8415
    case 0x6: r = rimEdge(ny); break; // $82:841E
    case 0x7: r = rimEdge(xf); break; // $82:8427
    case 0x8: r = rimCorner(nx, yf); break; // $82:8436
    case 0x9: r = rimCorner(nx, ny); break; // $82:8443
    case 0xa: r = rimCorner(xf, ny); break; // $82:8455
    case 0xb: r = rimCorner(xf, yf); break; // $82:8462
    case 0xc: r = rimInner(nx, yf); break; // $82:8493
    case 0xd: r = rimInner(nx, ny); break; // $82:84A0
    case 0xe: r = rimInner(xf, ny); break; // $82:84B2
    case 0xf: r = rimInner(xf, yf); break; // $82:84BF
    default: r = 0; // the ROM's traps
  }
  w.waterRegion = r;
  return r;
}

/** $82:83B9: `$69D0:$69CE`, the level over the probe's cell. */
export function waterLevel(ctx: Ctx, w: Work): number {
  const i = w.elev + (w.tile === 0x61 ? 1 : 0); // $82:83C2 INC A on $61
  const lo = ctx.rules.table('heightZLo')[i] + ctx.rules.const_('waterLevelOffset'); // ADC $88:8000,X
  const hi = ctx.rules.table('heightZHi')[i] + (lo >> 16); // ADC $88:80C8,X with the carry
  w.waterLevel = ((hi & 0xffff) << 16 | (lo & 0xffff)) | 0;
  return w.waterLevel;
}

/** z < the level, as the handlers compare it: the high words, then the low ones, unsigned. */
function belowLevel(w: Work): boolean {
  return (w.z >>> 0) < (w.waterLevel >>> 0);
}

// --- the helpers ---

/** $82:8228: the skips a ball entering the water has, from its spin. */
export function skipCount(w: Work, rollTB: number): void {
  let y = 0xffff;
  if ((w.spinX | w.spinY) !== 0) {
    const d = Math.abs(s16(rollTB) - 6); // $6B58,X - 6, negated if negative
    if (d !== 0 && d >= 4) y = d >= 6 ? 2 : 1;
  }
  w.waterSkips = y;
}

/** $82:836E: the drag in the water, three axes. */
function drag3(ctx: Ctx, w: Work): void {
  const k = ctx.rules.const_('waterDrag');
  w.vx = wrap16(w.vx - mul16x8(w.vx, k));
  w.vy = wrap16(w.vy - mul16x8(w.vy, k));
  w.vz = wrap16(w.vz - mul16x8(w.vz, k));
}

/** $82:8344: the drag rolling in the water, x and y. */
function drag2(ctx: Ctx, w: Work): void {
  const k = ctx.rules.const_('waterDragRoll');
  w.vx = wrap16(w.vx - mul16x8(w.vx, k));
  w.vy = wrap16(w.vy - mul16x8(w.vy, k));
}

/** $82:85CB: / 8 toward zero (the magnitude shifted, the sign put back). */
function div8(v: number): number {
  const s = s16(v);
  const m = Math.abs(s) >> 3;
  return wrap16(s < 0 ? -m : m);
}

/** $82:858D: the entry's slow-down, by the region. */
function entrySlow(w: Work): void {
  if (w.waterRegion === 1) {
    // ASL mem / ROR A: an arithmetic shift right
    w.vx = wrap16(s16(w.vx) >> 1);
    w.vy = wrap16(s16(w.vy) >> 1);
    w.vz = wrap16(s16(w.vz) >> 1);
  } else {
    w.vx = div8(w.vx);
    w.vy = div8(w.vy);
    w.vz = div8(w.vz);
  }
}

/** $82:8604: a splash by |vz| (object 55, 56 or 57) and Kirby's palette for `$D9EE`. */
function splashAndPalette(ctx: Ctx, w: Work): void {
  const vz = s16(w.vz);
  const m = vz < 0 ? -vz : vz;
  w.waterSplash = m >= ctx.rules.const_('waterSplashBig') ? 57 : m >= ctx.rules.const_('waterSplashMid') ? 56 : 55;
  w.waterPalette = w.onOverlay !== 0 ? 1 : 0;
}

function zeroSpin(w: Work): void {
  w.spinX = 0;
  w.spinY = 0;
  w.spinPending = 0;
}

/** $82:8316: z on the level. */
function onLevel(w: Work): void {
  w.z = w.waterLevel;
}

/**
 * $82:8256: a skip, or the modifier's bounce once the skips are spent.
 * True (SEC) when the ball left the water's surface.
 */
function trySkip(ctx: Ctx, w: Work, mod: RollModifier, rollTB: number): boolean {
  const n = w.waterSkips;
  if (n === 0) {
    // $82:82CD: the A/Y modifier armed
    if (mod.kind < 0) return false;
    const k = mod.kind >> 1;
    // $82:82D4-$82:8300: $00 = $833C,X (tables.json waterModBounce) and $02
    // = $8340,X, but the routine loads $02 before the first multiply and
    // again before the third, and never stores the second: vx and vz take
    // $8340's factor and vy is left (web_water_mod)
    const f = ctx.rules.table('waterModBounceZ')[k];
    w.vx = mulHiU(f, w.vx);
    w.vz = wrap16(-s16(mulHiU(f, w.vz)));
    w.waterSplash = 53; // $82:8303: object $35
  } else {
    if (n & 0x8000) return false; // BMI: none
    const back = rollTB >= 7; // $82:8265: $6B58 >= 7, backspin
    const speed = ctx.rules.table(back ? 'waterSkipSpeedBack' : 'waterSkipSpeed')[n];
    w.vz = ctx.rules.table(back ? 'waterSkipVzBack' : 'waterSkipVz')[n] & 0xffff;
    const deg = w.deg < 360 ? w.deg : 0; // the heading is valid on an airborne step ($81:8E60)
    w.vx = mulFloor(cosDeg(ctx.rules, deg), speed);
    w.vy = mulFloor(sinDeg(ctx.rules, deg), speed);
    w.waterSplash = 54; // $82:82A3: object $36
    w.kirbyRoll = 1; // $82:82B9: $D7D4,X = $0E
    zeroSpin(w);
    w.waterSkips = wrap16(n - 1);
  }
  w.tailSfx = 0x48;
  onLevel(w);
  return true;
}

/** $82:84DB: the skim; true when it skimmed. */
function trySkim(ctx: Ctx, w: Work, mod: RollModifier): boolean {
  const vz = s16(w.vz);
  if ((vz < 0 ? -vz : vz) >= ctx.rules.const_('waterSkimVzMax')) return false;
  const vx = s16(w.vx);
  const vy = s16(w.vy);
  const sum = ((vx < 0 ? -vx : vx) + (vy < 0 ? -vy : vy)) & 0xffff; // ADC $B0, 16 bits
  if (sum < ctx.rules.const_('waterSkimSpeedMin')) return false;
  w.waterSplash = sum >= ctx.rules.const_('waterSkimBig') ? 54 : 53; // $82:8509
  w.tailSfx = 0x48;
  w.code = 0; // $82:8525: STZ $DA04
  const f = mod.kind >= 0 ? ctx.rules.table('waterSkimMod')[mod.kind >> 1] : ctx.rules.const_('waterSkimFactor');
  w.vx = mulHiU(f, w.vx);
  w.vy = mulHiU(f, w.vy);
  w.vz = wrap16(-s16(mulHiU(ctx.rules.const_('waterSkimFactorZ'), w.vz)));
  onLevel(w);
  // $82:8571: the spin halved (ASL mem / ROR A); $D9D0 kept
  w.spinX = wrap16(s16(w.spinX) >> 1);
  w.spinY = wrap16(s16(w.spinY) >> 1);
  return true;
}

/** The entry's effects ($82:81C2 / $82:80A5), after the slow-down. */
function enter(ctx: Ctx, w: Work): void {
  w.onOverlay = 1;
  zeroSpin(w);
  splashAndPalette(ctx, w); // $82:8604
  w.waterBubbles = 1; // $82:85DD
  w.waterSilence = 1; // $80:B542 with A = 0
  w.waterWait = 1; // JML $80:8F78: one frozen frame, then RTL
}

/** $82:813F / $82:8053: the ball rides the level (modes 6, 9, 10). */
function walk(ctx: Ctx, w: Work, rolling: boolean): boolean {
  if (waterRegion(w) === 0) {
    w.waterWalk = 0;
    return false;
  }
  w.ground = waterLevel(ctx, w);
  w.code = 0;
  w.waterWalk = 1;
  if (rolling) w.rollMu = (w.rollMu & 0xffff) >> 2; // $82:8077: LSR LSR $DA3A
  return true;
}

/** Freeze, mode 9 ($82:819B / $82:8039). */
/**
 * `$82:D9C2`, the thaw: the ice goes ($69DA = 0) with sfx $4D, silent while
 * the water is off ($69CA). Called by the trigger (a new ability other than
 * Freeze), by Freeze stopping on its ice, by the lost ball's countdown and
 * by the hazard reaction; the hole's start clears $69DA too ($80:C276).
 */
export function thaw(ctx: Ctx, w: Work): void {
  w.waterFreeze = 0;
  if (!ctx.course.waterOff) w.abilitySfx.push(0x4d);
}

function freeze(w: Work): void {
  w.waterFreeze = 1;
  w.tailSfx = 0x47;
  // LDX $180F / LDA $D872,X: the other player's ball in the water gets
  // $D780,X = $15. 1P: the other block is empty.
}

/** The mode-6/9/10 gate of both handlers: true when the ball rides the level. */
function ridesLevel(w: Work): boolean {
  if (w.mode === 6) return true;
  if (w.mode === 0x0a) return w.d77a === 0; // $82:8028 / $82:8135: the UFO flying
  return false;
}

function saveGround(w: Work): void {
  w.waterGround = w.ground; // $69D2/$69D4
  w.waterCode = w.code; // $69D6
}

// --- the handlers ---

/** `$82:80F6`, the landing side. */
export function waterLand(ctx: Ctx, w: Work, mod: RollModifier): DispatchOutcome {
  const rollTB = w.rollTB;
  if (ctx.presentation === false) return guideLand(ctx, w);
  if (ctx.course.waterOff) return LANDING; // $82:80F6: $69CA
  saveGround(w);
  if (!isWaterTile(w.pTile)) skipCount(w, rollTB); // $82:8111: entering from dry
  if (w.waterFreeze !== 0) {
    if (w.onOverlay !== 0) return LANDING; // $82:8126 BNE $8163
    walk(ctx, w, false);
    return LANDING;
  }
  if (ridesLevel(w)) {
    walk(ctx, w, false);
    return LANDING;
  }
  if (w.onOverlay !== 0) {
    // $82:81F9: in the water
    waterLevel(ctx, w);
    if (belowLevel(w)) {
      drag3(ctx, w); // $82:8220
      return LANDING;
    }
    // $82:820D: up through the surface
    w.onOverlay = 0;
    skipCount(w, rollTB);
    splashAndPalette(ctx, w);
    w.tailSfx = 0x49;
    return LANDING;
  }
  if (waterRegion(w) === 0) return LANDING; // $82:8173
  waterLevel(ctx, w);
  if (!belowLevel(w)) return LANDING; // $82:818B
  if (w.mode === 0) {
    if (trySkip(ctx, w, mod, rollTB)) return DONE; // $82:81BA: RTL
    if (trySkim(ctx, w, mod)) return DONE; // $82:81BF: RTL
  } else if (w.mode === 9) {
    freeze(w);
    walk(ctx, w, false);
    return LANDING;
  }
  // $82:81C2: the sink
  entrySlow(w);
  enter(ctx, w);
  w.tailSfx = (w.vz & 0xffff) >= ctx.rules.const_('waterSinkSlow') ? 0x49 : 0x4c; // $82:81DD
  return DONE;
}

/** `$82:8000`, the rolling side. */
export function waterHit(ctx: Ctx, w: Work): DispatchOutcome {
  if (ctx.presentation === false) return guideRoll(ctx, w);
  if (ctx.course.waterOff) return ROLLING;
  saveGround(w);
  let rides = w.waterFreeze !== 0 || w.mode === 6 || (w.mode === 0x0a && w.d77a === 0); // the UFO flying
  if (!rides && w.mode === 9) {
    freeze(w);
    rides = true;
  }
  if (rides) {
    walk(ctx, w, true);
    return ROLLING;
  }
  // $82:8083
  if (!isWaterTile(w.pTile)) {
    // $82:80EC: off the dry ground, the ball drops in
    w.vz = 0;
    w.air = 1;
    return DONE;
  }
  w.waterSkips = 0xffff; // $82:8090
  if (w.onOverlay !== 0) {
    // $82:80D4
    if (waterRegion(w) !== 0) {
      drag2(ctx, w);
      return ROLLING;
    }
    w.onOverlay = 0;
    splashAndPalette(ctx, w);
    return ROLLING;
  }
  if (waterRegion(w) === 0) return ROLLING;
  entrySlow(w);
  w.vz = 0; // $82:80AB
  enter(ctx, w);
  w.tailSfx = 0x49;
  return DONE;
}

// --- the shot guide's model ($81:B0C4 airborne, $81:B285 rolling) ---

/**
 * `$81:B0C4`-`$81:B19C` for a water tile, airborne. In the water: the drag
 * below the level, else the ball is out. Dry over the region: below the
 * level it lands on it as on flat ground (surface code 0), above it only
 * gravity acts (`$81:B144`). The level is nonzero only on a step that
 * reached `$82:83B9` (`$81:AF82` zeroes it).
 */
function guideLand(ctx: Ctx, w: Work): DispatchOutcome {
  if (ctx.course.waterOff) return LANDING;
  if (waterRegion(w) === 0) return LANDING;
  waterLevel(ctx, w);
  if (w.onOverlay !== 0) {
    if (belowLevel(w)) drag3(ctx, w);
    else w.onOverlay = 0;
    return LANDING;
  }
  // $81:B144: lands on the level, code 0 ($81:B161-$81:B170), or gravity only
  return { next: 'landing', entry: 'full', surface: { ground: w.waterLevel, code: 0 } };
}

/**
 * `$81:B285`-`$81:B2C9` for a water tile, rolling: a ball that started the
 * guide in the water (the block's `$D872`) drags in the region and is out of
 * it beyond; a dry one rolls on the level as flat ground.
 */
function guideRoll(ctx: Ctx, w: Work): DispatchOutcome {
  if (ctx.course.waterOff) return ROLLING;
  waterLevel(ctx, w);
  if (w.blockWet !== 0) {
    if (waterRegion(w) !== 0) {
      drag2(ctx, w);
      w.onOverlay = 1;
    } else {
      w.onOverlay = 0;
    }
    return ROLLING;
  }
  w.ground = w.waterLevel;
  w.code = 0;
  w.onOverlay = 0;
  return ROLLING;
}
