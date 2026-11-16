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
import { compareAbilityFields, distinctStates, matchBallStates, type BallTraceFrame } from './align';
import { iterationOf, loadSounds, loadTrace, type SoundRequest } from './fixtures';
import { compareSounds, fromCore } from './events.test';
import { bodyOf, loadIters } from './demo-harness';

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
  /**
   * 'iteration': the sounds compared on the game's iterations from the
   * poke's (iters_<name>.json; the engine's lag frames do not count), ±1:
   * a copy ability's 48 frames hold the ball still, so the ball states
   * cannot carry the sounds through them. 'frame': on the game's frames,
   * ±1, as the demos are (test/trace-demos.test.ts): a run with no poke of
   * the ball, which is frame-exact through the aim and the shot panel.
   */
  clock?: 'iteration' | 'frame';
}

/**
 * Drop a record whose frame holds a later one written by something other
 * than the store (a reaction, an object): the next step starts from that.
 * Two stores in one frame are two steps (the game catching up after a lag:
 * web_ab_spark_volcano), and both stay. Records without the writer's pc
 * (older recordings) keep only the frame's last.
 */
function lastPerFrame(frames: BallTraceFrame[]): BallTraceFrame[] {
  const isStore = (r: BallTraceFrame): boolean => r.pc !== undefined && r.pc.startsWith('$82:F1');
  return frames.filter((r, i) => {
    const next = frames[i + 1];
    if (next === undefined || next.f !== r.f) return true;
    return r.pc !== undefined && isStore(next);
  });
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
  // the copy ability's block words ($D852-$D85E), at every matched state
  expect(compareAbilityFields(r.pairs, (f) => run.ball[f - s.offset - 1])).toEqual([]);
  // the game lags on some holes (web_haz80: two frames after the poke; the
  // volcano holes 4-7 over the window, their projectiles), which the engine
  // does not model: each request's iteration is carried to the engine's
  // frame through the last ball state matched at or before it
  const sounds = loadSounds(s.name);
  if (sounds && s.clock === 'iteration') {
    expect(compareSoundsByIteration(s, sounds, run)).toEqual([]);
  } else if (sounds && s.clock === 'frame') {
    expect(compareSoundsByFrame(s, sounds, run)).toEqual([]);
  } else if (sounds) {
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

/**
 * The sounds on the iteration clock (Scenario.clock): a game request's body
 * (its first frame-helper call at or after it) counted from the poke's, an
 * engine event's iteration counted from the poke's frame; each within ±1.
 */
function compareSoundsByIteration(s: Scenario, sounds: SoundRequest[], run: ReturnType<typeof runFlowScript>): string[] {
  const iters = loadIters(s.name);
  if (!iters) return [`no iters_${s.name}.json`];
  const b0 = bodyOf(iters.entries, s.from, 200);
  const e0 = run.iters[s.from - s.offset - 1];
  const kTo = bodyOf(iters.entries, s.to, 200) - b0;
  const want = sounds.filter((q) => fromCore(q) && q[0] * 1000 + q[1] >= s.from * 1000 + 200)
    .map((q) => ({ k: bodyOf(iters.entries, q[0], q[1]) - b0, song: q[3] === 'song', id: q[3] === 'song' ? q[4] - 0x7e : q[4], caller: q[5] }))
    .filter((w) => w.k <= kTo);
  const got = run.emitted.filter((e) => e.romSfx >= 0 && e.kind !== 'music-volume' && e.gameFrame >= s.from)
    .map((e) => ({ k: run.iters[e.gameFrame - s.offset - 1] - e0, song: e.kind === 'song', id: e.romSfx, kind: e.kind, used: false }))
    .filter((g) => g.k >= 0 && g.k <= kTo);
  const bad: string[] = [];
  for (const w of want) {
    const hit = got.find((g) => !g.used && Math.abs(g.k - w.k) <= 1 && g.song === w.song && g.id === w.id);
    if (hit) hit.used = true;
    else bad.push(`missing: the game's ${w.song ? 'song' : 'sfx'} ${w.id} at +${w.k} (${w.caller})`);
  }
  for (const g of got) if (!g.used) bad.push(`extra: the engine's ${g.kind} ${g.id} at +${g.k}`);
  return bad;
}

/** The sounds on the game's frames (Scenario.clock 'frame'), each within ±1. */
function compareSoundsByFrame(s: Scenario, sounds: SoundRequest[], run: ReturnType<typeof runFlowScript>): string[] {
  const want = sounds.filter((q) => fromCore(q) && q[0] > s.from && q[0] <= s.to)
    .map((q) => ({ f: q[0], song: q[3] === 'song', id: q[3] === 'song' ? q[4] - 0x7e : q[4], caller: q[5] }));
  const got = run.emitted.filter((e) => e.romSfx >= 0 && e.kind !== 'music-volume' && e.gameFrame > s.from && e.gameFrame <= s.to + 1)
    .map((e) => ({ f: e.gameFrame, song: e.kind === 'song', id: e.romSfx, kind: e.kind, used: false }));
  const bad: string[] = [];
  for (const w of want) {
    const hit = got.find((g) => !g.used && Math.abs(g.f - w.f) <= 1 && g.song === w.song && g.id === w.id);
    if (hit) hit.used = true;
    else bad.push(`missing: the game's ${w.song ? 'song' : 'sfx'} ${w.id} at ${w.f} (${w.caller})`);
  }
  for (const g of got) if (!g.used) bad.push(`extra: the engine's ${g.kind} ${g.id} at ${g.f}`);
  return bad;
}
