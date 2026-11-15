/**
 * Kirby's colours: OBJ palette 0's colours 2-8 (CGRAM 130-136, the shadow
 * `$0504`-`$0510`), as the copy abilities, the water and the HUD write them
 * (notes/port-v2-phase5-abilities.md "Kirby's colours"). Pure: the system
 * (systems/ability-fx.ts) runs them in the thread tick, in the scheduler's
 * order; the view (game/features/kirby/kirby-view.ts) recolours his frames.
 *
 * Colour 7 is his outline. The HUD object's draw (`$84:99FA`, list 4's first
 * object in 1P) rewrites it every tick: the 42-tick green flash while B is
 * available, else `$0C63`. A writer later in the same tick (Kirby's script,
 * Spark's object 36) wins until the next tick.
 *
 * The sets (tables.json, player 1's; tools/export_web.py):
 * - set 3 (`$80:D3AD`): `kirbyDry` `$98:C77A`, or `kirbyWet` `$98:C796` in the water;
 * - Fireball's set 5 (`$82:CA43` -> `$80:D3DB`): `kirbyFire`, colours 2-7;
 * - object 29's six fades at Fireball's end (`$85:80F4`): `kirbyBurnt`, 2-7;
 * - object 36's four sets while Spark is on (`$85:86B1`): `kirbySpark`, 2-8;
 *   `kirbySparkStand` once Kirby stands;
 * - state 36's script (Freeze, `$87:8301`): `kirbyFreeze`, 2-7;
 * - the transformation's script (state 8): `kirbyFlash` (2-6 black);
 * - object 50 while the UFO flies (`$84:89D7`): `kirbyUfo` 2-5, its light
 *   (colour 6) cycling, and the warning's sets as the countdown runs out.
 */
import type { RomRules } from '../rules';

/** Colours 2-8: the array's index of colour n is n - 2. */
export const FIRST_COLOUR = 2;
export const OUTLINE = 7;
/** The outline's resting colour ($98:D4A8[0]). */
export const OUTLINE_REST = 0x0c63;

/** Write `words` from colour `from` on. */
export function writeColours(colours: number[], from: number, words: ArrayLike<number>): void {
  for (let i = 0; i < words.length && from - FIRST_COLOUR + i < colours.length; i++) colours[from - FIRST_COLOUR + i] = words[i];
}

/** Set 3 (`$80:D3AD`): dry, or wet when the block's `$D872` is set. */
export function set3(rules: RomRules, wet: number): number[] {
  return Array.from(rules.table(wet !== 0 ? 'kirbyWet' : 'kirbyDry'));
}

/** The copy abilities by number whose transformation's second half comes early. */
const SECOND_HALF: Record<number, number> = { 7: 28, 10: 24 };

/**
 * The transformation's script (state 8, `$87:82D3`/`$87:832D` and the
 * ability's arm): on its tick k (1 the first), a write of Kirby's colours or
 * null. Black at 4, set 3 at 8, black at 12; then the ability's second set,
 * black, the second set again, 4 ticks apart from 36 (Spark 28, the UFO 24;
 * measured on demos 10-19 and web_ab_c1, every activation). The second set
 * is set 3, but Spark's first (`kirbySpark`) and Freeze's (`kirbyFreeze`).
 */
export function transformFlash(rules: RomRules, ability: number, k: number): { from: number; words: ArrayLike<number> } | null {
  const black = { from: 2, words: rules.table('kirbyFlash') };
  if (k === 4 || k === 12) return black;
  if (k === 8) return { from: 2, words: rules.table('kirbyDry') };
  const s = SECOND_HALF[ability] ?? 36;
  if (k === s + 4) return black;
  if (k === s || k === s + 8) {
    if (ability === 7) return { from: 2, words: rules.table('kirbySpark').slice(0, 7) };
    if (ability === 9) return { from: 2, words: rules.table('kirbyFreeze') };
    return { from: 2, words: rules.table('kirbyDry') };
  }
  return null;
}

/** What the HUD's draw reads ($84:99FA, player 1). */
export interface HudSource {
  stock: number; // $D852
  latch: number; // $D85E, signed
  lost: number; // $D876
  wet: number; // $D872
  state: number; // $D7D4
}

