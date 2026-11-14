// Text in the game's own 8x8 font (docs/text.md): a character is the index of
// its glyph tile. tools/export_web.py writes the glyphs as font.png, 16 per row.
import Phaser from 'phaser';

export const FONT = 'font';

export function registerFont(scene: Phaser.Scene): void {
  const tex = scene.textures.get(FONT);
  for (let i = 0; i < 192; i++) {
    tex.add(`g${i}`, 0, (i % 16) * 8, Math.floor(i / 16) * 8, 8, 8);
  }
}

const SYMBOLS: Record<string, number> = {
  ' ': 0x1f, '#': 0x01, '%': 0x02, '(': 0x03, ')': 0x04, '*': 0x05, '/': 0x06, ':': 0x07,
  '.': 0x08, '!': 0x09, '<': 0x0a, '=': 0x0b, '>': 0x0c, '?': 0x0d, '[': 0x0e, ']': 0x0f,
  '+': 0x1c, '-': 0x1d, ',': 0x6b, "'": 0x6c,
};

export function glyphOf(ch: string): number {
  const c = ch.charCodeAt(0);
  if (c >= 48 && c <= 57) return 0x10 + (c - 48);
  if (c >= 65 && c <= 90) return 0x21 + (c - 65);
  if (c >= 97 && c <= 122) return 0x51 + (c - 97);
  return SYMBOLS[ch] ?? 0x1f;
}

/** A line of glyph sprites. Cheap enough to rebuild when the text changes. */
export class GlyphText extends Phaser.GameObjects.Container {
  private str = '';
  private readonly scaleXY: number;

  constructor(scene: Phaser.Scene, x: number, y: number, text: string, scale = 1, private tint = 0xffffff) {
    super(scene, x, y);
    this.scaleXY = scale;
    scene.add.existing(this);
    this.setText(text);
  }

  setText(text: string): this {
    if (text === this.str) return this;
    this.str = text;
    this.removeAll(true);
    let x = 0;
    for (const ch of text) {
      if (ch !== ' ') {
        const img = this.scene.add.image(x, 0, FONT, `g${glyphOf(ch)}`).setOrigin(0, 0);
        img.setScale(this.scaleXY);
        if (this.tint !== 0xffffff) img.setTint(this.tint);
        this.add(img);
      }
      x += 8 * this.scaleXY;
    }
    return this;
  }

  get width8(): number { return this.str.length * 8 * this.scaleXY; }
}
