/**
 * The snap panels' star trail (sim/snap-stars.ts): the live objects 61 (the
 * spawners; the latch can re-arm while one lives, so there may be two) and
 * 62 (the stars), and `$699A`, the flag every object 61 shares: set to $FFFF
 * at each of its bursts, cleared by every snap push ($82:A5F7). World
 * singleton, reset at the hole's start; systems/snap-trail.ts ticks it, the
 * view draws `stars`.
 */
import { trait } from 'koota';
import type { SpawnerRun, StarRun } from '../sim/snap-stars';

export interface SnapTrailState {
  keep: number;
  spawners: SpawnerRun[];
  stars: StarRun[];
}

export const SnapTrail = trait((): SnapTrailState => ({ keep: 0xffff, spawners: [], stars: [] }));
