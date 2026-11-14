/**
 * The game's font as a Phaser bitmap font: font.png (tools/export_web.py
 * build_font, gfx_course_font $90:FBBC) is 16 glyphs to a row of 8 x 8, the
 * glyph index being the game's character code (docs/text.md). RetroFont maps
 * a string's characters to cells in order, so the string is built from the
 * encoding (encoding.ts).
 */
import Phaser from 'phaser';
import { Fonts, Tex } from '../../assets/keys';
import { GLYPH_SIZE, GLYPHS_PER_ROW, fontSafe, retroFontChars } from './encoding';

export function buildFont(scene: Phaser.Scene): boolean {
  if (!scene.textures.exists(Tex.font)) return false;
  if (scene.cache.bitmapFont.exists(Fonts.main)) return true;
  const config = {
    image: Tex.font,
    width: GLYPH_SIZE,
    height: GLYPH_SIZE,
    chars: retroFontChars(),
    charsPerRow: GLYPHS_PER_ROW,
    'offset.x': 0,
    'offset.y': 0,
    'spacing.x': 0,
    'spacing.y': 0,
    lineSpacing: 0,
  } as unknown as Phaser.Types.GameObjects.BitmapText.RetroFontConfig;
  scene.cache.bitmapFont.add(Fonts.main, Phaser.GameObjects.RetroFont.Parse(scene, config));
  return true;
}

/** A line of the game's text at (x, y), screen-fixed; falls back to a system font without font.png. */
export function addText(scene: Phaser.Scene, x: number, y: number, text: string): Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text {
  if (scene.cache.bitmapFont.exists(Fonts.main)) {
    return scene.add.bitmapText(x, y, Fonts.main, fontSafe(text)).setScrollFactor(0);
  }
  return scene.add.text(x, y, text, { fontFamily: 'monospace', fontSize: '8px', color: '#ffffff' })
    .setResolution(2).setScrollFactor(0);
}

export function setGameText(obj: Phaser.GameObjects.BitmapText | Phaser.GameObjects.Text, text: string): void {
  if (obj instanceof Phaser.GameObjects.BitmapText) obj.setText(fontSafe(text));
  else obj.setText(text);
}
