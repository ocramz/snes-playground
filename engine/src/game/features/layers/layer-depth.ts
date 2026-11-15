/**
 * The course's depth bands, back to front (layers-view.ts draws them; the
 * sprites' bands are in bridge/presentation.ts). Phaser-free, so the pure
 * modules can place things relative to the layers.
 */
export const DEPTH = {
  bg3: 0,
  back: 10,
  rippleBack: 10.5,
  outlineBack: 11,
  front: 12,
  rippleFront: 12.5,
  outlineFront: 13,
} as const;
