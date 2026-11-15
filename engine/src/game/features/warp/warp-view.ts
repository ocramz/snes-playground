/**
 * The warp's objects 63 and 64 (warp-frames.ts), from the core's `Warp`
 * trait: one image on the objects atlas, in the actors' depth band at its
 * own y. Nothing is drawn when the atlas lacks the sheets.
 */
import Phaser from 'phaser';
import { Tex } from '../../assets/keys';
import { Warp } from '../../../core/traits/warp';
import { bitmapOf } from '../../bridge/placement';
import type { ViewCtx } from '../../bridge/view';
import { warpPicture } from './warp-frames';

export class WarpView {
  private readonly image: Phaser.GameObjects.Image | null;

  constructor(scene: Phaser.Scene, private readonly actorDepth: number) {
    this.image = scene.textures.exists(Tex.objects) ? scene.add.image(0, 0, Tex.objects).setVisible(false) : null;
  }

  update(ctx: ViewCtx): void {
    if (!this.image) return;
    const warp = ctx.world.get(Warp)!;
    const pic = warpPicture(warp.stage, warp.t);
    const name = pic ? ctx.host.assets.objects?.objects?.[String(pic.type)]?.frames[pic.table]?.[pic.index] ?? null : null;
    if (!pic || !name) {
      this.image.setVisible(false);
      return;
    }
    const p = pic.at === 'out' ? bitmapOf(ctx.course, warp.outX, warp.outY) : bitmapOf(ctx.course, warp.panX, warp.panY);
    this.image.setFrame(name).setPosition(p.x, p.y).setDepth(this.actorDepth + p.y * 1e-5).setVisible(true);
  }

  destroy(): void {
    this.image?.destroy();
  }
}
