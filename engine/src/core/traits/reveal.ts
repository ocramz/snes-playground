/**
 * The cup reveal's state (`$82:8B5C`): its stage and the stages' inputs.
 * The stages and their measured frames are systems/reveal.ts's header; the
 * reveal runs as the `cupReveal` stall (traits/stall.ts). The hover drop's
 * table is here because the cup's view draws the drop from it.
 */
import { trait } from 'koota';

/** `$82:8CE8`: the hover drop's frames by hover height; + 8 more ($85:9A2B). */
export const HOVER_DROP = [0, 4, 6, 10, 13, 17, 20, 23];
export const HOVER_DROP_EXTRA = 8;

export type RevealStage = 'none' | 'lead' | 'panTo' | 'hover' | 'ring' | 'panBack';

export const Reveal = trait({
  stage: 'none' as RevealStage,
  /** Frames in the current stage. */
  t: 0,
  /** Frames since the reveal began. */
  total: 0,
  /** The cup's cell. */
  cupX: 0,
  cupY: 0,
  /** $38B4 / $38B6: the camera saved at the start. */
  savedX: 0,
  savedY: 0,
  /** $ECBB / $ECBD: the cup's projection, the pan's target. */
  panX: 0,
  panY: 0,
  /** The enemy was on screen at the start (`$82:8D5A`'s window). */
  onScreen: 0,
  /** The hover drop's length (0 = none). */
  hoverFrames: 0,
  /** The camera panned to the cup (the ring then comes a frame sooner). */
  panned: 0,
});
