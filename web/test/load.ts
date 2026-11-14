// Loads the exporter's output for the tests. The files are ROM-derived and
// gitignored; run `python3 tools/export_web.py --golden` first.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rom, type CourseJson, type TablesJson } from '../src/sim/tables';
import { Terrain } from '../src/sim/terrain';
import type { BallWorld } from '../src/sim/ball';

const here = fileURLToPath(new URL('.', import.meta.url));
const web = resolve(here, '../../build/web');
const testDir = resolve(here, '../../build/web-test');

export const haveAssets = existsSync(resolve(web, 'tables.json')) && existsSync(resolve(web, 'course.json'));
export const haveGolden = existsSync(resolve(testDir, 'terrain_golden.json'));

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadRom(): { rom: Rom; course: CourseJson; terrain: Terrain } {
  const tables = readJson<TablesJson>(resolve(web, 'tables.json'));
  const course = readJson<CourseJson>(resolve(web, 'course.json'));
  const rom = new Rom(tables);
  return { rom, course, terrain: new Terrain(rom, course) };
}

export function loadGolden(): { w: number; h: number; fracs: number[]; z: number[] } {
  return readJson(resolve(testDir, 'terrain_golden.json'));
}

/** A world with no enemies, for physics tests. */
export function bareWorld(terrain: Terrain): BallWorld {
  return {
    terrain,
    enemyHeight: () => 0,
    takeEnemy: () => undefined,
    enemyUntaken: () => false,
  };
}
