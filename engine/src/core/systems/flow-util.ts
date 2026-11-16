/**
 * Shared plumbing of the flow systems: the phase clock, event emission.
 * (The player is `activePlayer`, traits/player.ts.)
 */
import type { World } from 'koota';
import { Time } from '../traits/time';
import { HoleFlow, type FlowPhase } from '../traits/flow';
import { emit } from '../events';

export function frameOf(world: World): number {
  return world.get(Time)!.frame;
}

/** The current phase and the frames since it was entered (0 on that frame). */
export function phaseNow(world: World): { phase: FlowPhase; t: number } {
  const f = world.get(HoleFlow)!;
  return { phase: f.phase, t: frameOf(world) - f.since };
}

export function enterPhase(world: World, phase: FlowPhase): void {
  const f = world.get(HoleFlow)!;
  world.set(HoleFlow, { ...f, phase, since: frameOf(world), prev: f.phase });
}

/** Emit a sound/presentation event stamped with this frame. */
export function emitEvent(world: World, kind: string, romSfx = -1, subject = 0): void {
  emit(world, { frame: frameOf(world) }, kind, romSfx, subject);
}
