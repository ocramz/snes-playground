/**
 * The copy abilities' poked scenarios (core/sim/abilities.ts; tools/
 * snesstep/inputs/web_ab_*): a course hole's weak shot, then the ball poked
 * at the roll's first frame with a stock ($D852) and B pressed on the same
 * frame, so the trigger fires on the first step after the poke. Each covers
 * branches the DEMOPLAY demos (test/trace-demos.test.ts) do not reach.
 */
import type { Scenario } from './scenarios';

export const ABILITY_SCENARIOS: Scenario[] = [
  { name: 'web_ab_tornado_step', hole: 2, offset: 2333, from: 2463, to: 2800, clock: 'iteration', what: 'Tornado into a step: the burst, the stop (state 35)' },
  { name: 'web_ab_fire_step', hole: 2, offset: 2333, from: 2463, to: 2800, clock: 'iteration', what: 'Fireball into a step: the hop and the end' },
  { name: 'web_ab_wheel_step', hole: 2, offset: 2333, from: 2463, to: 2800, clock: 'iteration', what: 'Wheel into a step: the stop, the hop, the end at its landing' },
  { name: 'web_ab_ufo_step', hole: 2, offset: 2333, from: 2463, to: 2630, clock: 'iteration', what: 'the UFO into a step: state 39, the fall, the countdown, the end' },
  { name: 'web_ab_parasol_ledge', hole: 2, offset: 2333, from: 2463, to: 2610, clock: 'iteration', what: 'Parasol rolled off a ledge: the reopen, the float, the landing' },
  { name: 'web_ab_spark_tree', hole: 3, offset: 2336, from: 2463, to: 2700, clock: 'iteration', what: 'Spark into a tree: the tree destroyed, no push' },
  { name: 'web_ab_ufo_bumper', hole: 3, offset: 2336, from: 2463, to: 2700, clock: 'iteration', what: 'the UFO into a bumper: code 19 from the object hit, the reaction' },
  { name: 'web_ab_spark_volcano', hole: 54, offset: 2337, from: 2468, to: 2760, clock: 'iteration', what: 'Spark falling onto a volcano\'s cone: the volcano destroyed' },
  { name: 'web_ab_needle_boost', hole: 17, offset: 2338, from: 2463, to: 2610, clock: 'iteration', what: 'Needle onto a boost panel: no stick on its live band' },
  { name: 'web_ab_freeze_pond', hole: 6, offset: 2332, from: 2468, to: 2980, clock: 'iteration', what: 'Freeze onto the pond: the ice, the ride, the stop on the ice, the sink' },
  { name: 'web_ab_stone_pond', hole: 6, offset: 2332, from: 2468, to: 2660, clock: 'iteration', what: 'Stone dropped into the pond: the sink and the ability\'s water drop' },
  { name: 'web_ab_c1', hole: 2, offset: 2333, from: 2340, to: 4250, clock: 'frame', what: 'course 1 hole 3, unpoked: the Hi-Jump enemy taken, then used on the next two shots (the latch refuses a second B)' },
];
