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

/**
 * An enemy's idle clip by its species (core's EnemyKind.species, tile - $40
 * with $50-$52 folded onto $4D-$4F): `enemy_XX_idle`, XX the species' tile,
 * as tools/snesstep/trace_enemies.py recorded it on a hole that has it; the
 * hole-1 sheet's `enemy_idle` ($4C) when the atlas lacks it.
 */
export function enemyClip(atlas: AtlasJson | null, species: number): string {
  const name = `enemy_${(0x40 + species).toString(16).toUpperCase().padStart(2, '0')}_idle`;
  return atlas?.clips[name] ? name : 'enemy_idle';
}

/** The cup's ring (object 74, a still of obj_074) and the ball's shadow (obj_121). */
export const CUP_RING_FRAME = 'cupring';
export const SHADOW_FRAME = 'shadow';

/**
 * The hazard actors' picture: objects.json lists each type's frame tables in
 * sheet order and the pictures by the thread's frame number ($5D9C). The
 * table is fixed at the spawn by the tile: `$84:DD34` stores
 * `$84:DD55`[tile - $80] (tables.json hazardFrameTables) in `$5E1C`, so
 * object 76 takes table (tile - $80) >> 2 and 77 takes tile & 3, whatever the
 * run's direction; 81-83 have one table. The sheets were checked against the
 * holes' tiles (notes/port-v2-phase1-courses.md): tile $84 draws only
 * `$89:CCAB`, $91/$95 only `$89:CC5F`. A table the sheet lacks falls back to
 * its first.
 */
export function hazardFrame(
  objects: AtlasJson | null,
  frameTables: ArrayLike<number> | null,
  type: number,
  tile: number,
  frame: number,
): string | null {
  const sheet = objects?.objects?.[String(type)];
  if (!sheet) return null;
  const k = tile - 0x80;
  const addr = frameTables && k >= 0 && k < frameTables.length ? frameTables[k] : -1;
  const at = addr >= 0 ? sheet.tables.indexOf(`$89:${addr.toString(16).toUpperCase().padStart(4, '0')}`) : -1;
  const row = sheet.frames[Math.max(0, at)] ?? [];
  const f = frame === 0xffff || frame < 0 ? 0 : frame;
  return row[f] ?? row[0] ?? null;
}

/** The hazard object types the engine spawns (sim/actors.ts). */
export const HAZARD_TYPES = [76, 77, 81, 82, 83] as const;
