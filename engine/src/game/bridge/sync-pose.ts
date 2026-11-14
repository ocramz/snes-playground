/** `sync-pose` (reference §12): clips follow semantic state; each view dirty-checks its own clip. */
import type { Presentation } from './presentation';

export function syncPose(p: Presentation): void {
  for (const [e, v] of p.views.entries()) if (e.isAlive()) v.animate?.(p.ctx, e);
}
