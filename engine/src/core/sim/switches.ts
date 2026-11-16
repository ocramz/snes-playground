/**
 * The switches and the swirls (port_v2 phase 6; docs/tiles.md "Toggles",
 * "Switches" and "The water switch"; notes/port-v2-phase6-switches.md).
 * Read with `tools/dis65816.py '$82:9EF9' --length 0x660 --m16 --x16`.
 *
 * - `$70-$7B`, the swirls: inside a disc about the cell's centre the ball is
 *   pushed across the line to the centre, as far as it is from it. The tile
 *   picks when ((tile - $70) >> 2: always, while `$6A2A` is set, while it is
 *   clear), how hard (bit 1: strong or weak) and which way round (bit 0).
 * - `$5A`/`$5B`, the toggles' switch: flips `$6A2A`, once a visit.
 * - `$5C`/`$5D`, the water switch: flips `$69CA` (the water off), and the
 *   step blocks for the water's tiles to dissolve (systems/switches.ts).
 *
 * The two of each pair differ only at the load (`$82:BC59`: the second
 * without the first sets the global). `$58`/`$59` (the `$6A2E` switch, 2P
 * holes only) and the 2P branches (`$17FF`: the other ball on a swirl or in
 * the water, `$82:A20E` and `$82:A474`) are left for step 9.
 */
import { hi16, mulHiU, s16, wrap16, atan2Deg } from '../fixed';
import type { Ctx, Work } from './context';
import { updateHeading } from './reflect';
import { cosDeg, sinDeg } from './trig';
import { LANDING, ROLLING, DONE, type DispatchOutcome } from './types';

// --- the swirls $70-$7B ---

/** Does a swirl act? Group 0 always, 1 while `$6A2A` is set, 2 while it is clear. */
function swirlOn(w: Work, tile: number): boolean {
  const group = (tile - 0x70) >> 2;
  return group === 0 || (group === 1) === (w.toggleOn !== 0);
}

/** |f - $8000| as the ROM folds it (`SBC #$8000 / BPL / EOR #$FFFF / INC`): 0 gives $8000. */
function fold(f: number): number {
  const r = wrap16(f - 0x8000);
  return (r & 0x8000) !== 0 ? wrap16(-r) : r;
}

/**
 * `$82:A086`: the disc. The high byte of each folded fraction, halved, is a
 * row (y) and a bit (x) of the quarter-disc bitmap `$88:9190`, 8 bytes a
 * row, LSB first (`tbl_edge_bitmask $80:8815`). A fraction of 0 folds to 64,
 * one past the last row or byte, which the ROM reads as it is.
 */
export function swirlDisc(ctx: Ctx, w: Work): { inside: boolean; byte: number } {
  const row = (fold(w.yf) >> 9) << 3;
  const col = fold(w.xf) >> 9;
  const byte = ctx.rules.table('toggleDisc')[row + (col >> 3)]; // $82:A0C7 STA $B6
  return { inside: (byte & (1 << (col & 7))) !== 0, byte };
}

/**
 * `$82:A111` + `$82:A0D9` (`sub`) / `$82:A0F9`: the push. The heading of
 * the ball from the centre (`$80:A4C1`) and the Manhattan distance |dx| +
 * |dy| (a 16-bit sum) scaled by the magnitude (`$80:A367`, high word);
 * then (-sin, cos) of that heading times it (`$80:A378`, high words) is
 * taken from (`sub`) or added to (vx, vy), and the heading updated
 * (`$81:8E60`). The vector is the heading turned 90 degrees, so the ball
 * goes round the centre.
 */
export function swirlPush(ctx: Ctx, w: Work, mag: number, sub: boolean): void {
  const dy = wrap16(w.yf ^ 0x8000);
  const dx = wrap16(w.xf ^ 0x8000);
  const deg = atan2Deg(dx, dy, ctx.rules.table('atanDeg'));
  const nsin = wrap16(-sinDeg(ctx.rules, deg)); // $82:A12E: EOR #$FFFF / INC
  const cos = cosDeg(ctx.rules, deg);
  const ax = (dx & 0x8000) !== 0 ? wrap16(-dx) : dx;
  const ay = (dy & 0x8000) !== 0 ? wrap16(-dy) : dy;
  const k = mulHiU(wrap16(ax + ay), mag); // $80:A367, $38A0
  const x = hi16(k, nsin);
  const y = hi16(k, cos);
  if (sub) {
    w.vx = wrap16(w.vx - x);
    w.vy = wrap16(w.vy - y);
  } else {
    w.vx = wrap16(w.vx + x);
    w.vy = wrap16(w.vy + y);
  }
  updateHeading(ctx.rules, w);
}

/**
 * Landed on (`$82:9FD1`-`$82:A082`): the gate by the switch, then (`$A03F`)
 * z under the ground (strictly: `CMP` / `BCS` skips at z = ground), in the
 * disc, mode neither 3 nor 6, halved in mode 5: the push, and the default
 * landing from `$81:892B` (the grounded entry). Otherwise `$81:8905`.
 */
export function swirlLand(ctx: Ctx, w: Work): DispatchOutcome {
  const tile = w.tile;
  if (!swirlOn(w, tile)) return LANDING;
  let mag = ctx.rules.const_((tile & 2) === 0 ? 'toggleLandStrong' : 'toggleLandWeak'); // $00
  if (!(w.z < w.ground)) return LANDING;
  if (!swirlDisc(ctx, w).inside) return LANDING;
  if (w.mode === 3 || w.mode === 6) return LANDING;
  if (w.mode === 5) mag >>= 1;
  swirlPush(ctx, w, mag, (tile & 1) === 0);
  return { next: 'landing', entry: 'grounded' };
}

