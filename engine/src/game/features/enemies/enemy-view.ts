/**
 * An enemy (Visual 'enemy') and a taken enemy's star ('star'): the hole-1
 * enemy sheet's idle cycle (8 pictures, 63 frames) or the star (8 one-frame
 * pictures) at the corner of its cell, a hovering enemy its hover's height
 * above the ground (Hover.steps; the ball meets it there, test/course-
 * driver.ts). Every enemy of course 1 is object type 73 (actor $49, the only
 * "match" in build/sprites/emu/actors.tsv); other species would need their
 * own sheets (plans risk 9), so all share this one.
 */
import Phaser from 'phaser';
import type { Entity } from 'koota';
import { Tex } from '../../assets/keys';
import { playClip } from '../../assets/atlas';
import { Cell, Hover } from '../../../core/traits/hole';
import { cellCorner } from '../../bridge/placement';
import type { View, ViewCtx } from '../../bridge/view';

export class EnemyView implements View {
  readonly band = 'actor' as const;
  private readonly sprite: Phaser.GameObjects.Sprite;

  constructor(scene: Phaser.Scene, readonly kind: 'enemy' | 'star') {
    this.sprite = scene.add.sprite(0, 0, Tex.atlas);
    playClip(this.sprite, kind === 'star' ? 'star' : 'enemy_idle');
  }

  place(ctx: ViewCtx, e: Entity): number | null {
    const c = e.get(Cell)!;
    const p = cellCorner(ctx.rules, ctx.course, c.x, c.y, e.has(Hover) ? e.get(Hover)!.steps : 0);
    this.sprite.setPosition(p.x, p.y);
    return p.y;
  }

  setDepth(depth: number): void {
    this.sprite.setDepth(depth);
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
