/**
 * Loaders for the ROM-derived fixtures. Everything is generated into
 * build/engine by the Makefile and is gitignored:
 *
 *   build/engine/rules/tables.json        make build/engine/rules/tables.json
 *   build/engine/rom-test/course.json     make build/engine/rom-test/.stamp
 *   build/engine/rom-test/terrain_golden.json   (same target)
 *   build/engine/rom-test/trace_web_*.json      make engine-traces
 *   build/engine/rom-test/flow_web_*.json       make engine-traces
 *
 * Tests that need them must `describe.skipIf(!haveRules)` etc., the same
 * convention as the web demo's test/load.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TablesJson } from '../src/core/rules';
import type { BallTrace, FlowTrace } from './align';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '../..');
const rulesDir = resolve(repo, 'build/engine/rules');
const romTestDir = resolve(repo, 'build/engine/rom-test');

export const haveRules = existsSync(resolve(rulesDir, 'tables.json'));
export const haveRomTest =
  existsSync(resolve(romTestDir, 'course.json')) && existsSync(resolve(romTestDir, 'terrain_golden.json'));

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The exported ROM hole (tools/export_web.py --only course). */
export interface CourseJson {
  index: number;
  name: string;
  header: number[];
  w: number;
  h: number;
  word7: number;
  zUnit: number;
  shape: number[];
  elev: number[];
  walls: number[];
  tile: number[];
  tee: { x: number; y: number; elevation: number };
  enemies: Array<{ x: number; y: number; tile: number; actor: number }>;
  objects: Array<{ x: number; y: number; tile: number; actor: number; type: number }>;
  edgeTiles: number[];
  /** The hole's song ($80:C99D's lists); older exports lack it. */
  song?: number;
}

/** tools/terrain.py Tables.surface_z sampled over every cell (golden fixture). */
export interface TerrainGolden {
  about: string;
  w: number;
  h: number;
  fracs: number[];
  z: number[];
}

export function loadTables(): TablesJson {
  return readJson(resolve(rulesDir, 'tables.json'));
}

export function loadRomCourse(): CourseJson {
  return readJson(resolve(romTestDir, 'course.json'));
}

export function loadGolden(): TerrainGolden {
  return readJson(resolve(romTestDir, 'terrain_golden.json'));
}

/** trace_web_grounder.json -> 'web_grounder'. Returns null when absent. */
export function loadTrace(name: string): BallTrace | null {
  const path = resolve(romTestDir, `trace_${name}.json`);
  return existsSync(path) ? readJson(path) : null;
}

export function loadFlow(name: string): FlowTrace | null {
  const path = resolve(romTestDir, `flow_${name}.json`);
  return existsSync(path) ? readJson(path) : null;
}

/** The committed input scripts the traces were recorded with. */
export function inputScriptPath(name: string): string {
  return resolve(repo, `tools/snesstep/inputs/${name}.txt`);
}

/** One sound request of the game: [frame, line, iteration, kind, id, caller]. */
export type SoundRequest = [number, number, number, 'sfx' | 'song', number, string];

/** sounds_web_flow.json (tools/snesstep/trace_flow.py). Returns null when absent. */
export function loadSounds(name: string): SoundRequest[] | null {
  const path = resolve(romTestDir, `sounds_${name}.json`);
  return existsSync(path) ? readJson<{ requests: SoundRequest[] }>(path).requests : null;
}

/**
 * The main loop's iteration a stamped record belongs to: the loop often
 * runs past the vblank, so a store in the first lines of frame F is the
 * iteration of F - 1 (trace_flow.py ITERATION_LINE).
 */
export const ITERATION_LINE = 112;
export function iterationOf(frame: number, line: number | undefined): number {
  return line !== undefined && line < ITERATION_LINE ? frame - 1 : frame;
}

/** build/engine/rom-test/holes/<n>/course.json (the Makefile's rom-test target). */
export function loadRomHole(n: number): CourseJson | null {
  const path = resolve(romTestDir, `holes/${n}/course.json`);
  return existsSync(path) ? readJson(path) : null;
}

/** A file in build/engine/rom-test, for loaders that live elsewhere. */
export function romTestPath(name: string): string {
  return resolve(romTestDir, name);
}