/** B is available: the outline flashes and the icon's ground cycles. */
export function abilityReady(h: HudSource): boolean {
  return h.stock !== 0 && h.latch >= 0;
}

/**
 * The HUD's draw, its colour writes: the outline (colour 7) by the phase
 * `$5B1C` when B is available, Kirby is dry, not fallen and in neither state
 * 10 nor 11 (else the table's first, `$0C63`); then the phase steps, back to
 * 0 when the table's word there is negative (`$84:9A7D` LDA / BPL, 16-bit:
 * the next byte is the `$FF`), so the cycle is 41 ticks (demo 10: 40 -> 0).
 * Returns the colour and the next phase.
 */
export function hudOutline(rules: RomRules, h: HudSource, phase: number): { colour: number; phase: number } {
  const table = rules.table('outlinePhase');
  const on = abilityReady(h) && h.lost !== 0x8000 && h.wet === 0 && h.state !== 10 && h.state !== 11;
  const colour = rules.table('outlineColour')[table[on ? phase : 0]];
  let next = phase + 1;
  if ((table[next + 1] ?? 0xff) >= 0x80) next = 0;
  return { colour, phase: next };
}

/** The icon's ground (colour 9 of OBJ palette 1): red unless B is available, else the 32-tick cycle. */
export function hudIconGround(rules: RomRules, h: HudSource, phase: number): { colour: number; phase: number } {
  const table = rules.table('iconPhase');
  const colour = rules.table('iconGround')[table[abilityReady(h) ? phase : 0]];
  let next = phase + 1;
  if (table[next] === 0xff) next = 0;
  return { colour, phase: next };
}

/** Object 29 (`$85:80F4`): the burnt fade after Fireball's end. */
export interface BurntRun {
  /** The fade written last (0-5). */
  step: number;
  wait: number;
  done: boolean;
}

/** Its first tick: fade 0, then 30 ticks; fades 1-5 every 4; the end. Returns a write or null. */
export function tickBurnt(rules: RomRules, b: BurntRun, d76c: number, wet: number): { from: number; words: ArrayLike<number> } | null {
  if (b.done) return null;
  if (d76c !== 0) {
    b.done = true; // $85:815F: the set back ($80:D2FE A = 3)
    return { from: 2, words: set3(rules, wet) };
  }
  b.wait -= 1;
  if (b.wait >= 0) return null;
  b.step += 1;
  if (b.step > 5) {
    b.done = true;
    return null;
  }
  b.wait = b.step === 0 ? 0x1d : 3;
  return { from: 2, words: rules.table('kirbyBurnt').slice(6 * b.step, 6 * b.step + 6) };
}

export function spawnBurnt(): BurntRun {
  return { step: -1, wait: 0, done: false };
}

/** Object 36 (`$85:86B1`): Spark's colours. */
export interface SparkPalRun {
  phase: number; // $539C
  counter: number; // $551C
  done: boolean;
}

export function spawnSparkPal(): SparkPalRun {
  return { phase: 0, counter: 1, done: false };
}

/**
 * One tick: the set back and the end on `$D76C`; Kirby standing, the four
 * sets of the second table at once, the set back, the end; else every 2
 * ticks the next of the four sets (`$85:8751`, from the spawn tick).
 */
export function tickSparkPal(rules: RomRules, s: SparkPalRun, d76c: number, standing: boolean, wet: number, colours: number[]): void {
  if (s.done) return;
  if (d76c !== 0) {
    writeColours(colours, 2, set3(rules, wet)); // $80:C958
    s.done = true;
    return;
  }
  if (standing) {
    // $85:86D2: the second table's four sets in one tick, then set 3 ($85:8724)
    writeColours(colours, 2, set3(rules, wet));
    s.done = true;
    return;
  }
  s.counter -= 1;
  if (s.counter !== 0) return;
  s.counter = 2;
  writeColours(colours, 2, rules.table('kirbySpark').slice(7 * s.phase, 7 * s.phase + 7));
  s.phase = (s.phase + 1) & 3;
}

