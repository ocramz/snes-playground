/**
 * A recorded run played back on the game's own pad, shot by shot
 * (notes/port-v2-phase5-abilities.md "The demo clock"). Made for DEMOPLAY's
 * demos, whose input is the ROM's stream (core/demo.ts) and whose clock is
 * the game's iterations, not the video frames; it works for any recording
 * of tools/snesstep/trace_flow.py, which logs the pad the game reads
 * (`pad` $0067, `padp` $006B) and every call of the frame helper $80:8F78
 * (iters_<name>.json).
 *
 * Neither clock alone keeps the engine on the game's inputs:
 * - From a shot's set-up to its launch the engine is frame-exact with the
 *   game (the flow tests' constant offset): its pans and panel count video
 *   frames, lag frames included. So there, engine frame f_s + n reads the
 *   pad of game frame F_s + n, from the shot's first aim iteration.
 * - In the roll the game lags where the engine does not, but every roll
 *   iteration is one physics step in both, and every frame of a nested
 *   wait (a hit-stop, the take's wait, the transformation) one call of the
 *   frame helper. So there, the engine's iteration k from the roll's start
 *   reads what the game's body r_s + k read, r_s being the body of the
 *   shot's first ability-trigger read ($82:C880, once per roll iteration).
 *   An engine frame is an iteration unless it idles in the guide's or the
 *   APU's lag (core/demo.ts isIterationFrame).
 *
 * Each engine event is stamped with the game frame its frame maps to, so
 * the comparisons work in game frames, re-anchored at each shot.
 */
import { existsSync } from 'node:fs';
import type { World } from 'koota';
import { createGameWorld } from '../src/core/world';
import { runCoreFrame } from '../src/core/schedule';
import { startCourse } from '../src/core/actions';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { drainEvents, type GameEvent } from '../src/core/events';
import { Pad } from '../src/core/traits/pad';
import { Pose } from '../src/core/traits/pose';
import { HoleFlow } from '../src/core/traits/flow';
import { GameRng } from '../src/core/traits/water';
import { activePlayer } from '../src/core/traits/player';
import { Tomatoes, StockedAbility, Career } from '../src/core/traits/counters';
import { demoHole, demoRecord, isIterationFrame, type DemoRecord } from '../src/core/demo';
import type { Ctx } from '../src/core/sim/context';
import { iterationOf, loadFlow, loadRomHole, loadTables, readJson, romTestPath } from './fixtures';
import { readBall, sample } from './flow-harness';
import type { BallTraceFrame, FlowEvent } from './align';

/** iters_<name>.json (trace_flow.py). */
export interface GameIters {
  /** Every call of the frame helper `$80:8F78`: [frame, line]. */
  entries: Array<[number, number]>;
  /** Every pad read of the ability trigger `$82:C880` (one per roll iteration): [frame, line, $006B]. */
  trigger: Array<[number, number, number]>;
  /** Every vblank wait `$80:845F` (the frame helpers' and others'), where a demo's stream ticks. */
  waits: Array<[number, number]>;
}

export function loadIters(name: string): GameIters | null {
  const path = romTestPath(`iters_${name}.json`);
  return existsSync(path) ? readJson<GameIters>(path) : null;
}

const key = (frame: number, line: number): number => frame * 1000 + line;

/** The first frame-helper call at or after (frame, line): the body the event ran in. */
export function bodyOf(entries: Array<[number, number]>, frame: number, line: number): number {
  const k = key(frame, line);
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(entries[mid][0], entries[mid][1]) < k) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A flow event's scanline (trace_flow.py's fourth element; 0 in older recordings). */
export function lineOf(e: FlowEvent): number {
  return Number((e as unknown[])[3] ?? 0);
}

/** One shot of the recording: its first aim iteration and its roll's first body. */
export interface GameShot {
  /** The iteration frame (fixtures.iterationOf) of the shot's first aim iteration. */
  aimFrame: number;
  /** The body (entry index) of the shot's first trigger read, -1 if it never rolled. */
  rollBody: number;
}

