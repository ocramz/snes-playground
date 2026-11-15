/**
 * The shapes of the asset pipeline's JSON (build/engine/assets, written by
 * `make engine-assets`: tools/export_web.py, export_web_sprites.py,
 * export_web_ui.py). Types only, so the bridge, the views and the node tests
 * share them. The atlas conventions (ox/oy origin, 60 Hz durations) are in
 * plans/port_v1_koota_phaser4.md, "Atlas format the engine consumes".
 */

export interface AtlasFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The object's position within the frame: draw at position - (ox, oy). */
  ox?: number;
  oy?: number;
}

export interface AtlasClip {
  /** `d` in 60 Hz frames. */
  frames: Array<{ f: string; d: number }>;
  loop: boolean;
  loopStart: number;
  /**
   * Kirby clips only: the animation state ($7E:D7D4) the script continues
   * with (kirbyanim's next_state), e.g. hop -> 14. A state number, not a clip:
   * core sets that state itself, so the view ignores it.
   */
  next: number | null;
}

/** objects.json's lookup: by object type, the frame tables and their pictures. */
export interface ObjectSheet {
  /** $89:xxxx frame tables, in the sheet's order (one per look). */
  tables: string[];
  /** frames[table][index] -> atlas frame name (null: never seen). */
  frames: Array<Array<string | null>>;
  source: string;
}

export interface AtlasJson {
  image: string;
  size: [number, number];
  frames: Record<string, AtlasFrame>;
  clips: Record<string, AtlasClip>;
  /** objects.json only. */
  objects?: Record<string, ObjectSheet>;
}

/** A sprite of the shot panel: a ui.json frame at an offset from Kirby's point. */
export interface UiPart {
  f: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  /** base only: the age (from the aim's A) it appears at. */
  t?: number;
}

export interface UiJson {
  image: string;
  size: [number, number];
  frames: Record<string, AtlasFrame>;
  base: UiPart[];
  face: UiPart[];
  one: UiPart[];
  tomato: UiPart[];
  ruler: UiPart[];
  bar: UiPart;
  dot: UiPart;
  /** By meter value "0".."63": the gauge's tiles. */
  gauge: Record<string, UiPart[]>;
  /** By meter value: the face's 9 tiles. */
  faces: Record<string, UiPart[]>;
  /** dotWet / coneWet: the pictures from the water (absent from older exports). */
  guide: { dot: string; cone: string; note: string; dotWet?: string; coneWet?: string };
  timing: {
    one: number;
    panel: number;
    ready: number;
    slide: number[];
    oneIntro: Array<[number, number]>;
    oneCycle: { from: number; frames: number; values: number[] };
    meterStart: number;
  };
  anchorNote: string;
}

export interface AudioEntry {
  file: string;
  /** Seconds; absent for a song that does not loop. */
  loopStart?: number;
  loopEnd?: number;
}

export interface AudioJson {
  music: AudioEntry;
  /** Keyed by song number n (the request byte is $7E + n). */
  songs: Record<string, AudioEntry>;
  /** Keyed by effect number, decimal. */
  sfx: Record<string, string>;
}

/** One cue: [frame within the window, "song" | "sfx", id]. Song ids are request bytes ($7E + n). */
export type CutsceneCue = [number, 'song' | 'sfx', number];

/**
 * One recorded sprite: [atlas frame, dx, dy, anchor index (0 tee, 1 cup),
 * depth]. World types (74, 108) are relative to their own anchor, depth -1;
 * every other type is screen + scroll - the window's main anchor, depth
 * 64 - OAM slot (higher draws on top).
 */
export type CutsceneSprite = [string, number, number, number, number];

export interface CutsceneWindow {
  recorded: [number, number];
  length: number;
  anchor: 'tee' | 'cup';
  /** Per frame: [scrollX - anchorX, scrollY - anchorY]. */
  camera: Array<[number, number]>;
  /** Per frame: INIDISP & 15, 0 when blanked. */
  brightness: number[];
  /** The index from which the view hides its own Kirby (null: never). */
  hideKirby: number | null;
  /** The index the night palette applies at (null: never). */
  night: number | null;
  cues: CutsceneCue[];
  sprites: CutsceneSprite[][];
}

export interface CutscenesJson {
  about: string;
  /** World (course-bitmap px) positions of the tee pad and the cup ring in the recorded run. */
  anchors: { tee: [number, number]; cup: [number, number] };
  windows: Record<string, CutsceneWindow>;
  nightPalette: { day: string; night: string; frame: number };
}

/**
 * A BG colour cycle an object runs while the hole is in play
 * (coursemap.palette_cycles): the ripple (object 113), the boost panels'
 * (112), the warp or snap panels' (114, 115). `colours` are the sets'
 * addresses; set `order[phase]` shows for `stepFrames` each. The layers carry
 * set 0; `layer_{back,front}_<name><k>.png` are the pixels that differ under
 * set k.
 */
export interface PaletteCycle {
  name: 'ripple' | 'boost' | 'panels';
  object: number;
  source: string;
  colours: string[];
  stepFrames: number;
  order: number[];
}

export interface LayersJson {
  /** file name -> [w, h]; only files with an opaque pixel are written. */
  files: Record<string, [number, number]>;
  backColour: [number, number, number];
  nightBackColour: [number, number, number] | null;
  name: string;
  outline: { source: string; stepFrames: number; cycle: Array<[number, number, number]> };
  /** The hole's palette cycles (absent from older exports). */
  cycles?: PaletteCycle[];
}

/** One exported ROM hole: its index (course * 8 + hole), name and directory under assets/. */
export interface ManifestHole {
  index: number;
  name: string;
  dir: string;
}

export interface ManifestCourse {
  /** 0-based course number (index // 8). */
  course: number;
  holes: ManifestHole[];
}

/** assets/manifest.json (tools/export_web.py --only manifest). */
export interface ManifestJson {
  exporter: number;
  romSha1: string;
  files: string[];
  /** The exported ROM holes by course (absent from older exports). */
  courses?: ManifestCourse[];
}

export interface HudJson {
  panel: [number, number];
  at: [number, number];
  tomato: [number, number];
  slots: {
    hole: [number, number];
    shot: [number, number];
    tomato: [number, number];
    tomatoStep: number;
    stars: [number, number];
    portrait: [number, number, number, number];
  };
  /**
   * The copy ability's icon (tools/export_web_sprites.py build_icons): the
   * pictures by upload descriptor (hex) in 32 x 32 cells of hud_ability.png,
   * row 0, their ground (colour 9, white) in row 1; `at` the icon's top-left.
   */
  ability?: { image: string; at: [number, number]; cell: number; cells: Record<string, number> };
}
