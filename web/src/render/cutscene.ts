// The hole intro (Kirby flies in on the warp star and jumps onto the tee) and
// the hole-out (a ball rises from the cup, becomes a star, Kirby rides it up),
// replayed frame by frame from the real game. tools/snesstep/trace_cutscene.py
// records them; tools/export_web_sprites.py writes cutscenes.json, where every
// sprite and the camera are relative to an anchor (the tee pad or the cup ring)
// so the hole-out plays at whichever enemy became the cup.

/** A sprite in one frame: atlas frame, world offset from the anchor, anchor index, draw order (-1 = on the ground). */
export type CutSprite = [frame: string, dx: number, dy: number, anchor: number, z: number];
export type CutCue = [frame: number, kind: 'sfx' | 'song', id: number];

export interface CutWindow {
  /** the frames of the recorded run it was cut from, [first, end) */
  recorded: [number, number];
  length: number;
  anchor: 'tee' | 'cup';
  /** scroll minus the anchor, per frame */
  camera: [number, number][];
  /** 0 (black) .. 15 (full), per frame */
  brightness: number[];
  /** the frame Kirby's own sprite is gone (the hole-out), or null */
  hideKirby: number | null;
  /** the frame the night palette comes up (HOLE IN ONE), or null */
  night: number | null;
  cues: CutCue[];
  sprites: CutSprite[][];
}

export interface CutscenesJson {
  /** where the recorded run had the anchors (world pixels) */
  anchors: { tee: [number, number]; cup: [number, number] };
  windows: Record<'intro' | 'outro' | 'outroHio', CutWindow>;
}

export const ANCHORS = ['tee', 'cup'] as const;

export interface CutFrame {
  sprites: { frame: string; x: number; y: number; z: number }[];
  scrollX: number;
  scrollY: number;
  brightness: number;
  cues: CutCue[];
  night: boolean;
  hideKirby: boolean;
}

/** Steps through one window, one 60 Hz tick per call. Pure: no Phaser. */
export class CutscenePlayer {
  /** the frame next() returns next */
  t = 0;

  constructor(
    readonly win: CutWindow,
    /** world positions of the tee pad and the cup ring in this game, by ANCHORS index */
    readonly anchors: [number, number][],
  ) {}

  get done(): boolean { return this.t >= this.win.length; }

  /** The frame at index t (clamped). */
  frameAt(t: number): CutFrame {
    const w = this.win;
    const i = Math.max(0, Math.min(w.length - 1, t));
    const main = this.anchors[ANCHORS.indexOf(w.anchor)];
    const [cx, cy] = w.camera[i];
    return {
      sprites: w.sprites[i].map(([frame, dx, dy, a, z]) => ({
        frame, x: this.anchors[a][0] + dx, y: this.anchors[a][1] + dy, z,
      })),
      scrollX: main[0] + cx,
      scrollY: main[1] + cy,
      brightness: w.brightness[i],
      cues: w.cues.filter((c) => c[0] === t),
      night: w.night !== null && i >= w.night,
      hideKirby: w.hideKirby !== null && i >= w.hideKirby,
    };
  }

  next(): CutFrame {
    const f = this.frameAt(this.t);
    this.t += 1;
    return f;
  }
}