/** The recording as the playback reads it. */
export interface GameRecording {
  name: string;
  iters: GameIters;
  events: FlowEvent[];
  shots: GameShot[];
  /** The pad (held, pressed) after every write up to game frame F's end. */
  padAtFrame(frame: number): [number, number];
  /** The pad body k read: every write before its frame-helper call. */
  padAtBody(k: number): [number, number];
  /** The pad after every write before (frame, line). */
  padAt(frame: number, line: number): [number, number];
}

export function loadRecording(name: string): GameRecording | null {
  const iters = loadIters(name);
  const flow = loadFlow(name);
  if (!iters || !flow) return null;
  const events = flow.events;
  // the pad's writes, in order: [key, held, pressed]
  const writes: Array<[number, number, number]> = [];
  let held = 0;
  let pressed = 0;
  for (const e of events) {
    if (e[1] === 'pad') held = Number(e[2]);
    else if (e[1] === 'padp') pressed = Number(e[2]);
    else continue;
    writes.push([key(e[0], lineOf(e)), held, pressed]);
  }
  const at = (k: number): [number, number] => {
    let lo = 0;
    let hi = writes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (writes[mid][0] <= k) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? [0, 0] : [writes[lo - 1][1], writes[lo - 1][2]];
  };
  // the shots: a state 4 after anything but 4 or 5, and the first trigger read after it
  const shots: GameShot[] = [];
  let prev = -1;
  for (const e of events) {
    if (e[1] !== 'state') continue;
    const v = Number(e[2]);
    if (v === 4 && prev !== 4 && prev !== 5) {
      const k = key(e[0], lineOf(e));
      const t = iters.trigger.find((r) => key(r[0], r[1]) > k);
      shots.push({ aimFrame: iterationOf(e[0], lineOf(e)), rollBody: t ? bodyOf(iters.entries, t[0], t[1]) : -1 });
    }
    prev = v;
  }
  for (let i = 0; i + 1 < shots.length; i++) {
    // a trigger read past the next shot's aim belongs to that shot
    const next = shots[i + 1];
    const e = iters.entries[shots[i].rollBody];
    if (shots[i].rollBody >= 0 && e && iterationOf(e[0], e[1]) > next.aimFrame) shots[i].rollBody = -1;
  }
  return {
    name, iters, events, shots,
    padAtFrame: (frame) => at(key(frame, 999)),
    padAt: (frame, line) => at(key(frame, line) - 1),
    padAtBody: (k) => {
      const e = iters.entries[k];
      return e ? at(key(e[0], e[1])) : [0, 0];
    },
  };
}

export interface PlaybackRun {
  world: World;
  ctx: Ctx;
  /** [game frame, name, value] on every change of sample(). */
  events: Array<[number, string, number]>;
  /** The ball after every frame, stamped `f` = the game frame. */
  ball: BallTraceFrame[];
  emitted: Array<GameEvent & { gameFrame: number }>;
  /** Per engine frame: [engine frame, game frame, the clock ('pre' | 'aim' | 'roll'), shot]. */
  clock: Array<[number, number, string, number]>;
}

/**
 * Play `rec` on `hole` from the set-up, the pad from the recording shot by
 * shot (the header comment). Stops after `frames` engine frames or `until`.
 */
