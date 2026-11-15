/**
 * `sync-cup-mask`: the cup's near rim over Kirby while object 75 is up
 * (features/enemies/cup-mask.ts): Kirby cut off below the rim, the ring
 * (the CupView's, or the hole-out replay's) raised over him. After
 * sync-depth, whose depths it overrides, and before sync-cutscene, which
 * reads `groundOver`.
 */
import { Cell, IsCup } from '../../core/traits/hole';
import { cellCorner } from './placement';
import { KirbyView } from '../features/kirby/kirby-view';
import { CupView } from '../features/enemies/cup-view';
import { CUP_MASK_FRAME, cupMaskCut } from '../features/enemies/cup-mask';
import type { Presentation } from './presentation';

export function syncCupMask(p: Presentation): void {
  p.cupMask.note(p.events);
  let kirby: KirbyView | null = null;
  let cupView: CupView | null = null;
  for (const v of p.views.values()) {
    if (v instanceof KirbyView) kirby = v;
    else if (v instanceof CupView) cupView = v;
  }
  const cup = p.ctx.world.queryFirst(IsCup, Cell);
  const frame = p.ctx.host.assets.atlas?.frames[CUP_MASK_FRAME];
  const on = p.cupMask.active(p.ctx.frame) && kirby !== null && kirby.position.visible
    && cup !== undefined && frame !== undefined;
  if (!on) {
    kirby?.setCut(null);
    cupView?.setRingOver(null);
    p.groundOver = null;
    return;
  }
  const c = cup!.get(Cell)!;
  const corner = cellCorner(p.ctx.rules, p.ctx.course, c.x, c.y);
  kirby!.setCut(cupMaskCut(corner.y, frame!));
  const over = kirby!.depth + 1e-6;
  cupView?.setRingOver(over);
  p.groundOver = over;
}
