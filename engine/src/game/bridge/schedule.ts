/**
 * The presentation schedule (reference §8 stage 5; plans/port_v1_koota_
 * phaser4.md "HoleScene.update" step 3): once per host frame, after the core
 * frames, in this order. Data, so a system can be switched off when debugging.
 */
import { bindViews } from './bind-views';
import { syncTransforms } from './sync-transforms';
import { syncDepth } from './sync-depth';
import { syncCamera } from './sync-camera';
import { syncPose } from './sync-pose';
import { playFeedback } from './play-feedback';
import { syncCupMask } from './sync-cup-mask';
import { panelState } from '../features/shot-panel/panel-state';
import type { Presentation } from './presentation';

export const PRESENTATION: Array<{ name: string; run: (p: Presentation) => void }> = [
  { name: 'bind-views', run: (p) => bindViews(p.ctx.world, p.views) },
  { name: 'sync-transforms', run: syncTransforms },
  { name: 'sync-depth', run: syncDepth },
  { name: 'sync-camera', run: syncCamera },
  { name: 'sync-layers', run: (p) => {
    p.layers.update(p.ctx.history.ticks);
    p.layers.setNight(p.director.night());
  } },
  { name: 'sync-guide', run: (p) => p.guide.update(p.ctx.world, p.ctx.course) },
  { name: 'sync-pose', run: syncPose },
  { name: 'sync-cup-mask', run: syncCupMask },
  { name: 'sync-warp', run: (p) => p.warp.update(p.ctx) },
  { name: 'sync-snap-stars', run: (p) => p.snapStars.update(p.ctx) },
  { name: 'sync-water-fx', run: (p) => p.waterFx.update(p.ctx) },
  { name: 'sync-panel', run: (p) => p.panel.update(panelState(p.ctx.world, p.ctx.history)) },
  { name: 'sync-cutscene', run: (p) => p.cutscene.update(p.director.frame(), p.groundOver) },
  { name: 'play-feedback', run: playFeedback },
];

export function runPresentation(p: Presentation, disabled: ReadonlySet<string> = new Set()): void {
  for (const s of PRESENTATION) if (!disabled.has(s.name)) s.run(p);
}
