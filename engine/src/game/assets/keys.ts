/**
 * Every asset key the game uses, in one place (reference §4). Vite serves
 * ../build/engine as the public dir, so the URLs below are paths there
 * (rules/tables.json, assets/...). Core never imports this: it keeps semantic
 * `Visual.kind` values and pose states, and the view catalog maps those to
 * these keys and to the atlas' frame and clip names.
 */

const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';

export const Rules = {
  /** build/engine/rules/tables.json — the ROM physics constants. */
  tables: 'rules:tables',
} as const;

export const RulesUrl = {
  tables: `${BASE}rules/tables.json`,
} as const;

/** JSON cache keys. */
export const Json = {
  manifest: 'json:manifest',
  atlas: 'json:atlas',
  objects: 'json:objects',
  ui: 'json:ui',
  hud: 'json:hud',
  audio: 'json:audio',
  cutscenes: 'json:cutscenes',
  terrainStyle: 'json:terrain-style',
} as const;

/** Texture keys. The atlases' frames are added to these by assets/atlas.ts. */
export const Tex = {
  atlas: 'tex:atlas',
  objects: 'tex:objects',
  ui: 'tex:ui',
  font: 'tex:font',
  hudPanel: 'tex:hud-panel',
  hudTomato: 'tex:hud-tomato',
  hudAbility: 'tex:hud-ability',
  terrainStyle: 'tex:terrain-style',
  /** Course 1's BG3 scenery (holes/000/layer_bg3.png), behind the holes without bitmaps. */
  scenery: 'tex:scenery',
} as const;

/** The bitmap font made from font.png (features/text/font.ts). */
export const Fonts = {
  main: 'font:main',
} as const;

export const AssetUrl = {
  manifest: `${BASE}assets/manifest.json`,
  atlas: `${BASE}assets/sprites.json`,
  atlasImage: `${BASE}assets/sprites.png`,
  objects: `${BASE}assets/objects.json`,
  objectsImage: `${BASE}assets/objects.png`,
  ui: `${BASE}assets/ui.json`,
  uiImage: `${BASE}assets/ui.png`,
  hud: `${BASE}assets/hud.json`,
  hudPanel: `${BASE}assets/hud_panel.png`,
  hudTomato: `${BASE}assets/hud_tomato.png`,
  hudAbility: `${BASE}assets/hud_ability.png`,
  font: `${BASE}assets/font.png`,
  audio: `${BASE}assets/audio.json`,
  terrainStyle: `${BASE}assets/terrain_style.json`,
  terrainStyleImage: `${BASE}assets/terrain_style.png`,
  cutscenes: `${BASE}assets/cutscenes.json`,
} as const;

export function assetUrl(file: string): string {
  return `${BASE}assets/${file}`;
}

/**
 * The shipped ROM holes are keyed by their ROM index (course * 8 + hole,
 * `$82:B0A4`), under assets/holes/NNN; manifest.json lists them by course.
 */
export function holeDir(index: number): string {
  return `holes/${String(index).padStart(3, '0')}`;
}

export function holeJsonKey(index: number, which: 'course' | 'layers'): string {
  return `hole${index}:${which}`;
}

/** A layer bitmap's texture key, by its file name (layer_back.png -> hole17:layer_back). */
export function holeTexKey(index: number, file: string): string {
  return `hole${index}:${file.replace(/\.png$/, '')}`;
}

export function holeUrl(index: number, file: string): string {
  return `${BASE}assets/${holeDir(index)}/${file}`;
}

/** Audio keys: effects by their decimal number, songs by n. */
export function sfxKey(id: number): string {
  return `sfx:${id}`;
}

export function songKey(n: number): string {
  return `song:${n}`;
}
