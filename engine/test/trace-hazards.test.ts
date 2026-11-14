/**
 * The hazards against the recorded game (plans phase 6 §3b): course holes
 * with hazards, chosen with `$6A5A`/`$6A5E` pokes as tools/snesstep/
 * holes.py does, a weak shot from the tee, then the ball's block poked into
 * a hazard at the roll's first frame (R + 24: after the launch's write,
 * before the first step's load) — tools/snesstep/inputs/web_haz*.txt and
 * .pokes. The engine plays the same script and pokes on the same hole and
 * must follow every ball state the game recorded from the poke on, and
 * request the same sounds (the hazard's $6F, the tomato's $10, the bounces).
 *
 * A reaction ($82:DB9A) writes the block after the step's own store, so the
 * game can stamp two records in one frame; only the frame's last is the
 * state the next step starts from.
 */
import { describe, expect, it } from 'vitest';
import { runFlowScript } from './flow-harness';
import { distinctStates, matchBallStates, type BallTraceFrame } from './align';
import { haveRules, haveRomTest, iterationOf, loadSounds, loadTrace, loadRomHole, type SoundRequest } from './fixtures';
import { compareSounds } from './events.test';

interface Scenario {
  name: string;
  /** The course index (build/engine/rom-test/holes/<n>). */
  hole: number;
  /** Engine frame f is game frame f + offset (the hole's set-up). */
  offset: number;
  /** The poke's frame and the window compared. */
  from: number;
  to: number;
  what: string;
  /** Align the moving actors to the recording at the end of this iteration (the poke's - 1). */
  actors?: number;
}

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

function lastPerFrame(frames: BallTraceFrame[]): BallTraceFrame[] {
  return frames.filter((r, i) => i + 1 >= frames.length || frames[i + 1].f !== r.f);
}

describe.skipIf(!haveRules || !haveRomTest)('the hazards vs the recorded game', () => {
  for (const s of SCENARIOS) {
    const trace = loadTrace(s.name);
    it.skipIf(!trace || !loadRomHole(s.hole))(`${s.name}: ${s.what}`, () => {
      const run = runFlowScript(s.name, s.to - s.offset + 20, { hole: s.hole, offset: s.offset, pokes: true, alignActors: s.actors });
      const game = distinctStates(lastPerFrame(trace!.frames.filter((r) => r.f > s.from && r.f <= s.to)));
      const engine = distinctStates(run.ball);
      const r = matchBallStates(game, engine);
      expect(r.error, s.name).toBeNull();
      expect(r.matched).toBe(game.length);
      expect(r.skips).toBeLessThan(Math.max(4, r.matched / 20));
      // the game lags on these holes (web_haz80: two frames after the poke;
      // the volcano holes 4-7 over the window, their projectiles), which the
      // engine does not model: each request's iteration is carried to the
      // engine's frame through the last ball state matched at or before it
      const sounds = loadSounds(s.name);
      if (sounds) {
        const at = r.pairs.map(([g, e]) => [iterationOf(g.f, g.ln), e.f] as const);
        const toEngine = (i: number): number => {
          let best: readonly [number, number] | undefined;
          for (const p of at) if (p[0] <= i) best = p;
          return best ? best[1] + (i - best[0]) : i;
        };
        const first = at[0][0];
        const carried = sounds.filter((q) => q[2] > first).map((q): SoundRequest => [q[0], q[1], toEngine(q[2]), q[3], q[4], q[5]]);
        expect(compareSounds(carried, run.emitted, toEngine(s.from + 4), toEngine(s.to))).toEqual([]);
      }
    });
  }
});