export function playRecording(
  game: GameRecording,
  hole: number,
  frames: number,
  opts: { setup?: (world: World) => void; until?: (world: World, gameFrame: number) => boolean } = {},
): PlaybackRun {
  const rules = new RomRules(loadTables());
  const json = loadRomHole(hole);
  if (!json) throw new Error(`no build/engine/rom-test/holes/${hole}`);
  const world = createGameWorld();
  const ctx = startCourse(world, rules, [fromRomCourse(json)]);
  opts.setup?.(world);
  seedRng(world, game);
  const run: PlaybackRun = { world, ctx, events: [], ball: [], emitted: [], clock: [] };
  const last = new Map<string, number>();
  let mode: 'pre' | 'aim' | 'roll' = 'pre';
  let shot = -1;
  let anchor = 0; // aim: the engine frame of the shot's first aim iteration; roll: iterations since the roll's start
  let prevState = -1;
  let gameFrame = 0;
  for (let f = 1; f <= frames; f++) {
    const s = game.shots[shot];
    if (mode === 'aim') {
      gameFrame = s.aimFrame + (f - anchor);
      world.set(Pad, { ...world.get(Pad)!, raw: game.padAtFrame(gameFrame)[0] });
    } else if (mode === 'roll' && isIterationFrame(world)) {
      anchor += 1;
      const e = game.iters.entries[s.rollBody + anchor];
      gameFrame = e ? iterationOf(e[0], e[1]) : gameFrame + 1;
      world.set(Pad, { ...world.get(Pad)!, raw: game.padAtBody(s.rollBody + anchor)[0] });
    } else if (mode === 'roll') {
      gameFrame += 1; // a lag frame
    }
    const rolling = world.get(HoleFlow)!.phase === 'Rolling';
    runCoreFrame(world);
    const state = activePlayer(world).get(Pose)!.state;
    if (state === 4 && prevState !== 4 && prevState !== 5 && shot + 1 < game.shots.length) {
      shot += 1;
      mode = 'aim';
      anchor = f;
      gameFrame = game.shots[shot].aimFrame;
    } else if (mode === 'aim' && !rolling && world.get(HoleFlow)!.phase === 'Rolling' && game.shots[shot].rollBody >= 0) {
      mode = 'roll';
      anchor = 0;
      const e = game.iters.entries[game.shots[shot].rollBody];
      gameFrame = iterationOf(e[0], e[1]);
    }
    prevState = state;
    run.clock.push([f, gameFrame, mode, shot]);
    for (const ev of drainEvents(world)) run.emitted.push({ ...ev, gameFrame });
    const smp = sample(world);
    for (const [k, v] of Object.entries(smp)) {
      if (last.get(k) !== v) {
        last.set(k, v);
        run.events.push([gameFrame, k, v]);
      }
    }
    run.ball.push(readBall(world, gameFrame));
    if (opts.until?.(world, gameFrame)) break;
  }
  return run;
}

/** The random state at the game's first aim iteration (the hole's opening draws are not modelled). */
function seedRng(world: World, game: GameRecording): void {
  const to = game.shots[0]?.aimFrame ?? 0;
  let a = -1;
  let b = -1;
  for (const e of game.events) {
    if (iterationOf(e[0], lineOf(e)) > to) break;
    if (e[1] === 'rnga') a = Number(e[2]);
    else if (e[1] === 'rngb') b = Number(e[2]);
  }
  if (a >= 0 && b >= 0) world.set(GameRng, { a: a & 0xffff, b: b & 0xffff });
}

/** DEMOPLAY demo k: its record, hole and recording. */
export interface Demo {
  k: number;
  rec: DemoRecord;
  hole: number;
  game: GameRecording;
}

export function loadDemo(k: number): Demo | null {
  const game = loadRecording(`web_demo${k}`);
  if (!game) return null;
  const rec = demoRecord(new RomRules(loadTables()), k);
  return { k, rec, hole: demoHole(rec), game };
}

/** Play demo k for `frames` engine frames, the record's header applied. */
export function runDemo(demo: Demo, frames: number, until?: (world: World, gameFrame: number) => boolean): PlaybackRun {
  return playRecording(demo.game, demo.hole, frames, { setup: (w) => applyDemoHeader(w, demo.rec), until });
}

/**
 * The record's header, as far as the engine keeps those words: the tomatoes
 * (`$D7F0`), the lives (`$D7F4`) and the stock carried into the hole
 * (`$DA90`, which `$80:C22E` copies to `$D852` at the hole's start).
 */
export function applyDemoHeader(world: World, rec: DemoRecord): void {
  const e = activePlayer(world);
  e.set(Tomatoes, { n: rec.header.get(0xd7f0)! });
  e.set(StockedAbility, { id: rec.header.get(0xda90)!, carry: rec.header.get(0xda90)! });
  world.set(Career, { ...world.get(Career)!, lives: rec.header.get(0xd7f4)! });
}
