/**
 * The cup (Visual 'cup'): the last free enemy, turned into the cup by the
 * reveal ($82:8B5C, core systems/reveal.ts) inside the ball step. The view
 * follows the reveal's stages:
 * - lead, panTo: still the enemy (its species' idle clip), at its hover height;
 * - hover: a hovering enemy drops to the ground in $82:8CE8[h] + 8 frames
 *   (drawn as a straight drop; the drop's curve is unmeasured);
 * - ring (and after): the enemy sheet's pictures 16-20 open into the hole
 *   (the cup_open clip, which stops on the open hole) and the ring
 *   (object 74) appears around it.
 * The ring and the hole sit on the ground (the decal band), under Kirby
 * (web/test/e2e/depth.mjs's rule), except while the cup's rim mask is up
 * (object 75, cup-mask.ts): then the ring draws over Kirby (`setRingOver`),
 * as the game's OAM order has it. The hole-out's replay draws its own ring,
 * so the cutscene hides this one ('ring').
 */
import Phaser from 'phaser';
import type { Entity } from 'koota';
import { Tex } from '../../assets/keys';
import { playClip } from '../../assets/atlas';
import { Cell, EnemyKind, Hover } from '../../../core/traits/hole';
import { HOVER_DROP, HOVER_DROP_EXTRA, Reveal } from '../../../core/traits/reveal';
import { cellCorner } from '../../bridge/placement';
import type { View, ViewCtx } from '../../bridge/view';
import type { Host } from '../../host';
import { CUP_RING_FRAME, enemyClip } from '../catalog-data';

export class CupView implements View {
  readonly kind = 'cup';
  readonly band = 'decal' as const;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly ring: Phaser.GameObjects.Image;
  private opened = false;
  private chosen = false;
  private ringOver: number | null = null;

  constructor(scene: Phaser.Scene, private readonly host: Host) {
    this.sprite = scene.add.sprite(0, 0, Tex.atlas);
    playClip(this.sprite, 'enemy_idle');
    this.ring = scene.add.image(0, 0, Tex.atlas, CUP_RING_FRAME).setVisible(false);
  }

  place(ctx: ViewCtx, e: Entity): number | null {
    if (!this.chosen) {
      this.chosen = true;
      const clip = enemyClip(this.host.assets.atlas, e.has(EnemyKind) ? e.get(EnemyKind)!.species : 0x0c);
      if (!this.opened && clip !== 'enemy_idle') playClip(this.sprite, clip);
    }
    const c = e.get(Cell)!;
    const stage = ctx.world.get(Reveal)!.stage;
    const opening = stage === 'ring' || stage === 'panBack' || stage === 'none';
    let lift = 0;
    if (!opening) {
      const h = e.has(Hover) ? e.get(Hover)!.steps : 0;
      lift = h;
      if (stage === 'hover' && h > 0) {
        const frames = (HOVER_DROP[h] ?? 0) + HOVER_DROP_EXTRA;
        lift = h * Math.max(0, 1 - ctx.world.get(Reveal)!.t / frames);
      }
    }
    const p = cellCorner(ctx.rules, ctx.course, c.x, c.y, lift);
    this.sprite.setPosition(p.x, p.y);
    this.ring.setPosition(p.x, p.y).setVisible(this.opened && !ctx.hidden.has('ring'));
    return p.y;
  }

  animate(ctx: ViewCtx): void {
    if (this.opened) return;
    const stage = ctx.world.get(Reveal)!.stage;
    if (stage === 'ring' || stage === 'panBack') {
      this.opened = true;
      playClip(this.sprite, 'cup_open');
    } else if (stage === 'none') {
      // bound after the reveal (a scene restart): straight to the open hole
      this.opened = true;
      const clip = this.host.assets.atlas?.clips.cup_open;
      this.sprite.stop();
      if (clip) this.sprite.setFrame(clip.frames[clip.frames.length - 1].f);
    }
  }

  setDepth(depth: number): void {
    this.sprite.setDepth(depth);
    this.ring.setDepth(this.ringOver ?? depth + 0.0001);
  }

  /** The ring's depth while the rim mask is up (over Kirby), or null for its own. */
  setRingOver(depth: number | null): void {
    this.ringOver = depth;
    this.ring.setDepth(depth ?? this.sprite.depth + 0.0001);
  }

  destroy(): void {
    this.sprite.destroy();
    this.ring.destroy();
  }
}
