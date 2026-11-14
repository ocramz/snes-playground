/**
 * The flow against the recorded game (plans/port_v1_koota_phaser4.md
 * verification, "flow"): hole 1 played from the stepper's input scripts,
 * compared with tools/snesstep/trace_flow.py's per-frame record of the same
 * runs (build/engine/rom-test/flow_web_*.json, `make engine-traces`).
 *
 * - Discrete fields (Kirby's state, facing and shot angle, the aim, the
 *   elevation, the selectors, the meter, shot over, airborne, the ball's
 *   cell, Kirby's projected position): the game's sequence of changes must
 *   be a subsequence of the engine's — the game's lag catch-ups merge or
 *   skip steps (meter 9 -> 11 at web_flow 2915) — with each change within
 *   ±2 frames.
 * - The world camera ($38AC/$38AE): every frame within ±2 px in x and
 *   ±8 px in y, at the best alignment within ±2 frames.
 * - The guide's first end, the aim camera's target ($6AAA/$6AAC): within
 *   1 px for at least 95% of the targets the game wrote.
 *
 * Windows: web_flow stops at 3244 — the cup appears at 3245 and stalls the
 * game for 100 frames (phase 6, $82:8B5C); web_ui ends with its trace; the
 * fly shots run through the lost ball, its reset and the next set-up.
 */
import { describe, expect, it } from 'vitest';
import { runFlowScript, GAME_OFFSET } from './flow-harness';
import { valueChanges, type FlowEvent } from './align';
import { haveRules, haveRomTest, loadFlow } from './fixtures';

const DISCRETE = ['state', 'facing', 'angle', 'aim', 'elev', 'side', 'tb', 'meter', 'over', 'air', 'bx', 'by', 'kx', 'ky'];

const RUNS: Array<{ name: string; from: number; to: number }> = [
  { name: 'web_flow', from: 2333, to: 3244 },
  { name: 'web_ui', from: 2333, to: 3300 },
  { name: 'web_fly', from: 2333, to: 3915 },
  { name: 'web_fly_spin', from: 2333, to: 3915 },
];

/** The game's changes of one field inside the window must be found, in
 *  order, among the engine's, each within `tol` frames. */
export function matchChanges(
  game: FlowEvent[], engine: FlowEvent[], name: string, from: number, to: number, tol = 2,
): string | null {
  const want = valueChanges(game, name).filter(([f]) => f >= from && f <= to);
  const got = valueChanges(engine, name);
  let j = 0;
  for (const [f, v] of want) {
    let k = j;
    while (k < got.length && !(got[k][1] === v && Math.abs(got[k][0] - f) <= tol)) {
      if (got[k][0] > f + tol) break;
      k++;
    }
    if (k >= got.length || got[k][1] !== v || Math.abs(got[k][0] - f) > tol) {
      const near = got.filter(([g]) => Math.abs(g - f) <= 6).map(([g, x]) => `${g}:${x}`).join(' ');
      return `${name}: the game's ${v} at ${f} has no match (engine near it: ${near || 'nothing'})`;
    }
    j = k + 1;
  }
  return null;
}

/** The value a field holds on every frame of [from, to]. */
function perFrame(events: FlowEvent[], name: string, from: number, to: number): Map<number, number> {
  const own = events.filter((e) => e[1] === name);
  const out = new Map<number, number>();
  let v = 0;
  let i = 0;
  for (let f = Math.min(from, own[0]?.[0] ?? from); f <= to; f++) {
    while (i < own.length && own[i][0] <= f) v = own[i++][2] as number;
    if (f >= from) out.set(f, v);
  }
  return out;
}

function cameraWorst(game: FlowEvent[], engine: FlowEvent[], name: string, from: number, to: number): { worst: number; at: number } {
  const g = perFrame(game, name, from, to);
  const e = perFrame(engine, name, from - 2, to + 2);
  let worst = 0;
  let at = -1;
  for (const [f, v] of g) {
    let best = Infinity;
    for (let d = -2; d <= 2; d++) {
      const ev = e.get(f + d);
      if (ev !== undefined) best = Math.min(best, Math.abs(ev - v));
    }
    if (best > worst) {
      worst = best;
      at = f;
    }
  }
  return { worst, at };
}

describe.skipIf(!haveRules || !haveRomTest)('the flow vs the recorded game', () => {
  for (const { name, from, to } of RUNS) {
    const want = loadFlow(name);
    describe.skipIf(!want)(name, () => {
      const run = want ? runFlowScript(name, to - GAME_OFFSET + 3) : null;

      for (const field of DISCRETE) {
        it(field, () => {
          expect(matchChanges(want!.events, run!.events, field, from, to)).toBeNull();
        });
      }

      it('camera within 2 px (x) and 8 px (y)', () => {
        const x = cameraWorst(want!.events, run!.events, 'cx38', from, to);
        const y = cameraWorst(want!.events, run!.events, 'cy38', from, to);
        expect(x.worst, `x worst at ${x.at}`).toBeLessThanOrEqual(2);
        expect(y.worst, `y worst at ${y.at}`).toBeLessThanOrEqual(8);
      });

      it("the guide's end (the aim camera's target) within 1 px", () => {
        const g = valueChanges(want!.events, 'tgtx').filter(([f]) => f >= from && f <= to);
        const gx = perFrame(want!.events, 'tgtx', from, to);
        const gy = perFrame(want!.events, 'tgty', from, to);
        const ex = perFrame(run!.events, 'tgtx', from - 3, to + 3);
        const ey = perFrame(run!.events, 'tgty', from - 3, to + 3);
        const frames = new Set<number>([...g.map(([f]) => f), ...valueChanges(want!.events, 'tgty').filter(([f]) => f >= from && f <= to).map(([f]) => f)]);
        let ok = 0;
        const bad: string[] = [];
        for (const f of frames) {
          let hit = false;
          for (let d = -1; d <= 3 && !hit; d++) {
            const x = ex.get(f + d);
            const y = ey.get(f + d);
            if (x !== undefined && y !== undefined && Math.abs(x - gx.get(f)!) <= 1 && Math.abs(y - gy.get(f)!) <= 1) hit = true;
          }
          if (hit) ok++;
          else bad.push(`${f}:(${gx.get(f)},${gy.get(f)})`);
        }
        expect(frames.size).toBeGreaterThan(0);
        expect(ok / frames.size, `missed: ${bad.join(' ')}`).toBeGreaterThanOrEqual(0.95);
      });
    });
  }
});
