import Phaser from 'phaser';
import { GAME_H, GAME_W } from '../config';
import { GlyphText } from '../render/text';
import { GameAudio } from '../audio/audio';

export class TitleScene extends Phaser.Scene {
  constructor() { super('Title'); }

  create(): void {
    const layers = this.registry.get('layers') as { backColour: number[] };
    const [r, g, b] = layers.backColour;
    this.cameras.main.setBackgroundColor(Phaser.Display.Color.GetColor(r, g, b));
    this.add.image(0, 0, 'layer_bg3').setOrigin(0, 0);
    const card = this.add.rectangle(GAME_W / 2, 96, 176, 64, 0x2a1a5e).setStrokeStyle(2, 0xffffff);
    card.setAlpha(0.92);
    const t = (s: string, y: number, sc = 1, tint = 0xffffff): GlyphText => {
      const g = new GlyphText(this, 0, y, s, sc, tint);
      g.x = Math.round((GAME_W - g.width8) / 2);
      return g;
    };
    t('COURSE 1', 74, 2, 0xffe27a);
    t('HOLE 1', 98, 2);
    t('PRESS A', 170);
    t('Z/SPACE = A   X = B   ARROWS = AIM', GAME_H - 24, 1, 0xdddddd);

    const audio = new GameAudio();
    this.registry.set('audio', audio);
    const go = (): void => {
      void audio.unlock().then(() => audio.playMusic());
      this.scene.start('Hole');
    };
    this.input.keyboard!.once('keydown', go);
    this.input.once('pointerdown', go);
  }
}
