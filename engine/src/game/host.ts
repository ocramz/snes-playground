/**
 * What the scenes share for the life of the page (reference §6: the world
 * outlives the scenes and is passed in scene data, not kept in a module
 * global). Game state is the world's; the rest is the platform's: the
 * parsed asset JSON, the course sets, the audio player, the URL flags, and
 * the presentation's per-frame scratch the HUD scene reads.
 */
import type { World } from 'koota';
import type { RomRules } from '../core/rules';
import type { AtlasJson, AudioJson, CutscenesJson, HudJson, UiJson } from './assets/schema';
import type { CourseSet } from './assets/course-sets';
import type { AudioPlayer } from './features/audio/audio-player';
import type { Difficulty, GeneratedHole } from '../core/gen/generate';
import type { TerrainStyle } from './features/layers/styled';

export interface LoadedAssets {
  atlas: AtlasJson | null;
  objects: AtlasJson | null;
  ui: UiJson | null;
  hud: HudJson | null;
  audio: AudioJson | null;
  cutscenes: CutscenesJson | null;
  /** The course art's exemplar patches (tools/terrain_style.py), for holes without bitmaps. */
  terrainStyle: TerrainStyle | null;
}

export interface Flags {
  /** ?nointro: start each hole at the set-up, without the star's fly-in. */
  nointro: boolean;
  /** ?debug: window.__engine, the D key's terrain view. */
  debug: boolean;
  /** ?hole=N: start the chosen course at its hole N (1-based), for debugging. */
  hole: number | null;
  /** random.html ?seed=N: the random course's seed (decimal, or 0x hex). */
  seed: number | null;
  /** random.html ?difficulty=easy|normal|hard (or 0-2). */
  difficulty: Difficulty | null;
}

/** random.html's course: the seed, the difficulty, and the holes once generated. */
export interface RandomCourse {
  seed: number;
  difficulty: Difficulty;
  holes: GeneratedHole[] | null;
}

export interface Host {
  world: World;
  rules: RomRules | null;
  assets: LoadedAssets;
  sets: CourseSet[];
  /** The course being played (chosen in the menu). */
  set: CourseSet | null;
  audio: AudioPlayer | null;
  flags: Flags;
  /** Presentation scratch: the hole scene hides the score panel through this. */
  screen: { hudHidden: boolean };
  /** random.html only. */
  random: RandomCourse | null;
}

export function readFlags(search: string): Flags {
  const q = new URLSearchParams(search);
  const hole = Number(q.get('hole'));
  return {
    nointro: q.has('nointro'),
    debug: q.has('debug'),
    hole: Number.isInteger(hole) && hole > 0 ? hole : null,
    seed: parseSeed(q.get('seed')),
    difficulty: parseDifficulty(q.get('difficulty')),
  };
}

function parseSeed(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
}

function parseDifficulty(v: string | null): Difficulty | null {
  if (v === null) return null;
  const k = ['easy', 'normal', 'hard'].indexOf(v.toLowerCase());
  if (k >= 0) return k as Difficulty;
  return v === '0' || v === '1' || v === '2' ? (Number(v) as Difficulty) : null;
}

export interface SceneData {
  host: Host;
}
