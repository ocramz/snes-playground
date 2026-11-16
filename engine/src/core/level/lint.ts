/**
 * What the level editor reports about a level (docs/editor.md "Lint"):
 * - errors, which block Play and Share: whatever the engine's validator
 *   (`fromAuthoredCourse`) rejects, more than 16 enemies, and the bytes that
 *   must never be authored (the cup $08, the water bytes $60/$62/$63 that
 *   hang the ROM);
 * - warnings: placements the ROM never makes, tiles outside the editor's
 *   palette, more than 8 enemy species (the ROM's VRAM, $82:B730), a marking
 *   the styled art does not draw;
 * - the steps: the edges between solid cells that do not meet flush, which
 *   the grid view draws (a step up stops the ball, a drop launches it).
 */
import { fromAuthoredCourse, type AuthoredCourseJson, type CourseData } from '../course-data';
import type { RomRules } from '../rules';
import type { EdgeDelta } from '../gen/grid';
import { isEnemyTile, enemySpecies, ENEMY_LIST_MAX, TEE_TILE } from '../sweep';
import { isWaterTile, paletteEntry, placementError, waterTile } from './palette';
import type { Level } from './ops';

export type Severity = 'error' | 'warning' | 'info';

export interface LintIssue {
  severity: Severity;
  message: string;
  /** The cells it is about (indices), for the grid view. */
  cells: number[];
}

export interface LintResult {
  issues: LintIssue[];
  /** Any error: the level cannot be played or shared as it is. */
  ok: boolean;
  /** The engine's hole, when the validator accepts it. */
  data: CourseData | null;
  json: AuthoredCourseJson;
  /** The non-flush edges (needs the rules; empty without them). */
  steps: EdgeDelta[];
  /** Can the solver's par be trusted (only tiles it is checked on)? */
  solverSafe: boolean;
}

/**
 * The solver's shots into the water rest where the whole world's do, and
 * its plan on a pond holes out (test/level-play.test.ts, 2026-11-16: seven
 * shots into a pond made with the editor's operations). Were it false, the
 * editor would mark a water level's par unverified.
 */
export const WATER_SOLVER_VERIFIED = true;

const NEVER = new Map<number, string>([
  [0x08, 'the cup $08 is written in play, never authored'],
  [0x60, 'water byte $60 hangs the game'],
  [0x62, 'water byte $62 hangs the game'],
  [0x63, 'water byte $63 hangs the game'],
]);

/** The level as the authored format (engine/courses/README.md). */
export function levelJson(level: Level): AuthoredCourseJson {
  return level.grid.toJson(level.name, 'level editor');
}

export function lintLevel(level: Level, rules: RomRules | null): LintResult {
  const g = level.grid;
  const json = levelJson(level);
  const issues: LintIssue[] = [];
  const add = (severity: Severity, message: string, cells: number[] = []): void => {
    issues.push({ severity, message, cells });
  };

  let data: CourseData | null = null;
  try {
    data = fromAuthoredCourse(json, rules ? { enemyAbility: rules.table('enemyAbility') } : {});
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    add('error', message.replace(/^[^:]*: /, ''), cellsIn(message, g.w, g.h));
  }

  const enemies: number[] = [];
  const species = new Set<number>();
  const never = new Map<string, number[]>();
  const offPalette = new Map<number, number[]>();
  const placement = new Map<string, number[]>();
  const noArt: number[] = [];
  const onGap: number[] = [];
  let water = false;
  for (let i = 0; i < g.w * g.h; i++) {
    const t = g.tile[i];
    if (t === 0) continue;
    const s = g.shape[i];
    if (isEnemyTile(t)) {
      enemies.push(i);
      species.add(enemySpecies(t));
    }
    const nv = NEVER.get(t);
    if (nv) {
      push(never, nv, i);
      continue;
    }
    if (s === 0) {
      onGap.push(i);
      continue;
    }
    if (isWaterTile(t)) {
      water = true;
      if (waterTile(s) !== t) push(placement, `water $${hex(t)} does not restate its cell's shape ($60 + shape)`, i);
      continue;
    }
    if (!paletteEntry(t)) {
      push(offPalette, t, i);
      continue;
    }
    if (t === 0x19) noArt.push(i);
    if (t === TEE_TILE) continue; // the validator's
    const why = placementError(t, s);
    if (why) push(placement, why, i);
  }

  if (enemies.length > ENEMY_LIST_MAX) {
    add('error', `${enemies.length} enemies: the enemy list holds ${ENEMY_LIST_MAX}`, enemies.slice(ENEMY_LIST_MAX));
  }
  for (const [why, cells] of never) add('error', why, cells);
  for (const [why, cells] of placement) add('warning', `${why} (the ROM never does otherwise)`, cells);
  if (species.size > 8) add('warning', `${species.size} enemy species: the ROM loads at most 8 a hole`, enemies);
  if (onGap.length > 0) add('warning', 'markings on a gap do nothing', onGap);
  for (const [t, cells] of offPalette) add('warning', `tile $${hex(t)} is outside the editor's palette: it plays, but the par is unverified`, cells);
  if (noArt.length > 0) add('info', 'the snap $19 has no art: it draws as plain ground', noArt);
  if (water && !WATER_SOLVER_VERIFIED) add('info', 'water: the par is unverified', []);

  const steps = rules ? g.edgeDeltas(rules) : [];
  if (steps.length > 0) {
    add('info', `${steps.length} step${steps.length > 1 ? 's' : ''}: a step up stops a rolling ball, a drop launches it`, []);
  }
  const ok = !issues.some((x) => x.severity === 'error');
  const solverSafe = offPalette.size === 0 && (!water || WATER_SOLVER_VERIFIED);
  return { issues, ok, data: ok ? data : null, json, steps, solverSafe };
}

function push<K>(m: Map<K, number[]>, k: K, i: number): void {
  const l = m.get(k);
  if (l) l.push(i);
  else m.set(k, [i]);
}

function hex(v: number): string {
  return v.toString(16).toUpperCase().padStart(2, '0');
}

/** The "(x,y)" cells a validator message names. */
function cellsIn(message: string, w: number, h: number): number[] {
  const out: number[] = [];
  for (const m of message.matchAll(/\((\d+),(\d+)\)/g)) {
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x < w && y < h) out.push(y * w + x);
  }
  return out;
}
