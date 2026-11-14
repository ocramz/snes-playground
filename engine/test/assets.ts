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

const here = fileURLToPath(new URL('.', import.meta.url));
const assetsDir = resolve(here, '../../build/engine/assets');

export const haveAssets = existsSync(resolve(assetsDir, 'manifest.json'));

export interface AtlasFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Object position within the frame; draw at position - (ox, oy). */
  ox?: number;
  oy?: number;
}

export interface AtlasClip {
  frames: Array<{ f: string; d: number }>;
  loop: boolean;
  loopStart: number;
  /**
   * Kirby clips only: the animation state ($7E:D7D4) to continue with when
   * the clip ends (kirbyanim's next_state), e.g. hop -> 14 (roll). Not a
   * clip name. Null for the object sheets.
   */
  next: number | null;
}

export interface AtlasJson {
  image: string;
  size: [number, number];
  frames: Record<string, AtlasFrame>;
  clips: Record<string, AtlasClip>;
}

export interface UiJson {
  image: string;
  size: [number, number];
  frames: Record<string, AtlasFrame>;
  timing: {
    one: number;
    panel: number;
    ready: number;
    slide: number[];
    meterStart: number;
    [key: string]: unknown;
  };
  anchorNote: string;
  [key: string]: unknown;
}

export interface AudioEntry {
  file: string;
  loopStart: number;
  loopEnd: number;
}

export interface AudioJson {
  music: AudioEntry;
  /** Keyed by song number (the request id is $7E + n). */
  songs: Record<string, AudioEntry>;
  /** Keyed by effect number, decimal. */
  sfx: Record<string, string>;
}

/** One cue: [frame within the window, "song" | "sfx", id]. */
export type CutsceneCue = [number, string, number];

export interface CutsceneWindow {
  recorded: [number, number];
  length: number;
  anchor: 'tee' | 'cup';
  camera: Array<[number, number]>;
  brightness: number[];
  hideKirby: unknown;
  night: unknown;
  cues: CutsceneCue[];
  sprites: unknown[];
}

export interface CutscenesJson {
  about: string;
  anchors: { tee: [number, number]; cup: [number, number] };
  windows: Record<string, CutsceneWindow>;
  nightPalette: { day: number[]; night: number[]; frame: number };
}

export interface LayersJson {
  files: Record<string, [number, number]>;
  backColour: [number, number, number];
  name: string;
  [key: string]: unknown;
}

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
