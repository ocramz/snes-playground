/** The tee pad (Visual 'tee'; object 108's picture), on the ground under Kirby's start. */
import Phaser from 'phaser';
import { Tex } from '../../assets/keys';
import { teePad } from '../../bridge/placement';
import type { View, ViewCtx } from '../../bridge/view';

export class TeeView implements View {
  readonly kind = 'tee';
  readonly band = 'decal' as const;
  private readonly image: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene) {
    this.image = scene.add.image(0, 0, Tex.atlas, 'tee');
  }

  place(ctx: ViewCtx): number | null {
    const p = teePad(ctx.rules, ctx.course);
    this.image.setPosition(p.x, p.y).setVisible(!ctx.hidden.has('tee'));
    return p.y;
  }

  setDepth(depth: number): void {
    this.image.setDepth(depth);
  }

  destroy(): void {
    this.image.destroy();
  }
}
