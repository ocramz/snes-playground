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
export interface CourseData {
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
   * The hole's enemies as placed (the actor list's cells, $B538/$B578), in
   * list order. Phase 5 reads them for the aim target ($82:8E41); phase 6
   * spawns them.
   */
  enemies: Array<{ x: number; y: number }>;
}

/** Optional course fields; authored courses that omit them get defaults. */
export interface CourseExtras {
  screenBase?: number;
  enemies?: Array<{ x: number; y: number }>;
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
  return {
    w,
    h,
    shape: check(shape, 'shape'),
    elev: check(elev, 'elevation'),
    walls: check(walls, 'walls'),
    tile: check(tile, 'tile'),
    tee: { x: tee.x, y: tee.y },
    originY,
    // the bitmap is 224 lines taller than the origin row on hole 1 (456 =
    // 232 + 224); authored courses without a header use the same relation
    screenBase: extras.screenBase ?? originY + 224,
    enemies: (extras.enemies ?? []).map((e) => ({ x: e.x, y: e.y })),
  };
}

/** tools/export_web.py --only course → CourseData (the tests and PreloadScene). */
export function fromRomCourse(json: CourseJson): CourseData {
  return courseData(json.w, json.h, json.shape, json.elev, json.walls, json.tile, json.tee, json.word7, {
    screenBase: (json.header[5] ?? 0) * 8,
    enemies: json.enemies,
  });
}
