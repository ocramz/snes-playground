// The sprite atlas written by tools/export_web_sprites.py: one PNG, per-frame
// rectangles and "origin" (where the object sits inside the frame), and clips
// with durations in 60 Hz ticks.
import Phaser from 'phaser';

export interface AtlasFrame { x: number; y: number; w: number; h: number; ox: number; oy: number }
export interface ClipFrame { f: string; d: number }
export interface Clip { frames: ClipFrame[]; loop: boolean; loopStart: number; next: number | null }
export interface AtlasJson {
  image: string;
  size: [number, number];
  frames: Record<string, AtlasFrame>;
  clips: Record<string, Clip>;
}

export const SPRITES = 'sprites';
export const UI = 'ui';

/** Register every frame of the atlas image as a named texture frame. */
export function registerAtlas(scene: Phaser.Scene, atlas: AtlasJson): void {
  const tex = scene.textures.get(SPRITES);
  for (const [name, f] of Object.entries(atlas.frames)) {
    tex.add(name, 0, f.x, f.y, f.w, f.h);
  }
}

/** An image positioned by its object point: top-left = position - (ox, oy). */
export function spriteImage(scene: Phaser.Scene, atlas: AtlasJson, frame: string, x = 0, y = 0): Phaser.GameObjects.Image {
  const f = atlas.frames[frame];
  const img = scene.add.image(x, y, SPRITES, frame);
  img.setOrigin(f.ox / f.w, f.oy / f.h);
  return img;
}

export function setFrame(img: Phaser.GameObjects.Image, atlas: AtlasJson, frame: string): void {
  const f = atlas.frames[frame];
  img.setFrame(frame);
  img.setOrigin(f.ox / f.w, f.oy / f.h);
}

/** Register rectangles of an image texture (the shot panel pictures of ui.json). */
export function registerFrames(scene: Phaser.Scene, key: string, frames: Record<string, { x: number; y: number; w: number; h: number }>): void {
  const tex = scene.textures.get(key);
  for (const [name, f] of Object.entries(frames)) tex.add(name, 0, f.x, f.y, f.w, f.h);
}
