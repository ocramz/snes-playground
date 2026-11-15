/**
 * The stalls' edges, frame-exact (plans/port_v1_koota_phaser4.md
 * verification, "stalls"). While the original's main loop is blocked inside
 * the ball step the player block is not written, so the ball trace has a
 * gap; the engine's ball record (written by store-ball-work) must show the
 * same gap at the same iterations:
 *
 * - the cup reveal ($82:8B5C): web_flow's step takes (8,5) in the
 *   iteration of 3245 and writes the block again in 3345; web_curve
 *   3233 -> 3333;
 * - the landing hit-stop (4) and the step hit-stop (2): web_fly's 3105 ->
 *   3109 -> 3111 (plans: "the F, F+4, F+6 record pattern").
 *
 * Records are converted to iterations with their burst's scanline
 * (fixtures.ts `iterationOf`).
 */
import { describe, expect, it } from 'vitest';
import { runFlowScript, GAME_OFFSET } from './flow-harness';
import { distinctStates, type BallTraceFrame } from './align';
import { haveRules, haveRomTest, iterationOf, loadTrace } from './fixtures';

/** The iterations of the distinct states, game side. */
function gameStates(frames: Array<BallTraceFrame & { ln?: number }>): Array<{ i: number; key: string }> {
  return distinctStates(frames).map((s) => ({
    i: iterationOf(s.f, (s as { ln?: number }).ln),
    key: `${s.xc}:${s.xf}:${s.yc}:${s.yf}:${s.z}:${s.vx}:${s.vy}:${s.vz}`,
  }));
}

function engineStates(frames: BallTraceFrame[]): Map<string, number> {
  const first = new Map<string, number>();
  for (const s of distinctStates(frames)) {
    const key = `${s.xc}:${s.xf}:${s.yc}:${s.yf}:${s.z}:${s.vx}:${s.vy}:${s.vz}`;
    if (!first.has(key)) first.set(key, s.f);
  }
  return first;
}

const CASES: Array<{ name: string; before: number; after: number; what: string }> = [
  { name: 'web_flow', before: 3244, after: 3345, what: 'the cup reveal' },
  { name: 'web_curve', before: 3232, after: 3333, what: 'the cup reveal' },
];

describe.skipIf(!haveRules || !haveRomTest)('the stalls, frame-exact', () => {
  for (const c of CASES) {
    const trace = loadTrace(c.name);
    it.skipIf(!trace)(`${c.name}: ${c.what}, ${c.before} -> ${c.after}`, () => {
      const game = gameStates(trace!.frames);
      const pre = game.find((g) => g.i === c.before);
      const post = game.find((g) => g.i === c.after);
      expect(pre, `the game has no state at ${c.before}`).toBeDefined();
      expect(post, `the game has no state at ${c.after}`).toBeDefined();
      // nothing in between: the block is not written during the stall
      expect(game.filter((g) => g.i > c.before && g.i < c.after)).toEqual([]);
      const run = runFlowScript(c.name, c.after - GAME_OFFSET + 10);
      const eng = engineStates(run.ball);
      expect(eng.get(pre!.key)).toBe(c.before);
      expect(eng.get(post!.key)).toBe(c.after);
    });
  }

  it('web_fly: the landing hit-stop and the step hit-stop keep the game\'s record gaps', () => {
    const trace = loadTrace('web_fly');
    if (!trace) return;
    const game = gameStates(trace.frames).filter((g) => g.i >= 3095 && g.i <= 3125);
    const run = runFlowScript('web_fly', 3125 - GAME_OFFSET + 3);
    const eng = engineStates(run.ball);
    for (const g of game) expect(eng.get(g.key), `the state the game has at ${g.i}`).toBe(g.i);
  });
});
