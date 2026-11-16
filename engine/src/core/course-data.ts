/**
 * The playfield as the kernels see it: the four grid layers plus the
 * dimensions and the tee. Shared by PreloadScene (shipped ROM holes),
 * the authored test courses and the tests (plans/port_v1_koota_phaser4.md,
 * "src/core/course-data.ts").
 *
 * Grid layers are one byte per cell, row-major, w * h entries:
 *   shape[i]  layer 1 ($7E:6B90): 0 = gap, 1 = flat, 2/3 = mound/dimple,
 *             $04-$1B the sloped shapes (docs/terrain.md)
 *   elev[i]   layer 3 ($7E:7390): the cell's base elevation, $00-$0F
 *   walls[i]  layer 4 ($7E:7B90): bit 0-3 = wall flag on the N/E/S/W edge
 *             ($80:8815 masks; the high nibble is unestablished and ignored)
 *   tile[i]   layer 2 ($7E:8390): the special-tile dispatch byte; the cup
 *             handler writes tile $08 into it at run time, so it is mutable
 */
import { isEnemyTile, ENEMY_LIST_MAX, TEE_TILE } from './sweep';
import { buildOcclusion, fromOcclusionJson, type OcclusionJson, type OcclusionTable } from './occlusion';
import { sweepWarps } from './sim/warp';
import { HOLE_SONG } from './traits/flow';

export interface CourseData {
  /** The hole's name (the ROM's MAPnn, or the authored file's). */
  name: string;
  w: number;
  h: number;
  shape: Uint8Array;
  elev: Uint8Array;
  walls: Uint8Array;
  tile: Uint8Array;
  /** The tee cell (docs: the marked $0C cell is the hole's start). */
  tee: { x: number; y: number };
  /**
   * $8B9E = header word 7 (232 on hole 1): the projection's row origin,
   * `py = originY + 16 (x - y) - 16 Z / $5A82` on the course bitmap
   * (docs/web-demo.md; read at $82:B1E8-$82:B1F5, the header copy to $8B90).
   */
  originY: number;
  /**
   * $8B9A = header word 5 x 8 (456 on hole 1, $82:B203-$82:B209): the base
   * the upward screen coordinates are measured from. Kirby's $DA5C and the
   * camera's $38AE count up from it; the scroll's y is `screenBase - $38AE`.
   */
  screenBase: number;
  /**
   * $8B98 = header word 4 x 8 ($82:B1FA-$82:B200): the course bitmap's
   * width in pixels, the look's right bound ($81:B8F7). Authored courses
   * use the bitmap's width, 32 (w + h).
   */
  mapWidth: number;
  /**
   * The hole's enemies as placed (the actor list's cells, $B538/$B578), in
   * the enemy list's order `$69DE`: the load-time sweep's, rows from the
   * top and each row from its last column ($82:B320; src/core/sweep.ts).
   * Derived from the tile layer, so ROM and authored holes agree.
   */
  enemies: Array<{ x: number; y: number }>;
  /**
   * Kirby's occlusion table: table 10 ($88:C570 → $7E:A3B2, occlusion.ts),
   * which $82:F4FD reads over a gap. A ROM hole has the game's own table, an
   * authored hole the one `buildOcclusion` makes.
   */
  occlusion: OcclusionTable;
  /**
   * The hole's song number (the request byte - $7E), which `$80:C967` plays
   * at the hole's start, after a lost ball and when Kirby wakes: a ROM hole's
   * from `$80:C99D`'s per-course list (course.json `song`), the authored and
   * generated holes course 1's HOLE_SONG.
   */
  song: number;
}

/** Optional course fields; authored courses that omit them get defaults. */
export interface CourseExtras {
  name?: string;
  screenBase?: number;
  mapWidth?: number;
  /** Table 10; absent: built from the shape layer (buildOcclusion). */
  occlusion?: OcclusionTable;
  /** The hole's song; absent: HOLE_SONG. */
  song?: number;
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
  /** Table 10 (tools/export_web.py `occlusion_table`); older exports lack it. */
  occlusion?: OcclusionJson;
  /** The hole's song, `$80:C99D`[course] -> [hole] - $7E; older exports lack it. */
  song?: number;
}

