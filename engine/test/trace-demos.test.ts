/**
 * DEMOPLAY demos 10-19 (test/demo-harness.ts): each demo's hole played from
 * its set-up with the pad the game read, shot by shot. Every ball state the
 * game recorded must follow, in order (test/align.ts matchBallStates), with
 * the ability's block words at each (compareAbilityFields), and Kirby's
 * states must change at the game's frames (±1, the flow tests' tolerance
 * being ±2).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { compareAbilityFields, distinctStates, matchBallStates } from './align';
import { haveRules, haveRomTest, iterationOf, loadSounds, loadTrace } from './fixtures';
import { EVENT_TABLE } from '../src/game/features/audio/event-table';
import { bodyOf, lineOf, loadDemo, runDemo, type Demo } from './demo-harness';
import { demoCursor, tickDemo } from '../src/core/demo';
import { fromCore } from './events.test';

const DEMOS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
/** The demos whose ability is ported: compared to the hole-out, the others to their first activation. */
const PORTED = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

/** The game frame where a demo's comparison ends: its first activation (no abilities yet). */
function firstActivation(d: Demo): number {
  const t = d.game.iters.trigger.find((r) => (r[2] & 0x8000) !== 0);
  return t ? iterationOf(t[0], t[1]) : Infinity;
}

const stats: string[] = [];

/** Kirby's state changes, [game frame, state], in [from, to]. */
function stateChanges(events: Array<[number, string, number | string]>, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [f, k, v] of events) {
    if (k !== 'state' || f < from || f > to) continue;
    if (out.length === 0 || out[out.length - 1][1] !== v) out.push([f, Number(v)]);
  }
  return out;
}

describe.skipIf(!haveRules || !haveRomTest)('the DEMOPLAY streams ($83:DAAA)', () => {
  for (const k of DEMOS) {
    const demo = loadDemo(k);
    it.skipIf(!demo)(`demo ${k}: every tick's pad, from the ROM's record`, () => {
      const { game, rec } = demo!;
      // the arm ($82:B2E7, $C0 = 1); every vblank wait after it ticks once
      const arm = game.events.find((e) => e[1] === 'darm' && e[2] !== 0)!;
      const waits = game.iters.waits;
      const first = bodyOf(waits, arm[0], lineOf(arm));
      const c = demoCursor();
      let bad = 0;
      let checked = 0;
      for (let i = first; i + 1 < waits.length; i++) {
        const want = tickDemo(rec, c);
        // what the code after wait i reads, before the next wait; a lag frame
        // between them lets the NMI write the real pad (0) first
        if (waits[i + 1][0] - waits[i][0] > 1) continue;
        const [held, pressed] = game.padAt(waits[i + 1][0], waits[i + 1][1]);
        checked += 1;
        if (held !== want.held || pressed !== want.pressed) bad += 1;
      }
      expect(checked).toBeGreaterThan(500);
      expect(bad).toBe(0);
    });
  }
});

afterAll(() => {
  if (process.env.TRACE_STATS) console.log(stats.join('\n'));
});

/** Koota allows 16 worlds at once: each run's goes after its test. */
const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
});

