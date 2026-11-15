/**
 * The snap panels' poked scenarios, shared by trace-terrain.test.ts (the
 * ball, through scenarios.ts) and snap-stars.test.ts (the stars). Plain
 * data: importing scenarios.ts also registers events.test.ts's suite.
 */
import type { Scenario } from './scenarios';

/**
 * The snap panels $18-$1B (sim/dispatch.ts; tools/snesstep/inputs/web_snap*):
 * the ball's states (trace-terrain.test.ts) and the stars, objects 61 and 62
 * (snap-stars.test.ts).
 * - web_snap (course 7 hole 7): north from the tee cell onto the N panel
 *   (5,22) at vy -1011: the window's entry at yf $DFFF, -$300 a frame to the
 *   floor $E000 (2507), $11 and object 61 at its first push (2497), the
 *   window's exit, then the enemy $41 at (5,21), which the cleared latch lets
 *   it take (2511). The window ends before the reveal's HUD: its tomato
 *   (game 2535) comes 4 frames after the engine's, the game's lag at the
 *   reveal (docs/engine.md "Deviations").
 * - web_snap_land: falling onto the same panel at vy -466: the landing
 *   handler sets it on the surface and the push and the roll follow on the
 *   landing frame, whose friction is the guide's leftover $DA3A ($07B0,
 *   $81:B24C; sim/guide.ts).
 * - web_snap_back (course 4 hole 6): north into the S panel (6,10) at
 *   vy -1146: two pushes turn it (-365, 391, 1147), then it leaves the
 *   window south; object 61's one burst waits for vy >= 0 (2514).
 * - web_snap_fast: south onto the same panel at 7620: capped at $2000
 *   (8180 after the friction) through the window.
 * - web_snap_east (course 8 hole 7): east onto the E panel (3,4) at 7120:
 *   one push to 7876, then vx + $300 >= $2000 every frame and the store is
 *   skipped ($82:A66B): only the friction acts.
 */
export const SNAP_SCENARIOS: Scenario[] = [
  { name: 'web_snap', hole: 54, offset: 2338, from: 2468, to: 2530, what: 'the N snap panel rolled onto: the window, the push to the floor, $11 once, the enemy beyond' },
  { name: 'web_snap_land', hole: 54, offset: 2338, from: 2468, to: 2522, what: 'the N snap panel landed on: set on the surface, pushed, rolled' },
  { name: 'web_snap_back', hole: 29, offset: 2340, from: 2468, to: 2555, what: 'the S snap panel entered against its push: stopped, turned back, pushed out' },
  { name: 'web_snap_fast', hole: 29, offset: 2340, from: 2468, to: 2501, what: 'the S snap panel entered fast: vy capped at $2000' },
  { name: 'web_snap_east', hole: 62, offset: 2342, from: 2468, to: 2488, what: 'the E snap panel entered fast: vx left unchanged at the cap ($82:A66B)' },
];
