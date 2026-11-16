/**
 * The water's thread objects (read 2026-11-15; docs/animation.md "The
 * water's objects", notes/port-v2-phase4-water.md). Pure: the system
 * (systems/water-fx.ts) feeds them Kirby and keeps the runs in the `WaterFx`
 * trait; the view (game/features/env/water-fx-view.ts) draws them.
 *
 * The splashes 53-58 (`$85:8E5A`-`$85:8FFB`, list 6, frame table `$89:94DB`)
 * are straight lines: at their first run they take Kirby's OAM queue (53 one
 * further back) and his projected point (`$091E,X`/`$093E,X`), then show a
 * few frames and end. 57 is 56 that first spawns a 58 at the same point.
 * tables.json `waterFx` holds them as ops (tools/export_web.py
 * `water_fx_scripts`).
 *
 * Object 67 (`$85:E76B`) is a bubble emitter, two per entry into the water
 * (`$82:85DD`, `$539C` = 4 and 12). After that first wait it loops while
 * the ball is in the water (its hook `$85:E836` sets `$549C` once the
 * block's `$D872` is clear; the loop tests it at the top):
 *
 *     frozen water or no tomatoes: wait 1 tick
 *     Kirby standing ($D842): a bubble at his point + the facing's offset
 *     the ball airborne: wait 1 tick
 *     else: a bubble at the ball
 *
 * A bubble (`$85:E8FC`) is the slot itself: a random offset (`$80:87DD`
 * & 7, `$85:EA2F`), then the rise script (`$85:E934`: velocities and frames
 * of `$89:952B`, then hidden), then a random wait (`$85:E800`, the waits
 * `$85:E87D` read at an index x 2 that runs into the code after the table)
 * before the loop's next turn. The default draw routine (`$80:E55A`, from
 * `$80:E4F2`) integrates the velocity every tick, y then x; the fractions
 * carry from one bubble to the next.
 */
import type { RomRules } from '../rules';
import { wrap16 } from '../fixed';
import { rngNext, type RngState } from './rng';

/** One splash (objects 53-58). */
export interface SplashRun {
  type: number;
  /** The next op in tables.json `waterFx`. */
  pc: number;
  frame: number; // $5D9C, -1 hidden
  /** $5E9C - Kirby's $0B1E,X at the first run: 0, or 1 (53's INC A, 54's INC $5E9C). */
  queueAdd: number;
  x: number; y: number; // $5F1C / $5F9C
  wait: number; // $529C
  started: boolean;
  age: number;
  done: boolean;
}

/** One object 67. */
export interface BubbleRun {
  /** $539C: the wait before the first turn (4 or 12). */
  first: number;
  wait: number; // $529C
  /** Where the thread resumes: 'first' (the first wait's end), 'loop' (`$85:E78D`), 'rise', 'pause' (the random wait's end). */
  at: 'start' | 'first' | 'loop' | 'rise' | 'pause';
  /** The hook is installed after the first wait ($85:E772). */
  hooked: boolean;
  exit: number; // $549C
  toggle: number; // $541C
  pc: number; // the rise script's next op
  frame: number; // $5D9C
  queue: number; // $5E9C, absolute (the view sorts against Kirby's)
  x: number; xf: number; // $5F1C / $601C
  y: number; yf: number; // $5F9C / $609C
  vx: number; vxf: number; // $611C / $621C
  vy: number; vyf: number; // $619C / $629C
  age: number;
  done: boolean;
}

/** What the objects read of Kirby and the ball at their tick. */
export interface FxSource {
  /** $091E,X / $093E,X: his projected point in bitmap pixels. */
  x: number;
  y: number;
  /** $0B1E,X: his OAM queue. */
  queue: number;
  /** $D872,X: the ball in the water (the block's). */
  wet: number;
  /** $69DA: the water iced. */
  frozen: number;
  /** $D7F0,X: the tomatoes. */
  tomatoes: number;
  /** $D842,X: Kirby standing, from the set-up to the roll ($80:C679, $82:C282). */
  standing: boolean;
  /** $D7C4,X: his facing, 0-7. */
  facing: number;
  /** $D8A6,X: the ball airborne. */
  air: number;
}

export function spawnSplash(rules: RomRules, type: number): SplashRun {
  const ops = rules.table('waterFx');
  const at = ops[type - 53];
  return {
    type, pc: at + 2, frame: -1, queueAdd: ops[at], x: 0, y: 0,
    wait: 0, started: false, age: 0, done: false,
  };
}

/**
 * One scheduler tick of a splash: its thread when due. Returns the object
 * it spawned (57's 58), which runs in the same tick.
 */
