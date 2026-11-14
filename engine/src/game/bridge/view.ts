/**
 * The contract between the bridge and the per-domain views (reference §9
 * "{Domain}View"): a view owns the Phaser objects of one entity; the sync
 * systems call it in a fixed order every host frame.
 */
import type Phaser from 'phaser';
import type { Entity, World } from 'koota';
import type { RomRules } from '../../core/rules';
import type { CourseState } from '../../core/traits/course';
import type { CoreHistory } from './history';
import type { Host } from '../host';

import type { Hideable } from '../features/cutscene/director';

export interface ViewCtx {
  scene: Phaser.Scene;
  world: World;
  host: Host;
  rules: RomRules;
  course: CourseState;
  history: CoreHistory;
  /** The core frame. */
  frame: number;
  hidden: ReadonlySet<Hideable>;
}

/** Depth bands (bridge/sync-depth.ts). */
export type Band = 'decal' | 'actor';

export interface View {
  readonly kind: string;
  readonly band: Band;
  /** Position the objects; returns the world y the depth sort uses (the feet), or null when not drawn. */
  place(ctx: ViewCtx, e: Entity): number | null;
  /** Clip changes on state transitions (Kirby's pose, the cup opening). */
  animate?(ctx: ViewCtx, e: Entity): void;
  setDepth(depth: number): void;
  destroy(): void;
}

export type ViewFactory = (scene: Phaser.Scene, host: Host) => View;
