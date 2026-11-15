/**
 * The terrain and the arrow panels against the recorded game: course 1
 * holes 2 and 3, a weak shot from the tee, then the ball's block poked at the
 * roll's first frame (tools/snesstep/inputs/web_arrow, web_ramps, web_step
 * .txt and .pokes; the comparison is test/scenarios.ts's).
 *
 * - web_arrow: the arrow $16 at (2,14) turns the ball to 90 at the same
 *   speed ($82:A74F -> $82:A7B7 -> $82:ECFC, sfx $0C at 2480), then the
 *   enemy at (2,15), the in-cell crest on the $11 corner (2,16) (the launch
 *   at 2541, $81:980B with no edge crossed) and the landings on the $05 ramp.
 * - web_ramps: the pit's flush edges along +y and -y ($81:9001's edge 0 when
 *   moving +y, and its sign): pit -> $04 (2488), $04 -> pit (2577),
 *   pit -> $06 (2624), $06 -> pit (2670), all rolling, none a step.
 * - web_step: +y into the elevation-4 row, a step up of 6 by the N edge: the
 *   step bounce at 2505 (yf $FFFF, vy 2532 -> -1646), its 2-frame hit-stop
 *   ($81:8C48 takes edges 0 and 1) and sfx 4.
 * - web_boost (course 3 hole 2, index 17): -y from (4,19) onto the N boost
 *   panel (4,18) at vy -929, a straight hit ($82:9CBF: vy -> -1023, $6A28
 *   set); object 112's hum (sound $15 at 2499 and 2533, 34 frames apart)
 *   until the ball leaves the panel (sound 0 at 2563). The game then flies
 *   off the ramp (4,17) that falls away from the panel, which is the crest's
 *   unported cross-cell branch ($81:980B, docs/engine.md), so the window
 *   ends there. Recorded beyond it: the warp, the arrow, and the hum again
 *   on the panels further north (2815-2942, its counter held while another
 *   panel's exit has cleared $6A28).
 * - web_boost_side: the same panel entered with vx +245: the small push
 *   (vy -$40, the coefficients reset) on its first frame, then, the panel's
 *   friction having brought |vx| under $80, the straight launch, and the hum
 *   at 2505 and 2539 to the sound 0 at 2564.
 * - web_rough_roll / _land / _soft / _hard (course 2 hole 4, index 11): the
 *   rough $04 at (2,14), rolled onto (the hit side $82:8F30) and fallen onto
 *   (the land side $82:8EFB) at vz -$200, -$100, -$800: the coefficients
 *   by byte offset ($80:DD71 + 0 or 2: mode 0 reads $6800 / $6665 / $20C4),
 *   and the tail sound only for vz = 0 ($5F) or below -$400 ($60)
 *   ($82:8F17; notes/port-v2-phase5-abilities.md).
 * - web_kicker_roll / _land / _side (course 3 hole 2, index 17): the kickers
 *   $13 (they push -x). Rolled along against the push (the hit side
 *   $82:A88C: by the angle to the kicker's, halved against it, the friction
 *   $1000), fallen onto ($82:A7DD: vz x 25 >> 8, clamped to 25, vx - 26) and
 *   entered askew from the north (the angle 90: the push 30 and $1800).
 * - the snap panels' five scenarios: test/snap-scenarios.ts.
 * - the water's eight: test/water-scenarios.ts.
 * - the copy abilities' eleven: test/ability-scenarios.ts.
 */
import { describe, it } from 'vitest';
import { haveRules, haveRomTest, loadTrace, loadRomHole } from './fixtures';
import { checkScenario, type Scenario } from './scenarios';
import { SNAP_SCENARIOS } from './snap-scenarios';
import { WATER_SCENARIOS } from './water-scenarios';
import { ABILITY_SCENARIOS } from './ability-scenarios';

export const TERRAIN_SCENARIOS: Scenario[] = [
  { name: 'web_arrow', hole: 1, offset: 2332, from: 2463, to: 3000, what: 'the arrow $16 turns the ball south; the enemy, the $11 crest, the $05 ramp' },
  { name: 'web_ramps', hole: 1, offset: 2332, from: 2463, to: 3000, what: 'the pit\'s ramps crossed along +y and -y: flush, no step' },
  { name: 'web_step', hole: 2, offset: 2333, from: 2463, to: 3000, what: 'the step up into the elevation-4 row: the bounce, the hit-stop' },
  { name: 'web_boost', hole: 17, offset: 2338, from: 2463, to: 2563, what: 'the N boost panel hit straight: the launch, object 112\'s hum and its end' },
  { name: 'web_boost_side', hole: 17, offset: 2338, from: 2463, to: 2564, what: 'the N boost panel entered askew: the small push, then the straight launch and the hum' },
  { name: 'web_kicker_roll', hole: 17, offset: 2338, from: 2463, to: 2600, what: 'along the kicker row against its push: the hit side' },
  { name: 'web_kicker_land', hole: 17, offset: 2338, from: 2463, to: 2600, what: 'fallen onto a kicker: the land side\'s clamped kick' },
  { name: 'web_kicker_side', hole: 17, offset: 2338, from: 2463, to: 2600, what: 'onto a kicker from the north: the push by the angle' },
  { name: 'web_rough_roll', hole: 11, offset: 2332, from: 2455, to: 2600, what: 'rolled onto the rough $04: its coefficients, $60' },
  { name: 'web_rough_land', hole: 11, offset: 2332, from: 2455, to: 2600, what: 'fallen onto the rough at vz -$200: no tail sound' },
  { name: 'web_rough_soft', hole: 11, offset: 2332, from: 2455, to: 2600, what: 'fallen onto the rough at vz -$100: no tail sound' },
  { name: 'web_rough_hard', hole: 11, offset: 2332, from: 2455, to: 2600, what: 'fallen onto the rough at vz -$800: the tail sound $60' },
];

describe.skipIf(!haveRules || !haveRomTest)('the terrain and the arrows vs the recorded game', () => {
  for (const s of [...TERRAIN_SCENARIOS, ...SNAP_SCENARIOS, ...WATER_SCENARIOS, ...ABILITY_SCENARIOS]) {
    it.skipIf(!loadTrace(s.name) || !loadRomHole(s.hole))(`${s.name}: ${s.what}`, () => checkScenario(s));
  }
});
