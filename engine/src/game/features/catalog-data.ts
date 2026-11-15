/**
 * The view catalog's data (pure; reference §9 "view catalog"): what each
 * semantic `Visual.kind` is drawn with — atlas frame and clip names, never a
 * Phaser object. features/view-catalog.ts turns these into views; the
 * catalog test checks every name against the exported atlases.
 */
import type { AtlasJson } from '../assets/schema';

/** Which atlas: sprites.json ('atlas') or objects.json ('objects'). */
export type AtlasId = 'atlas' | 'objects';

export interface KindArt {
  atlas: AtlasId;
  /** A looping or one-shot clip, if animated. */
  clip?: string;
  /** A still frame (also the first picture before a clip starts). */
  frame?: string;
}

/** Visual kinds (core/traits/visual.ts) -> their art. 'ball' is Kirby: its clip comes from poseClip. */
export const KIND_ART: Record<string, KindArt> = {
  ball: { atlas: 'atlas', clip: 'ball_roll' },
  tee: { atlas: 'atlas', frame: 'tee' },
  enemy: { atlas: 'atlas', clip: 'enemy_idle' },
  star: { atlas: 'atlas', clip: 'star' },
  // the last enemy's sheet pictures 16-20 open into the hole; the ring is object 74
  cup: { atlas: 'atlas', clip: 'cup_open', frame: 'enemy_0' },
  pillar: { atlas: 'atlas', frame: 'tree' },
  hazard: { atlas: 'objects' },
};

/** The cup's ring (object 74, a still of obj_074) and the ball's shadow (obj_121). */
export const CUP_RING_FRAME = 'cupring';
export const SHADOW_FRAME = 'shadow';

/**
 * The hazard actors' picture: objects.json lists each type's frame tables in
 * sheet order and the pictures by the thread's frame number ($5D9C).
 * Object 76's four tables are its four directions (tables 1 and 3 are the
 * mirror images of 0 and 2 in build/sprites/emu/obj_076.png), so the table is
 * the run's `dir` (0 N, 1 E, 2 S, 3 W; the order is inferred). 77's four are
 * one per look and 81-83 have one; both use the first, the one course 1 and
 * its neighbours show (unconfirmed per course).
 */
export function hazardFrame(
  objects: AtlasJson | null,
  type: number,
  dir: number,
  frame: number,
): string | null {
  const sheet = objects?.objects?.[String(type)];
  if (!sheet) return null;
  const table = type === 76 ? dir & 3 : 0;
  const row = sheet.frames[Math.min(table, sheet.frames.length - 1)] ?? [];
  const f = frame === 0xffff || frame < 0 ? 0 : frame;
  return row[f] ?? row[0] ?? null;
}

/** The hazard object types the engine spawns (sim/actors.ts). */
export const HAZARD_TYPES = [76, 77, 81, 82, 83] as const;
