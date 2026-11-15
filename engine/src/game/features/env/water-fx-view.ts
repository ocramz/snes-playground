/**
 * The water's splashes and bubbles, objects 53-58 and 67 (core's `WaterFx`;
 * sim/water-fx.ts): a pool of images on the objects atlas, one per live
 * object that shows a frame, at its bitmap point. Their frame lists (tables
 * `$89:94DB`, `$89:952B`) are priority 3: over the course even when Kirby is
 * under it. Their OAM queue is Kirby's, or one further back (53, a 54 after
 * its first frame, a bubble from his head in four of his eight facings,
 * `$85:E865`). In his queue they cover him: the game's frame at the entry
 * (web_water_shot 2763, `tools/ppu_render.py`) has the splash's crown over
 * his lower half; one queue back they are behind him. Nothing is drawn when
 * the atlas lacks the sheet.
 */
import Phaser from 'phaser';
import { Tex } from '../../assets/keys';
import { WaterFx } from '../../../core/traits/water';
import { BallScreen } from '../../../core/traits/pose';
import { findActivePlayer } from '../../../core/traits/player';
import { s16 } from '../../../core/fixed';
import { kirbyPoint } from '../../bridge/placement';
import type { ViewCtx } from '../../bridge/view';

/** Object 67's type, for the atlas. */
export const BUBBLE_TYPE = 67;

/** Just in front of Kirby's sort in his OAM queue; behind him one queue back. */
export function waterFxDepth(kirbySorted: number, queueAdd: number): number {
  return queueAdd === 0 ? kirbySorted + 1e-6 : kirbySorted - 1e-6 * queueAdd;
}

export class WaterFxView {
  private readonly pool: Phaser.GameObjects.Image[] = [];

  constructor(private readonly scene: Phaser.Scene, private readonly actorDepth: number) {}

  update(ctx: ViewCtx): void {
    if (!this.scene.textures.exists(Tex.objects)) return;
    const fx = ctx.world.get(WaterFx);
    const objects = ctx.host.assets.objects?.objects ?? {};
    const e = findActivePlayer(ctx.world);
    const k = e ? kirbyPoint(ctx.course, e.get(BallScreen)!) : { x: 0, y: 0 };
    const sorted = this.actorDepth + Math.max(-5000, Math.min(50000, k.y)) * 1e-5; // sync-depth's rule
    let n = 0;
    const draw = (type: number, frame: number, x: number, y: number, queueAdd: number): void => {
      const name = frame >= 0 ? objects[String(type)]?.frames[0]?.[frame] ?? null : null;
      if (!name) return;
      if (n === this.pool.length) this.pool.push(this.scene.add.image(0, 0, Tex.objects));
      this.pool[n++].setFrame(name).setPosition(s16(x), s16(y)).setDepth(waterFxDepth(sorted, queueAdd)).setVisible(true);
    };
    for (const s of fx?.splashes ?? []) draw(s.type, s.frame, s.x, s.y, s.queueAdd);
    for (const b of fx?.bubbles ?? []) draw(BUBBLE_TYPE, b.frame, b.x, b.y, b.queue);
    for (let i = n; i < this.pool.length; i++) this.pool[i].setVisible(false);
  }

  destroy(): void {
    for (const img of this.pool) img.destroy();
    this.pool.length = 0;
  }
}
