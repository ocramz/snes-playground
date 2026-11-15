/**
 * The end-to-end harness of phase 5: hole 1 played from its shot set-up by
 * one of the stepper's input scripts (tools/snesstep/inputs/web_*.txt),
 * recording, every core frame, the same WRAM words tools/snesstep/
 * trace_flow.py watches — under the same names — and the ball block that
 * trace_ball.py records.
 *
 * Frames: the engine's hole starts at the set-up, the game's after a
 * 168-frame intro, so engine frame f is game frame f + GAME_OFFSET. The
 * offset is pinned on web_flow's set-up ($80:C4FF writes the aim and the
 * elevation at game frame 2334, the set-up's second frame) and is the same
 * for every script: they all start hole 1 with `2100 A`.
 */
import { readFileSync } from 'node:fs';
import { createGameWorld } from '../src/core/world';
import { runCoreFrame } from '../src/core/schedule';
import { startCourse } from '../src/core/actions';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { drainEvents, type GameEvent } from '../src/core/events';
import { Pad } from '../src/core/traits/pad';
import { Time } from '../src/core/traits/time';
import { Shot } from '../src/core/traits/shot';
import { Camera } from '../src/core/traits/camera';
import { HoleFlow } from '../src/core/traits/flow';
import { Course, courseEntity } from '../src/core/traits/course';
import { Pose, BallScreen, BallSprite } from '../src/core/traits/pose';
import { BallPos, BallVel, BallAir, BallSpin, StillCount, BallHoled } from '../src/core/traits/ball';
import { activePlayer } from '../src/core/traits/player';
import { Tomatoes, Strokes, Stars, Career, TomatoQueue } from '../src/core/traits/counters';
import { s16 } from '../src/core/fixed';
import type { World } from 'koota';
import type { Ctx } from '../src/core/sim/context';
import { heldAt, parseInputScript } from './input-script';
import { inputScriptPath, loadRomCourse, loadRomHole, loadTables } from './fixtures';
import { existsSync } from 'node:fs';
import { Hazards } from '../src/core/traits/hazards';
import { iterationOf, romTestPath } from './fixtures';
import { spawnActor, tickActor, type ActorRun, type BallView } from '../src/core/sim/actors';
import type { BallTraceFrame, FlowEvent } from './align';

/** Engine frame f is game frame f + GAME_OFFSET (see the header). */
export const GAME_OFFSET = 2332;

export interface FlowRun {
  world: World;
  ctx: Ctx;
  /** [game frame, name, value] on every change, as trace_flow.py writes them. */
  events: FlowEvent[];
  /** The ball block after every frame, stamped with the game frame. */
  ball: BallTraceFrame[];
  /** Every event the core emitted, stamped with the game frame. */
  emitted: Array<GameEvent & { gameFrame: number }>;
  /** The phase on each frame (game frame -> phase), for debugging. */
  phases: Array<[number, string]>;
  /** The hazard actors' pre-ticks (`alignActors`). */
  actorTicks?: number;
}

/** The engine-side values of trace_flow.py's WATCH names. */
export function sample(world: World): Record<string, number> {
  const shot = world.get(Shot)!;
  const cam = world.get(Camera)!;
  const e = activePlayer(world);
  const pose = e.get(Pose)!;
  const sc = e.get(BallScreen)!;
  const pos = e.get(BallPos)!;
  const screenBase = courseEntity(world).get(Course)!.screenBase;
  return {
    state: pose.state,
    facing: pose.facing,
    angle: pose.angle,
    aim: s16(shot.aim),
    elev: s16(shot.elev),
    side: shot.side,
    tb: shot.topBack,
    meter: shot.meter & 0xffff,
    cx38: s16(cam.x),
    cy38: s16(cam.y),
    camx: s16(cam.x),
    camy: s16(screenBase - cam.y),
    tgtx: s16(cam.targetX),
    tgty: s16(cam.targetY),
    kx: s16(sc.x),
    ky: s16(sc.y),
    kxf: sc.xf,
    kyf: sc.yf,
    c2: s16(cam.wantX),
    c4: s16(cam.wantY),
    c6: s16(cam.lagX),
    c8: s16(cam.lagY),
    st: cam.mode,
    bx: s16(pos.xc),
    by: s16(pos.yc),
    air: e.get(BallAir)!.air,
    over: e.get(StillCount)!.over,
    prio: e.get(BallSprite)!.prio,
    tom: e.get(Tomatoes)!.n,
    lives: world.get(Career)!.lives,
    strokes: e.get(Strokes)!.n,
    stars: e.get(Stars)!.n,
    holed: e.get(BallHoled)!.holed,
    card0: Math.max(0, world.get(Career)!.card[0] ?? 0),
    tqw: (world.get(TomatoQueue)!.pushed * 2) & 0x1f,
    tqr: (world.get(TomatoQueue)!.applied * 2) & 0x1f,
  };
}

