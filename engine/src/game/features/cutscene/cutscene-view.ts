/**
 * The replay's pictures: a pool of images showing one ReplayFrame — the
 * world types (the tee pad 108, the ring 74) on the ground, the others
 * (the star, Kirby riding it, the sparkles, the letters) in their recorded
 * slot order above the course's sprites — and the screen's brightness as a
 * black overlay (INIDISP: 15 lit, 0 black).
 */
import Phaser from 'phaser';
import { GAME_H, GAME_W } from '../../config';
import { Tex } from '../../assets/keys';
import type { ReplayFrame } from './replay';

export class CutsceneView {
  private readonly pool: Phaser.GameObjects.Image[] = [];
  private readonly fade: Phaser.GameObjects.Rectangle;

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly depth: { ground: number; sprites: number; fade: number },
  ) {
    this.fade = scene.add.rectangle(0, 0, GAME_W, GAME_H, 0x000000, 1)
      .setOrigin(0, 0).setScrollFactor(0).setDepth(depth.fade).setAlpha(0);
  }

  /** `groundOver`: a depth for the world types while the cup's rim mask is up (the ring over Kirby). */
  update(frame: ReplayFrame | null, groundOver: number | null = null): void {
    const sprites = frame?.sprites ?? [];
    while (this.pool.length < sprites.length) this.pool.push(this.scene.add.image(0, 0, Tex.atlas));
    this.pool.forEach((img, i) => {
      const s = sprites[i];
      if (!s) {
        img.setVisible(false);
        return;
      }
      img.setFrame(s.key).setPosition(s.x, s.y).setVisible(true)
        .setDepth(s.depth < 0 ? groundOver ?? this.depth.ground : this.depth.sprites + s.depth * 0.01);
    });
    this.fade.setAlpha(frame ? 1 - Math.max(0, Math.min(15, frame.brightness)) / 15 : 0);
  }

  destroy(): void {
    for (const img of this.pool) img.destroy();
    this.fade.destroy();
  }
}
