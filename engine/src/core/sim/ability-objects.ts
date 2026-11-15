/**
 * The copy abilities' drawn objects (notes/port-v2-phase5-abilities.md
 * "The objects"; the threads of banks $84/$85). Pure: the system
 * (systems/ability-fx.ts) spawns them from the abilities' facts and ticks
 * them in the thread tick, list 4's before list 6's; the view
 * (game/features/env/ability-fx-view.ts) draws them from objects.json.
 *
 * Every object is a slot: a frame index (`$5D9C`, -1 hidden), a point in
 * the bitmap's draw space (`$5F1C`/`$5F9C`), its OAM queue against Kirby's
 * (0 his, 1 one further back: behind him), a wait (`$529C`) and a velocity
 * the default draw routine (`$80:E55A`) adds every tick, y then x. Kirby's
 * point (`$091E,X`/`$093E,X`) is read where the thread or its per-frame
 * handler reads it. The random offsets draw on the game's numbers
 * (`$80:87DD`, sim/rng.ts): Stone's dust, Fireball's smoke, Hi-Jump's
 * trail, Spark's sparks.
 *
 *   21  the transformation (`$84:C928`): at Kirby's point as of the last
 *       store (`$D972`/`$D97A`: the iteration's before, demo 10 2017 at
 *       2016's), the point the step's trigger sees; frames 5 4 0 1 2 3 0 1 2 3 4 5, 4 ticks each, then gone
 *   27  Freeze's frost (`$85:851D`): frames 0-4, 2 ticks each, forever, on
 *       Kirby; gone when holed or on `$D76C`
 *   28  Stone's landing dust (`$85:8000`): four times two random points
 *       near Kirby, frame 0 at each, then 2 and 1 (3 ticks each)
 *   30  Fireball's smoke (`$85:819B`, never drawn): object 31 at random
 *       points: 12 every 3 ticks, 4 every 4, 2 every 5, 2 every 6
 *   31  a puff of it (`$85:8273`): frames 0-3, 2 ticks each, where spawned
 *   32  Fireball's flames, four (`$85:8327`): after 7, 5, 3, 1 ticks, a
 *       10-tick cycle (frames 0-3, 2 ticks each, then 2 hidden) at Kirby's
 *       point of the cycle's start, one queue back unless heading 90-179;
 *       gone when the mode is not 3 or on `$D76C`
 *   33  Tornado's whirl (`$85:83F0`): frames 0-3, 4 ticks each, forever,
 *       on Kirby; gone when the mode is not 5, Kirby stands or `$D76C`
 *   35  Hi-Jump's trail, six (`$85:85AF`): after 21, 17, ... 1 ticks a star
 *       at a random point under Kirby, drifting by the heading's x speed
 *       and down 1 a tick: frames 2, 1, 0, 4 ticks each
 *   37  Spark's aura (`$85:878A`): frames 1-7 then 0, 2 ticks each, on
 *       Kirby 6 up; 38 (`$85:8855`, never drawn) every 8 ticks four 39s at
 *       random points; 39 (`$85:890D`) frames 0, 1, 0 for 2, 3, 2 ticks.
 *       Gone when Kirby stands, is holed, or on `$D76C`
 *   52  the parasol's puff (`$85:B202` with `$531C` = 1): frames 0-3 for
 *       4, 2, 2, 2 ticks where the parasol was (its `$531C` = 0 run, at the
 *       transformation, draws nothing of its own)
 *   65  Wheel's splash on the water (`$85:8FFC`): frames 0-2, 2 ticks each
 *   66  Wheel riding the water (`$85:9045`): frames 0-2, 2 ticks each,
 *       forever, on Kirby; gone when the mode is not 6 or the ride ends
 */
import type { RomRules } from '../rules';
import { rngNext, type RngState } from './rng';

export interface AbilityObject {
  type: number;
  /** `$531C`: the spawn's argument (32's and 35's stagger, 52's kind). */
  arg: number;
  frame: number;
  x: number; xf: number;
  y: number; yf: number;
  vx: number; vxf: number;
  vy: number; vyf: number;
  queueAdd: number;
  wait: number;
  /** Where the thread is (per type). */
  step: number;
  /** Per-type scratch: 28's points, 30's stage and count. */
  a: number; b: number; c: number; d: number;
  started: boolean;
  done: boolean;
}

/** What the objects read of Kirby and the block between iterations. */
export interface ObjectSource {
  /** Kirby's point now ($091E,X / $093E,X). */
  x: number; y: number;
  d76c: number;
  mode: number; // $D85A
  standing: boolean; // $D842 (& $D844 in 1P)
  holed: number; // $D956
  heading: number; // $D9DA, degrees
  abilityDir: number; // $D75E
  ride: number; // $69D8
}

