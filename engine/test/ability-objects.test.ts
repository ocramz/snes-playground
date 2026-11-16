/**
 * The copy abilities' drawn objects (core/sim/ability-objects.ts) against
 * the game's slots on the DEMOPLAY demos (tools/snesstep/trace_actors.py
 * --types ...: actors_web_demoNN.json): every object of a ported type the
 * game spawned, in order (by its first frame, then its slot), with its
 * frame index and point at each change, within a frame (a record in a
 * frame's first lines is the iteration's of the frame before), and its end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { haveRules, haveRomTest, readJson, romTestPath } from './fixtures';
import { existsSync } from 'node:fs';
import { loadDemo, runDemo } from './demo-harness';
import { AbilityFx } from '../src/core/traits/ability-fx';
import type { AbilityObject } from '../src/core/sim/ability-objects';

/** The types the engine draws (systems/ability-fx.ts DRAWN, less 30 and 38, which never draw). */
const TYPES = new Set([0x15, 0x1b, 0x1c, 0x1f, 0x20, 0x21, 0x23, 0x25, 0x27, 0x41, 0x42]);

/** The objects that loop on Kirby until the ability ends: 27, 33, 37, 66. */
const LOOPING = new Set([0x1b, 0x21, 0x25, 0x42]);

interface Run {
  type: number;
  start: number;
  end: number;
  order: number;
  states: Array<[number, number, number, number]>; // frame, index, x, y
}

interface ActorsJson {
  records: number[][];
  exits: number[][];
}

const LOW_LINE = 112;

function gameRuns(a: ActorsJson): Run[] {
  const open = new Map<number, Run>();
  const out: Run[] = [];
  const events: Array<{ f: number; ln: number; kind: 'rec' | 'exit'; r: number[] }> = [
    ...a.records.map((r) => ({ f: r[0], ln: r[1], kind: 'rec' as const, r })),
    ...a.exits.map((r) => ({ f: r[0], ln: r[1], kind: 'exit' as const, r })),
  ].sort((x, y) => x.f * 1000 + x.ln - (y.f * 1000 + y.ln));
  for (const ev of events) {
    const f = ev.ln < LOW_LINE ? ev.f - 1 : ev.f;
    const slot = ev.r[2];
    const type = ev.r[3];
    if (ev.kind === 'exit') {
      const run = open.get(slot);
      if (run) {
        run.end = f;
        open.delete(slot);
      }
      continue;
    }
    if (!TYPES.has(type)) continue;
    let run = open.get(slot);
    if (!run || run.type !== type) {
      run = { type, start: f, end: -1, order: slot, states: [] };
      open.set(slot, run);
      out.push(run);
    }
    const n = ev.r.length;
    const idx = ev.r[n - 3];
    const st: [number, number, number, number] = [f, idx === 0xffff ? -1 : idx, ev.r[n - 2], ev.r[n - 1]];
    const last = run.states[run.states.length - 1];
    if (!last || last[1] !== st[1] || last[2] !== st[2] || last[3] !== st[3]) run.states.push(st);
  }
  return out.sort((x, y) => x.start - y.start || x.order - y.order);
}

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
});

/**
 * Visible states only (an object's hidden frames), the last of each frame
 * (a fresh slot's stale fields before its first run's writes).
 */
const shown = (r: Run): Array<[number, number, number, number]> =>
  r.states.filter((s, i) => s[1] >= 0 && (i + 1 >= r.states.length || r.states[i + 1][0] !== s[0]));

/**
 * Objects that start on the same frame (a burst's four sparks): the game's
 * slots need not be in spawn order (a freed slot is taken again), so each
 * engine object is paired with the game's that shows its first state.
 */
