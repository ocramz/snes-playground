/**
 * What the presentation systems share in one host frame (reference §8,
 * stage 5): the scene's views and features, the frame's events, and the
 * per-frame view context.
 */
import type Phaser from 'phaser';
import type { GameEvent } from '../../core/events';
import type { ViewCtx } from './view';
import type { ViewRegistry } from './view-registry';
import type { LayersView } from '../features/layers/layers-view';
import type { GuideView } from '../features/guide/guide-view';
import type { PanelView } from '../features/shot-panel/panel-view';
import type { CutsceneView } from '../features/cutscene/cutscene-view';
import type { CutsceneDirector } from '../features/cutscene/director';
import type { AudioPlayer } from '../features/audio/audio-player';
import type { CupMaskClock } from '../features/enemies/cup-mask';
import type { WarpView } from '../features/warp/warp-view';
import type { SnapStarsView } from '../features/env/snap-stars-view';
import type { WaterFxView } from '../features/env/water-fx-view';
import type { AbilityFxView } from '../features/env/ability-fx-view';

export interface Presentation {
  ctx: ViewCtx;
  views: ViewRegistry;
  layers: LayersView;
  guide: GuideView;
  panel: PanelView;
  cutscene: CutsceneView;
  warp: WarpView;
  /** The snap panels' stars, object 62 (sync-snap-stars). */
  snapStars: SnapStarsView;
  /** The water's splashes and bubbles, objects 53-58 and 67 (sync-water-fx). */
  waterFx: WaterFxView;
  abilityFx: AbilityFxView;
  director: CutsceneDirector;
  audio: AudioPlayer | null;
  camera: Phaser.Cameras.Scene2D.Camera;
  events: GameEvent[];
  /** When the cup's rim mask (object 75) is up; sync-cup-mask. */
  cupMask: CupMaskClock;
  /** The replay's world types' depth while the rim mask is up (over Kirby), else null. */
  groundOver: number | null;
}

/** Depth bands, back to front (layers-view.ts has the course's own). */
export const DEPTH = {
  decal: 20,
  guide: 25,
  actor: 100,
  cutsceneSprites: 900,
  panel: 1100,
  fade: 2000,
} as const;
