/**
 * The water's poked scenarios (sim/water.ts; tools/snesstep/inputs/
 * web_water_*), shared by trace-terrain.test.ts (the ball, through
 * scenarios.ts) and water-fx.test.ts (the splashes and the bubbles). All on
 * course 1 hole 7 (index 6): the 3x3 pond at (7-9, 8-10), open water `$61`
 * at (8,9), the level `$1_6733`.
 * - web_water_roll: west off the plateau onto the rim `$67` (9,9): the drop
 *   (air 1, vz 0), the entry once in the region (deep: / 8, object 55, `$49`,
 *   the frozen frame), the fall to the bed with the drag, the roll to rest.
 * - web_water_drop: falling onto `$61` at vz -$1000: / 8, objects 57 and 58,
 *   `$4C`; the bed's bounces under the water.
 * - web_water_shallow: onto the corner `$6A` (9,8) in its shallow band at
 *   vz -$300: / 2, object 56, `$4C`.
 * - web_water_skim: fast and flat across the pond: the skims ($E180 / -$E800,
 *   objects 54 then 53, `$48`) until it sinks or reaches the far rim.
 * - web_water_climb: from the bed (`$D872` poked) east up the rim: the drag,
 *   then out of the region (`$D9EE` 0, the dry palette, object 55). Its
 *   window ends before the crest at the rim's top.
 * - web_water_skip / _back: two skips with top / back spin (`$6B58` 0 / 12),
 *   object 54 and Kirby's state 14 at each.
 * - web_water_mod: _back with A at 2545: the modifier's bounce at the third
 *   contact (`$82:82CD`, its factors as the ROM loads them).
 */
import type { Scenario } from './scenarios';

export const WATER_SCENARIOS: Scenario[] = [
  { name: 'web_water_roll', hole: 6, offset: 2332, from: 2468, to: 2660, what: 'rolled into the pond: the drop, the deep entry, the drag, the bed' },
  { name: 'web_water_drop', hole: 6, offset: 2332, from: 2468, to: 2620, what: 'a fast fall onto the open water: / 8, objects 57 and 58, $4C' },
  { name: 'web_water_shallow', hole: 6, offset: 2332, from: 2467, to: 2600, what: 'onto a corner\'s shallow band: / 2, object 56' },
  { name: 'web_water_skim', hole: 6, offset: 2332, from: 2468, to: 2640, what: 'skimming across the pond' },
  // the window ends before the rim's crest launches the ball onto the plateau
  // (2501), the crest's unported cross-cell branch ($81:980B, docs/engine.md)
  { name: 'web_water_climb', hole: 6, offset: 2332, from: 2468, to: 2500, what: 'up and out of the water: the drag, the leave' },
  { name: 'web_water_skip', hole: 6, offset: 2332, from: 2468, to: 2640, what: 'two skips with topspin' },
  { name: 'web_water_skip_back', hole: 6, offset: 2332, from: 2468, to: 2640, what: 'two skips with backspin, then the sink' },
  { name: 'web_water_mod', hole: 6, offset: 2332, from: 2468, to: 2640, what: 'the A modifier\'s bounce after the skips', uncarried: [0x26] },
];
