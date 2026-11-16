/**
 * Kirby's repainted frames (game/features/kirby/kirby-recolour.ts): the
 * BGR555 -> RGB conversion is the pipeline's (tools/tiles.py snes_color),
 * and a repaint touches only the palette's opaque pixels.
 */
import { describe, expect, it } from 'vitest';
import { colourMap, repaint, snesRgb } from '../src/game/features/kirby/kirby-recolour';

describe('Kirby recolour', () => {
  it('converts as snes_color (r << 3 | r >> 2 per channel)', () => {
    expect(snesRgb(0x0000)).toBe(0x000000);
    expect(snesRgb(0x7fff)).toBe(0xffffff);
    expect(snesRgb(0x0c63)).toBe(0x181818); // the outline at rest: 3 -> 24 on each channel
    expect(snesRgb(0x001f)).toBe(0xff0000);
  });

  it('repaints the mapped opaque pixels only', () => {
    const map = colourMap([0x2c9c, 0x0c63], [0x2c9c, 0x03e0]); // the outline green, colour 2 unchanged
    expect(map.size).toBe(1);
    const outline = snesRgb(0x0c63);
    const px = new Uint8ClampedArray([
      outline >> 16, (outline >> 8) & 0xff, outline & 0xff, 255,
      outline >> 16, (outline >> 8) & 0xff, outline & 0xff, 0, // transparent: kept
      1, 2, 3, 255,
    ]);
    repaint(px, map);
    const green = snesRgb(0x03e0);
    expect([...px.slice(0, 4)]).toEqual([green >> 16, (green >> 8) & 0xff, green & 0xff, 255]);
    expect([...px.slice(4, 8)]).toEqual([outline >> 16, (outline >> 8) & 0xff, outline & 0xff, 0]);
    expect([...px.slice(8)]).toEqual([1, 2, 3, 255]);
  });
});