/** Object 50 (`$84:89D7`): the UFO's colours. */
export interface UfoPalRun {
  started: boolean;
  /** `$571C`: the `$D77A` its light last saw. */
  seen: number;
  /** `$559C` / `$551C`: the light's timer and index. */
  lightTimer: number;
  lightIdx: number;
  lightStopped: boolean;
  /** The warning ($579C = 2): its stage s (2, 1, 0), `$569C` the stage's ticks left, `$539C`, `$531C`. */
  warn: { s: number; left: number; timer: number; set: number } | null;
  /** Loop D left for good: the warning done, or `$D77A` set. */
  idle: boolean;
  done: boolean;
}

export function spawnUfoPal(): UfoPalRun {
  return { started: false, seen: 0xffff, lightTimer: 0, lightIdx: 0, lightStopped: false, warn: null, idle: false, done: false };
}

/** What object 50 reads. */
export interface UfoPalSource {
  mode: number; // $D85A
  d76c: number;
  d77a: number; // the UFO's phase: 0 flying, 1 (the end, $82:D2E6), 2 wearing off
  d776: number; // its countdown (600 at the setup)
  wet: number;
}

/**
 * One tick, in the slot's order: the thread (the spawn's colours 2-5, or the
 * exit test `$84:8AC2` and loop D: the warning once `$D776` < `$EF`, its
 * three stages' lengths `ufoWarnTicks`, then the end set; idle once `$D77A`
 * is set), the per-frame warning (`$84:8AFB`: colours 2-5 from the stage's
 * sets every `ufoWarnPeriod` ticks), the draw (`$84:8B59`: colour 6, the
 * light, restarted on a `$D77A` change: cycling every `ufoLightTicks` ticks,
 * or the one-shot `kirbyUfoLightEnd` run while it wears off).
 */
export function tickUfoPal(rules: RomRules, u: UfoPalRun, src: UfoPalSource, colours: number[]): void {
  if (u.done) return;
  if (!u.started) {
    u.started = true;
    writeColours(colours, 2, rules.table('kirbyUfo'));
  } else {
    if (src.mode !== 0x0a || src.d76c !== 0) {
      writeColours(colours, 2, set3(rules, src.wet)); // $84:8AEA: $80:D2FE A = 3
      u.done = true;
      return;
    }
    if (u.warn !== null) {
      u.warn.left -= 1;
      if (u.warn.left <= 0) {
        if (u.warn.s === 0) {
          u.warn = null;
          u.idle = true;
          writeColours(colours, 2, rules.table('kirbyUfoWarnEnd'));
        } else {
          const s = u.warn.s - 1;
          u.warn = { s, left: rules.table('ufoWarnTicks')[s], timer: 1, set: 0 };
        }
      }
    } else if (!u.idle) {
      if (src.d77a !== 0) u.idle = true;
      else if (src.d776 < 0xef) u.warn = { s: 2, left: rules.table('ufoWarnTicks')[2], timer: 1, set: 0 };
    }
  }
  if (u.warn !== null) {
    const w = u.warn;
    w.timer -= 1;
    if (w.timer === 0) {
      w.timer = rules.table('ufoWarnPeriod')[w.s];
      w.set = (w.set + 1) % rules.table('ufoWarnSets')[w.s];
      const sets = rules.table(`kirbyUfoWarn${w.s}`);
      writeColours(colours, 2, sets.slice(4 * w.set, 4 * w.set + 4));
    }
  }
  if (src.d77a !== u.seen) {
    u.seen = src.d77a;
    u.lightTimer = 1;
    u.lightIdx = 0;
    u.lightStopped = false;
  }
  if (u.lightStopped) return;
  u.lightTimer -= 1;
  if (u.lightTimer !== 0) return;
  if (src.d77a === 2) {
    const t = rules.table('ufoLightEndTicks')[u.lightIdx];
    if (t === 0) {
      u.lightStopped = true;
      return;
    }
    colours[6 - FIRST_COLOUR] = rules.table('kirbyUfoLightEnd')[u.lightIdx];
    u.lightTimer = t;
    u.lightIdx += 1;
  } else {
    u.lightTimer = rules.table('ufoLightTicks')[src.d77a & 1];
    u.lightIdx = (u.lightIdx + 1) % 3;
    colours[6 - FIRST_COLOUR] = rules.table('kirbyUfoLight')[u.lightIdx];
  }
}
