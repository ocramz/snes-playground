/**
 * The hazards' actors (read 2026-11-14; notes/engine-phase6-holes.md
 * "Hazards"): the load-time auto-tiling of the bumper tracks and the thread
 * objects whose state the ball's hazard handlers read.
 *
 * - `$82:BA87` rewrites layer 2's track tiles in place, row by row, each cell
 *   against its already-rewritten neighbours: a tile whose sides do not all
 *   connect becomes the dead end of the side that does ($82:BB82), or $A2
 *   when none does.
 * - Object 76 (tiles $80-$8F, `$84:DED6`): a bumper riding its track at 1/64
 *   cell per tick ($84:E04F), turning at each cell centre by the track tile
 *   it is on ($84:E051); on an isolated tile ($A2) it stays still. Its Z is
 *   the ground under it (`$81:9661`); frames 0 and 1, 9 ticks each.
 * - Object 77 (tiles $90-$97, `$84:DD9D`): a bumper that bobs through 22
 *   steps of 9 ticks ($84:DE0F); tiles $94-$97 start 11 steps on. The
 *   handler's box height comes from its frame ($82:967B).
 * - Objects 81-83 (tiles $AC-$AE, the volcanoes, `$84:E166`): an idle
 *   loop (frames 0, 1, 2, 1, 8 ticks each) chained in segments, with
 *   eruption tests between them (81 never erupts; 82: 128, E, 192, E, 64, E,
 *   64, E; 83: 64, E, 64, E, 128, E, 32, E). An eruption: state 1 for 54
 *   ticks, 42 more, then state 2 for 96 ticks (`$84:E539`). The ball's
 *   low-contact handler reads that state. A poke (the ball on the cone,
 *   `$82:870C`) replays 32 frames ($84:E1F5) unless erupting. The eruption's
 *   projectiles (object 84 and its seven children) are not ported.
 *
 * The scheduler (`$80:E0C0`): a spawned thread runs on the first tick; a
 * yield of N resumes N + 1 ticks later; a thread's per-frame handler runs
 * after every thread's resumption in the same tick. While the cup reveal
 * holds `$6A8C`, objects 76 and 77 neither move nor count (`$84:DF75`, the
 * shared draw `$84:DE68`); the volcanoes do not look at it.
 */
import type { RomRules } from '../rules';
import type { Ctx } from './context';
import { emptyWork } from '../traits/ball';
import { probe } from './probe';

/** A tile of the bumper tracks ($80-$A2). */
export function isTrackTile(t: number): boolean {
  return t >= 0x80 && t <= 0xa2;
}

function mask(rules: RomRules, t: number): number {
  return isTrackTile(t) ? rules.table('trackMask')[t - 0x80] : 0;
}

/** `$82:BA87`: the auto-tiling, in place. */
export function autotileTracks(rules: RomRules, layer2: Uint8Array, w: number, h: number): void {
  const dead = rules.table('trackDeadEnd');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = mask(rules, layer2[i]);
      if (m === 0) continue;
      let c = 0;
      if ((m & 1) && y > 0 && (mask(rules, layer2[i - w]) & 4)) c |= 1;
      if ((m & 2) && x + 1 < w && (mask(rules, layer2[i + 1]) & 8)) c |= 2;
      if ((m & 4) && y + 1 < h && (mask(rules, layer2[i + w]) & 1)) c |= 4;
      if ((m & 8) && x > 0 && (mask(rules, layer2[i - 1]) & 2)) c |= 8;
      if (c === m) continue;
      layer2[i] = c === 0 ? 0xa2 : dead[c & m];
    }
  }
}

/** The ball as the volcanoes' eruption test sees it ($D8C2, $D8AA, $D8B2, the holed flags). */
export interface BallView {
  cell: number;
  xf: number;
  yf: number;
  holed: boolean;
  /** $6AC0 == 2: the shot is rolling. */
  rolling: boolean;
}

