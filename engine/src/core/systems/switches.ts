/**
 * The switches' and the swirls' presentation in the frame (port_v2 phase 6;
 * sim/switches.ts has the handlers; notes/port-v2-phase6-switches.md):
 *
 * - `switchEffects`, the `switches` step entry, inside the tile dispatch:
 *   the toggles' switch's sound $6B; the water switch's `$82:A45D` (sounds
 *   $6A, then $4A draining or $4B filling, Kirby squashed on a hard landing)
 *   and its block: the step waits 64 frames, one dissolve step each
 *   (`waterSwitch` stall, web_sw_water_drain: the flip at iteration 2527,
 *   the step's store at 2591).
 * - `tickWaterSwitch`, each frame of that block: `$80:8FB6` (1 frame) then
 *   `$80:9208` (one step); after step 20, palette set 3 (`$80:D2FE`:
 *   Kirby's colours by `$D872`).
 * - `tickSwitches`, the thread tick: object 127's frames (the swirls' tiles),
 *   objects 117 and 118's colours (the switches'), object 113's clock.
 *
 * The switches' tiles (`$80:D7B5` 1 and 2) follow the state: the views read
 * it from the work copy. The water switch's two records are the same bytes
 * (`$94:E5BB` = `$94:E7BB`), so only its colours change.
 */
import type { World } from 'koota';
import type { Ctx } from '../sim/context';
import type { BallWorkFields } from '../traits/ball';
import { BallWet, BallWork } from '../traits/ball';
import { Pose, PoseState } from '../traits/pose';
import { Switches, type SwitchColours, type SwirlAnim } from '../traits/switches';
import { activePlayer, findActivePlayer } from '../traits/player';
import { emitEvent } from './flow-util';
import { restoreKirbyColours } from './ability-fx';

/** The toggles' switch flips ($82:A195 / $82:A1E1). */
export const SWITCH_SFX = 0x6b;
/** The water switch is hit ($82:A470), then the water goes ($4A) or comes ($4B) ($82:A4ED). */
export const WATER_SWITCH_SFX = 0x6a;
export const WATER_OFF_SFX = 0x4a;
export const WATER_ON_SFX = 0x4b;
/** `$80:9208` runs to `$0854` = $40: 64 steps, each after a 1-frame wait. */
export const DISSOLVE_STEPS = 64;
/** `$82:A502`: the first loop's 20 steps, then `$80:D2FE` 3. */
export const DISSOLVE_PALETTE_AT = 20;
/** `$84:869D`: the switches' colours alternate every 4 frames. */
export const SWITCH_COLOUR_FRAMES = 4;

/**
 * The `switches` step entry. Null unless the water switch flipped, which
 * blocks the step for the dissolve (the stall runner calls tickWaterSwitch).
 */
export function switchEffects(world: World, w: BallWorkFields): { kind: 'waterSwitch'; frames: number; state: number } | null {
  if (w.switchFlip !== 0) {
    w.switchFlip = 0;
    emitEvent(world, 'switch', SWITCH_SFX); // inline, $80:B542
  }
  if (w.waterSwitch === 0) return null;
  w.waterSwitch = 0;
  if (w.waterSquash !== 0) {
    // $82:A41A-$82:A426: $6A6E = $DA04, Kirby's state $0C, before the block
    w.waterSquash = 0;
    const e = activePlayer(world);
    e.set(Pose, { ...e.get(Pose)!, state: PoseState.Squash, variant: w.lock6a6e, timer: 0 });
  }
  // $82:A466-$82:A470: the switch's tiles ($80:D7B5 2) and $6A; ($17FF: 2P only);
  // $82:A4E2-$82:A4ED: $4A with the water now off, else $4B
  emitEvent(world, 'switch', WATER_SWITCH_SFX);
  emitEvent(world, 'switch', w.waterOff !== 0 ? WATER_OFF_SFX : WATER_ON_SFX);
  // $80:9120: the buffer from the tiles (going) or zeroes (coming)
  world.get(Switches)!.dissolve = { step: 0, appear: w.waterOff !== 0 ? 0 : 1 };
  return { kind: 'waterSwitch', frames: DISSOLVE_STEPS, state: 0 };
}

