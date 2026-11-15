/**
 * `latch-pad` (schedule item 2): the NMI's pad read. The host writes
 * `Pad.raw`; this derives held ($0067), pressed ($006B) and the memories.
 */
import type { World } from 'koota';
import { Pad } from '../traits/pad';

export function latchPad(world: World): void {
  const p = world.get(Pad)!;
  const raw = p.raw & 0xffff;
  world.set(Pad, {
    ...p,
    held: raw,
    pressed: raw & ~p.last & 0xffff,
    prev: p.held,
    last: raw,
  });
}
