/**
 * Random holes (plans/random_holes.md): a seed names a course. Each hole is
 * laid out (layout.ts), furnished (features.ts), given its tee and enemies
 * (place.ts), validated as an authored course (`fromAuthoredCourse`, the
 * same rules as engine/courses), checked for edges no layout asked for, and
 * then played by the solver (solve.ts) with the engine's own physics; only
 * a hole with a plan is kept. A failed attempt retries with the next derived
 * seed.
 *
 * `GEN_VERSION` names the generator: a seed's holes depend on the layouts
 * and on the physics the solver ran, so it goes into the course label.
 */
import { fromAuthoredCourse, type AuthoredCourseJson, type CourseData } from '../course-data';
import type { RomRules } from '../rules';
import { buildLayout, type LayoutParams } from './layout';
import { placeActors, type PlaceParams } from './place';
import { addFeatures, type FeatureParams } from './features';
import { Rng, mixSeed } from './rng';
import { solveHole, type SolveOptions, type Solution } from './solve';

export const GEN_VERSION = 1;

export type Difficulty = 0 | 1 | 2;
export const DIFFICULTY_NAMES = ['EASY', 'NORMAL', 'HARD'] as const;

export interface Preset {
  layout: LayoutParams;
  place: PlaceParams;
  features: FeatureParams;
  /** The plan's length must fall in this window. */
  par: [number, number];
}

export const PRESETS: Record<Difficulty, Preset> = {
  0: {
    layout: {
      slot: [5], lattice: [2, 3], path: [3, 4], branch: 0.2, startElev: [1, 2],
      rise: [5, 2, 2, 0], stepDown: 0.2, wideDoor: 0.7, bump: 0.3, wall: 1,
    },
    place: { enemies: [2, 3], hover: 0, nearTee: 0.3 },
    features: { budget: [0, 2], groups: ['rough', 'friction', 'arrow', 'boost', 'tree'] },
    par: [2, 4],
  },
  1: {
    layout: {
      slot: [4, 5], lattice: [2, 3, 4], path: [3, 5], branch: 0.35, startElev: [1, 3],
      rise: [4, 3, 2, 1], stepDown: 0.35, wideDoor: 0.5, bump: 0.45, wall: 0.6,
    },
    place: { enemies: [3, 4], hover: 0.15, nearTee: 0.3 },
    features: { budget: [1, 4], groups: ['rough', 'friction', 'arrow', 'boost', 'kicker', 'tree', 'warp'] },
    par: [3, 6],
  },
  2: {
    layout: {
      slot: [4, 5], lattice: [3, 4], path: [4, 6], branch: 0.5, startElev: [1, 4],
      rise: [3, 3, 2, 2], stepDown: 0.5, wideDoor: 0.35, bump: 0.6, wall: 0.25,
    },
    place: { enemies: [3, 5], hover: 0.3, nearTee: 0.2 },
    features: { budget: [2, 6], groups: ['rough', 'friction', 'arrow', 'boost', 'kicker', 'snap', 'tree', 'warp'] },
    par: [3, 8],
  },
};

export interface GenOptions {
  difficulty?: Difficulty;
  /** Attempts per hole before giving up. */
  maxAttempts?: number;
  solve?: SolveOptions;
  /** Skip the solver (tests of the layouts only). */
  unsolved?: boolean;
}

export interface GeneratedHole {
  seed: number;
  attempt: number;
  json: AuthoredCourseJson;
  data: CourseData;
  solution: Solution | null;
}

export interface GenProgress {
  hole: number;
  attempt: number;
  /** Shots the solver has simulated in this attempt. */
  shots: number;
}

/** The hole's derived seed for an attempt. */
export function attemptSeed(seed: number, attempt: number): number {
  return attempt === 0 ? seed >>> 0 : mixSeed(seed, attempt);
}

/** One hole's terrain, tee, enemies and tiles, unsolved; null when the attempt failed. */
export function buildHole(rules: RomRules, seed: number, difficulty: Difficulty, name: string): { json: AuthoredCourseJson; data: CourseData } | null {
  const preset = PRESETS[difficulty];
  const rng = new Rng(seed);
  const layout = buildLayout(rng, rules, preset.layout);
  if (!layout) return null;
  const placed = placeActors(rng, rules, layout, preset.place);
  if (!placed) return null;
  addFeatures(rng, rules, layout, preset.features);
  if (layout.grid.unintendedSteps(rules).length > 0) return null;
  const about = `random hole, generator v${GEN_VERSION}, seed ${seed >>> 0}, ${DIFFICULTY_NAMES[difficulty].toLowerCase()}`;
  const json = layout.grid.toJson(name, about);
  try {
    const data = fromAuthoredCourse(json, { enemyAbility: rules.table('enemyAbility') });
    return { json, data };
  } catch {
    return null;
  }
}

/** One hole; yields after every simulated shot. */
export function* generateHole(rules: RomRules, seed: number, hole: number, opts: GenOptions = {}): Generator<GenProgress, GeneratedHole> {
  const difficulty = opts.difficulty ?? 1;
  const preset = PRESETS[difficulty];
  const maxAttempts = opts.maxAttempts ?? 40;
  const name = `RND${(seed >>> 0).toString(16).toUpperCase()}-${hole + 1}`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const s = attemptSeed(seed, attempt);
    const built = buildHole(rules, s, difficulty, name);
    if (!built) continue;
    if (opts.unsolved) return { seed: s, attempt, ...built, solution: null };
    const solver = solveHole(rules, built.data, opts.solve);
    let r = solver.next();
    while (!r.done) {
      yield { hole, attempt, shots: r.value };
      r = solver.next();
    }
    const sol = r.value;
    if (sol.ok && sol.par >= preset.par[0] && sol.par <= preset.par[1]) {
      return { seed: s, attempt, ...built, solution: sol };
    }
  }
  throw new Error(`no winnable hole for seed ${seed} after ${maxAttempts} attempts`);
}

/** A course of `holes` holes from one seed; yields after every simulated shot. */
export function* generateCourse(
  rules: RomRules, seed: number, holes = 8, opts: GenOptions = {},
): Generator<GenProgress, GeneratedHole[]> {
  const out: GeneratedHole[] = [];
  for (let k = 0; k < holes; k++) out.push(yield* generateHole(rules, mixSeed(seed, 1000 + k), k, opts));
  return out;
}

/** Run a generator to its end (tests, tools). */
export function runToEnd<T>(g: Generator<unknown, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
