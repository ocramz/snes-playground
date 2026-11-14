/**
 * The star fly-in and fly-out, replayed from one recorded run (pure; the
 * user's choice for phase 7: a bridge-only replay, no world entities).
 * cutscenes.json (tools/export_web_sprites.py build_cutscenes, from
 * tools/snesstep/trace_cutscene.py over c1n) keeps, per window and frame, the
 * sprites relative to an anchor — the tee pad (intro) or the cup ring
 * (hole-outs) where the recorded run had them — the camera relative to the
 * same anchor, the brightness and the sound requests (docs/web-demo.md "The
 * intro and the hole-out").
 *
 * To replay at another hole: world = anchorNow[sprite's anchor] + (dx, dy);
 * scroll = anchorNow[window's anchor] + camera[i].
 *
 * Timing against core:
 * - intro: index = the ticks since the hole began. The host holds the core
 *   until INTRO_CORE_AT (game frame 2333 is the core's first set-up frame:
 *   the recording starts at 2169, test/flow-harness.ts GAME_OFFSET 2332 and
 *   ShotSetup at since = frame + 1), then both run until the window ends.
 * - hole-outs: index = f - H until the camera reaches the cup, H two frames
 *   before the ball has sunk (core's 'holed' event, the effect $21, is the
 *   recording's index 2); from core's arrival frame C (HoleFlow.since +
 *   HoleFlow.length in HoleOut) index = OUTRO_ARRIVAL + f - C.
 *   Core's HoleOut timeline is the recording's: C + 31 song 25 = index 60,
 *   C + 147 song 24 = index 176, C + 410 HoleOver = index 439, the end.
 */
import type { GameEvent } from '../../../core/events';
import type { CutsceneCue, CutsceneWindow, CutscenesJson } from '../../assets/schema';
import type { WorldPoint } from '../../bridge/placement';

export type WindowName = 'intro' | 'outro' | 'outroHio';

export interface Anchors {
  tee: WorldPoint;
  cup: WorldPoint;
}

export interface ReplaySprite {
  /** sprites.json frame (cs_*). */
  key: string;
  /** World (course-bitmap) position: the sprite's top-left is this - (ox, oy). */
  x: number;
  y: number;
  /** Higher draws on top; -1 for the world types (the tee pad, the ring). */
  depth: number;
}

export interface ReplayFrame {
  sprites: ReplaySprite[];
  /** The screen's top-left in world pixels. */
  scroll: WorldPoint;
  /** 0 (black) .. 15 (full). */
  brightness: number;
}

/** Game 2333 - 2169: the core's first frame (ShotSetup t = 0) within the intro. */
export const INTRO_CORE_AT = 164;
/** The hole-outs' index on the frame the camera reaches the cup (c1n 3150 - 3121). */
export const OUTRO_ARRIVAL = 29;
/** The holed effect $21 (core's 'holed' event) comes 2 frames after the hole-out's index 0. */
export const OUTRO_HOLED_SFX_AT = 2;
/** The request byte of song n is $7E + n. */
export const SONG_BASE = 0x7e;

export function anchorPoint(anchors: Anchors, index: number): WorldPoint {
  return index === 0 ? anchors.tee : anchors.cup;
}

export function replayFrame(w: CutsceneWindow, i: number, anchors: Anchors): ReplayFrame {
  const k = Math.max(0, Math.min(w.length - 1, i));
  const main = w.anchor === 'tee' ? anchors.tee : anchors.cup;
  const sprites = (w.sprites[k] ?? []).map(([key, dx, dy, a, depth]) => {
    const p = anchorPoint(anchors, a);
    return { key, x: p.x + dx, y: p.y + dy, depth };
  });
  const [cx, cy] = w.camera[k] ?? [0, 0];
  return { sprites, scroll: { x: main.x + cx, y: main.y + cy }, brightness: w.brightness[k] ?? 15 };
}

/** The hole-out's index at core frame f; C = 0 while the camera has not reached the cup. */
export function outroIndex(f: number, holedAt: number, arrivedAt: number): number {
  if (arrivedAt > 0 && f >= arrivedAt) return OUTRO_ARRIVAL + (f - arrivedAt);
  return Math.min(OUTRO_ARRIVAL - 1, Math.max(0, f - holedAt));
}

/**
 * The cues the presentation plays itself. In the hole-outs, core already
 * requests every song and the holed effect $21 on the same frames, so those
 * cues are dropped (the replay only adds what no core system emits: $1D the
 * ball rising, $67 the star flying off, $3E the fireworks, $2D the 1UP).
 * The intro is all the replay's: the hole's song, $64, $62, $2F.
 */
export function ownCue(window: WindowName, cue: CutsceneCue): boolean {
  if (window === 'intro') return true;
  if (cue[1] === 'song') return false;
  return cue[2] !== 0x21;
}

/** The cues with from <= index < to, as events for play-feedback. */
export function cueEvents(
  window: WindowName,
  w: CutsceneWindow,
  from: number,
  to: number,
  frame: number,
): GameEvent[] {
  const out: GameEvent[] = [];
  for (const cue of w.cues) {
    if (cue[0] < from || cue[0] >= to || !ownCue(window, cue)) continue;
    out.push(cue[1] === 'song'
      ? { id: -1, kind: 'song', frame, seq: -1, romSfx: cue[2] - SONG_BASE, subject: 0 }
      : { id: -1, kind: 'cue', frame, seq: -1, romSfx: cue[2], subject: 0 });
  }
  return out;
}

export function windowOf(cutscenes: CutscenesJson | null, name: WindowName): CutsceneWindow | null {
  return cutscenes?.windows[name] ?? null;
}