function readBall(world: World, gameFrame: number): BallTraceFrame {
  const e = activePlayer(world);
  const pos = e.get(BallPos)!;
  const vel = e.get(BallVel)!;
  const spin = e.get(BallSpin)!;
  const shot = world.get(Shot)!;
  return {
    f: gameFrame,
    xc: pos.xc, xf: pos.xf, yc: pos.yc, yf: pos.yf, z: pos.z,
    vx: s16(vel.vx), vy: s16(vel.vy), vz: s16(vel.vz),
    air: e.get(BallAir)!.air ? 1 : 0,
    spinx: s16(spin.sx), spiny: s16(spin.sy), spinp: spin.pending,
    aim: shot.aim, elev: shot.elev,
  };
}

/**
 * Play `script` (a tools/snesstep/inputs name) for `frames` core frames from
 * hole 1's set-up. `until` stops early (it sees the world after each frame).
 */
export function runFlowScript(
  script: string,
  frames: number,
  opts: {
    offset?: number;
    until?: (world: World, gameFrame: number) => boolean;
    /** The script's text instead of tools/snesstep/inputs/<script>.txt. */
    text?: string;
    /** A ROM hole (build/engine/rom-test/holes/<n>) instead of hole 1. */
    hole?: number;
    /** Apply tools/snesstep/inputs/<script>.pokes (the ball's block words) at their frames. */
    pokes?: boolean;
    /**
     * Before the frame after this game iteration, respawn the hole's hazard
     * actors and tick them until they match actors_<script>.json at its end
     * (alignActors below). Returns the tick count in `actorTicks`.
     */
    alignActors?: number;
  } = {},
): FlowRun {
  const offset = opts.offset ?? GAME_OFFSET;
  const rules = new RomRules(loadTables());
  const course = fromRomCourse(opts.hole !== undefined ? loadRomHole(opts.hole)! : loadRomCourse());
  const pokes = opts.pokes ? loadBallPokes(script) : new Map<number, Array<[number, number]>>();
  const world = createGameWorld();
  const ctx = startCourse(world, rules, [course]);
  const entries = parseInputScript(opts.text ?? readFileSync(inputScriptPath(script), 'utf8'));
  const run: FlowRun = { world, ctx, events: [], ball: [], emitted: [], phases: [] };
  const last = new Map<string, number>();
  for (let i = 0; i < frames; i++) {
    const gameFrame = world.get(Time)!.frame + 1 + offset;
    const pad = world.get(Pad)!;
    world.set(Pad, { ...pad, raw: heldAt(entries, gameFrame) });
    if (opts.alignActors === gameFrame - 1) run.actorTicks = alignActors(world, ctx, script, gameFrame - 1);
    const poke = pokes.get(gameFrame);
    if (poke) pokeBlock(world, poke);
    runCoreFrame(world); // the session's context: a hole change mid-run takes effect
    for (const ev of drainEvents(world)) run.emitted.push({ ...ev, gameFrame });
    const s = sample(world);
    for (const [k, v] of Object.entries(s)) {
      if (last.get(k) !== v) {
        last.set(k, v);
        run.events.push([gameFrame, k, v]);
      }
    }
    run.ball.push(readBall(world, gameFrame));
    run.phases.push([gameFrame, world.get(HoleFlow)!.phase]);
    if (opts.until?.(world, gameFrame)) break;
  }
  return run;
}

/** The ball block's words the stepper's pokes write ($7E:D8xx -> the block traits). */
const BLOCK_WORDS: Record<number, string> = {
  0xd8aa: 'xf', 0xd8ae: 'xc', 0xd8b2: 'yf', 0xd8b6: 'yc', 0xd8ba: 'zlo', 0xd8be: 'zhi',
  0xd87a: 'vx', 0xd87e: 'vy', 0xd882: 'vz', 0xd8a6: 'air',
};

/** tools/snesstep/inputs/<name>.pokes -> {frame: [[addr, value]]}, the ball block's words only. */
export function loadBallPokes(name: string): Map<number, Array<[number, number]>> {
  const path = inputScriptPath(name).replace(/\.txt$/, '.pokes');
  const out = new Map<number, Array<[number, number]>>();
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.split('#', 1)[0].trim();
    if (!line) continue;
    const [f, rest] = line.split(/:(.*)/s);
    const [addr, val] = rest.split('=');
    const a = parseInt(addr.split(':')[1], 16);
    if (!(a in BLOCK_WORDS)) continue;
    const list = out.get(Number(f)) ?? [];
    list.push([a, parseInt(val, 16)]);
    out.set(Number(f), list);
  }
  return out;
}

