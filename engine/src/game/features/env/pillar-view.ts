/** A pillar (Visual 'pillar'; tile $02, object 72: the trees), at its cell's corner. */
import Phaser from 'phaser';
import type { Entity } from 'koota';
import { Tex } from '../../assets/keys';
import { Cell } from '../../../core/traits/hole';
import { cellCorner } from '../../bridge/placement';
import type { View, ViewCtx } from '../../bridge/view';

export class PillarView implements View {
  readonly kind = 'pillar';
  readonly band = 'actor' as const;
  private readonly image: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene) {
    this.image = scene.add.image(0, 0, Tex.atlas, 'tree');
  }

  place(ctx: ViewCtx, e: Entity): number | null {
    const c = e.get(Cell)!;
    const p = cellCorner(ctx.rules, ctx.course, c.x, c.y);
    this.image.setPosition(p.x, p.y);
    return p.y;
  }

  setDepth(depth: number): void {
    this.image.setDepth(depth);
  }

  destroy(): void {
    this.image.destroy();
  }
}
