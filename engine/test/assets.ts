/**
 * Loaders for the asset pipeline's output (build/engine/assets, written by
 * `make engine-assets`, gitignored). Schemas match what tools/export_web.py
 * and tools/export_web_sprites.py write; the atlas conventions (ox/oy
 * origin, 60 Hz durations, `next` chaining) are documented in
 * plans/port_v1_koota_phaser4.md, "Atlas format the engine consumes".
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, type CourseJson } from './fixtures';
import type {
  AtlasJson, AudioJson, CutscenesJson, HudJson, LayersJson, UiJson,
} from '../src/game/assets/schema';

const here = fileURLToPath(new URL('.', import.meta.url));
const assetsDir = resolve(here, '../../build/engine/assets');

export const haveAssets = existsSync(resolve(assetsDir, 'manifest.json'));

export type {
  AtlasFrame, AtlasClip, AtlasJson, UiJson, AudioEntry, AudioJson, CutsceneCue, CutsceneWindow,
  CutscenesJson, LayersJson, HudJson,
} from '../src/game/assets/schema';

export function assetPath(rel: string): string {
  return resolve(assetsDir, rel);
}

export function assetExists(rel: string): boolean {
  return existsSync(assetPath(rel));
}

export function loadAtlas(): AtlasJson {
  return readJson(assetPath('sprites.json'));
}

export function loadUi(): UiJson {
  return readJson(assetPath('ui.json'));
}

export function loadAudio(): AudioJson {
  return readJson(assetPath('audio.json'));
}

export function loadObjects(): AtlasJson | null {
  return assetExists('objects.json') ? readJson(assetPath('objects.json')) : null;
}

export function loadHud(): HudJson {
  return readJson(assetPath('hud.json'));
}

export function loadCutscenes(): CutscenesJson {
  return readJson(assetPath('cutscenes.json'));
}

/** hole is the 1P course-1 hole number 0-7; the directory is holes/0N. */
export function loadHoleCourse(hole: number): CourseJson {
  return readJson(assetPath(`holes/0${hole}/course.json`));
}

export function loadHoleLayers(hole: number): LayersJson {
  return readJson(assetPath(`holes/0${hole}/layers.json`));
}