export interface ActorRun {
  type: number;
  /** The tile it spawned on (before the auto-tiling). */
  tile: number;
  cell: number;
  /** 16.16: x = $589C:$581C, y = $599C:$591C, z = $5A9C:$5A1C. */
  x: number;
  y: number;
  z: number;
  /** $549C: 76 the direction (0 N, 1 E, 2 S, 3 W); 77 the step's flag;
   *  81-83 the eruption state (0 idle, 1 erupting, 2 spewing). */
  dir: number;
  /** $5D9C. */
  frame: number;
  /** Ticks until the thread resumes (1 = the next tick). */
  wait: number;
  /** 76: has the per-frame mover (not on an isolated tile). */
  moving: boolean;
  /** 77: its step ($551C). */
  step: number;
  /** 81-83: $551C the shadow, $559C the ball latch, $569C the pokes, $571C the poke's tick. */
  shadow: number;
  latch: number;
  poke: number;
  pokeT: number;
  /** The thread's coroutine (yields the ticks until it resumes). */
  co: Generator<number, void, void> | null;
}

/** $82:B9C7 + the thread's first values, at the cell centre with the ground's Z. */
export function spawnActor(ctx: Ctx, type: number, tile: number, cx: number, cy: number): ActorRun {
  const x = (cx << 16) | 0x8000;
  const y = (cy << 16) | 0x8000;
  const a: ActorRun = {
    type, tile, cell: cy * ctx.course.w + cx, x, y, z: groundAt(ctx, x, y),
    dir: tile < 0x90 ? tile & 3 : 0, // $84:DD85
    frame: 0xffff, wait: 1, moving: false,
    step: tile >= 0x94 ? 10 : 0xffff, // $84:DDB0
    shadow: 1, latch: 0, poke: 0, pokeT: 0,
    co: null,
  };
  return a;
}

/** `$81:9661` / the probe: the ground's Z under a 16.16 position (0 over a gap). */
export function groundAt(ctx: Ctx, x: number, y: number): number {
  const w = emptyWork();
  w.xc = (x >>> 16) & 0xffff; w.xf = x & 0xffff;
  w.yc = (y >>> 16) & 0xffff; w.yf = y & 0xffff;
  probe(ctx, w);
  return w.shape === 0 ? 0 : w.ground;
}

/**
 * One scheduler tick of an actor: phase 1 (its thread, if it resumes now),
 * then phase 2 (its per-frame handler). `frozen` is `$6A8C` (the cup reveal).
 * `between` sees the actor between the two (a tick can straddle a frame:
 * the recorded slots show that state; test/hazard-actors.test.ts).
 */
export function tickActor(ctx: Ctx, a: ActorRun, ball: BallView, frozen: boolean, between?: () => void): void {
  const volcano = a.type >= 81 && a.type <= 83;
  if (!volcano && a.type !== 76 && a.type !== 77) return;
  if (frozen && !volcano) return;
  if (a.co === null) a.co = program(ctx, a, ball);
  a.wait -= 1;
  if (a.wait <= 0) {
    const r = a.co.next();
    a.wait = r.done ? Infinity : r.value;
  }
  between?.();
  if (a.type === 76 && a.moving) move76(ctx, a);
  if (volcano) pokeOverride(ctx, a);
}

