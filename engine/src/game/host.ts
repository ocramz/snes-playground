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

export interface LoadedAssets {
  atlas: AtlasJson | null;
  objects: AtlasJson | null;
  ui: UiJson | null;
  hud: HudJson | null;
  audio: AudioJson | null;
  cutscenes: CutscenesJson | null;
}

export interface Flags {
  /** ?nointro: start each hole at the set-up, without the star's fly-in. */
  nointro: boolean;
  /** ?debug: window.__engine, the D key's terrain view. */
  debug: boolean;
  /** ?hole=N: start the chosen course at its hole N (1-based), for debugging. */
  hole: number | null;
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
}

export function readFlags(search: string): Flags {
  const q = new URLSearchParams(search);
  const hole = Number(q.get('hole'));
  return { nointro: q.has('nointro'), debug: q.has('debug'), hole: Number.isInteger(hole) && hole > 0 ? hole : null };
}

export interface SceneData {
  host: Host;
}
