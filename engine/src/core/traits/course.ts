/**
 * The course grid, an AoS world singleton (plans/port_v1_koota_phaser4.md,
 * "World singletons"). The layer arrays are shared with the CourseData the
 * loaders build; `layer2` is the mutable tile array (the cup writes $08).
 */
import { trait } from 'koota';
import type { CourseData } from '../course-data';

export interface CourseState {
  w: number;
  h: number;
  shape: Uint8Array;
  elev: Uint8Array;
  walls: Uint8Array;
  layer2: Uint8Array;
  tee: { x: number; y: number };
  originY: number;
  screenBase: number;
  /** $8B98: the course bitmap's width (course-data.ts). */
  mapWidth: number;
  enemies: Array<{ x: number; y: number }>;
}

export const Course = trait((): CourseState => ({
  w: 0,
  h: 0,
  shape: new Uint8Array(0),
  elev: new Uint8Array(0),
  walls: new Uint8Array(0),
  layer2: new Uint8Array(0),
  tee: { x: 0, y: 0 },
  originY: 0,
  screenBase: 0,
  mapWidth: 0,
  enemies: [],
}));

/** The world's course singleton entity, created on demand. */
export function courseEntity(world: import('koota').World): import('koota').Entity {
  const existing = world.queryFirst(Course);
  if (existing !== undefined) return existing;
  return world.spawn(Course());
}

export function setCourse(world: import('koota').World, data: CourseData): void {
  const e = courseEntity(world);
  const c = e.get(Course)!;
  // A fresh copy of layer 2 per hole: the cup handler mutates it.
  c.w = data.w;
  c.h = data.h;
  c.shape = data.shape;
  c.elev = data.elev;
  c.walls = data.walls;
  c.layer2 = Uint8Array.from(data.tile);
  c.tee = { ...data.tee };
  c.originY = data.originY;
  c.screenBase = data.screenBase;
  c.mapWidth = data.mapWidth;
  c.enemies = data.enemies.map((e) => ({ ...e }));
  e.changed(Course);
}
