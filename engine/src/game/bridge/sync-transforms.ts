/** `sync-transforms` (reference §9, trait-owned transforms): every view places its objects from the traits. */
import type { Presentation } from './presentation';

export function syncTransforms(p: Presentation): void {
  for (const [e, v] of p.views.entries()) {
    p.views.sortY.set(e, e.isAlive() ? v.place(p.ctx, e) : null);
  }
}
