/**
 * The game's own pictures for the editor's canvases: the tee pad, the tree
 * and each enemy species' first idle picture, cut from the sprite atlas the
 * game loaded (sprites.png, features/catalog-data.ts's names).
 */
import type { AtlasJson, AtlasFrame } from '../game/assets/schema';
import { enemyClip } from '../game/features/catalog-data';
import { isEnemyTile, enemySpecies, TEE_TILE } from '../core/sweep';

export interface Sprite {
  image: CanvasImageSource;
  frame: AtlasFrame;
}

export class Sprites {
  constructor(private readonly atlas: AtlasJson | null, private readonly image: CanvasImageSource | null) {}

  frame(name: string): Sprite | null {
    const f = this.atlas?.frames[name];
    return f && this.image ? { image: this.image, frame: f } : null;
  }

  /** The picture of an actor tile (tee, tree, enemy), or null. */
  forTile(t: number): Sprite | null {
    if (t === TEE_TILE) return this.frame('tee');
    if (t === 0x02) return this.frame('tree');
    if (isEnemyTile(t)) {
      const clip = this.atlas?.clips[enemyClip(this.atlas, enemySpecies(t))];
      const first = clip?.frames[0]?.f;
      return first ? this.frame(first) : null;
    }
    return null;
  }

  /** Draw a sprite with its pivot at (x, y), scaled. */
  static draw(g: CanvasRenderingContext2D, s: Sprite, x: number, y: number, scale = 1): void {
    const f = s.frame;
    g.drawImage(s.image, f.x, f.y, f.w, f.h, x - (f.ox ?? 0) * scale, y - (f.oy ?? 0) * scale, f.w * scale, f.h * scale);
  }

  /** Draw a sprite fitted into a box (the palette's and the grid's icons). */
  static drawFit(g: CanvasRenderingContext2D, s: Sprite, x: number, y: number, w: number, h: number): void {
    const f = s.frame;
    const k = Math.min(w / f.w, h / f.h);
    const dw = f.w * k;
    const dh = f.h * k;
    g.drawImage(s.image, f.x, f.y, f.w, f.h, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
}

/** $82:B703: the hovering enemies' height in steps (engine/courses/README.md). */
export const HOVER_STEPS: Record<number, number> = { 0x4d: 3, 0x4e: 1, 0x50: 4, 0x51: 2 };
