/**
 * The shot panel (`sync-panel`): panel-layout.ts's sprites, drawn from a
 * pool of screen-fixed images in list order (back to front). `update` takes
 * the same state object tools/check_web_ui.py's browser half passes
 * (test/e2e/panel.mjs), so the pixel check drives the real view.
 */
import Phaser from 'phaser';
import { Tex } from '../../assets/keys';
import type { UiJson } from '../../assets/schema';
import { panelSprites, type PanelInput } from './panel-layout';

export class PanelView {
  private readonly pool: Phaser.GameObjects.Image[] = [];

  constructor(private readonly scene: Phaser.Scene, private readonly ui: UiJson | null, private readonly depth: number) {}

  update(state: PanelInput): void {
    if (!this.ui) return;
    const sprites = panelSprites(this.ui, state);
    while (this.pool.length < sprites.length) {
      this.pool.push(this.scene.add.image(0, 0, Tex.ui, sprites[0].f).setOrigin(0, 0).setScrollFactor(0));
    }
    this.pool.forEach((img, i) => {
      const s = sprites[i];
      if (!s) {
        img.setVisible(false);
        return;
      }
      img.setFrame(s.f).setPosition(s.x, s.y).setDepth(this.depth + i * 0.001).setVisible(true);
    });
  }

  /** The panel's images, for the pixel check (everything else is hidden there). */
  get objects(): readonly Phaser.GameObjects.Image[] {
    return this.pool;
  }

  destroy(): void {
    for (const img of this.pool) img.destroy();
  }
}
