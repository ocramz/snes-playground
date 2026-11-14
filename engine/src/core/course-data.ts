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
  /** Header word 4 = 4*(w+h): the screen projection's row origin. */
  originY: number;
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
  };
}

/** tools/export_web.py --only course → CourseData (the tests and PreloadScene). */
export function fromRomCourse(json: CourseJson): CourseData {
  const originY = json.header[3] ?? 0;
  return courseData(json.w, json.h, json.shape, json.elev, json.walls, json.tile, json.tee, originY);
}
