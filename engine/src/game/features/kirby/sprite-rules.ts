/**
 * The pure half of Kirby's sprite (kirby-view.ts): where his OAM priority
 * puts him among the course's layers, and when his shadow is drawn.
 */
import { PRIO_OVER } from '../../../core/traits/pose';
import { DEPTH as LAYER } from '../layers/layer-depth';

/** Kirby's depth at OAM priorities 1 and 2 ($D96A, `$82:F4FD`). */
export const KIRBY_DEPTH = {
  /** Priority 1: under both course layers (BG*.0, BG*.1), over BG3. */
  under: (LAYER.bg3 + LAYER.back) / 2,
  /** Priority 2: over the back layer and its outline, under the front layer. */
  between: (LAYER.outlineBack + LAYER.front) / 2,
} as const;

/** Kirby's depth for OAM priority `prio`; `sorted` is his depth in the actors' sort. */
export function kirbyDepth(prio: number, sorted: number): number {
  if (prio >= PRIO_OVER) return sorted;
  return prio === 2 ? KIRBY_DEPTH.between : KIRBY_DEPTH.under;
}

/**
 * `$81:A23E`'s shadow test, beyond the view's own (airborne, rolling, not
 * holed). There is no shadow over a gap, where the probe's ground is 0
 * (docs/terrain.md "Gaps"), or once the ball is below z 0 ($D9D2 bit 0, set
 * by the projection).
 */
export function shadowShown(w: { ground: number; lost: number }): boolean {
  return w.ground !== 0 && (w.lost & 1) === 0;
}