const N = (v: number): number => {
  if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`course byte out of range: ${v}`);
  return v;
};

/** Validate and freeze a course. Throws with the offending cell on bad data. */
export function courseData(
  w: number,
  h: number,
  shape: ArrayLike<number>,
  elev: ArrayLike<number>,
  walls: ArrayLike<number>,
  tile: ArrayLike<number>,
  tee: { x: number; y: number },
  originY: number,
  extras: CourseExtras = {},
): CourseData {
  const n = w * h;
  const check = (a: ArrayLike<number>, name: string): Uint8Array => {
    if (a.length !== n) throw new Error(`course ${name} layer has ${a.length} cells, expected ${n}`);
    return Uint8Array.from(a, N);
  };
  if (tee.x < 0 || tee.x >= w || tee.y < 0 || tee.y >= h) throw new Error(`tee outside the grid`);
  const shapes = check(shape, 'shape');
  return {
    w,
    h,
    shape: shapes,
    elev: check(elev, 'elevation'),
    walls: check(walls, 'walls'),
    tile: check(tile, 'tile'),
    tee: { x: tee.x, y: tee.y },
    originY,
    // the bitmap is 224 lines taller than the origin row on hole 1 (456 =
    // 232 + 224); authored courses without a header use the same relation
    screenBase: extras.screenBase ?? originY + 224,
    mapWidth: extras.mapWidth ?? 32 * (w + h),
    enemies: enemyCells(tile, w, h),
    name: extras.name ?? '',
    occlusion: extras.occlusion ?? buildOcclusion(w, h, shapes),
    song: extras.song ?? HOLE_SONG,
  };
}

/** The enemy tiles' cells in the sweep's order (rows down, columns right to left). */
export function enemyCells(tile: ArrayLike<number>, w: number, h: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < h; y++) {
    for (let x = w - 1; x >= 0; x--) {
      if (isEnemyTile(tile[y * w + x] & 0xff) && out.length < ENEMY_LIST_MAX) out.push({ x, y });
    }
  }
  return out;
}

/** tools/export_web.py --only course → CourseData (the tests and PreloadScene). */
export function fromRomCourse(json: CourseJson): CourseData {
  return courseData(json.w, json.h, json.shape, json.elev, json.walls, json.tile, json.tee, json.word7, {
    screenBase: (json.header[5] ?? 0) * 8,
    mapWidth: (json.header[4] ?? 0) * 8,
    name: json.name,
    occlusion: json.occlusion === undefined ? undefined : fromOcclusionJson(json.occlusion, json.w, json.h),
    song: json.song,
  });
}

/**
 * An authored test hole (the files under engine/courses; the format is in
 * engine/courses/README.md). Each layer is one string per row, cells as
 * two-digit hex bytes separated by spaces, `..` for 00.
 */
export interface AuthoredCourseJson {
  name: string;
  about?: string;
  w: number;
  h: number;
  shape: string[];
  elev?: string[];
  walls?: string[];
  tile?: string[];
  originY?: number;
  screenBase?: number;
}

/** What the validator needs to know beyond the grid (from RomRules, optional). */
export interface AuthoredChecks {
  /** $82:B6EB by species: authored holes use only ability-0 enemies. */
  enemyAbility?: ArrayLike<number>;
}

function parseLayer(rows: string[] | undefined, w: number, h: number, layer: string, name: string): number[] {
  if (rows === undefined) return new Array<number>(w * h).fill(0);
  if (rows.length !== h) throw new Error(`${name}: ${layer} has ${rows.length} rows, expected ${h}`);
  const out: number[] = [];
  rows.forEach((row, y) => {
    const cells = row.trim().split(/\s+/);
    if (cells.length !== w) throw new Error(`${name}: ${layer} row ${y} has ${cells.length} cells, expected ${w}`);
    cells.forEach((c, x) => {
      if (c === '..') {
        out.push(0);
        return;
      }
      if (!/^[0-9A-Fa-f]{2}$/.test(c)) throw new Error(`${name}: ${layer} (${x},${y}) is not a hex byte: ${c}`);
      out.push(parseInt(c, 16));
    });
  });
  return out;
}

