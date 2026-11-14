/**
 * The hazard actors (sim/actors.ts) against the recorded thread slots
 * (tools/snesstep/trace_actors.py -> build/engine/rom-test/actors_<name>.json).
 *
 * The game's lag frames drop scheduler ticks, and a frame that runs two
 * ticks keeps only the second's state, so the comparison is of state
 * sequences, not frames: each slot's run of distinct states must occur, in
 * order, in the engine actor's. A state is (dir $549C, step $551C, frame
 * $5D9C), plus x and y for object 76 (the others keep no position there).
 * A tick can straddle a frame, so the engine's states are taken twice a
 * tick: between its thread and its per-frame handler, and after.
 *
 * - The set-up to the poke: each actor aligned to its slot at the hole's
 *   set-up (flow-harness alignActor: 76 by its state, 77 and the volcanoes
 *   by every state since their spawn), then ticked alone with the ball away
 *   (it sat on the tee). The intro before the set-up, which the engine does
 *   not play, ticks object 76 irregularly (web_haz98 2190-2191: the frame
 *   flips while the mover stands).
 * - Through the scenario: the actors as the engine's run of the script has
 *   them after the alignment at the poke, with the ball's hits in (a cone
 *   hit pokes the volcano, `$84:E1B4`), to the end of the window.
 */
import { describe, expect, it } from 'vitest';
import {
  runFlowScript, loadActorRecords, alignActor, slotOf, actorState, engineStep, recordStep, stateRuns,
} from './flow-harness';
import { haveRules, haveRomTest, loadRomHole } from './fixtures';
import { Hazards } from '../src/core/systems/actors';
import { tickActor, type BallView } from '../src/core/sim/actors';

interface Scenario {
  name: string;
  hole: number;
  /** The hole's set-up (engine frame 0). */
  offset: number;
  /** The alignment: the end of this iteration (the poke's - 1). */
  align: number;
  to: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'web_haz98', hole: 4, offset: 2332, align: 2454, to: 2700 },
  { name: 'web_haz94', hole: 11, offset: 2332, align: 2454, to: 2571 },
  { name: 'web_hazad', hole: 54, offset: 2337, align: 2467, to: 2799 },
  { name: 'web_hazac', hole: 54, offset: 2337, align: 2467, to: 2799 },
];

/** Is `want` a subsequence of `have`? The first state of `want` not found, or null. */
function missing(want: string[], have: string[]): string | null {
  let j = 0;
  for (let i = 0; i < want.length; i++) {
    while (j < have.length && have[j] !== want[i]) j++;
    if (j >= have.length) return `state ${i} of ${want.length} (${want[i]}) after ${want[i - 1] ?? 'the start'}`;
    j++;
  }
  return null;
}

const runsOf = (list: string[]): string[] => stateRuns(list, (s) => s).map((r) => r.s);

describe.skipIf(!haveRules || !haveRomTest)('the hazard actors vs the recorded thread slots', () => {
  for (const s of SCENARIOS) {
    const recs = loadActorRecords(s.name);
    it.skipIf(!recs || !loadRomHole(s.hole))(`${s.name}: every actor's states, the set-up to the poke and through the window`, () => {
      const run = runFlowScript(s.name, 1, { hole: s.hole, offset: s.offset });
      const ctx = run.ctx;
      const actors = run.world.get(Hazards)!.actors;
      const used = new Set<number>();
      const slots = actors.map((a) => {
        const slot = slotOf(recs!, a, ctx.course.w, used);
        expect(slot, `${s.name}: a slot for object ${a.type} at cell ${a.cell}`).toBeDefined();
        used.add(slot!);
        return slot!;
      });
      expect(slots.length).toBeGreaterThan(0);

      // the set-up to the poke, ticked alone
      const idle: BallView = { cell: -1, xf: 0, yf: 0, holed: false, rolling: false };
      actors.forEach((old, i) => {
        const list = recs!.get(slots[i])!;
        const { a } = alignActor(ctx, old, list.filter((r) => r.iter <= s.offset), s.offset);
        const engine: string[] = [];
        const push = (): void => { engine.push(actorState(a.type, a, engineStep(a))); };
        for (let n = 0; n < s.align - s.offset + 8; n++) {
          tickActor(ctx, a, idle, false, push);
          push();
        }
        const game = runsOf(list.filter((r) => r.iter > s.offset && r.iter <= s.align).map((r) => actorState(r.type, r, recordStep(r))));
        expect(game.length, `${s.name} slot ${slots[i]}: records`).toBeGreaterThan(0);
        expect(missing(game, runsOf(engine)), `${s.name} slot ${slots[i]} (object ${old.type}), the set-up to the poke`).toBeNull();
      });

      // through the window, as the scenario's run has them
      const seen = new Map<number, string[]>();
      runFlowScript(s.name, s.to - s.offset + 2, {
        hole: s.hole, offset: s.offset, pokes: true, alignActors: s.align,
        until: (world, f) => {
          if (f > s.align) {
            world.get(Hazards)!.actors.forEach((x, i) => {
              const l = seen.get(i) ?? [];
              l.push(actorState(x.type, x, engineStep(x)));
              seen.set(i, l);
            });
          }
          return false;
        },
      });
      actors.forEach((old, i) => {
        const list = recs!.get(slots[i])!;
        const game = runsOf(list.filter((r) => r.iter > s.align && r.iter <= s.to).map((r) => actorState(r.type, r, recordStep(r))));
        expect(missing(game, runsOf(seen.get(i) ?? [])), `${s.name} slot ${slots[i]} (object ${old.type}) through the window`).toBeNull();
      });
    });
  }
});
