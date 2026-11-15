/**
 * Where things are drawn, in course-bitmap pixels (pure; the transform half
 * of `sync-transforms`, reference §9). The projection is core's
 * (core/projection.ts): x = 32 (x + y) right, y counted upward from
 * screenBase; the course bitmap's y is screenBase - y (docs/web-demo.md
 * "Projection"). A sprite's top-left is its position - (ox, oy), which the
 * textures carry as the frame pivot (assets/atlas.ts).
 *
 * Positions (docs/web-demo.md, export_web_sprites.py's docstring, measured):
 * - Kirby and the ball: the projection the game itself keeps, BallScreen
 *   ($DA56-$DA5C).
 * - enemies, pillars, the cup and its ring: the corner of their cell
 *   (xf = yf = 0) at actorGround's Z ($82:B44B), plus a hover's height.
 * - the tee pad: Kirby's point on the tee, one pixel up (pinned by the
 *   cutscene test against the recorded tee anchor (320, 263) of hole 1).
 * - the hazards: their thread's own x, y, z (sim/actors.ts ActorRun).
 */
import { project, type ProjectionOrigin } from '../../core/projection';
import { actorGround } from '../../core/sweep';
import { surfaceZ } from '../../core/terrain';
import type { RomRules } from '../../core/rules';

export interface WorldPoint {
  x: number;
  y: number;
}

export interface CourseShape extends ProjectionOrigin {
  w: number;
  shape: ArrayLike<number>;
  elev: ArrayLike<number>;
}

const s16 = (v: number): number => {
  const w = v & 0xffff;
  return w >= 0x8000 ? w - 0x10000 : w;
};

/** A projected point (x, upward y) -> course-bitmap pixels. */
export function bitmapOf(origin: ProjectionOrigin, px: number, py: number): WorldPoint {
  return { x: s16(px), y: s16(origin.screenBase - py) };
}

/** The work copy's units (cells + 16-bit fractions, 16.16 Z) -> bitmap pixels. */
export function worldOf(
  origin: ProjectionOrigin,
  xc: number, xf: number, yc: number, yf: number, z: number,
): WorldPoint {
  const p = project(origin, xc & 0xffff, xf & 0xffff, yc & 0xffff, yf & 0xffff, z);
  return bitmapOf(origin, p.x, p.y);
}

/** An actor on its cell's corner, `lift` height steps above the ground there. */
export function cellCorner(rules: RomRules, course: CourseShape, x: number, y: number, lift = 0): WorldPoint {
  return worldOf(course, x, 0, y, 0, actorGround(rules, course, x, y) + Math.round(lift * rules.zUnit));
}

/** Kirby's drawn point (BallScreen). */
export function kirbyPoint(origin: ProjectionOrigin, screen: { x: number; y: number }): WorldPoint {
  return bitmapOf(origin, screen.x, screen.y);
}

/** The tee pad, from Kirby's point on the tee at the hole's start. */
export function teePadPoint(kirbyOnTee: WorldPoint): WorldPoint {
  return { x: kirbyOnTee.x, y: kirbyOnTee.y - 1 };
}

/** The tee pad of a course: Kirby's point on the tee's centre (startHole puts him there), 1 px up. */
export function teePad(rules: RomRules, course: CourseShape & { tee: { x: number; y: number } }): WorldPoint {
  const i = course.tee.y * course.w + course.tee.x;
  const z = surfaceZ(rules, course.shape[i] & 0xff, course.elev[i] & 0xff, 0x8000, 0x8000);
  return teePadPoint(worldOf(course, course.tee.x, 0x8000, course.tee.y, 0x8000, z));
}

/** A hazard actor's thread position (16.16 x, y, z). */
export function actorRunPoint(origin: ProjectionOrigin, a: { x: number; y: number; z: number }): WorldPoint {
  return worldOf(origin, a.x >>> 16, a.x & 0xffff, a.y >>> 16, a.y & 0xffff, a.z);
}

/** A bitmap point on the screen, given the scroll. */
export function screenOf(p: WorldPoint, scroll: WorldPoint): WorldPoint {
  return { x: p.x - scroll.x, y: p.y - scroll.y };
}
