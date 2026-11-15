/**
 * The snap panels' stars, object 62 (core's `SnapTrail`; sim/snap-stars.ts):
 * a pool of images on the objects atlas, one per live star that shows a
 * frame, at its bitmap point. Nothing is drawn when the atlas lacks the
 * sheet.
 */
import Phaser from 'phaser';
import { Tex } from '../../assets/keys';
import { SnapTrail } from '../../../core/traits/snap';
import { BallScreen, BallSprite } from '../../../core/traits/pose';
import { findActivePlayer } from '../../../core/traits/player';
import { s16 } from '../../../core/fixed';
import { kirbyPoint } from '../../bridge/placement';
import type { ViewCtx } from '../../bridge/view';
import { SNAP_STAR_TABLE, SNAP_STAR_TYPE, starDepth } from './snap-star-frames';

export class SnapStarsView {
  private readonly pool: Phaser.GameObjects.Image[] = [];

  constructor(private readonly scene: Phaser.Scene, private readonly actorDepth: number) {}

  update(ctx: ViewCtx): void {
    if (!this.scene.textures.exists(Tex.objects)) return;
    const stars = ctx.world.get(SnapTrail)?.stars ?? [];
    const names = ctx.host.assets.objects?.objects?.[String(SNAP_STAR_TYPE)]?.frames[SNAP_STAR_TABLE] ?? [];
    const e = findActivePlayer(ctx.world);
    const prio = e?.get(BallSprite)?.prio ?? 3;
    const k = e ? kirbyPoint(ctx.course, e.get(BallScreen)!) : { x: 0, y: 0 };
    const sorted = this.actorDepth + Math.max(-5000, Math.min(50000, k.y)) * 1e-5; // sync-depth's rule
    let n = 0;
    for (const s of stars) {
      const name = s.frame >= 0 ? names[s.frame] ?? null : null;
      if (!name) continue;
      if (n === this.pool.length) this.pool.push(this.scene.add.image(0, 0, Tex.objects));
      this.pool[n++].setFrame(name).setPosition(s16(s.x), s16(s.y)).setDepth(starDepth(s.frame, prio, sorted)).setVisible(true);
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].setVisible(false);
  }

  destroy(): void {
    for (const img of this.pool) img.destroy();
    this.pool.length = 0;
  }
}