/**
 * Rolled through (`$82:9EF9`-`$82:9FCD`): the gate by the switch, in the
 * disc, mode not 3, 6 or $0A, halved in mode 5: the push. Then modes 1, 4,
 * 2 and $10 return from the handler (RTL: no roll this step); otherwise the
 * default roll (`$81:8A56`), as on every other path.
 *
 * The magnitude is not `$80:DDED`/`$80:DDF1`: the handler keeps it in `$B6`
 * (`$82:9F5D`), which the disc test overwrites with its bitmap byte
 * (`$82:A0C7`), and reloads that. So the push is scaled by the byte, $FF
 * inside the disc and less on its rim, for the strong and the weak tiles
 * alike (web_sw_toggle_roll: `--log-pc '$82:A111'` reads A = 7, then $FF).
 */
export function swirlHit(ctx: Ctx, w: Work): DispatchOutcome {
  const tile = w.tile;
  if (!swirlOn(w, tile)) return ROLLING;
  const disc = swirlDisc(ctx, w);
  if (!disc.inside) return ROLLING;
  let mag = disc.byte; // LDA $B6, the disc's byte (not the constant stored there)
  if (w.mode === 3 || w.mode === 6 || w.mode === 0x0a) return ROLLING;
  if (w.mode === 5) mag >>= 1;
  swirlPush(ctx, w, mag, (tile & 1) === 0);
  if (w.mode === 1 || w.mode === 4 || w.mode === 2 || w.mode === 0x10) return DONE; // $82:9FB2
  return ROLLING;
}

// --- the toggles' switch $5A/$5B ---

/** `$82:A1FD`: both fractions in [$4000, $BFFF] (`SBC #$4000 / BMI`). */
function switchGate(w: Work): boolean {
  return s16(wrap16(w.xf - 0x4000)) >= 0 && s16(wrap16(w.yf - 0x4000)) >= 0;
}

/**
 * `$82:A189`/`$82:A1D5`: once a visit (the same cell as the last step's
 * with the latch set does nothing), `$6A2A` flips, sound $6B, the switch's
 * tiles (`$80:D7B5` 1) and `INC $6A2C`. (`$82:A20E`, the other ball on a
 * swirl, is 2P.)
 */
function flipSwitch(w: Work): void {
  if (w.cell === w.pCell && w.switchLatch !== 0) return;
  w.toggleOn ^= 1;
  w.switchFlip = 1;
  w.switchLatch = wrap16(w.switchLatch + 1);
}

/** `$82:A1B1`, landed on: the gate (out of it the latch clears), z under the ground, the flip. */
export function switchLand(_ctx: Ctx, w: Work): DispatchOutcome {
  if (!switchGate(w)) {
    w.switchLatch = 0; // $82:A1F6
    return LANDING;
  }
  if (!(w.z < w.ground)) return LANDING; // $82:A1C4 BCS
  flipSwitch(w);
  return LANDING;
}

/** `$82:A175`, rolled onto: the gate, the flip. */
export function switchHit(_ctx: Ctx, w: Work): DispatchOutcome {
  if (!switchGate(w)) {
    w.switchLatch = 0; // $82:A1AA
    return ROLLING;
  }
  flipSwitch(w);
  return ROLLING;
}

// --- the water switch $5C/$5D ---

/** `$82:A540`: both fractions in [$4800, $B800). */
function waterSwitchWindow(w: Work): boolean {
  return w.xf >= 0x4800 && w.xf < 0xb800 && w.yf >= 0x4800 && w.yf < 0xb800;
}

/**
 * `$82:A45D`: `$69CA` flips; the rest (the switch's colours, sounds $6A and
 * $4A or $4B, the dissolve and its block) is systems/switches.ts's.
 */
function flipWater(w: Work): void {
  w.waterOff ^= 1;
  w.waterSwitch = 1;
}

/**
 * `$82:A3EB`, landed on: at or under the surface (ground >= z) and in the
 * window, with the latch `$6A68` clear and falling (vz < $FDC0, unsigned):
 * a hard landing (vz < $F700) in mode 0 or 7 squashes Kirby (`$6A6E` =
 * `$DA04`, `$D7D4` = $0C) and sets `$6A70`, so the landing has no hit-stop
 * of its own; then the latch and the flip. Out of the window the latch
 * clears. Then the default landing (`$81:8905`).
 */
export function waterSwitchLand(_ctx: Ctx, w: Work): DispatchOutcome {
  if (!(w.ground >= w.z) || !waterSwitchWindow(w)) {
    w.enemyLatch = 0; // $82:A434
    return LANDING;
  }
  if (w.enemyLatch !== 0) return LANDING;
  if (w.vz >= 0xfdc0) return LANDING;
  if (w.vz < 0xf700 && (w.mode === 0 || w.mode === 7)) {
    w.lock6a6e = w.code; // $82:A41D
    w.waterSquash = 1;
    w.hitStopLatch = wrap16(w.hitStopLatch + 1); // $82:A429
  }
  w.enemyLatch = wrap16(w.enemyLatch + 1);
  flipWater(w);
  return LANDING;
}

/** `$82:A43E`, rolled onto: the window (out of it the latch clears), the latch, the flip; the default roll. */
export function waterSwitchHit(_ctx: Ctx, w: Work): DispatchOutcome {
  if (!waterSwitchWindow(w)) {
    w.enemyLatch = 0; // $82:A456
    return ROLLING;
  }
  if (w.enemyLatch !== 0) return ROLLING;
  w.enemyLatch = wrap16(w.enemyLatch + 1);
  flipWater(w);
  return ROLLING;
}