describe.skipIf(!haveRules || !haveRomTest)('the DEMOPLAY demos, shot by shot', () => {
  for (const k of DEMOS) {
    const name = `web_demo${k}`;
    const demo = loadDemo(k);
    const trace = loadTrace(name);
    it.skipIf(!demo || !trace)(`demo ${k}`, () => {
      const all = trace!.frames;
      const to = PORTED.has(k) ? all[all.length - 1].f : firstActivation(demo!);
      const from = demo!.game.shots[0].aimFrame;
      const run = runDemo(demo!, 9000, (_w, f) => f > to + 5);
      worlds.push(run.world);
      const gameEvents = demo!.game.events.map((e) => [iterationOf(e[0], lineOf(e)), e[1], e[2]] as [number, string, number | string]);
      const gs = stateChanges(gameEvents, from, PORTED.has(k) ? to : to - 1);
      const es = stateChanges(run.events, from, PORTED.has(k) ? to : to - 1);
      const g = distinctStates(trace!.frames.filter((r) => iterationOf(r.f, r.ln) <= to));
      const e = distinctStates(run.ball.filter((b) => b.f <= to));
      const r = matchBallStates(g, e);
      stats.push(`demo ${k}: to ${to}, ${r.matched}/${g.length} states, ${r.skips} catch-ups${r.error ? ` (${r.error})` : ''}\n  game   ${JSON.stringify(gs)}\n  engine ${JSON.stringify(es)}`);
      expect(r.error, name).toBeNull();
      const byFrame = new Map(run.ball.map((b) => [b.f, b]));
      expect(compareAbilityFields(r.pairs, (f) => byFrame.get(f)), `${name}: the ability words`).toEqual([]);
      expect(es.map(([, v]) => v)).toEqual(gs.map(([, v]) => v));
      es.forEach(([f], i) => expect(Math.abs(f - gs[i][0]), `${name}: state ${gs[i][1]} at ${gs[i][0]}`).toBeLessThanOrEqual(1));
    });
  }
});

/**
 * The sounds: every request the game made ($80:B542 effects, $80:B4AC
 * songs) from the first aim to the hole-out, each at the engine's frame
 * within ±1 (thread-phase sounds land in the first lines of the next video
 * frame); and every kind the engine emitted is in the event table.
 */
describe.skipIf(!haveRules || !haveRomTest)('the DEMOPLAY demos: the sounds', () => {
  for (const k of DEMOS) {
    const name = `web_demo${k}`;
    const demo = loadDemo(k);
    const sounds = loadSounds(name);
    const trace = loadTrace(name);
    it.skipIf(!demo || !sounds || !trace)(`demo ${k}`, () => {
      const from = demo!.game.shots[0].aimFrame;
      const all = trace!.frames;
      const to = all[all.length - 1].f;
      const run = runDemo(demo!, 9000, (_w, f) => f > to + 5);
      worlds.push(run.world);
      // the objects' and Kirby's scripts' sounds (banks $84, $85, $87) are
      // the presentation's, but those core runs (events.test.ts fromCore); the aim's guide lag
      // tick ($81:A98F) is the engine's estimate of that lag (docs/engine.md)
      const want = sounds!.filter((r) => r[2] >= from && r[2] <= to && fromCore(r) && r[5] !== '$81:A98F')
        .map((r) => ({ f: r[2], song: r[3] === 'song', id: r[3] === 'song' ? r[4] - 0x7e : r[4], caller: r[5] }));
      const got = run.emitted
        .filter((e) => e.gameFrame >= from && e.gameFrame <= to + 1 && e.romSfx >= 0 && e.kind !== 'music-volume' && e.kind !== 'aim-tick')
        .map((e) => ({ f: e.gameFrame, song: e.kind === 'song', id: e.romSfx, kind: e.kind, used: false }));
      const bad: string[] = [];
      for (const w of want) {
        const hit = got.find((g) => !g.used && Math.abs(g.f - w.f) <= 1 && g.song === w.song && g.id === w.id);
        if (hit) hit.used = true;
        else bad.push(`missing ${w.song ? 'song' : 'sfx'} ${w.id} at ${w.f} (${w.caller})`);
      }
      for (const g of got) if (!g.used) bad.push(`extra ${g.kind} ${g.id} at ${g.f}`);
      const off = run.emitted.filter((e) => {
        const row = EVENT_TABLE[e.kind];
        return !row || (row.ids.length === 0 ? e.romSfx !== -1 : !row.ids.includes(e.romSfx));
      }).map((e) => `${e.kind} ${e.romSfx}`);
      stats.push(`${name} sounds: ${bad.length} off: ${bad.slice(0, 14).join('; ')}`);
      expect([...new Set(off)]).toEqual([]);
      expect(bad).toEqual([]);
    });
  }
});
