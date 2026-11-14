/**
 * The shot guide's pictures (pure): the dots along the path the guide
 * simulated and the cone at its end (docs/web-demo.md "Guide"; ui.json's
 * guide note, measured over 31 aim angles):
 * - Guide.points is already one point per dot (a dot every 3 steps, 5 in a
 *   fly shot; core/sim/guide.ts `$81:AC93`);
 * - a dot's 8 x 8 centre sits at its point + (-3, 0);
 * - the dots march outward one spacing per 20 frames, in 4 steps (the game's
 *   own marching is in four steps; how it orders them is not traced, so each
 *   dot moves toward the next point — unconfirmed);
 * - the cone's top-left is at the first end + (-6, -15).
 * The fly shot's shrinking dot tiles are not exported: every dot uses the
 * rolling shot's picture.
 */
import type { GuidePoint, GuideEnd } from '../../../core/traits/guide';
import type { ProjectionOrigin } from '../../../core/projection';
import { bitmapOf, worldOf, type WorldPoint } from '../../bridge/placement';

export const MARCH_FRAMES = 20;
export const MARCH_STEPS = 4;

export interface GuidePictures {
  /** Top-left of each dot's 8 x 8 tile, in world pixels. */
  dots: WorldPoint[];
  /** Top-left of the cone (8 x 16), or null. */
  cone: WorldPoint | null;
}

export function guidePictures(
  origin: ProjectionOrigin,
  points: readonly GuidePoint[],
  ends: readonly GuideEnd[],
  frame: number,
): GuidePictures {
  const k = Math.floor((((frame % MARCH_FRAMES) + MARCH_FRAMES) % MARCH_FRAMES) / (MARCH_FRAMES / MARCH_STEPS));
  const at = points.map((p) => worldOf(origin, p.xc, p.xf, p.yc, p.yf, p.z));
  const dots: WorldPoint[] = [];
  for (let i = 0; i < at.length; i++) {
    const p = at[i];
    const q = at[i + 1];
    if (!q && k > 0) continue;
    const x = q ? p.x + Math.round(((q.x - p.x) * k) / MARCH_STEPS) : p.x;
    const y = q ? p.y + Math.round(((q.y - p.y) * k) / MARCH_STEPS) : p.y;
    dots.push({ x: x - 3 - 4, y: y - 4 });
  }
  const end = ends[0];
  const c = end ? bitmapOf(origin, end.sx, end.sy) : null;
  return { dots, cone: c ? { x: c.x - 6, y: c.y - 15 } : null };
}
