/**
 * One host frame's simulation (reference §8; plans/port_v1_koota_phaser4.md
 * "HoleScene.update"): N fixed core frames, then one drain of the events.
 * Pure (no Phaser), so the determinism test runs it in node: splitting the
 * same core frames into host frames of 1, 2 or 3 must give the same world and
 * the same events.
 *
 * Per tick:
 *   1. `beforeTick` (the cutscene director) says whether the core runs — the
 *      hole's intro holds it (features/cutscene/director.ts);
 *   2. if it runs: `Pad.raw` <- `readPad()` (capture-input), `runCoreFrame`;
 *   3. the history samples the frame.
 * After the ticks: `drainEvents` (core's, in seq order) followed by the
 * presentation's own cues (`takeCues`, the cutscenes' sounds), so
 * play-feedback handles both the same way.
 *
 * While the world has `IsPaused` nothing advances, the held clock included.
 */
import type { World } from 'koota';
import { runCoreFrame } from '../../core/schedule';
import { drainEvents, type GameEvent } from '../../core/events';
import { Pad } from '../../core/traits/pad';
import { IsPaused } from '../../core/traits/session';
import type { CoreHistory } from './history';

export interface HostFrameDeps {
  /** The pad bits for the next core frame (SNES layout, traits/pad.ts). */
  readPad(world: World): number;
  history?: CoreHistory;
  /** Called before each tick; false holds the core for that tick. */
  beforeTick?(world: World): boolean;
  /** Called after each tick (the core frame, if any, has run). */
  afterTick?(world: World, ran: boolean): void;
  /** Events the presentation raised during the ticks (cutscene cues). */
  takeCues?(): GameEvent[];
}

export function runHostFrame(world: World, n: number, deps: HostFrameDeps): GameEvent[] {
  for (let i = 0; i < n; i++) {
    if (world.has(IsPaused)) break;
    const ran = deps.beforeTick?.(world) ?? true;
    if (ran) {
      world.set(Pad, { ...world.get(Pad)!, raw: deps.readPad(world) & 0xffff });
      runCoreFrame(world);
    }
    deps.history?.sample(world, ran);
    deps.afterTick?.(world, ran);
  }
  const events = drainEvents(world);
  const cues = deps.takeCues?.() ?? [];
  return cues.length > 0 ? events.concat(cues) : events;
}
