/**
 * The hazards against the recorded game (plans phase 6 §3b): course holes
 * with hazards, chosen with `$6A5A`/`$6A5E` pokes as tools/snesstep/
 * holes.py does, a weak shot from the tee, then the ball's block poked into
 * a hazard at the roll's first frame (R + 24: after the launch's write,
 * before the first step's load) — tools/snesstep/inputs/web_haz*.txt and
 * .pokes. The engine plays the same script and pokes on the same hole and
 * must follow every ball state the game recorded from the poke on, and
 * request the same sounds (the hazard's $6F, the tomato's $10, the bounces).
 * The comparison is test/scenarios.ts's.
 */
import { describe, it } from 'vitest';
import { haveRules, haveRomTest, loadTrace, loadRomHole } from './fixtures';
import { checkScenario, type Scenario } from './scenarios';

const SCENARIOS: Scenario[] = [
  { name: 'web_haz80', hole: 3, offset: 2336, from: 2463, to: 2760, what: 'the isolated bumper ($80 -> $A2) rolled into, then the $05 row and its throw' },
  // ends before 2497: the ball crosses from the flat (6,13) onto the $07 ramp
  // (5,13) and the game launches it, the unported $81:980B crest branch
  // (plans risk 5), not the hazard
  { name: 'web_haz98', hole: 4, offset: 2332, from: 2455, to: 2496, what: 'the bumper riding its track (object 76): the cube test and the 3-D bounce', actors: 2454 },
  { name: 'web_haz94', hole: 11, offset: 2332, from: 2455, to: 2571, what: 'the bobbing bumper (object 77) rolled into while low: the box, the reflect', actors: 2454 },
  { name: 'web_hazad', hole: 54, offset: 2337, from: 2468, to: 2799, what: 'the erupting volcano (object 82): its base, the throw, then the cones', actors: 2467 },
  { name: 'web_hazac', hole: 54, offset: 2337, from: 2468, to: 2799, what: 'the volcano that never erupts (object 81): the cone flown into, the reflect by side', actors: 2467 },
];

describe.skipIf(!haveRules || !haveRomTest)('the hazards vs the recorded game', () => {
  for (const s of SCENARIOS) {
    it.skipIf(!loadTrace(s.name) || !loadRomHole(s.hole))(`${s.name}: ${s.what}`, () => checkScenario(s));
  }
});
