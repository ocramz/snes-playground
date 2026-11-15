/**
 * The view catalog (reference §9): Visual.kind -> the {Domain}View factory.
 * The art each view draws with is catalog-data.ts's (pure, tested against
 * the atlases).
 */
import type { ViewFactory } from '../bridge/view';
import { KirbyView } from './kirby/kirby-view';
import { EnemyView } from './enemies/enemy-view';
import { CupView } from './enemies/cup-view';
import { TeeView } from './env/tee-view';
import { PillarView } from './env/pillar-view';
import { HazardView } from './env/hazard-view';

export const VIEW_CATALOG: Readonly<Record<string, ViewFactory>> = {
  ball: (scene) => new KirbyView(scene),
  enemy: (scene) => new EnemyView(scene, 'enemy'),
  star: (scene) => new EnemyView(scene, 'star'),
  cup: (scene, host) => new CupView(scene, host),
  tee: (scene) => new TeeView(scene),
  pillar: (scene) => new PillarView(scene),
  hazard: (scene, host) => new HazardView(scene, host),
};
