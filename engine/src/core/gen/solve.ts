/**
 * Is a generated hole winnable? A search over real shots, simulated with the
 * engine's own physics (shot-sim.ts), for a plan that takes every enemy but
 * one and then holes in the last one, which by then is the cup
 * (docs/physics.md "Enemies and the cup": the cup is whichever enemy is left
 * last, in the player's order, so any enemy may end up the cup).
 *
 * A state is (where the ball rests, the enemies taken, the tomatoes). It is
 * expanded from its own exact work copy, so a plan replays exactly; states
 * are deduplicated by (rest cell, taken mask), the first arrival kept. The
 * search is best-first: the state with the fewest enemies left, then the
 * fewest shots, then the nearest free enemy, is expanded next. The shots
 * tried from a state:
 * - at each free enemy (`aimToward`, $82:AFB0) and 2 degrees either side,
 *   grounders at four meters, and fly shots for a hovering one (a rolling
 *   ball never tests $4D-$52, sim/enemy.ts);
 * - a fan of 16 grounder aims at three meters and 8 fly shots, to get round
 *   corners;
 * - with one enemy left and near: slower shots at it with the cup written
 *   into the solver's layer 2 ($82:8B5C), which must hole.
 *
 * The rules the plan keeps (docs/flow.md): every shot costs a tomato and
 * every take gives one back, at most 4; a state at 0 is out of tomatoes and
 * dropped (it costs a life); a lost ball is never part of a plan; a shot
 * that rolls through the cup's cell after the cup appeared is dropped too,
 * since the simulation ran it without the cup. `par` is the length of the
 * plan found: a score a player can reach, not always the best one.
 *
 * Generator function: it yields the shot count after every simulated shot,
 * so a host can spread the work over frames.
 */
import type { CourseData } from '../course-data';
import type { RomRules } from '../rules';
import type { Ctx, Work } from '../sim/context';
import { aimToward } from '../sim/aim';
import { enemyHover } from '../sweep';
import { CUP_TILE, simContext, simulateShot, teeWork, type ShotResult, type ShotSpec } from './shot-sim';

export const TOMATO_START = 4;
export const TOMATO_MAX = 4;

export interface SolveOptions {
  /** Simulated shots before giving up. */
  maxShots?: number;
  /** States expanded before giving up. */
  maxStates?: number;
  /** Tomatoes on the tee (the course starts with 4; they carry over between holes). */
  tomatoes?: number;
}

export interface PlannedShot {
  /** Where the ball rests before the shot. */
  from: { xc: number; xf: number; yc: number; yf: number; z: number };
  shot: ShotSpec;
  /** The enemies (indices into CourseData.enemies) this shot takes, in order. */
  takes: number[];
  /** Holes the ball (the plan's last shot). */
  holes: boolean;
  /** Tomatoes after the shot. */
  tomatoes: number;
}

export interface Solution {
  ok: boolean;
  /** The plan's length: the shots a player needs, at best, among those tried. */
  par: number;
  plan: PlannedShot[];
  shots: number;
  states: number;
  why: string;
}

interface Edge {
  shot: ShotSpec;
  result: ShotResult;
  /** Per enemy, the last step the ball was inside its cell (-1: never). */
  lastIn: Int32Array;
}

interface State {
  work: Work;
  cell: number;
  mask: number;
  tomatoes: number;
  depth: number;
  parent: State | null;
  via: PlannedShot | null;
}

const GROUND_METERS = [20, 32, 44, 63];
const FLY_METERS = [28, 40, 52, 63];
const FAN_METERS = [24, 44, 63];
const HOLE_METERS = [8, 12, 16, 21, 27, 34, 42];
const HOLE_AIMS = [0, -1, 1, -2, 2, -4, 4];
/** Holing is tried from this close (cells, Chebyshev). */
const HOLE_REACH = 8;

function popcount(m: number): number {
  let n = 0;
  for (let v = m; v !== 0; v &= v - 1) n++;
  return n;
}

