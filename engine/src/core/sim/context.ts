/**
 * The kernel context: the immutable inputs every kernel reads. Kernels are
 * pure functions over `(ctx, work)` — no world access, no events
 * (plans/port_v1_koota_phaser4.md: "Kernels never emit").
 */
import type { RomRules } from '../rules';
import type { CourseData } from '../course-data';
import type { BallWorkFields } from '../traits/ball';

export interface KernelCourse {
  w: number;
  h: number;
  shape: Uint8Array;
  elev: Uint8Array;
  walls: Uint8Array;
  layer2: Uint8Array;
}

export function kernelCourse(data: CourseData): KernelCourse {
  return {
    w: data.w,
    h: data.h,
    shape: data.shape,
    elev: data.elev,
    walls: data.walls,
    layer2: data.tile,
  };
}

export interface Ctx {
  rules: RomRules;
  course: KernelCourse;
}

export type Work = BallWorkFields;
