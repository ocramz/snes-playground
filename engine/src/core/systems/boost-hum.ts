/**
 * Object 112's per-frame hook, `$84:87D4` (read 2026-11-15; notes/
 * port-v2-phase1-courses.md), in the thread tick:
 *
 *     if $6A28 == 0: return
 *     if $30 <= $DA0A < $3C and $D9C8 != 5:
 *         if counter == 0: music volume $82, sound $15, counter = $22
 *         counter -= 1                      ; every 34 frames
 *     else: music volume $FF, sound 0, $6A28 = 0, counter = 0
 *
 * `$6A28` is set by a straight hit on a panel (sim/dispatch.ts boostHit) and
 * cleared by every other exit of the boost handlers, by this hook, and at
 * the object's spawn. `$80:B5F4` writes the music volume to APU port $2142
 * (`music-volume`, its byte in romSfx); sound 0 stops the effects.
 *
 * `$DA0A` is the work copy's probe tile as the hook finds it: the last real
 * step's, or, while the aim's guide has run on the work copy since
 * (`guideLeft`), the guide's last (sim/guide.ts; the game's guide runs on
 * the real work copy).
 */
import type { World } from 'koota';
import { BoostHum } from '../traits/boost';
import { BallWork } from '../traits/ball';
import { emitEvent } from './flow-util';

export const BOOST_HUM_SFX = 0x15;
export const BOOST_HUM_PERIOD = 0x22;
export const BOOST_HUM_VOLUME = 0x82;
export const MUSIC_VOLUME_FULL = 0xff;

export function tickBoostHum(world: World): void {
  const hum = world.get(BoostHum);
  if (!hum || hum.active === 0) return;
  const e = world.queryFirst(BallWork);
  if (!e) return;
  const w = e.get(BallWork)!;
  if (w.boostFlash === 0) return;
  const tile = w.guideLeft !== 0 ? w.guideTile : w.tile;
  if (tile >= 0x30 && tile < 0x3c && w.mode !== 5) {
    let counter = hum.counter;
    if (counter === 0) {
      emitEvent(world, 'music-volume', BOOST_HUM_VOLUME); // $84:87F6
      emitEvent(world, 'boost-hum', BOOST_HUM_SFX); // $84:87FD
      counter = BOOST_HUM_PERIOD;
    }
    world.set(BoostHum, { active: 1, counter: counter - 1 });
    return;
  }
  emitEvent(world, 'music-volume', MUSIC_VOLUME_FULL); // $84:8811
  emitEvent(world, 'silence', 0); // $84:8818
  w.boostFlash = 0;
  world.set(BoostHum, { active: 1, counter: 0 });
}