function pairUp(g: Run[], e: Run[]): Run[] {
  const out: Run[] = [];
  const left = [...e];
  for (const gr of g) {
    const first = shown(gr)[0];
    let k = left.findIndex((er) => er.start === gr.start && first !== undefined && JSON.stringify(shown(er)[0]?.slice(1)) === JSON.stringify(first.slice(1)));
    if (k < 0) k = 0;
    if (left.length === 0) break;
    out.push(left.splice(k, 1)[0]);
  }
  return out;
}

describe.skipIf(!haveRules || !haveRomTest)("the copy abilities' objects vs the game's", () => {
  for (const k of [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
    const demo = loadDemo(k);
    const path = romTestPath(`actors_web_demo${k}.json`);
    it.skipIf(!demo || !existsSync(path))(`demo ${k}`, () => {
      const game = gameRuns(readJson<ActorsJson>(path));
      const to = Math.max(...game.map((r) => Math.max(r.end, r.states[r.states.length - 1]?.[0] ?? 0)), 0);
      const ids = new Map<AbilityObject, Run>();
      const engine: Run[] = [];
      let order = 0;
      const run = runDemo(demo!, 9000, (w, f) => {
        const fx = w.get(AbilityFx)!;
        const alive = new Set(fx.objects);
        for (const [o, r] of ids) if (!alive.has(o) && r.end < 0) r.end = f;
        for (const o of fx.objects) {
          if (!TYPES.has(o.type)) continue;
          let r = ids.get(o);
          if (!r) {
            r = { type: o.type, start: f, end: -1, order: order++, states: [] };
            ids.set(o, r);
            engine.push(r);
          }
          const last = r.states[r.states.length - 1];
          if (!last || last[1] !== o.frame || last[2] !== o.x || last[3] !== o.y) r.states.push([f, o.frame, o.x, o.y]);
        }
        return f > to + 5;
      });
      worlds.push(run.world);
      const bad: string[] = [];
      const byType = (rs: Run[], t: number): Run[] => rs.filter((r) => r.type === t);
      for (const t of TYPES) {
        const g = byType(game, t);
        const e = pairUp(g, byType(engine, t));
        if (g.length !== byType(engine, t).length) bad.push(`type ${t}: the game's ${g.length} objects, the engine's ${byType(engine, t).length}`);
        for (let i = 0; i < Math.min(g.length, e.length) && bad.length < 12; i++) {
          // the followers loop for the ability's length: past their first
          // 120 frames a tick more or less in the game's lag (the cup reveal's
          // decompression, notes "Playing a recording back") shifts their
          // cycle, so they are compared over those
          const cut = (st: Array<[number, number, number, number]>, r: Run) => (LOOPING.has(t) ? st.filter((x) => x[0] <= r.start + 120) : st);
          const gs = cut(shown(g[i]), g[i]);
          const es = cut(shown(e[i]), g[i]);
          const at = `type ${t} #${i} (from ${g[i].start})`;
          if (gs.length !== es.length) {
            const j = gs.findIndex((x, n) => JSON.stringify(x) !== JSON.stringify(es[n]));
            if (j >= 0) bad.push(`${at}: first difference at state ${j}: ${JSON.stringify(gs.slice(j, j + 3))} vs ${JSON.stringify(es.slice(j, j + 3))}`);

            bad.push(`${at}: ${gs.length} states, the engine's ${es.length}: ${JSON.stringify(gs.slice(0, 4))} vs ${JSON.stringify(es.slice(0, 4))}`);
            continue;
          }
          gs.forEach((s, j) => {
            const x = es[j];
            if (s[1] !== x[1] || s[2] !== x[2] || s[3] !== x[3] || Math.abs(s[0] - x[0]) > 1) {
              if (bad.length < 12) bad.push(`${at} state ${j}: the game's ${JSON.stringify(s)}, the engine's ${JSON.stringify(x)}`);
            }
          });
          if (g[i].end >= 0 && Math.abs(g[i].end - e[i].end) > (LOOPING.has(t) ? 3 : 1)) bad.push(`${at}: ends at ${g[i].end}, the engine's ${e[i].end}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});
