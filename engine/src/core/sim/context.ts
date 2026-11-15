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
  /**
   * $69CA: the water is off, its tiles plain ground (sim/water.ts). The load
   * sets it when the hole has `$5D` and no `$5C` (`$82:BC59`, the byte counts
   * of `$7E:B3B8`); the `$5C`/`$5D` tiles toggle it in play (not ported).
   */
  waterOff?: boolean;
}

/** $82:BC59's `$69CA`: `$5D` cells and no `$5C` (the counts are bytes). */
export function waterOffAtLoad(layer2: Uint8Array): boolean {
  let c5c = 0;
  let c5d = 0;
  for (const t of layer2) {
    if (t === 0x5c) c5c++;
    else if (t === 0x5d) c5d++;
  }
  return (c5c & 0xff) === 0 && (c5d & 0xff) !== 0;
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
    waterOff: waterOffAtLoad(data.tile),
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