export function spawnObject(type: number, arg = 0, at?: { x: number; y: number }): AbilityObject {
  return {
    type, arg, frame: -1, x: at?.x ?? 0, xf: 0, y: at?.y ?? 0, yf: 0, vx: 0, vxf: 0, vy: 0, vyf: 0,
    queueAdd: 0, wait: 0, step: 0, a: 0, b: 0, c: 0, d: 0, started: false, done: false,
  };
}

/** The list (`$80:ED3A` / 2) an object type runs in: 6 or 4. */
export function objectList(type: number): number {
  return type === 0x23 || type === 0x31 || type === 0x32 || type === 0x33 || type === 0x3c || type === 0x41 || type === 0x42 ? 6 : 4;
}

const TRANSFORM_FRAMES = [5, 4, 0, 1, 2, 3, 0, 1, 2, 3, 4, 5];
const DUST_DY = [-2, -1, 0, 1, 2, -2, -1, 0, 1, 2, -2, -1, 0, 1, 2, -2];
const DUST_DX = [-16, -14, -12, -10, -8, -6, -4, -2, 2, 4, 6, 8, 10, 12, 14, 16];
const SMOKE_DY = [0, 1, 2, 4, -6, -4, -3, -1, 0, -5, 6, 5, 2, -1, 0, -3];
const SMOKE_DX = [-6, -4, -3, -2, 0, 1, 3, 5, -5, 2, -1, 4, 0, 5, -3, -1];
const SMOKE_STAGES: Array<[number, number]> = [[22, 2], [9, 3], [4, 4], [5, 5]];
const TRAIL_V = [0xff80, 0xff00, 0xfe80, 0xfe80, 0xff00, 0xff80, 0x0000, 0x0080, 0x0080, 0x0100, 0x0180, 0x0180, 0x0100, 0x0080, 0x0000, 0xff80];
const TRAIL_DY = [0, 4, -6, -2, 1, -4, 3, -5, 5, -1, 6, 0, 4, -3, 6, -5];
const TRAIL_DX = [5, -1, -3, 0, -6, 4, 2, -3, 0, -5, 1, 6, -2, 3, -4, 5];
const SPARK_DY = [0, -4, 8, -6, 10, -10, 2, 6, -8, -2, 0, 8, 4, -8, 6, -10];
const SPARK_DX = [-6, 8, -2, 10, 0, -8, 4, -10, 2, -10, 6, 0, -8, -4, 8, -6];

const w16 = (v: number): number => v & 0xffff;

/** A script of [frame, ticks]: shows each in turn, then the object is gone (`loop`: from the start again). */
function play(o: AbilityObject, script: ReadonlyArray<readonly [number, number]>, loop = false): void {
  if (o.step >= script.length) {
    if (!loop) {
      o.done = true;
      return;
    }
    o.step = 0;
  }
  const [frame, ticks] = script[o.step++];
  o.frame = frame;
  o.wait = ticks - 1;
}

const cycle = (frames: number[], ticks: number): Array<[number, number]> => frames.map((f) => [f, ticks]);

/**
 * One tick of an object: its thread when due, then its per-frame handler,
 * then the default draw's motion. Returns the objects it spawned (they run
 * in this tick when they share its list: the caller ticks them).
 */
