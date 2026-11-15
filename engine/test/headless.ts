/**
 * The headless host: runs a game world against an input script with no
 * Phaser anywhere, the way the trace tests drive it. It only writes the
 * raw buttons (`Pad.raw`); the schedule's `latch-pad` system derives held
 * and pressed, and everything else — advancing Time, stalls — belongs to
 * the `step` it is given.
 *
 * Timing: a script entry covering frame F is latched at F's vblank
 * (docs/emulation.md), so `heldAt(script, f + offset)` is written before
 * step f. `offset` maps the engine's frames onto the script's (the game's)
 * frame numbers.
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
  offset = 0,
): HeadlessRun {
  for (let f = 0; f < frames; f++) {
    const pad = world.get(Pad)!;
    world.set(Pad, { ...pad, raw: heldAt(script, f + offset) });
    step(world);
    onFrame?.(world, f);
  }
  return { frames };
}
