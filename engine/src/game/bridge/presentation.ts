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

export interface Presentation {
  ctx: ViewCtx;
  views: ViewRegistry;
  layers: LayersView;
  guide: GuideView;
  panel: PanelView;
  cutscene: CutsceneView;
  director: CutsceneDirector;
  audio: AudioPlayer | null;
  camera: Phaser.Cameras.Scene2D.Camera;
  events: GameEvent[];
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
