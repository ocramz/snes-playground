/**
 * The headless host: runs a game world against an input script with no
 * Phaser anywhere, the way the trace tests drive it. It owns input
 * latching only (the `latch-pad` system keeps its own copy of this logic);
 * everything else — advancing Time, the schedule, stalls — belongs to the
 * `step` it is given, so the harness is stable while the schedule grows
 * subsystem by subsystem.
 *
 * Timing: a script entry covering frame F is latched at F's vblank
 * (docs/emulation.md), so `heldAt(script, f)` is applied before step f.
 */
import type { World } from 'koota';
import { Pad } from '../src/core/traits/pad';
import { heldAt, type InputEntry } from './input-script';

export interface HeadlessRun {
  /** Core frames run. */
  frames: number;
}

export function runHeadless(
  world: World,
  script: InputEntry[],
  frames: number,
  step: (world: World) => void,
  onFrame?: (world: World, frame: number) => void,
): HeadlessRun {
  for (let f = 0; f < frames; f++) {
    const pad = world.get(Pad)!;
    const held = heldAt(script, f);
    world.set(Pad, {
      held,
      pressed: held & ~pad.held,
      prev: pad.held,
      stallLatch: pad.stallLatch,
    });
    step(world);
    onFrame?.(world, f);
  }
  return { frames };
}