export function tickObject(rules: RomRules, rng: RngState, o: AbilityObject, src: ObjectSource): AbilityObject[] {
  if (o.done) return [];
  const born: AbilityObject[] = [];
  const point = (dx: number, dy: number): void => {
    o.x = w16(src.x + dx);
    o.y = w16(src.y + dy);
  };
  void rules;
  o.wait -= 1;
  const due = o.wait < 0;
  switch (o.type) {
    case 0x15: // 21 (its point is the spawn's)
      if (due) play(o, TRANSFORM_FRAMES.map((f) => [f, 4] as const));
      break;
    case 0x1b: // 27
      if (src.holed !== 0 || src.d76c !== 0) {
        o.done = true;
        return [];
      }
      if (due) play(o, cycle([0, 1, 2, 3, 4], 2), true);
      point(0, 0);
      break;
    case 0x1c: // 28
      if (due) {
        // four times: P1 frame 0, P2 frame 0, P1 frame 2, P2 frame 1, 3 ticks each
        if (o.step >= 16) {
          o.done = true;
          return [];
        }
        const k = o.step & 3;
        const at = (): [number, number] => {
          const r = rngNext(rng) & 15;
          return [w16(src.x + DUST_DX[r]), w16(src.y + DUST_DY[r])];
        };
        if (k === 0) [o.a, o.b] = at();
        if (k === 1) [o.c, o.d] = at();
        const p1 = k === 0 || k === 2;
        o.x = p1 ? o.a : o.c;
        o.y = p1 ? o.b : o.d;
        o.frame = [0, 0, 2, 1][k];
        o.wait = 2;
        o.step += 1;
      }
      break;
    case 0x1e: // 30
      if (src.d76c !== 0) {
        o.done = true;
        return [];
      }
      if (due) {
        if (!o.started) {
          o.started = true;
          o.a = 0; // the stage
          o.b = SMOKE_STAGES[0][0]; // its count
        }
        for (;;) {
          if (o.a >= SMOKE_STAGES.length) {
            o.done = true;
            return born;
          }
          const [, period] = SMOKE_STAGES[o.a];
          if (o.b >= 0) {
            const r = rngNext(rng) & 15;
            born.push(spawnObject(0x1f, 0, { x: w16(src.x + SMOKE_DX[r]), y: w16(src.y - 6 + SMOKE_DY[r]) }));
            o.wait = period;
            o.b -= period;
            break;
          }
          o.a += 1;
          if (o.a < SMOKE_STAGES.length) o.b = SMOKE_STAGES[o.a][0];
        }
      }
      break;
    case 0x1f: // 31
      if (due) play(o, cycle([0, 1, 2, 3], 2));
      break;
    case 0x20: // 32
      if (src.mode !== 3 || src.d76c !== 0) {
        o.done = true;
        return [];
      }
      if (!o.started) {
        o.started = true;
        o.queueAdd = src.heading >= 90 && src.heading < 180 ? 0 : 1; // $85:83A9
        o.wait = o.arg; // yield $531C: 7, 5, 3, 1 ticks
        break;
      }
      if (due) {
        if (o.step % 5 === 0) point(0, 0); // Kirby's point once a cycle
        play(o, [[0, 2], [1, 2], [2, 2], [3, 2], [-1, 2]], true);
      }
      break;
    case 0x21: // 33
      if (src.mode !== 5 || src.standing || src.d76c !== 0) {
        o.done = true;
        return [];
      }
      if (due) play(o, cycle([0, 1, 2, 3], 4), true);
      point(0, 0);
      break;
    case 0x23: // 35
      if (!o.started) {
        o.started = true;
        o.wait = o.arg; // yield $531C: 21, 17, ... 1 ticks
        break;
      }
      if (due) {
        if (o.step === 0) {
          const v = TRAIL_V[src.abilityDir & 15];
          o.vx = (v << 16) >> 24; // $611C: the high byte, signed
          o.vxf = (v & 0xff) << 8; // $621C
          const r = rngNext(rng) & 15;
          point(TRAIL_DX[r], 3 + TRAIL_DY[r]);
          o.vy = 1;
          o.vyf = 0;
        }
        play(o, [[2, 4], [1, 4], [0, 4]]);
      }
      if (!o.done && o.step > 0) move(o);
      break;
    case 0x25: // 37
      if (src.standing || src.holed !== 0 || src.d76c !== 0) {
        o.done = true;
        return [];
      }
      if (due) play(o, cycle([1, 2, 3, 4, 5, 6, 7, 0], 2), true);
      point(0, -6);
      break;
    case 0x26: // 38
      if (src.standing || src.holed !== 0 || src.d76c !== 0) {
        o.done = true;
        return [];
      }
      if (due) {
        for (let i = 0; i < 4; i++) {
          const r = rngNext(rng) & 15;
          born.push(spawnObject(0x27, 0, { x: w16(src.x + SPARK_DX[r]), y: w16(src.y - 6 + SPARK_DY[r]) }));
        }
        o.wait = 7;
      }
      break;
    case 0x27: // 39
      if (due) play(o, [[0, 2], [1, 3], [0, 2]]);
      break;
    case 0x34: // 52
      if (o.arg === 0) {
        // the canopy at the transformation: 57 ticks, nothing of its own drawn
        if (!o.started) {
          o.started = true;
          o.wait = 0x38;
        } else if (due) o.done = true;
        break;
      }
      if (due) play(o, [[0, 4], [1, 2], [2, 2], [3, 2]]);
      break;
    case 0x41: // 65
      if (!o.started) {
        o.started = true;
        point(0, 0);
      }
      if (due) play(o, cycle([0, 1, 2], 2));
      break;
    case 0x42: // 66
      if (src.mode !== 6 || src.ride === 0) {
        o.done = true;
        return [];
      }
      if (due) play(o, cycle([0, 1, 2], 2), true);
      point(0, 0);
      break;
    default:
      o.done = true; // not drawn (29, 34, 36, 42-45, 49-51, 60: their logic is elsewhere or unported)
  }
  return born;
}

/** `$80:E55A` -> `$80:E5E2`: y += v, then x, 16.16. */
function move(o: AbilityObject): void {
  const y = o.yf + (o.vyf & 0xffff);
  o.yf = y & 0xffff;
  o.y = (o.y + o.vy + (y >> 16)) & 0xffff;
  const x = o.xf + (o.vxf & 0xffff);
  o.xf = x & 0xffff;
  o.x = (o.x + o.vx + (x >> 16)) & 0xffff;
}
