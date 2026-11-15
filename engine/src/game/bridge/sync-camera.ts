/**
 * `sync-camera`: core's camera (Camera.x = the scroll's x, Camera.y counted
 * upward, the scroll's y = screenBase - y; core/projection.ts scrollOf) ->
 * the Phaser camera's scroll, whole pixels. A cutscene's recorded track
 * replaces it while the director owns the camera.
 */
import { Camera } from '../../core/traits/camera';
import { scrollOf } from '../../core/projection';
import type { Presentation } from './presentation';

const s16 = (v: number): number => {
  const w = v & 0xffff;
  return w >= 0x8000 ? w - 0x10000 : w;
};

export function syncCamera(p: Presentation): void {
  const replay = p.director.ownsCamera() ? p.director.frame() : null;
  if (replay) {
    p.camera.setScroll(replay.scroll.x, replay.scroll.y);
    return;
  }
  const cam = p.ctx.world.get(Camera)!;
  const s = scrollOf(p.ctx.course, s16(cam.x), s16(cam.y));
  p.camera.setScroll(s.x, s.y);
}