function* program(ctx: Ctx, a: ActorRun, ball: BallView): Generator<number, void, void> {
  if (a.type === 76) {
    // $84:DED6: the mover unless the track tile is the isolated $A2; then
    // $84:DF13: frames 0 and 1, yield 8 each
    a.moving = ctx.course.layer2[a.cell] !== 0xa2;
    for (;;) {
      a.frame = 0;
      yield 9;
      a.frame = 1;
      yield 9;
    }
  }
  if (a.type === 77) {
    // $84:DDC7
    const phases = ctx.rules.table('bobPhases');
    for (;;) {
      a.step = (a.step + 1) & 0xffff;
      if (a.step >= 22) a.step = 0; // the entry after the last reads negative
      const e = a.step * 4;
      a.frame = phases[e];
      a.dir = phases[e + 3];
      yield phases[e + 2] + 1;
    }
  }
  // the volcanoes, $84:E166: idle segments chained with eruption tests
  a.dir = 0;
  a.frame = 0;
  const idle = function* (ticks: number): Generator<number, void, void> {
    const cycle = [0, 1, 2, 1];
    for (let i = 0; i < ticks / 8; i++) {
      a.frame = cycle[i % 4];
      yield 8;
    }
  };
  const test = function* (): Generator<number, void, void> {
    // $84:E4BB: a skip is 192 idle ticks (JMP $E376)
    let skip = false;
    if (a.poke !== 0) skip = true;
    else if (a.latch !== 0 && middle(ball)) skip = true;
    else {
      if (a.latch !== 0) a.latch = 0;
      if (!ball.rolling && ball.cell === a.cell && middle(ball)) {
        a.latch = 1;
        skip = true;
      }
    }
    if (skip) {
      yield* idle(192);
      return;
    }
    yield* erupt();
  };
  const erupt = function* (): Generator<number, void, void> {
    // $84:E539
    a.dir = 1;
    for (const [f, n] of [[0, 7], [1, 7], [2, 7], [1, 9], [0, 11], [1, 13]]) {
      a.frame = f;
      yield n;
    }
    if (ball.holed) {
      a.dir = 0;
      return;
    }
    a.frame = 2;
    yield 40;
    a.frame = 3;
    yield 2;
    // (object 84 spawns here: the projectiles, not ported)
    a.dir = 2;
    for (let i = 0; i < 12; i++) {
      for (const [sh, f, n] of [[1, 0, 1], [0, 0, 1], [-1, 3, 2], [1, 2, 1], [0, 2, 1], [-1, 3, 2]]) {
        if (sh >= 0) a.shadow = sh;
        a.frame = f;
        yield n;
      }
    }
    a.shadow = 1;
    a.dir = 0;
  };
  const seq = a.type === 82 ? [128, -1, 192, -1, 64, -1, 64, -1] : a.type === 83 ? [64, -1, 64, -1, 128, -1, 32, -1] : [192];
  for (;;) {
    for (const s of seq) {
      if (s > 0) yield* idle(s);
      else yield* test();
    }
  }
}

/** $82:EDD8: both fractions in $4000-$BFFF. */
function middle(b: BallView): boolean {
  return b.xf >= 0x4000 && b.xf < 0xc000 && b.yf >= 0x4000 && b.yf < 0xc000;
}

/** `$84:E1B4`: a poke replays $84:E1F5 for 32 ticks, unless it is erupting. */
function pokeOverride(ctx: Ctx, a: ActorRun): void {
  if (a.poke === 0) return;
  if (a.poke === 1) {
    if (a.dir !== 0) {
      a.poke = 0;
      return;
    }
    a.poke = 2;
    a.pokeT = 0;
  }
  a.pokeT += 1;
  const v = ctx.rules.table('volcanoPoked')[a.pokeT];
  if (v === 0xff || v === undefined) a.poke = 0;
  else a.frame = v;
}

/** `$84:DF75`. */
function move76(ctx: Ctx, a: ActorRun): void {
  if ((a.x & 0xffff) === 0x8000 && (a.y & 0xffff) === 0x8000) {
    const t = ctx.course.layer2[((a.y >>> 16) & 0xffff) * ctx.course.w + ((a.x >>> 16) & 0xffff)];
    if (t >= 0x80 && t <= 0xa1) a.dir = ctx.rules.table('trackTurn')[(t - 0x80) * 4 + (a.dir & 3)];
  }
  const v = ctx.rules.table('trackSpeed')[0];
  switch (a.dir) {
    case 0: a.y = (a.y - v) >>> 0; break;
    case 1: a.x = (a.x + v) >>> 0; break;
    case 2: a.y = (a.y + v) >>> 0; break;
    case 3: a.x = (a.x - v) >>> 0; break;
    default: return; // $FF: the ROM jumps through garbage; never on a valid track
  }
  a.z = groundAt(ctx, a.x, a.y);
}