export function tickSplash(rules: RomRules, s: SplashRun, src: FxSource): SplashRun | null {
  if (s.done) return null;
  s.age += 1;
  s.wait -= 1;
  if (s.wait >= 0) return null;
  const ops = rules.table('waterFx');
  let spawned: SplashRun | null = null;
  if (!s.started) {
    s.started = true;
    s.x = src.x & 0xffff;
    s.y = src.y & 0xffff;
  }
  for (;;) {
    switch (ops[s.pc]) {
      case 1: s.frame = ops[s.pc + 1]; s.pc += 2; break;
      case 2: s.frame += 1; s.pc += 1; break;
      case 3: s.queueAdd += 1; s.pc += 1; break;
      case 4: s.wait = ops[s.pc + 1]; s.pc += 2; return spawned;
      case 6: spawned = spawnSplash(rules, ops[s.pc + 1]); s.pc += 2; break;
      default: s.done = true; return spawned;
    }
  }
}

export function spawnBubbles(): BubbleRun[] {
  return [4, 12].map((first) => ({
    first, wait: 0, at: 'start' as const, hooked: false, exit: 0, toggle: 0, pc: 0,
    frame: -1, queue: 0, x: 0, xf: 0, y: 0, yf: 0, vx: 0, vxf: 0, vy: 0, vyf: 0,
    age: 0, done: false,
  }));
}

/**
 * One scheduler tick of object 67: the thread when due, then its hook and
 * the draw routine's motion (not on the exit tick).
 */
export function tickBubble(rules: RomRules, rng: RngState, b: BubbleRun, src: FxSource, between?: (b: BubbleRun) => void): void {
  if (b.done) return;
  b.age += 1;
  b.wait -= 1;
  if (b.wait < 0) runBubble(rules, rng, b, src);
  if (b.done) return;
  between?.(b);
  if (b.hooked && src.wet === 0) b.exit = 1; // $85:E836
  move(b);
}

function runBubble(rules: RomRules, rng: RngState, b: BubbleRun, src: FxSource): void {
  for (;;) {
    switch (b.at) {
      case 'start':
        b.wait = b.first; // $85:E76B: LDA $539C,Y / yield
        b.at = 'first';
        return;
      case 'first':
        b.hooked = true; // $85:E772-$85:E78A
        b.toggle = 0;
        b.exit = 0;
        b.at = 'loop';
        break;
      case 'loop': {
        // $85:E78D
        if (b.exit !== 0) {
          b.done = true; // $85:E7FA
          return;
        }
        if ((src.frozen & src.wet) !== 0 || src.tomatoes === 0) {
          b.wait = 0; // $85:E7F1: yield 0
          return;
        }
        let dx = 0;
        let dy = 0;
        let queue = src.queue;
        if (src.standing) {
          const f = src.facing & 7;
          dx = rules.table('bubbleFacingDx')[f];
          dy = rules.table('bubbleFacingDy')[f];
          queue = wrap16(rules.table('bubbleFacingQueue')[f] + src.queue); // $85:E7C7
        } else if (src.air !== 0) {
          b.wait = 0;
          return;
        }
        // $85:E8FC: a random offset, then the rise
        const r = rngNext(rng) & 7;
        const ox = rules.table('bubbleOffset')[2 * r];
        const oy = rules.table('bubbleOffset')[2 * r + 1];
        b.x = add3(ox, src.x, dx);
        b.y = add3(oy, src.y, dy);
        b.queue = queue;
        b.pc = rules.table('waterFx')[6]; // the rise, after the six splashes
        b.at = 'rise';
        break;
      }
      case 'rise': {
        const ops = rules.table('waterFx');
        for (;;) {
          const op = ops[b.pc];
          if (op === 1) { b.frame = ops[b.pc + 1]; b.pc += 2; continue; }
          if (op === 5) {
            const v = ops[b.pc + 2];
            switch (ops[b.pc + 1]) {
              case 0: b.vx = v; break;
              case 1: b.vxf = v; break;
              case 2: b.vy = v; break;
              default: b.vyf = v;
            }
            b.pc += 3;
            continue;
          }
          if (op === 4) { b.wait = ops[b.pc + 1]; b.pc += 2; return; }
          break; // 7: the continuation ($85:E7EF -> $85:E800)
        }
        // $85:E800: the random wait
        const r = rngNext(rng) & 7;
        b.toggle ^= 1;
        const i = rules.table('bubbleWaitIndex')[r] * 2 + 6 * b.toggle; // $4202: $541C x 6
        b.wait = rules.table('bubbleWait')[i];
        b.at = 'pause';
        return;
      }
      case 'pause':
        b.at = 'loop'; // JMP $85:E78D
        break;
    }
  }
}

/** `CLC / ADC m / ADC n`: the second add takes the first's carry. */
function add3(a: number, m: number, n: number): number {
  const t = (a & 0xffff) + (m & 0xffff);
  return (t + (n & 0xffff) + (t > 0xffff ? 1 : 0)) & 0xffff;
}

/** `$80:E55A` -> `$80:E5E2`: y += v, then x, 16.16. */
function move(b: BubbleRun): void {
  const y = b.yf + (b.vyf & 0xffff);
  b.yf = y & 0xffff;
  b.y = (b.y + b.vy + (y >> 16)) & 0xffff;
  const x = b.xf + (b.vxf & 0xffff);
  b.xf = x & 0xffff;
  b.x = (b.x + b.vx + (x >> 16)) & 0xffff;
}
