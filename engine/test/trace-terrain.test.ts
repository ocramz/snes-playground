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
 * - the snap panels' five scenarios: test/snap-scenarios.ts.
 */
import { describe, it } from 'vitest';
import { haveRules, haveRomTest, loadTrace, loadRomHole } from './fixtures';
import { checkScenario, type Scenario } from './scenarios';
import { SNAP_SCENARIOS } from './snap-scenarios';

export const TERRAIN_SCENARIOS: Scenario[] = [
  { name: 'web_arrow', hole: 1, offset: 2332, from: 2463, to: 3000, what: 'the arrow $16 turns the ball south; the enemy, the $11 crest, the $05 ramp' },
  { name: 'web_ramps', hole: 1, offset: 2332, from: 2463, to: 3000, what: 'the pit\'s ramps crossed along +y and -y: flush, no step' },
  { name: 'web_step', hole: 2, offset: 2333, from: 2463, to: 3000, what: 'the step up into the elevation-4 row: the bounce, the hit-stop' },
  { name: 'web_boost', hole: 17, offset: 2338, from: 2463, to: 2563, what: 'the N boost panel hit straight: the launch, object 112\'s hum and its end' },
  { name: 'web_boost_side', hole: 17, offset: 2338, from: 2463, to: 2564, what: 'the N boost panel entered askew: the small push, then the straight launch and the hum' },
];

describe.skipIf(!haveRules || !haveRomTest)('the terrain and the arrows vs the recorded game', () => {
  for (const s of [...TERRAIN_SCENARIOS, ...SNAP_SCENARIOS]) {
    it.skipIf(!loadTrace(s.name) || !loadRomHole(s.hole))(`${s.name}: ${s.what}`, () => checkScenario(s));
  }
});
