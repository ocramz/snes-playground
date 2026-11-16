/**
 * The per-hole RESULT card on screen (port_v2 phase 7): the hole's BG3
 * scenery, which the card keeps (TM = $15: BG1, BG3, OBJ); the course's
 * window on BG1 (card_window_<course>.png, the member's drawing blank);
 * object $8C's numbers at `$83:CD82`'s slots (card.json); the fade veil
 * from core's Screen. The warp star with Kirby (objects $88/$89) and the
 * numbers' pop-in are not drawn (docs/engine.md "Not ported").
 */
import Phaser from 'phaser';
import { Tex, holeTexKey } from '../../assets/keys';
import type { CardJson } from '../../assets/schema';
import { numberCells, type CardState } from './card-state';

export class CardView {
  private readonly objects: Phaser.GameObjects.GameObject[] = [];
  private readonly digits: Phaser.GameObjects.Image[] = [];
  private veil: Phaser.GameObjects.Rectangle;
  private bestWindow: Phaser.GameObjects.Image | null = null;
  private last = '';

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly card: CardJson | null,
    private readonly holeIndex: number | null,
    private readonly course: number,
    private readonly depth: number,
    /** The course's colour 0 (layers.json backColour): the backdrop where BG3 is clear. */
    private readonly back: [number, number, number] = [0, 0, 0],
  ) {
    this.veil = scene.add.rectangle(0, 0, 256, 224, 0x000000).setOrigin(0, 0).setScrollFactor(0)
      .setDepth(depth + 5).setVisible(false);
  }

  update(s: CardState): void {
    const key = JSON.stringify(s);
    if (key === this.last) return;
    this.last = key;
    if (!s.visible) {
      for (const o of this.objects) (o as unknown as Phaser.GameObjects.Components.Visible).setVisible(false);
      for (const d of this.digits) d.destroy();
      this.digits.length = 0;
      this.veil.setVisible(false);
      this.bestWindow?.setVisible(false);
      return;
    }
    if (this.objects.length === 0) this.build();
    for (const o of this.objects) (o as unknown as Phaser.GameObjects.Components.Visible).setVisible(true);
    for (const d of this.digits) d.destroy();
    this.digits.length = 0;
    const c = this.card;
    if (c && this.scene.textures.exists(Tex.cardDigits)) {
      const put = (cell: number, x: number, y: number, h = 16): void => {
        this.digits.push(this.scene.add.image(x, y, Tex.cardDigits).setOrigin(0, 0).setScrollFactor(0)
          .setCrop(cell * c.digits.w, 0, c.digits.w, h).setDisplayOrigin(cell * c.digits.w, 0).setDepth(this.depth + 2));
      };
      s.strokes.forEach((n, k) => {
        const [x, y] = c.holes[k];
        for (const d of numberCells(n, x, y)) put(d.cell, d.x, d.y);
        if (n === 1) put(10, x - 34, y - 4, 8); // $83:CF1D: the 1's star
      });
      const [tx, ty] = c.total;
      for (const d of numberCells(s.total, tx, ty)) put(d.cell, d.x, d.y);
      if (s.best && c.best) {
        const dx = c.best.dx;
        s.best.strokes.forEach((n, k) => {
          const [x, y] = c.holes[k];
          for (const d of numberCells(n, x + dx, y)) put(d.cell, d.x, d.y);
          if (n === 1) put(10, x + dx - 34, y - 4, 8);
        });
        for (const d of numberCells(s.best.total, tx + dx, ty)) put(d.cell, d.x, d.y);
      }
    }
    this.bestWindow?.setVisible(s.best !== null);
    this.veil.setVisible(true).setAlpha(s.bright < 0 ? 1 : 1 - s.bright / 15);
  }

  private build(): void {
    const sc = this.scene;
    const [r, g, b] = this.back;
    this.objects.push(sc.add.rectangle(0, 0, 256, 224, (r << 16) | (g << 8) | b).setOrigin(0, 0).setScrollFactor(0)
      .setDepth(this.depth - 0.5));
    const bg3 = this.holeIndex !== null ? holeTexKey(this.holeIndex, 'layer_bg3.png') : Tex.scenery;
    if (sc.textures.exists(bg3)) {
      this.objects.push(sc.add.image(0, 0, bg3).setOrigin(0, 0).setScrollFactor(0).setDepth(this.depth));
    } else {
      this.objects.push(sc.add.rectangle(0, 0, 256, 224, 0x000000).setOrigin(0, 0).setScrollFactor(0).setDepth(this.depth));
    }
    if (this.card?.best && sc.textures.exists(Tex.cardBest)) {
      const [bx, by] = this.card.best.at;
      this.bestWindow = sc.add.image(bx, by, Tex.cardBest).setOrigin(0, 0).setScrollFactor(0).setDepth(this.depth + 1);
    }
    const win = Tex.cardWindow(this.course);
    if (this.card && sc.textures.exists(win)) {
      const [x, y] = this.card.window.at;
      this.objects.push(sc.add.image(x, y, win).setOrigin(0, 0).setScrollFactor(0).setDepth(this.depth + 1));
    }
  }

  destroy(): void {
    for (const o of this.objects) o.destroy();
    for (const d of this.digits) d.destroy();
    this.veil.destroy();
    this.bestWindow?.destroy();
  }
}
