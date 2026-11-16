/**
 * The switches and the toggles' poked scenarios (port_v2 phase 6;
 * tools/snesstep/inputs/web_sw_*; notes/port-v2-phase6-switches.md), shared
 * by trace-terrain.test.ts (the ball and the sounds, through scenarios.ts)
 * and switches.test.ts (the switch state, the block, the colours).
 *
 * - web_sw_switch_roll (course 2 hole 3): west across the $75 swirls (12,9)
 *   and (11,9), on at the load ($5B and no $5A), then onto the switch $5B at
 *   (10,9): the flip at 2522 ($6A2A 1 -> 0, sfx $6B), the latch cleared
 *   leaving the gate west (2543), the outline's bounce at (9,9).
 * - web_sw_switch_land (course 4 hole 2): dropped onto the $5A at (8,6): the
 *   flip at 2486 inside the gate with the landing's hit-stop, the bounce, the
 *   latch cleared in the air (2506).
 * - web_sw_toggle_roll / _land (course 2 hole 3): a $75 swirl rolled through
 *   (the hit side, $80:DDED) and landed on (the land side, $80:DDEF, then
 *   the grounded entry).
 * - web_sw_toggle_pull (course 4 hole 3): a $74, the subtracting side.
 * - web_sw_toggle_off (course 4 hole 2): a $74 while $6A2A = 0: plain ground.
 * - web_sw_water_drain (course 1 hole 8): rolled onto the $5C at (4,10): the
 *   water off at 2527, sfx $6A and $4A, the 64-frame block (the store resumes
 *   at iteration 2591), then down through the drained pond.
 * - web_sw_water_fill (course 3 hole 8, the water off at the load): a hard
 *   landing on the $5D at (10,6): Kirby squashed with no hit-stop ($6A70),
 *   the water back at 2478 (sfx $6A, $4B), the block, then into the pond at
 *   (8,6), where the ball sinks.
 */
import type { Scenario } from './scenarios';

export const SWITCH_SCENARIOS: Scenario[] = [
  { name: 'web_sw_switch_roll', hole: 10, offset: 2333, from: 2468, to: 2650, what: 'the $75 swirls, then the switch $5B rolled onto: the flip, the latch' },
  { name: 'web_sw_switch_land', hole: 25, offset: 2337, from: 2468, to: 2580, what: 'the switch $5A landed on: the flip, the hit-stop, the latch cleared in the air' },
  { name: 'web_sw_toggle_roll', hole: 10, offset: 2333, from: 2468, to: 2550, what: 'a $75 swirl rolled through: the hit side' },
  { name: 'web_sw_toggle_land', hole: 10, offset: 2333, from: 2468, to: 2540, what: 'a $75 swirl landed on: the land side, then the hit side' },
  { name: 'web_sw_toggle_pull', hole: 26, offset: 2337, from: 2468, to: 2556, what: 'a $74 swirl rolled through: the subtracting side' },
  { name: 'web_sw_toggle_off', hole: 25, offset: 2337, from: 2468, to: 2625, what: 'a $74 swirl while the switch is off: plain ground' },
  { name: 'web_sw_water_drain', hole: 7, offset: 2338, from: 2468, to: 2880, what: 'the water switch $5C rolled onto: the water off, the block, the dry pond' },
  { name: 'web_sw_water_fill', hole: 23, offset: 2339, from: 2468, to: 2720, what: 'the water switch $5D landed on hard: the squash, the water on, the block, the pond' },
];
