/**
 * An enemy (Visual 'enemy') and a taken enemy's star ('star'): its species'
 * idle clip (catalog-data.ts enemyClip: recorded per species by
 * tools/snesstep/trace_enemies.py) or the star (8 one-frame pictures, the same
 * for every species) at the corner of its cell, a hovering enemy its hover's
 * height above the ground (Hover.steps; the ball meets it there, test/
 * course-driver.ts). Every enemy is object type 73 (actor $49); the species
 * picks its frame lists ($85:9220) and its per-frame code ($85:9238). The
 * enemies of one species draw one WRAM block, so they move in step; the
 * views, bound on the same frame, start their clips together.
 */
import Phaser from 'phaser';
import type { Entity } from 'koota';
import { Tex } from '../../assets/keys';
import { playClip } from '../../assets/atlas';
import { Cell, EnemyKind, Hover } from '../../../core/traits/hole';
import { enemyClip } from '../catalog-data';
import { cellCorner } from '../../bridge/placement';
import type { View, ViewCtx } from '../../bridge/view';

export class EnemyView implements View {
  readonly band = 'actor' as const;
  private readonly sprite: Phaser.GameObjects.Sprite;
  /** The species' clip is chosen on the first place (the factory has no entity). */
  private chosen: boolean;

  constructor(scene: Phaser.Scene, readonly kind: 'enemy' | 'star') {
    this.sprite = scene.add.sprite(0, 0, Tex.atlas);
    playClip(this.sprite, kind === 'star' ? 'star' : 'enemy_idle');
    this.chosen = kind === 'star';
  }

  place(ctx: ViewCtx, e: Entity): number | null {
    if (!this.chosen) {
      this.chosen = true;
      const clip = enemyClip(ctx.host.assets.atlas, e.has(EnemyKind) ? e.get(EnemyKind)!.species : 0x0c);
      if (clip !== 'enemy_idle') playClip(this.sprite, clip);
    }
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
