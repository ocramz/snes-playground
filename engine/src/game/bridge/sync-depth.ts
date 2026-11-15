/**
 * `sync-depth`: the iso sort. Things on the ground (the tee pad, the cup and
 * its ring) stay under the actors (Kirby must be drawn over the cup:
 * web/test/e2e/depth.mjs's rule); actors sort by the world y of their feet
 * (a larger y is nearer the camera). All of it sits over both of the course's
 * layers (BG*.0 and BG*.1): every sprite of play is OAM priority 3
 * (layers-view.ts). While the cup's rim mask is up (object 75,
 * features/enemies/cup-mask.ts), sync-cup-mask raises the ring over Kirby
 * and cuts him off below the rim.
 */
import { DEPTH, type Presentation } from './presentation';

export function syncDepth(p: Presentation): void {
  for (const [e, v] of p.views.entries()) {
    const y = p.views.sortY.get(e);
    if (y === null || y === undefined) continue;
    v.setDepth((v.band === 'decal' ? DEPTH.decal : DEPTH.actor) + Math.max(-5000, Math.min(50000, y)) * 1e-5);
  }
}