/** One frame of the water switch's block: a dissolve step, and Kirby's set 3 after the 20th. */
export function tickWaterSwitch(world: World, ctx: Ctx): void {
  const d = world.get(Switches)!.dissolve;
  if (d.step >= DISSOLVE_STEPS) return;
  d.step += 1;
  if (d.step === DISSOLVE_PALETTE_AT) {
    const e = activePlayer(world);
    restoreKirbyColours(world, ctx, e.get(BallWet)!.wet); // $80:D2FE 3 (4 for player 2, $180D)
  }
}

/** The hole's start: the objects `$82:BBAE` and `$82:BC59` spawn by the layer-2 counts. */
export function resetSwitches(world: World, layer2: Uint8Array, w: BallWorkFields): void {
  const s = world.get(Switches)!;
  s.anims = [];
  for (let pair = 0; pair < 6; pair++) {
    const a = 0x70 + 2 * pair;
    if (!layer2.some((t) => t === a || t === a + 1)) continue;
    // $82:BBF3: $539C = $00 for the first spawned, $14 for the rest; $541C
    // = $FFFF and $549C = 1 from the init ($84:DB6A)
    s.anims.push({ pair, list: s.anims.length === 0 ? 0 : 1, frame: -1, wait: 1 });
  }
  const has = (a: number): boolean => layer2.some((t) => t === a || t === a + 1);
  s.toggle = has(0x5a) ? freshColours(w.toggleOn) : null;
  s.water = has(0x5c) ? freshColours(w.waterOff) : null;
  s.dissolve = { step: DISSOLVE_STEPS, appear: w.waterOff !== 0 ? 0 : 1 };
  s.rippleTicks = 0;
}

/** The thread's first run: set 0 on the hook's next tick. */
function freshColours(on: number): SwitchColours {
  return { on, next: 0, wait: 1, shown: -1 };
}

/**
 * The thread tick's part: each object's thread then its hook, as the
 * scheduler runs them (web_sw_switch_roll: the flip and object 117's set 0
 * in the same iteration, 2494).
 */
export function tickSwitches(world: World, ctx: Ctx): void {
  const e = findActivePlayer(world);
  if (!e) return;
  const w = e.get(BallWork)!;
  const s = world.get(Switches)!;
  for (const a of s.anims) tickSwirlAnim(ctx, a, w.toggleOn);
  if (s.toggle) tickColours(s.toggle, w.toggleOn);
  if (s.water) tickColours(s.water, w.waterOff);
  if (w.waterOff === 0) s.rippleTicks += 1; // $84:8533: LDA $69CA / BNE (the hook's countdown held)
}

/**
 * Object 127's hook (`$84:DB97`, by its variant `$531C` = 2 x pair): pairs 0
 * and 1 always, 2 and 3 while `$6A2A` is set, 4 and 5 while it is clear;
 * the even pairs wait 4 frames a frame (`$84:DC42`), the odd 6 (`$84:DC4D`),
 * ten frames in a loop. A frame's upload is record `$84:DC58`[frame + 10 x
 * list].
 */
function tickSwirlAnim(ctx: Ctx, a: SwirlAnim, toggleOn: number): void {
  const group = a.pair >> 1;
  if (group === 1 && toggleOn === 0) return;
  if (group === 2 && toggleOn !== 0) return;
  a.wait -= 1;
  if (a.wait !== 0) return;
  // the two $FF-ended lists, $84:DC42 (ten 4s) and $84:DC4D (ten 6s), one table
  const waits = ctx.rules.table('swirlWaits');
  const base = (a.pair & 1) === 0 ? 0 : SWIRL_LIST2;
  a.frame += 1;
  let n = waits[base + a.frame];
  if (n === 0xff) {
    a.frame = 0;
    n = waits[base];
  }
  a.wait = n;
}

/** `$84:DC4D` - `$84:DC42`: where the second wait list starts. */
const SWIRL_LIST2 = 11;

/** Objects 117/118: the thread resets on a change of state, then the hook. */
function tickColours(c: SwitchColours, on: number): void {
  if (on !== c.on) {
    // $84:8612 / $84:862E: STZ $531C, $539C = 1, the other base
    c.on = on;
    c.next = 0;
    c.wait = 1;
  }
  c.wait -= 1; // $84:869D
  if (c.wait !== 0) return;
  c.wait = SWITCH_COLOUR_FRAMES;
  c.shown = c.next;
  c.next ^= 1;
}
