/**
 * The water's dissolve as the view draws it (port_v2 phase 6; core's
 * `Switches.dissolve`, systems/switches.ts). Pure, no Phaser: the exporter's
 * `layer_{back,front}_dissolve.png` gives each water pixel its step in red
 * (tools/export_web.py `dissolve_map`: `$80:9271` read back, the tile's
 * flips applied), and a pixel is the water's once its step is done while the
 * water comes in, until its step is done while it goes.
 */

/** The water pixels of a layer: their indices (y * w + x) and steps. */
export interface DissolveMap {
  index: Int32Array;
  step: Uint8Array;
  /** The bounding box of the water pixels, for the canvas's dirty rect. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** From the exported map's RGBA (alpha 255 = a water pixel, red its step). */
export function dissolveMap(rgba: Uint8ClampedArray, width: number): DissolveMap {
  const idx: number[] = [];
  const steps: number[] = [];
  let x0 = width;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i * 4 < rgba.length; i++) {
    if (rgba[i * 4 + 3] === 0) continue;
    idx.push(i);
    steps.push(rgba[i * 4]);
    const x = i % width;
    const y = Math.floor(i / width);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  return { index: Int32Array.from(idx), step: Uint8Array.from(steps), x0, y0: Number.isFinite(y0) ? y0 : 0, x1, y1 };
}

/** Is a water pixel shown after `done` steps (0-64) of a dissolve that brings the water (`appear`) or takes it? */
export function waterShown(step: number, done: number, appear: boolean): boolean {
  return appear ? step < done : step >= done;
}

/**
 * Write the alpha of `out` from `orig` (same size, RGBA) at the map's water
 * pixels: the original's where the water shows, 0 elsewhere. Pixels off the
 * map are left as they are.
 */
export function applyDissolve(map: DissolveMap, orig: Uint8ClampedArray, out: Uint8ClampedArray, done: number, appear: boolean): void {
  for (let k = 0; k < map.index.length; k++) {
    const a = map.index[k] * 4 + 3;
    out[a] = waterShown(map.step[k], done, appear) ? orig[a] : 0;
  }
}
