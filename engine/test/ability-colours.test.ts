/**
 * Kirby's colours (core/sim/kirby-colours.ts) against the game's: OBJ
 * palette 0's colours 2-8 as trace_flow.py records them (`pal`, `pal3`-`pal6`,
 * `outline` for colour 7, `pal8`), frame by frame on the DEMOPLAY demos
 * (test/demo-harness.ts) and the unpoked take-and-use web_ab_c1: the
 * transformation's flash, the outline's green flash while B is available,
 * Fireball's set and its burnt fade, Spark's cycle, Freeze's set, the UFO's
 * colours, its light and its warning, and the set restored at each end.
 *
 * An engine frame's colours must be the game's on that frame or a
 * neighbour (±1: the engine runs the threads at the frame's end, the game
 * at its start). The HUD's phases run free from the course's panel set-up,
 * which the engine does not play: they are seeded from the recording (`hudo`,
 * `hudi`, the HUD object's `$5B1C`/`$551C`) on the first frame.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { haveRules, haveRomTest, loadFlow } from './fixtures';
import { loadDemo, loadIters, runDemo } from './demo-harness';
import { runFlowScript } from './flow-harness';
import { AbilityFx } from '../src/core/traits/ability-fx';

const KEYS = ['pal', 'pal3', 'pal4', 'pal5', 'pal6', 'outline', 'pal8'] as const;

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
});

/** The game's value of `key` at every frame of [from, to] (the last write at or before it). */
function timeline(events: Array<[number, string, number]>, key: string, from: number, to: number): Map<number, number> {
  const out = new Map<number, number>();
  let v: number | undefined;
  let i = 0;
  const evs = events.filter((e) => e[1] === key);
  for (let f = 0; f <= to; f++) {
    while (i < evs.length && evs[i][0] <= f) v = evs[i++][2] & 0xffff;
    if (f >= from && v !== undefined) out.set(f, v);
  }
  return out;
}

/**
 * The shots' curl-to-roll windows (Kirby's state 6 to 14, plus a few
 * frames): the power stage's glow (an object of bank $84, `$84:CBBE` ->
 * `$80:D3AD`, set 3 back at `$81:C07F`) is not ported.
 */
