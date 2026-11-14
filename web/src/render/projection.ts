// World -> course-bitmap pixels (docs/courses.md, verified against 230 of 232
// holes): px = 32 (x + y), py = word7 + 16 (x - y) - 16 Z / $5A82, with x, y
// in cells (fraction included) and Z the 16.16 world height. Screen y is down,
// so +x runs down-right and +y up-right.

export const Z_STEP = 0x5a82;

export interface Proj { x: number; y: number }

export function project(word7: number, xc: number, xf: number, yc: number, yf: number, z: number, out: Proj = { x: 0, y: 0 }): Proj {
  const x = xc + xf / 65536;
  const y = yc + yf / 65536;
  out.x = 32 * (x + y);
  out.y = word7 + 16 * (x - y) - (16 * z) / Z_STEP;
  return out;
}
