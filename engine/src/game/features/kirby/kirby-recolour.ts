/**
 * Kirby's frames in other colours (core's `AbilityFx.colours`, OBJ palette
 * 0's colours 2-8; core/sim/kirby-colours.ts): the atlas draws every frame
 * with the dry set (`$98:C77A`) and a wet twin (`<frame>_w`); any other set
 * (the copy abilities' palettes, the transformation's flash, the outline's
 * green flash) is the dry frame with each dry colour's pixels repainted,
 * made on first use into a small canvas texture with the frame's pivot and
 * kept in a bounded cache. A pixel matches a palette colour by its exact
 * RGB (tools/tiles.py `snes_color`, the pipeline's conversion).
 */
import Phaser from 'phaser';

/** BGR555 -> 0xRRGGBB, as tools/tiles.py snes_color. */
export function snesRgb(word: number): number {
  const r = word & 0x1f;
  const g = (word >> 5) & 0x1f;
  const b = (word >> 10) & 0x1f;
  return (((r << 3) | (r >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((b << 3) | (b >> 2));
}

/** The colours -> new colours map of a recolouring, the unchanged left out. */
export function colourMap(from: readonly number[], to: readonly number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < from.length && i < to.length; i++) {
    if (from[i] !== to[i]) m.set(snesRgb(from[i]), snesRgb(to[i]));
  }
  return m;
}

/** Repaint RGBA pixels in place by `map` (opaque pixels only). */
export function repaint(px: Uint8ClampedArray, map: Map<number, number>): void {
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const t = map.get((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (t === undefined) continue;
    px[i] = t >> 16;
    px[i + 1] = (t >> 8) & 0xff;
    px[i + 2] = t & 0xff;
  }
}

const CACHE_MAX = 384;

export class KirbyRecolour {
  private source: CanvasRenderingContext2D | null = null;
  private readonly cache = new Map<string, Phaser.Textures.Frame>();
  private serial = 0;

  constructor(private readonly scene: Phaser.Scene, private readonly atlasKey: string) {}

  /** Atlas frame `name` with `from`'s colours painted as `to`'s, or null (no such frame, no canvas). */
  frame(name: string, from: readonly number[], to: readonly number[]): Phaser.Textures.Frame | null {
    const key = `${name}|${to.join(',')}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // most recent last
      this.cache.set(key, hit);
      return hit;
    }
    const tex = this.scene.textures.get(this.atlasKey);
    if (!tex.has(name)) return null;
    const f = tex.get(name);
    const src = this.sourceContext(tex);
    if (!src) return null;
    const data = src.getImageData(f.cutX, f.cutY, f.cutWidth, f.cutHeight);
    repaint(data.data, colourMap(from, to));
    const texKey = `kirby-recolour-${this.serial++}`;
    const canvas = this.scene.textures.createCanvas(texKey, f.cutWidth, f.cutHeight);
    if (!canvas) return null;
    canvas.context.putImageData(data, 0, 0);
    canvas.refresh();
    const out = canvas.get();
    out.customPivot = true;
    out.pivotX = f.pivotX;
    out.pivotY = f.pivotY;
    this.cache.set(key, out);
    if (this.cache.size > CACHE_MAX) {
      const [oldKey, old] = this.cache.entries().next().value as [string, Phaser.Textures.Frame];
      this.cache.delete(oldKey);
      old.texture.destroy();
    }
    return out;
  }

  private sourceContext(tex: Phaser.Textures.Texture): CanvasRenderingContext2D | null {
    if (this.source) return this.source;
    const img = tex.getSourceImage() as HTMLImageElement | HTMLCanvasElement;
    if (typeof document === 'undefined' || !img) return null;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0);
    this.source = g;
    return g;
  }

  destroy(): void {
    for (const f of this.cache.values()) f.texture.destroy();
    this.cache.clear();
    this.source = null;
  }
}