/**
 * A poke of the ball's block, as the stepper does it: at the vblank, before
 * the frame's step loads the block into the work copy. The work copy's probe
 * fields stay as they were, as the block's ($D8C2-$D8DE) do in the game.
 */
function pokeBlock(world: World, words: Array<[number, number]>): void {
  const e = activePlayer(world);
  const pos = { ...e.get(BallPos)! };
  const vel = { ...e.get(BallVel)! };
  const air = { ...e.get(BallAir)! };
  let zlo = pos.z & 0xffff;
  let zhi = (pos.z >>> 16) & 0xffff;
  for (const [a, v] of words) {
    const k = BLOCK_WORDS[a];
    if (k === 'xf' || k === 'xc' || k === 'yf' || k === 'yc') pos[k] = v;
    else if (k === 'zlo') zlo = v;
    else if (k === 'zhi') zhi = v;
    else if (k === 'vx' || k === 'vy' || k === 'vz') vel[k] = v;
    else if (k === 'air') air.air = v;
  }
  pos.z = ((zhi << 16) | zlo) | 0;
  e.set(BallPos, pos);
  e.set(BallVel, vel);
  e.set(BallAir, air);
}

/** A recorded actor slot: build/engine/rom-test/actors_<name>.json, by slot. */
export interface ActorRecord {
  iter: number;
  type: number;
  x: number;
  y: number;
  dir: number;
  step: number;
  frame: number;
}

export function loadActorRecords(name: string): Map<number, ActorRecord[]> | null {
  const path = romTestPath(`actors_${name}.json`);
  if (!existsSync(path)) return null;
  const json = JSON.parse(readFileSync(path, 'utf8')) as { fields: string[]; records: number[][] };
  const col = (k: string): number => json.fields.indexOf(k);
  const out = new Map<number, ActorRecord[]>();
  for (const r of json.records) {
    const rec: ActorRecord = {
      iter: iterationOf(r[0], r[1]),
      type: r[col('type')],
      x: ((r[col('f589C')] << 16) | r[col('f581C')]) >>> 0,
      y: ((r[col('f599C')] << 16) | r[col('f591C')]) >>> 0,
      dir: r[col('f549C')],
      step: r[col('f551C')],
      frame: r[col('f5D9C')],
    };
    const list = out.get(r[col('slot')]) ?? [];
    // a slot reused by another object starts over
    if (list.length > 0 && list[list.length - 1].type !== rec.type) list.length = 0;
    list.push(rec);
    out.set(r[col('slot')], list);
  }
  return out;
}

/** An actor's state as the comparisons see it: $549C, $551C, $5D9C (and 76's x, y). */
export function actorState(type: number, s: { x: number; y: number; dir: number; frame: number }, step: number): string {
  const base = `d${s.dir} s${step} f${s.frame}`;
  return type === 76 ? `${base} ${(s.x >>> 0).toString(16)},${(s.y >>> 0).toString(16)}` : base;
}

/** The engine actor's $551C: 77 its step, the volcanoes their shadow; 76 does not use it. */
export function engineStep(a: ActorRun): number {
  if (a.type === 77) return a.step;
  if (a.type >= 81 && a.type <= 83) return a.shadow;
  return -1;
}

export function recordStep(r: ActorRecord): number {
  return r.type === 76 ? -1 : r.step;
}

/** Collapse repeats: the states a slot went through, in order. */
export function stateRuns<T>(list: T[], key: (t: T) => string): Array<{ s: string; at: T }> {
  const out: Array<{ s: string; at: T }> = [];
  for (const t of list) {
    const k = key(t);
    if (out.length === 0 || out[out.length - 1].s !== k) out.push({ s: k, at: t });
  }
  return out;
}

/**
 * One actor as the game had it at the end of main-loop iteration `at`,
 * from its recorded slot `hist` (its records up to `at`): respawned, then
 * ticked alone (the ball away from it) until
 *
 * - object 76: its states of the last 120 iterations (x, y, dir, frame)
 *   have just occurred, a tick or two apart (a record can catch a tick
 *   between its thread's frame and its mover: tickActor's `between`), with
 *   the frame's phase searched (the intro's thread-only ticks);
 * - 77 and the volcanoes: the slot's states since its first frame have
 *   occurred in order (a frame with two ticks keeps only the second's
 *   state, so the slot's may skip some) and the last has just begun; then
 *   as many ticks as the game's iterations since it began.
 */