function posOf(w: Work): PlannedShot['from'] {
  return { xc: w.xc, xf: w.xf, yc: w.yc, yf: w.yf, z: w.z };
}

export function* solveHole(rules: RomRules, data: CourseData, opts: SolveOptions = {}): Generator<number, Solution> {
  const maxShots = opts.maxShots ?? 3000;
  const maxStates = opts.maxStates ?? 80;
  const ctx = simContext(rules, data);
  const enemies = data.enemies.map((c) => {
    const i = c.y * data.w + c.x;
    const tile = data.tile[i];
    return { x: c.x, y: c.y, cell: i, tile, hover: enemyHover(rules, tile) };
  });
  const n = enemies.length;
  const all = (1 << n) - 1;
  const enemyAtCell = new Map<number, number>(enemies.map((e, k) => [e.cell, k]));
  let shots = 0;

  /** One simulated shot, with the cells of the enemies it went through. */
  function* run(from: Work, shot: ShotSpec, c: Ctx = ctx): Generator<number, Edge> {
    const lastIn = new Int32Array(n).fill(-1);
    const result = simulateShotTracked(c, from, shot, (step, cell) => {
      const k = enemyAtCell.get(cell);
      if (k !== undefined) lastIn[k] = step;
    });
    shots += 1;
    yield shots;
    return { shot, result, lastIn };
  }

  function candidateShots(w: Work, mask: number): ShotSpec[] {
    const out: ShotSpec[] = [];
    enemies.forEach((e, k) => {
      if ((mask >> k) & 1) return;
      const base = aimToward(rules, w.xc, w.xf, w.yc, w.yf, e.x, 0x8000, e.y, 0x8000);
      for (const da of [0, -2, 2]) {
        const aim = (base + da + 360) % 360;
        if (e.hover !== 0) for (const meter of FLY_METERS) out.push({ aim, meter, fly: true });
        else for (const meter of GROUND_METERS) out.push({ aim, meter, fly: false });
      }
    });
    for (let a = 0; a < 16; a++) for (const meter of FAN_METERS) out.push({ aim: Math.round(a * 22.5), meter, fly: false });
    for (let a = 0; a < 8; a++) out.push({ aim: a * 45 + 22, meter: 63, fly: true });
    return out;
  }

  const fail = (why: string, states: number): Solution => ({ ok: false, par: 0, plan: [], shots, states, why });

  const start: State = {
    work: teeWork(ctx, data.tee), cell: data.tee.y * data.w + data.tee.x, mask: 0,
    tomatoes: opts.tomatoes ?? TOMATO_START, depth: 0, parent: null, via: null,
  };
  const seen = new Set<string>([`${start.cell}|0`]);
  const open: State[] = [start];
  /** Free enemies first, then shots, then the distance to the nearest free one. */
  const rank = (st: State): number => {
    const free = all & ~st.mask;
    let near = 99;
    enemies.forEach((e, k) => {
      if ((free >> k) & 1) near = Math.min(near, Math.max(Math.abs(e.x - st.work.xc), Math.abs(e.y - st.work.yc)));
    });
    return popcount(free) * 10000 + st.depth * 100 + near;
  };
  let expanded = 0;
  while (open.length > 0) {
    let best = 0;
    let bestRank = rank(open[0]);
    for (let j = 1; j < open.length; j++) {
      const r = rank(open[j]);
      if (r < bestRank) {
        best = j;
        bestRank = r;
      }
    }
    const s = open.splice(best, 1)[0];
    if (expanded >= maxStates) return fail(`state budget (${maxStates}) spent`, expanded);
    expanded += 1;
    const free = all & ~s.mask;
    // one enemy left: it is the cup; try to hole in it from near enough
    if (popcount(free) === 1) {
      const k = 31 - Math.clz32(free);
      const e = enemies[k];
      if (Math.max(Math.abs(e.x - s.work.xc), Math.abs(e.y - s.work.yc)) <= HOLE_REACH) {
        const saved = ctx.course.layer2[e.cell];
        ctx.course.layer2[e.cell] = CUP_TILE;
        try {
          const base = aimToward(rules, s.work.xc, s.work.xf, s.work.yc, s.work.yf, e.x, 0x8000, e.y, 0x8000);
          for (const meter of HOLE_METERS) {
            for (const da of HOLE_AIMS) {
              const edge = yield* run(s.work, { aim: (base + da + 360) % 360, meter, fly: false });
              if (edge.result.outcome === 'holed') {
                const last: PlannedShot = {
                  from: posOf(s.work), shot: edge.shot, takes: [], holes: true, tomatoes: s.tomatoes - 1,
                };
                return { ok: true, par: s.depth + 1, plan: [...planOf(s), last], shots, states: expanded, why: '' };
              }
              if (shots >= maxShots) return fail(`shot budget (${maxShots}) spent`, expanded);
            }
          }
        } finally {
          ctx.course.layer2[e.cell] = saved;
        }
      }
    }
    for (const shot of candidateShots(s.work, s.mask)) {
      if (shots >= maxShots) return fail(`shot budget (${maxShots}) spent`, expanded);
      const edge = yield* run(s.work, shot);
      const next = apply(s, edge);
      if (next === null) continue;
      const key = `${next.cell}|${next.mask}`;
      if (seen.has(key)) continue;
      seen.add(key);
      open.push(next);
    }
  }
  return fail('no plan: some enemy cannot be reached', expanded);

  /** The state a shot leads to, or null when the plan cannot use it. */
  function apply(s: State, edge: Edge): State | null {
    const r = edge.result;
    if (r.outcome !== 'rest') return null; // lost, timed out (holed needs the cup: not here)
    let mask = s.mask;
    let tomatoes = s.tomatoes - 1; // $82:BFD8
    const takes: number[] = [];
    let cupFrom = popcount(all & ~mask) === 1 ? 0 : -1; // the step the cup is out from
    let cup = cupFrom === 0 ? 31 - Math.clz32(all & ~mask) : -1;
    for (let j = 0; j < r.hits.length; j++) {
      const k = enemyAtCell.get(r.hits[j]);
      if (k === undefined || ((mask >> k) & 1) !== 0) continue;
      if (k === cup) return null; // reached the cup, which was simulated as an enemy
      mask |= 1 << k;
      takes.push(k);
      tomatoes = Math.min(TOMATO_MAX, tomatoes + 1);
      if (popcount(all & ~mask) === 1) {
        cupFrom = r.hitSteps[j];
        cup = 31 - Math.clz32(all & ~mask);
      }
    }
    // through the cup's cell after it appeared: the cup would have acted
    if (cup >= 0 && edge.lastIn[cup] > cupFrom) return null;
    if (tomatoes <= 0) return null; // out of tomatoes: a life lost
    const w = r.work;
    const via: PlannedShot = { from: posOf(s.work), shot: edge.shot, takes, holes: false, tomatoes };
    return { work: w, cell: w.yc * data.w + w.xc, mask, tomatoes, depth: s.depth + 1, parent: s, via };
  }
}

function planOf(s: State): PlannedShot[] {
  const out: PlannedShot[] = [];
  for (let p: State | null = s; p && p.via; p = p.parent) out.unshift(p.via);
  return out;
}

/** simulateShot, reporting the cell the ball is in after every step. */
function simulateShotTracked(ctx: Ctx, from: Work, shot: ShotSpec, onStep: (step: number, cell: number) => void): ShotResult {
  return simulateShot(ctx, from, shot, undefined, (w, step) => {
    if (w.xc >= 0 && w.yc >= 0 && w.xc < ctx.course.w && w.yc < ctx.course.h) onStep(step, w.yc * ctx.course.w + w.xc);
  });
}

/** Run the whole search at once (tests, tools). */
export function solveNow(rules: RomRules, data: CourseData, opts: SolveOptions = {}): Solution {
  const g = solveHole(rules, data, opts);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
