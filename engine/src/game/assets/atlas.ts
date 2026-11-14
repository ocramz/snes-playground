/**
 * The pipeline's atlas format -> Phaser (plans/port_v1_koota_phaser4.md
 * "Atlas format the engine consumes"): one texture frame per atlas frame,
 * with the object's position inside it (ox, oy) as the frame's custom pivot,
 * so a sprite placed at an object's position draws its top-left at
 * position - (ox, oy) on every frame of a clip (Phaser sets the origin from
 * a custom pivot on setFrame and on each animation frame). One global
 * animation per clip, its frames timed in 60.0988 Hz frames. Phaser has no
 * loop tail, so a clip whose loop starts past its first frame becomes two:
 * the lead-in, then `name~loop` repeating, chained by playClip.
 */
import Phaser from 'phaser';
import type { AtlasJson } from './schema';
import { FRAME_MS } from '../config';

export const LOOP_SUFFIX = '~loop';

export function addAtlasFrames(textures: Phaser.Textures.TextureManager, key: string, atlas: AtlasJson): void {
  const tex = textures.get(key);
  for (const [name, f] of Object.entries(atlas.frames)) {
    const frame = tex.has(name) ? tex.get(name) : tex.add(name, 0, f.x, f.y, f.w, f.h);
    if (!frame) continue;
    frame.customPivot = true;
    frame.pivotX = (f.ox ?? 0) / f.w;
    frame.pivotY = (f.oy ?? 0) / f.h;
  }
}

export function addAtlasClips(anims: Phaser.Animations.AnimationManager, key: string, atlas: AtlasJson): void {
  for (const [name, clip] of Object.entries(atlas.clips)) {
    if (anims.exists(name)) continue;
    const frames = clip.frames.map(({ f, d }) => ({ key, frame: f, duration: Math.max(1, d) * FRAME_MS }));
    if (clip.loop && clip.loopStart > 0 && clip.loopStart < frames.length) {
      anims.create({ key: name, frames: frames.slice(0, clip.loopStart), frameRate: 60, repeat: 0 });
      anims.create({ key: name + LOOP_SUFFIX, frames: frames.slice(clip.loopStart), frameRate: 60, repeat: -1 });
    } else {
      anims.create({ key: name, frames, frameRate: 60, repeat: clip.loop ? -1 : 0 });
    }
  }
}

/** Play a clip from its start (its loop tail chained), dropping any queued one. */
export function playClip(sprite: Phaser.GameObjects.Sprite, clip: string): void {
  sprite.chain();
  sprite.play(clip);
  if (sprite.scene.anims.exists(clip + LOOP_SUFFIX)) sprite.chain(clip + LOOP_SUFFIX);
}
