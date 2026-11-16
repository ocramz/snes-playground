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
  AtlasJson, AudioJson, CutscenesJson, HudJson, LayersJson, ManifestJson, UiJson,
} from '../src/game/assets/schema';
import { holeDir } from '../src/game/assets/keys';

const here = fileURLToPath(new URL('.', import.meta.url));
const assetsDir = resolve(here, '../../build/engine/assets');

export const haveAssets = existsSync(resolve(assetsDir, 'manifest.json'));

export type {
  AtlasFrame, AtlasClip, AtlasJson, UiJson, AudioEntry, AudioJson, CutsceneCue, CutsceneWindow,
  CutscenesJson, LayersJson, HudJson, ManifestJson,
} from '../src/game/assets/schema';

export function assetPath(rel: string): string {
  return resolve(assetsDir, rel);
}

export function assetExists(rel: string): boolean {
  return existsSync(assetPath(rel));
}

export function loadManifest(): ManifestJson {
  return readJson(assetPath('manifest.json'));
}

/** The exported ROM holes' indices, in course order (the manifest's `courses`). */
export function exportedHoles(): number[] {
  return (loadManifest().courses ?? []).flatMap((c) => c.holes.map((h) => h.index));
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

/** `index` is the ROM hole index (course * 8 + hole); the directory is holes/NNN. */
export function loadHoleCourse(index: number): CourseJson {
  return readJson(assetPath(`${holeDir(index)}/course.json`));
}

export function loadHoleLayers(index: number): LayersJson {
  return readJson(assetPath(`${holeDir(index)}/layers.json`));
}
