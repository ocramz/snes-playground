import { createWorld, type World } from 'koota';
import { Pad } from './traits/pad';
import { Time } from './traits/time';

/**
 * The one game world. No module-level world: the headless test harness and
 * the Phaser host each create their own (plans/port_v1_koota_phaser4.md,
 * "createGameWorld(), no global"). Traits and systems land subsystem by
 * subsystem; for now the world carries only the frame counter and the pad.
 */
export function createGameWorld(): World {
  const world = createWorld();
  world.add(Time);
  world.add(Pad);
  return world;
}