function shotWindows(game: Array<[number, string, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (const [f, k, v] of game) {
    if (k !== 'state') continue;
    if (v === 6 && start < 0) start = f;
    else if (v === 14 && start >= 0) {
      out.push([start, f + 2]);
      start = -1;
    }
  }
  return out;
}

/**
 * Engine frames whose colour is none of the game's on that frame and its
 * neighbours. The outline: a writer after the HUD in a tick (the flash,
 * Freeze's script, Fireball's set) shows for one frame or none, by where the
 * tick falls against the frame (the game's iteration runs past the vblank):
 * a one-frame value in the engine is not counted, nor a frame of `drift`
 * (the HUD's phase was off, then put back).
 */
function compare(game: Array<[number, string, number]>, engine: Map<number, number[]>, from: number, to: number, drift = new Set<number>()): string[] {
  const bad: string[] = [];
  const skip = shotWindows(game);
  KEYS.forEach((key, c) => {
    const g = timeline(game, key, from - 1, to + 1);
    let n = 0;
    for (const [f, cols] of engine) {
      if (f < from || f > to || skip.some(([a, b]) => f >= a && f <= b)) continue;
      const v = cols[c];
      if (v === g.get(f) || v === g.get(f - 1) || v === g.get(f + 1)) continue;
      if (key === 'outline') {
        if (drift.has(f) || drift.has(f - 1)) continue;
        if (engine.get(f - 1)?.[c] !== v && engine.get(f + 1)?.[c] !== v) continue;
      }
      if (n++ < 4) bad.push(`colour ${c + 2} at ${f}: the engine's ${v.toString(16)}, the game's ${g.get(f)?.toString(16)}`);
    }
    if (n > 4) bad.push(`colour ${c + 2}: ${n} frames off`);
  });
  return bad;
}

const DEMOS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

describe.skipIf(!haveRules || !haveRomTest)("Kirby's colours vs the game's", () => {
  for (const k of DEMOS) {
    const demo = loadDemo(k);
    const flow = loadFlow(`web_demo${k}`);
    it.skipIf(!demo || !flow || !flow.events.some((e) => e[1] === 'hudo'))(`demo ${k}`, () => {
      const game = flow!.events as Array<[number, string, number]>;
      const from = demo!.game.shots[0].aimFrame;
      // to the hole-out (Kirby's state 1), or the recording's end (demo 19 is not holed)
      const holed = game.filter((e) => e[1] === 'state' && e[2] === 1).map((e) => e[0]);
      const to = holed.length > 0 ? Math.max(...holed) : game[game.length - 1][0] - 10;
      const engine = new Map<number, number[]>();
      let seeded = false;
      const hudo = timeline(game, 'hudo', 0, to + 10);
      const hudi = timeline(game, 'hudi', 0, to + 10);
      const drift = new Set<number>();
      const run = runDemo(demo!, 9000, (w, f) => {
        const fx = w.get(AbilityFx)!;
        if (f < from - 1) return false;
        // the help texts stop the game's threads (notes "The demo clock"),
        // which the engine does not play: the phases follow the game's there
        if (!seeded || hudo.get(f) === hudo.get(f - 1)) {
          seeded = true;
          fx.hud.outlinePhase = hudo.get(f) ?? 0;
          fx.hud.iconPhase = hudi.get(f) ?? 0;
          return false;
        }
        engine.set(f, [...fx.colours]);
        // the guide's lag is the engine's estimate (docs/engine.md): a tick
        // more or less in an aim shifts the free-running phases; counted,
        // and the phases put back
        if (fx.hud.outlinePhase !== hudo.get(f)) {
          drift.add(f);
          fx.hud.outlinePhase = hudo.get(f) ?? 0;
          fx.hud.iconPhase = hudi.get(f) ?? 0;
        }
        return f > to + 5;
      });
      worlds.push(run.world);
      expect(compare(game, engine, from + 2, to, drift)).toEqual([]);
      expect(drift.size, `${drift.size} frames with the HUD's phase off`).toBeLessThan((to - from) / 20);
    });
  }

  const flow = loadFlow('web_ab_c1');
  it.skipIf(!flow || !flow.events.some((e) => e[1] === 'hudo10'))('web_ab_c1: the take, two Hi-Jumps', () => {
    const game = flow!.events as Array<[number, string, number]>;
    const engine = new Map<number, number[]>();
    // the HUD object is in slot 10 in a course played from the map (trace_flow.py)
    const hudo = timeline(game, 'hudo10', 0, 4300);
    const hudi = timeline(game, 'hudi10', 0, 4300);
    const drift = new Set<number>();
    let seeded = false;
    const run = runFlowScript('web_ab_c1', 4250 - 2333, {
      hole: 2, offset: 2333, pokes: true,
      until: (w, f) => {
        const fx = w.get(AbilityFx)!;
        if (!seeded) seeded = true;
        else engine.set(f, [...fx.colours]);
        if (fx.hud.outlinePhase !== hudo.get(f)) {
          if (f > 2334) drift.add(f);
          fx.hud.outlinePhase = hudo.get(f) ?? 0;
          fx.hud.iconPhase = hudi.get(f) ?? 0;
        }
        return false;
      },
    });
    worlds.push(run.world);
    expect(compare(game, engine, 2340, 4240, drift)).toEqual([]);
    expect(drift.size, `${drift.size} frames with the HUD's phase off`).toBeLessThan(1900 / 20);
  });
});

/**
 * The HUD's ability icon (`AbilityFx.hud.icon`, the upload descriptor): the
 * game's uploads from the HUD's draw (`$84:9B8C`) and object 49's countdown
 * (`$84:A531`, `$84:A54C`), iters_<name>.json; each change of picture must
 * come in order, within 2 frames (the queue's upload lands at the next
 * vblank either way).
 */
function iconChanges(uploads: Array<[number, number, number, string]>, from: number, to: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [f, , a, caller] of uploads) {
    if (!/^\$84:(9B8C|A531|A54C)$/.test(caller)) continue;
    if (out.length > 0 && out[out.length - 1][1] === a) continue;
    if (f >= from && f <= to) out.push([f, a]);
    else if (f < from) out.splice(0, out.length, [f, a]);
  }
  return out.filter(([f]) => f >= from);
}

describe.skipIf(!haveRules || !haveRomTest)("the HUD's ability icon vs the game's", () => {
  for (const k of DEMOS) {
    const demo = loadDemo(k);
    const iters = loadIters(`web_demo${k}`);
    it.skipIf(!demo || !iters || !(iters as { uploads?: unknown }).uploads)(`demo ${k}`, () => {
      const uploads = (iters as unknown as { uploads: Array<[number, number, number, string]> }).uploads;
      const from = demo!.game.shots[0].aimFrame;
      const flow = loadFlow(`web_demo${k}`)!.events as Array<[number, string, number]>;
      const holed = flow.filter((e) => e[1] === 'state' && e[2] === 1).map((e) => e[0]);
      const to = holed.length > 0 ? Math.max(...holed) : flow[flow.length - 1][0] - 10;
      const engine: Array<[number, number]> = [];
      let last = -1;
      const run = runDemo(demo!, 9000, (w, f) => {
        const icon = w.get(AbilityFx)!.hud.icon;
        if (f >= from && icon !== last) engine.push([f, icon]);
        last = icon;
        return f > to + 5;
      });
      worlds.push(run.world);
      const game = iconChanges(uploads, from, to);
      const e = engine.filter(([f]) => f <= to);
      expect(e.map(([, a]) => a.toString(16))).toEqual(game.map(([, a]) => a.toString(16)));
      e.forEach(([f], i) => expect(Math.abs(f - game[i][0]), `icon ${game[i][1].toString(16)} at ${game[i][0]}`).toBeLessThanOrEqual(2));
    });
  }
});
