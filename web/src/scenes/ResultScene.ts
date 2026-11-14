import Phaser from 'phaser';
import { GAME_H, GAME_W } from '../config';
import { GlyphText } from '../render/text';

interface ResultData { won: boolean; strokes: number; stars: number }

export class ResultScene extends Phaser.Scene {
  constructor() { super('Result'); }

  create(data: ResultData): void {
    const layers = this.registry.get('layers') as { backColour: number[] };
    const [r, g, b] = layers.backColour;
    this.cameras.main.setBackgroundColor(Phaser.Display.Color.GetColor(r, g, b));
    this.add.image(0, 0, 'layer_bg3').setOrigin(0, 0);
    this.add.rectangle(GAME_W / 2, 100, 200, 120, 0x2a1a5e).setStrokeStyle(2, 0xffffff).setAlpha(0.94);
    const line = (s: string, y: number, sc = 1, tint = 0xffffff): void => {
      const t = new GlyphText(this, 0, y, s, sc, tint);
      t.x = Math.round((GAME_W - t.width8) / 2);
    };
    if (data.won) {
      const par = data.strokes === 1 ? 'HOLE IN ONE!' : `HOLE IN ${data.strokes}`;
      line(par, 56, 2, 0xffe27a);
      line(`STROKES ${data.strokes}`, 92);
      line(`ENEMIES ${data.stars + 1}`, 108);
    } else {
      line('OUT OF', 56, 2, 0xff8080);
      line('TOMATOES', 76, 2, 0xff8080);
      line(`STROKES ${data.strokes}`, 108);
    }
    line('A = TRY AGAIN', 140);
    line('Z/SPACE', GAME_H - 28, 1, 0xdddddd);
    this.input.keyboard!.once('keydown', () => this.scene.start('Hole'));
    this.input.once('pointerdown', () => this.scene.start('Hole'));
  }
}
