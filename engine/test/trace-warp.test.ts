/**
 * The warp panels against the recorded game: course 1 hole 4's pair $B4
 * (4,22) and $B5 (4,18), a weak shot from the tee, then the ball's block
 * poked at the roll's first frame (tools/snesstep/inputs/web_warp and
 * web_warp_fly .txt and .pokes; the comparison is test/scenarios.ts's).
 *
 * - web_warp: rolled west into $B4's centre window ($82:A9DB): the warp at
 *   2488 (sound $76), the step blocked until 2609 (object 63, the pan,
 *   object 64 and sound $77 at 2563), then $B5's arrow turns the ball east
 *   at the same speed and it rolls on along row 18.
 * - web_warp_fly: dropped onto $B4 ($82:A980) at |vz| >= $900 (Kirby's
 *   state $0C): the warp at 2479, back at 2599 with the fall's vz on the
 *   ground at (4,18), the landing and its hit-stop on the next step, and
 *   (15 frames in the air) no bounce: $81:8962's settle rule after the
 *   hit-stop.
 *
 * The warp's own frames, counted from its start F (the sound $76) in both
 * the game and the engine (the game lags three frames before web_warp_fly's
 * warp, which the engine does not): Kirby's projection at the destination at
 * F + 10, the camera's pan from F + 49 frame by frame (flow_*.json's
 * $38AC/$38AE), sound $77 when it arrives, the step's end at $77 + 46.
 */
import { describe, expect, it } from 'vitest';
import { haveRules, haveRomTest, loadFlow, loadSounds, loadTrace, loadRomHole, iterationOf } from './fixtures';
import { checkScenario, type Scenario } from './scenarios';
import { runFlowScript } from './flow-harness';
import { valueChanges, type FlowEvent } from './align';
import { Warp } from '../src/core/traits/warp';
import { WARP_HOLD, WARP_IN, WARP_LEAD, WARP_OUT } from '../src/core/systems/warp';

export const WARP_SCENARIOS: Scenario[] = [
  { name: 'web_warp', hole: 3, offset: 2336, from: 2463, to: 2800, what: 'rolled onto $B4: the warp to $B5, the turn east' },
  { name: 'web_warp_fly', hole: 3, offset: 2336, from: 2463, to: 2800, what: 'landed on $B4 hard: the squash, the warp, the landing at $B5' },
];

/** The value of `name` on frame f: the last change at or before it. */
function at(events: FlowEvent[], name: string, f: number): number | string | undefined {
  let v: number | string | undefined;
  for (const [g, x] of valueChanges(events, name)) if (g <= f) v = x;
  return v;
}

function checkWarpFrames(s: Scenario): void {
  const sounds = loadSounds(s.name)!;
  const game = loadFlow(s.name)!.events as FlowEvent[];
  const req = (id: number): number => {
    const q = sounds.find((r) => r[3] === 'sfx' && r[4] === id && r[0] > s.from)!;
    return iterationOf(q[0], q[1]);
  };
  const gOut = req(0x76);
  const gIn = req(0x77);
  const hidden: Array<[number, number]> = [];
  const run = runFlowScript(s.name, s.to - s.offset, {
    hole: s.hole, offset: s.offset, pokes: true,
    until: (world, gf) => {
      hidden.push([gf, world.get(Warp)!.hidden]);
      return false;
    },
  });
  const warps = run.emitted.filter((e) => e.kind === 'warp');
  expect(warps.map((e) => e.romSfx)).toEqual([0x76, 0x77]);
  const eOut = warps[0].gameFrame;
  const eIn = warps[1].gameFrame;
  // the pan's length is the game's: $77 as many frames after $76
  expect(eIn - eOut, 'F -> A').toBe(gIn - gOut);
  expect(eIn - eOut).toBeGreaterThan(WARP_LEAD + WARP_OUT);
  // Kirby's sprite off from F + 10 to A + 26
  const off = hidden.filter(([, h]) => h !== 0).map(([f]) => f);
  expect([off[0], off[off.length - 1] + 1]).toEqual([eOut + WARP_LEAD, eIn + WARP_IN]);
  // the projection at F + 10 and the camera on every frame of the warp
  const shift = eOut - gOut;
  for (const name of ['kx', 'ky']) {
    expect(at(run.events, name, eOut + WARP_LEAD), name).toBe(at(game, name, gOut + WARP_LEAD));
  }
  for (let d = 0; d <= gIn - gOut + WARP_IN + WARP_HOLD; d++) {
    for (const name of ['cx38', 'cy38']) {
      expect(at(run.events, name, gOut + d + shift), `${name} at F + ${d}`).toBe(at(game, name, gOut + d));
    }
  }
}

describe.skipIf(!haveRules || !haveRomTest)('the warps vs the recorded game', () => {
  for (const s of WARP_SCENARIOS) {
    const have = !!loadTrace(s.name) && !!loadRomHole(s.hole) && !!loadFlow(s.name) && !!loadSounds(s.name);
    it.skipIf(!have)(`${s.name}: ${s.what}`, () => checkScenario(s));
    it.skipIf(!have)(`${s.name}: the warp's frames, Kirby's sprite, the camera's pan`, () => checkWarpFrames(s));
  }
});