export function alignActor(ctx: Ctx, old: ActorRun, hist: ActorRecord[], at: number): { a: ActorRun; ticks: number } {
  const w = ctx.course.w;
  const a = spawnActor(ctx, old.type, old.tile, old.cell % w, Math.floor(old.cell / w));
  const idle: BallView = { cell: -1, xf: 0, yf: 0, holed: false, rolling: false };
  if (old.type === 76) {
    // the states of the last 120 iterations, each at most 2 ticks after the
    // one before (a frame keeps the second of two ticks; the engine's states
    // are taken twice a tick, between its phases and after). The hole's
    // intro ticks the thread while the mover stands (web_haz98 2190-2191),
    // which the engine does not play: `d` such thread-only ticks set the
    // frame's phase against the position, which the track's loop alone
    // cannot (256 ticks, a multiple of 2 of the frames' 18)
    const recent = stateRuns(hist.filter((r) => r.iter > at - 120), (r) => actorState(76, r, -1)).map((r) => r.s);
    for (let d = 0; d < 18; d++) {
      const b = spawnActor(ctx, old.type, old.tile, old.cell % w, Math.floor(old.cell / w));
      tickActor(ctx, b, idle, false); // the thread's start: frame 0, the mover on
      const moving = b.moving;
      b.moving = false;
      for (let i = 0; i < d; i++) tickActor(ctx, b, idle, false);
      b.moving = moving;
      const seen: string[] = [];
      for (let n = 1; n <= 600; n++) {
        tickActor(ctx, b, idle, false, () => seen.push(actorState(76, b, -1)));
        seen.push(actorState(76, b, -1));
        let j = seen.length - 1;
        let ok = seen[j] === recent[recent.length - 1];
        for (let i = recent.length - 2; ok && i >= 0; i--) {
          const lo = j - 5;
          j -= 1;
          while (j >= lo && j >= 0 && seen[j] !== recent[i]) j--;
          ok = j >= lo && j >= 0;
        }
        if (ok) return { a: b, ticks: 1 + d + n };
      }
    }
    throw new Error(`no tick count reproduces object 76's last 120 iterations to ${at}`);
  }
  const want = stateRuns(hist.filter((r) => r.frame !== 0xffff), (r) => actorState(r.type, r, recordStep(r)));
  let i = 0;
  let prev = '';
  for (let n = 1; n <= 8000; n++) {
    tickActor(ctx, a, idle, false);
    if (a.frame === 0xffff) continue;
    const k = actorState(a.type, a, engineStep(a));
    if (k === prev) continue;
    prev = k;
    if (k !== want[i].s) continue;
    i += 1;
    if (i === want.length) {
      const extra = at - want[i - 1].at.iter;
      for (let e = 0; e < extra; e++) tickActor(ctx, a, idle, false);
      return { a, ticks: n + extra };
    }
  }
  throw new Error(`object ${old.type} never goes through its recorded states to iteration ${at} (${i} of ${want.length}: ${want[i]?.s})`);
}

/** The recorded slot of an engine actor: 76 and 77 by the cell they start on; the volcanoes by type (one each per hole). */
export function slotOf(recs: Map<number, ActorRecord[]>, a: ActorRun, w: number, used = new Set<number>()): number | undefined {
  return [...recs.entries()].find(([k, l]) => !used.has(k) && l[0].type === a.type && (a.type > 77 || sameCell(l, a, w)))?.[0];
}

/**
 * The hazard actors as the game had them at the end of main-loop iteration
 * `at` (alignActor, each on its own). The game's lag frames drop scheduler
 * ticks, which the engine does not model, so a scenario aligns right before
 * its poke. Returns the most ticks an actor took.
 */
function alignActors(world: World, ctx: Ctx, name: string, at: number): number {
  const recs = loadActorRecords(name);
  if (!recs) throw new Error(`no actors_${name}.json`);
  const f = world.get(Hazards)!;
  let most = 0;
  const used = new Set<number>();
  f.actors = f.actors.map((old) => {
    const slot = slotOf(recs, old, ctx.course.w, used);
    if (slot === undefined) throw new Error(`${name}: no recorded slot for the type ${old.type} at cell ${old.cell}`);
    used.add(slot);
    const r = alignActor(ctx, old, recs.get(slot)!.filter((q) => q.iter <= at), at);
    most = Math.max(most, r.ticks);
    return r.a;
  });
  return most;
}

/** The slot's first set-up record is on the actor's cell (76 moves 1/64 cell a tick). */
function sameCell(list: ActorRecord[], a: ActorRun, w: number): boolean {
  const r = list.find((q) => q.frame !== 0xffff) ?? list[0];
  return ((r.y >>> 16) & 0xffff) * w + ((r.x >>> 16) & 0xffff) === a.cell;
}
