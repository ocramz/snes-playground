/**
 * A hazard actor (Visual 'hazard': objects 76, 77, 81-83). Its state is the
 * thread's, in the Hazards singleton (core sim/actors.ts ActorRun), found by
 * the entity's spawn cell; the picture is objects.json's for the thread's
 * frame number (catalog-data.ts hazardFrame). A type with no sheet is drawn
 * as a marker.
 */
import Phaser from 'phaser';
import type { Entity } from 'koota';
import { Tex } from '../../assets/keys';
import { ActorType, Cell } from '../../../core/traits/hole';
import { Hazards } from '../../../core/traits/hazards';
import { actorRunPoint } from '../../bridge/placement';
import type { View, ViewCtx } from '../../bridge/view';
import type { Host } from '../../host';
import { hazardFrame } from '../catalog-data';

export class HazardView implements View {
  readonly kind = 'hazard';
  readonly band = 'actor' as const;
  private readonly image: Phaser.GameObjects.Image | null;
  private readonly marker: Phaser.GameObjects.Graphics | null;

  constructor(scene: Phaser.Scene, private readonly host: Host) {
    const ok = host.assets.objects !== null && scene.textures.exists(Tex.objects);
    this.image = ok ? scene.add.image(0, 0, Tex.objects) : null;
    this.marker = ok ? null : scene.add.graphics();
    if (this.marker) {
      this.marker.fillStyle(0xe04040, 1).fillTriangle(0, -12, 8, 0, -8, 0).lineStyle(1, 0xffffff, 1).strokeTriangle(0, -12, 8, 0, -8, 0);
    }
  }

  place(ctx: ViewCtx, e: Entity): number | null {
    const field = ctx.world.get(Hazards)!;
    const c = e.get(Cell)!;
    const run = field.actors[field.atCell[c.y * ctx.course.w + c.x]];
    if (!run) return null;
    const p = actorRunPoint(ctx.course, run);
    if (this.image) {
      const name = hazardFrame(this.host.assets.objects, e.get(ActorType)!.type, run.dir, run.frame);
      if (name) this.image.setFrame(name);
      this.image.setPosition(p.x, p.y).setVisible(name !== null);
    }
    this.marker?.setPosition(p.x, p.y);
    return p.y;
  }

  setDepth(depth: number): void {
    this.image?.setDepth(depth);
    this.marker?.setDepth(depth);
  }

  destroy(): void {
    this.image?.destroy();
    this.marker?.destroy();
  }
}
