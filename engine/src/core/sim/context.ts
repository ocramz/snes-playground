/**
 * The kernel context: the immutable inputs every kernel reads. Kernels are
 * pure functions over `(ctx, work)` — no world access, no events
 * (plans/port_v1_koota_phaser4.md: "Kernels never emit").
 */
import type { RomRules } from '../rules';
import type { CourseData } from '../course-data';
import type { BallWorkFields } from '../traits/ball';
import { sweepWarps } from './warp';

export interface KernelCourse {
  w: number;
  h: number;
  shape: Uint8Array;
  elev: Uint8Array;
  walls: Uint8Array;
  layer2: Uint8Array;
  /** The projection's origins ($8B9E, $8B9A): see CourseData. */
  originY: number;
  screenBase: number;
  /** The hole's hazard actors, shared with the world (absent: no hazards). */
  hazards?: import('./hazards').HazardField;
  /** The warp lists ($82:BD5C; absent: none). */
  warps?: import('./warp').WarpLists;
  /** Kirby's occlusion table, table 10 (../occlusion.ts; absent: no records). */
  occlusion?: import('../occlusion').OcclusionTable;
}

/**
 * `$82:BC59`'s test on the counts of `$7E:B3B8` (bytes, read as the word of
 * a pair): a pair present, and none of its first value. `$6A2A` for `$5A`/
 * `$5B`, `$69CA` for `$5C`/`$5D` (and `$6A2E` for `$58`/`$59`, step 9).
 */
function secondWithoutFirst(layer2: Uint8Array, first: number): boolean {
  let a = 0;
  let b = 0;
  for (const t of layer2) {
    if (t === first) a++;
    else if (t === first + 1) b++;
  }
  return (a & 0xff) === 0 && (b & 0xff) !== 0;
}

/** $82:BC59's `$69CA`: `$5D` cells and no `$5C` (the water off at the load). */
export function waterOffAtLoad(layer2: Uint8Array): boolean {
  return secondWithoutFirst(layer2, 0x5c);
}

/** $82:BC59's `$6A2A`: `$5B` cells and no `$5A` (the `$74-$77` swirls on at the load). */
export function toggleOnAtLoad(layer2: Uint8Array): boolean {
  return secondWithoutFirst(layer2, 0x5a);
}

export function kernelCourse(data: CourseData): KernelCourse {
  return {
    w: data.w,
    h: data.h,
    shape: data.shape,
    elev: data.elev,
    walls: data.walls,
    layer2: data.tile,
    originY: data.originY,
    screenBase: data.screenBase,
    warps: sweepWarps(data),
    occlusion: data.occlusion,
  };
}

export interface Ctx {
  rules: RomRules;
  course: KernelCourse;
  /**
   * $6AC0: 0 while the shot guide simulates ($81:A619, $81:A9BB), 1 in the
   * shot thread, 2 in the roll ($82:C027). The kernels branch on it where
   * the ROM does: the outline wall's silent path ($82:9188) and the spin
   * effect spawn ($81:8CEC). Absent means play (true).
   */
  presentation?: boolean;
}

export type Work = BallWorkFields;
