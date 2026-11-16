/**
 * The copy abilities' objects (core's `AbilityFx.objects`;
 * core/sim/ability-objects.ts): a pool of images on the objects atlas, one
 * per live object that shows a frame, at its bitmap point, sorted against
 * Kirby by its OAM queue as the water's are (water-fx-view.ts): in his
 * queue in front of him, one queue back behind him. Each type's pictures
 * are its frame table's (objects.json, tools/export_web_sprites.py
 * OBJECT_TYPES); a type without a sheet draws nothing.
 */
import Phaser from 'phaser';
import { Tex } from '../../assets/keys';
import { AbilityFx } from '../../../core/traits/ability-fx';
import { BallScreen } from '../../../core/traits/pose';
import { findActivePlayer } from '../../../core/traits/player';
import { s16 } from '../../../core/fixed';
import { kirbyPoint } from '../../bridge/placement';
import type { ViewCtx } from '../../bridge/view';
import { waterFxDepth } from './water-fx-view';

export class AbilityFxView {
  private readonly pool: Phaser.GameObjects.Image[] = [];

  constructor(private readonly scene: Phaser.Scene, private readonly actorDepth: number) {}

  update(ctx: ViewCtx): void {
    if (!this.scene.textures.exists(Tex.objects)) return;
    const objs = ctx.world.get(AbilityFx)?.objects ?? [];
    const sheets = ctx.host.assets.objects?.objects ?? {};
    const e = findActivePlayer(ctx.world);
    const k = e ? kirbyPoint(ctx.course, e.get(BallScreen)!) : { x: 0, y: 0 };
    const sorted = this.actorDepth + Math.max(-5000, Math.min(50000, k.y)) * 1e-5; // sync-depth's rule
    let n = 0;
    for (const o of objs) {
      const name = o.frame >= 0 ? sheets[String(o.type)]?.frames[0]?.[o.frame] ?? null : null;
      if (!name) continue;
      if (n === this.pool.length) this.pool.push(this.scene.add.image(0, 0, Tex.objects));
      this.pool[n++].setFrame(name).setPosition(s16(o.x), s16(o.y)).setDepth(waterFxDepth(sorted, o.queueAdd)).setVisible(true);
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].setVisible(false);
  }

  destroy(): void {
    for (const img of this.pool) img.destroy();
    this.pool.length = 0;
  }
}
