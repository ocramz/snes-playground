/**
 * The poked scenarios against the recorded game, shared by
 * trace-hazards.test.ts and trace-terrain.test.ts: a course hole chosen with
 * `$6A5A`/`$6A5E` pokes as tools/snesstep/holes.py does, a weak shot from
 * the tee, then the ball's block poked at the roll's first frame (R + 24:
 * after the launch's write, before the first step's load) —
 * tools/snesstep/inputs/web_*.txt and .pokes. The engine plays the same
 * script and pokes on the same hole and must follow every ball state the
 * game recorded from the poke on, and request the same sounds.
 *
 * A reaction ($82:DB9A) writes the block after the step's own store, so the
 * game can stamp two records in one frame; only the frame's last is the
 * state the next step starts from.
 */
import { expect } from 'vitest';
import { runFlowScript } from './flow-harness';
import { distinctStates, matchBallStates, type BallTraceFrame } from './align';
import { iterationOf, loadSounds, loadTrace, type SoundRequest } from './fixtures';
import { compareSounds } from './events.test';

export interface Scenario {
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
  /**
   * Sounds the input requests (the A press's `$26`): compared at the game's
   * iteration, not carried through the ball states, which a hole's lag after
   * the poke (course 1 hole 7: 5 frames) puts behind the input.
   */
  uncarried?: number[];
}

function lastPerFrame(frames: BallTraceFrame[]): BallTraceFrame[] {
  return frames.filter((r, i) => i + 1 >= frames.length || frames[i + 1].f !== r.f);
}

/** Plays the scenario and checks its ball states and sound requests against the recording. */
export function checkScenario(s: Scenario): void {
  const trace = loadTrace(s.name)!;
  const run = runFlowScript(s.name, s.to - s.offset + 20, { hole: s.hole, offset: s.offset, pokes: true, alignActors: s.actors });
  try {
    compare(s, trace, run);
  } finally {
    run.world.destroy(); // Koota allows 16 worlds at once
  }
}

function compare(s: Scenario, trace: NonNullable<ReturnType<typeof loadTrace>>, run: ReturnType<typeof runFlowScript>): void {
  const game = distinctStates(lastPerFrame(trace.frames.filter((r) => r.f > s.from && r.f <= s.to)));
  const engine = distinctStates(run.ball);
  const r = matchBallStates(game, engine);
  expect(r.error, s.name).toBeNull();
  expect(r.matched).toBe(game.length);
  expect(r.skips).toBeLessThan(Math.max(4, r.matched / 20));
  // the game lags on some holes (web_haz80: two frames after the poke; the
  // volcano holes 4-7 over the window, their projectiles), which the engine
  // does not model: each request's iteration is carried to the engine's
  // frame through the last ball state matched at or before it
  const sounds = loadSounds(s.name);
  if (sounds) {
    const at = r.pairs.map(([g, e]) => [iterationOf(g.f, g.ln), e.f] as const);
    const toEngine = (i: number): number => {
      let best: readonly [number, number] | undefined;
      for (const p of at) if (p[0] <= i) best = p;
      return best ? best[1] + (i - best[0]) : i;
    };
    const first = at[0][0];
    const keep = new Set(s.uncarried ?? []);
    const carried = sounds.filter((q) => q[2] > first)
      .map((q): SoundRequest => [q[0], q[1], keep.has(q[4]) ? q[2] : toEngine(q[2]), q[3], q[4], q[5]]);
    expect(compareSounds(carried, run.emitted, toEngine(s.from + 4), toEngine(s.to))).toEqual([]);
  }
}