/**
 * Parse and validate an authored hole. Throws with the offending cell:
 * - every layer the declared size, every cell a hex byte;
 * - shapes $00-$1B only (docs/terrain.md), elevations $00-$0F;
 * - exactly one tee tile $0C, on flat ground (docs/tiles.md: true of all
 *   212 ROM layouts); the tee is derived from it;
 * - at least two enemies (one is taken, the last becomes the cup), none
 *   with a copy ability (deferred) and no roulette $57;
 * - no actor tile on a gap;
 * - the warps ($B0-$B9) in pairs: each of the four lists ($B0-$B3, $B4-$B7,
 *   $B8, $B9) empty or two (with 3 or 4 the game picks at random, which is
 *   not ported; one alone hangs the game, sim/warp.ts), each on the ground.
 * `originY` defaults so that every cell projects below the top of the
 * bitmap: 16 x (h + the highest elevation + 2) + 32.
 */
export function fromAuthoredCourse(json: AuthoredCourseJson, checks: AuthoredChecks = {}): CourseData {
  const { w, h, name } = json;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new Error(`${name}: bad size ${w}x${h}`);
  const shape = parseLayer(json.shape, w, h, 'shape', name);
  const elev = parseLayer(json.elev, w, h, 'elev', name);
  const walls = parseLayer(json.walls, w, h, 'walls', name);
  const tile = parseLayer(json.tile, w, h, 'tile', name);
  let tee: { x: number; y: number } | null = null;
  let enemies = 0;
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    const at = `${name}: (${x},${y})`;
    if (shape[i] > 0x1b) throw new Error(`${at} shape $${shape[i].toString(16)} is not one of the 28`);
    if (elev[i] > 0x0f) throw new Error(`${at} elevation ${elev[i]} above 15`);
    const t = tile[i];
    if (t === TEE_TILE) {
      if (tee) throw new Error(`${at} a second tee (the first is at (${tee.x},${tee.y}))`);
      if (shape[i] !== 0x01) throw new Error(`${at} the tee must stand on flat ground`);
      tee = { x, y };
    }
    if (isEnemyTile(t)) {
      enemies++;
      if (t === 0x57) throw new Error(`${at} the roulette enemy $57 is not supported (deferred)`);
      const species = t >= 0x50 && t < 0x53 ? t - 0x50 + 0x0d : t - 0x40;
      if (checks.enemyAbility && (checks.enemyAbility[species] & 0xff) !== 0) {
        throw new Error(`${at} enemy $${t.toString(16)} gives a copy ability (deferred)`);
      }
    }
    if (t !== 0 && shape[i] === 0 && (isEnemyTile(t) || t === 0x02 || t >= 0x80)) {
      throw new Error(`${at} actor tile $${t.toString(16)} on a gap`);
    }
  }
  const warps = sweepWarps({ w, h, tile });
  warps.forEach((list, g) => {
    const at = list.map((c) => `(${c.x},${c.y})`).join(' ');
    if (list.length !== 0 && list.length !== 2) {
      throw new Error(`${name}: warp list ${g} has ${list.length} warps (${at}); warps come in pairs`);
    }
    for (const c of list) if (shape[c.y * w + c.x] === 0) throw new Error(`${name}: (${c.x},${c.y}) a warp on a gap`);
  });
  if (!tee) throw new Error(`${name}: no tee (tile 0C)`);
  if (enemies < 2) throw new Error(`${name}: ${enemies} enemies; a hole needs at least 2`);
  const maxElev = elev.reduce((m, v) => Math.max(m, v), 0);
  const originY = json.originY ?? 16 * (h + maxElev + 2) + 32;
  return courseData(w, h, shape, elev, walls, tile, tee, originY, {
    name,
    screenBase: json.screenBase ?? originY + Math.max(224, 16 * (w + 2)),
  });
}
