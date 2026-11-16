import { trait } from 'koota';

/** One point of the shot guide's path, in the work copy's units. */
export interface GuidePoint {
  xc: number; xf: number; yc: number; yf: number; z: number;
  air: number;
  /** The guide's $D9EE at the dot: in the water, palette 0's own picture ($81:ACDE, $81:ACF9). */
  wet: number;
}

/** One recorded end ($6B0C-$6B2A, projected to $6AFA/$6B00). */
export interface GuideEnd {
  xc: number; xf: number; yc: number; yf: number; z: number;
  /** $DA58/$DA5C space: px, and the upward y. */
  sx: number; sy: number;
  /** The guide's $D9EE at the end: the wet end marker ($81:ADF9). */
  wet: number;
}

export interface GuideState {
  /** Every step's position, for the dots (the view samples them). */
  points: GuidePoint[];
  /** The ends recorded ($6ACA of them); the camera looks at the first. */
  ends: GuideEnd[];
  /** Steps simulated ($B744). */
  steps: number;
  /** Bumped on every recomputation, so a view can tell a new path. */
  version: number;
  /** The frame the latest result was computed on; the camera takes its
   *  first end as the target from the next frame on (-1 = taken). */
  pendingFrame: number;
}

/**
 * World singleton, AoS: the shot guide `$81:A9B8` simulates while aiming
 * (plans/port_v1_koota_phaser4.md item 7). Written by `update-shot-guide`;
 * the camera's target comes from `ends[0]`.
 */
export const Guide = trait((): GuideState => ({ points: [], ends: [], steps: 0, version: 0, pendingFrame: -1 }));
