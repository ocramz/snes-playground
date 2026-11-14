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
 */
import { describe, it } from 'vitest';
import { haveRules, haveRomTest, loadTrace, loadRomHole } from './fixtures';
import { checkScenario, type Scenario } from './scenarios';

export const TERRAIN_SCENARIOS: Scenario[] = [
  { name: 'web_arrow', hole: 1, offset: 2332, from: 2463, to: 3000, what: 'the arrow $16 turns the ball south; the enemy, the $11 crest, the $05 ramp' },
  { name: 'web_ramps', hole: 1, offset: 2332, from: 2463, to: 3000, what: 'the pit\'s ramps crossed along +y and -y: flush, no step' },
  { name: 'web_step', hole: 2, offset: 2333, from: 2463, to: 3000, what: 'the step up into the elevation-4 row: the bounce, the hit-stop' },
];

describe.skipIf(!haveRules || !haveRomTest)('the terrain and the arrows vs the recorded game', () => {
  for (const s of TERRAIN_SCENARIOS) {
    it.skipIf(!loadTrace(s.name) || !loadRomHole(s.hole))(`${s.name}: ${s.what}`, () => checkScenario(s));
  }
});
