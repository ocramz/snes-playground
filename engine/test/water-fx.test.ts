/**
 * The water's effects (sim/water.ts, sim/water-fx.ts, systems/water-fx.ts)
 * against the recordings of test/water-scenarios.ts:
 *
 * - Kirby's palette ($82:8604, CGRAM shadow `$7E:0504`: `$2C9C` dry, `$312F`
 *   wet; trace_flow.py `pal`) and the block's `$D872` (`wet`): each change,
 *   carried to the engine's frame through the matched ball states, as the
 *   sounds are (test/scenarios.ts). The hop's flash also writes `$0504`
 *   (`$5DFF`, then the dry colour, web_water_mod); it is not the water's and
 *   is left out.
 * - The splashes (objects 53-58, trace_actors.py --types ...): each slot's
 *   run from its first record to its exit, in spawn order: the same types,
 *   and its distinct (x, y, frame) states in the engine's.
 * - The bubbles (object 67): the same for each emitter, the engine's random
 *   state seeded from the recording at the set-up (`rnga`/`rngb`).
 *
 * The pure half: the region table at its edges, the level, the skip count,
 * the random numbers against a run of the game's.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { RomRules } from '../src/core/rules';
import { haveRules, haveRomTest, loadTables, loadRomHole, loadTrace, loadFlow, iterationOf, romTestPath } from './fixtures';
import { runFlowScript } from './flow-harness';
import { distinctStates, matchBallStates } from './align';
import { WATER_SCENARIOS } from './water-scenarios';
import type { Scenario } from './scenarios';
import { WaterFx, KirbyPalette } from '../src/core/traits/water';
import { activePlayer } from '../src/core/traits/player';
import { waterRegion, waterLevel, skipCount, waterLand, waterHit } from '../src/core/sim/water';
import { rngNext } from '../src/core/sim/rng';
import { emptyWork } from '../src/core/traits/ball';
import type { Ctx } from '../src/core/sim/context';
import type { BubbleRun, SplashRun } from '../src/core/sim/water-fx';

interface GameRun {
  slot: number;
  type: number;
  spawn: number;
  exit: number;
  states: string[];
  /** The iteration of each state's first record. */
  at: number[];
}

const FX_TYPES = new Set([53, 54, 55, 56, 57, 58, 67]);

function loadRuns(name: string): GameRun[] | null {
  const path = romTestPath(`actors_${name}.json`);
  if (!existsSync(path)) return null;
  const json = JSON.parse(readFileSync(path, 'utf8')) as { fields: string[]; records: number[][]; exits?: number[][] };
  if (!json.exits) return null;
  const col = (k: string): number => json.fields.indexOf(k);
  const events = [
    ...json.records.map((r) => ({ t: r[0] * 1000 + r[1], exit: false, r })),
    ...json.exits.map((r) => ({ t: r[0] * 1000 + r[1], exit: true, r })),
  ].sort((a, b) => a.t - b.t);
  const open = new Map<number, GameRun>();
  const out: GameRun[] = [];
  for (const e of events) {
    const slot = e.r[2];
    const type = e.r[3];
    if (!FX_TYPES.has(type)) continue;
    if (e.exit) {
      const g = open.get(slot);
      if (g) {
        g.exit = iterationOf(e.r[0], e.r[1]);
        open.delete(slot);
      }
      continue;
    }
    let g = open.get(slot);
    if (!g || g.type !== type) {
      g = { slot, type, spawn: iterationOf(e.r[0], e.r[1]), exit: -1, states: [], at: [] };
      open.set(slot, g);
      out.push(g);
    }
    const frame = e.r[col('f5D9C')] & 0xffff;
    // a hidden slot's position is the spawn's leftover registers until its first run
    const st = frame === 0xffff ? 'hidden' : `${e.r[col('f5F1C')]},${e.r[col('f5F9C')]},${frame}`;
    if (g.states[g.states.length - 1] !== st) {
      g.states.push(st);
      g.at.push(iterationOf(e.r[0], e.r[1]));
    }
  }
  return out;
}

interface EngineRun {
  type: number;
  spawn: number;
  states: string[];
}

const stateOf = (r: SplashRun | BubbleRun): string => (r.frame < 0 ? 'hidden' : `${r.x},${r.y},${r.frame & 0xffff}`);

function isSubsequence(want: string[], have: string[]): string | null {
  let j = 0;
  for (const s of want) {
    while (j < have.length && have[j] !== s) j++;
    if (j === have.length) return s;
    j++;
  }
  return null;
}

/** The scenarios, and web_water_shot played from the tee (trace-script's): the bubbles while Kirby stands in the water. */
const RUNS: Scenario[] = [
  ...WATER_SCENARIOS,
  { name: 'web_water_shot', hole: 6, offset: 2332, from: 2333, to: 3640, what: 'into the pond and out' },
];

describe.skipIf(!haveRules || !haveRomTest)('the water\'s effects vs the recorded game', () => {
  for (const s of RUNS) {
    it.skipIf(!loadTrace(s.name) || !loadRomHole(s.hole) || !loadRuns(s.name))(`${s.name}`, () => {
      const engine: EngineRun[] = [];
      const ids = new Map<object, EngineRun>();
      const palAt = new Map<number, number>();
      const note = (r: SplashRun | BubbleRun, frame: number): void => {
        let e = ids.get(r);
        if (!e) {
          e = { type: 'type' in r ? r.type : 67, spawn: frame, states: [] };
          ids.set(r, e);
          engine.push(e);
        }
        const st = stateOf(r);
        if (e.states[e.states.length - 1] !== st) e.states.push(st);
      };
      let frameNow = 0;
      const run = runFlowScript(s.name, s.to - s.offset + 40, {
        hole: s.hole, offset: s.offset, pokes: true, seedRng: true,
        until: (world, gameFrame) => {
          const fx = world.get(WaterFx)!;
          fx.between = (r) => note(r, frameNow);
          frameNow = gameFrame + 1;
          for (const r of [...fx.splashes, ...fx.bubbles]) note(r, gameFrame);
          palAt.set(gameFrame, activePlayer(world).get(KirbyPalette)!.wet);
          return false;
        },
      });
      try {
        const trace = loadTrace(s.name)!;
        const last = trace.frames.filter((r, i, a) => i + 1 >= a.length || a[i + 1].f !== r.f);
        const game = distinctStates(last.filter((r) => r.f > s.from && r.f <= s.to));
        const m = matchBallStates(game, distinctStates(run.ball));
        expect(m.error).toBeNull();
        // per matched ball state: the block's $D872, and Kirby's palette as the
        // game's last dry or wet write at or before that state's iteration
        const flow = loadFlow(s.name)!;
        const DRY = 0x2c9c;
        const WET = 0x312f;
        const pals = flow.events.filter(([, k, v]) => k === 'pal' && (v === DRY || v === WET));
        const gamePalAt = (i: number): number => {
          let v = 0;
          for (const [f, , x] of pals) if (f <= i) v = x === WET ? 1 : 0;
          return v;
        };
        for (const [g, e] of m.pairs) {
          if (g.wet !== undefined) expect(e.wet, `$D872 at game f${g.f} / engine f${e.f}`).toBe(g.wet);
          expect(palAt.get(e.f), `Kirby's palette at game f${g.f} / engine f${e.f}`).toBe(gamePalAt(iterationOf(g.f, g.ln)));
        }
        // the objects spawned in the window, in order (a 58 spawns in the tick, after the step's)
        const first = iterationOf(m.pairs[0][0].f, m.pairs[0][0].ln);
        const lastPair = m.pairs[m.pairs.length - 1];
        const gameEnd = iterationOf(lastPair[0].f, lastPair[0].ln);
        const engineEnd = lastPair[1].f;
        const byOrder = <T extends { spawn: number; type: number }>(l: T[]): T[] => [...l].sort((a, b) => a.spawn - b.spawn || a.type - b.type);
        const games = byOrder(loadRuns(s.name)!.filter((g) => g.spawn >= first - 1 && g.spawn <= gameEnd));
        const ours = byOrder(engine.filter((e) => e.spawn <= engineEnd));
        expect(ours.map((e) => e.type), 'the objects spawned').toEqual(games.map((g) => g.type));
        games.forEach((g, k) => {
          const e = ours[k];
          // the game's states within the window (an emitter outlives it)
          const want = g.states.filter((x, i) => x !== 'hidden' && g.at[i] <= gameEnd);
          const miss = isSubsequence(want, e.states.filter((x) => x !== 'hidden'));
          expect(miss, `${g.type} #${k} (game ${g.spawn}, engine ${e.spawn}): ${miss} of ${want.join(' ')} not in ${e.states.join(' ')}`).toBeNull();
        });
      } finally {
        run.world.destroy();
      }
    });
  }
});

describe.skipIf(!haveRules)('the water\'s kernels ($82:83DD, $82:83B9, $82:8228, $80:87DD)', () => {
  const rules = new RomRules(loadTables());
  const at = (tile: number, xf: number, yf: number): number => {
    const w = emptyWork();
    w.tile = tile; w.xf = xf; w.yf = yf;
    return waterRegion(w);
  };

  it('the region: open water deep; a rim deep to $E000 and dry beyond, never shallow', () => {
    expect(at(0x61, 0xffff, 0xffff)).toBe(2);
    expect([at(0x64, 0, 0xdfff), at(0x64, 0, 0xe000)]).toEqual([2, 0]); // yf toward the water
    expect([at(0x67, 0xdfff, 0), at(0x67, 0xe000, 0)]).toEqual([2, 0]);
    expect([at(0x65, 0x2001, 0), at(0x65, 0x2000, 0)]).toEqual([2, 0]); // -xf
    expect([at(0x66, 0, 0x2001), at(0x66, 0, 0x2000), at(0x66, 0, 0)]).toEqual([2, 0, 2]); // -0 = 0
  });

  it('the corners: a band of $1000 shallow outside $E000, dry from $F000', () => {
    // $6B: x = xf, y = yf
    expect([at(0x6b, 0xdfff, 0xdfff), at(0x6b, 0xe000, 0), at(0x6b, 0, 0xefff), at(0x6b, 0xf000, 0)]).toEqual([2, 1, 1, 0]);
    // $6A: x = xf, y = -yf (web_water_shallow: xf $E800, yf $8000)
    expect(at(0x6a, 0xe800, 0x8000)).toBe(1);
    // the inner corner $6F: deep unless x is outside $E000; dry only with both outside $F000
    expect([at(0x6f, 0xdfff, 0xffff), at(0x6f, 0xe000, 0xdfff), at(0x6f, 0xe000, 0xe000), at(0x6f, 0xf000, 0xefff), at(0x6f, 0xf000, 0xf000)])
      .toEqual([2, 2, 1, 1, 0]);
  });

  it('the level: the height of the elevation (+ 1 on $61) + $57AD', () => {
    const ctx = { rules, course: {} } as unknown as Ctx;
    const w = emptyWork();
    w.elev = 3; w.tile = 0x67;
    expect(waterLevel(ctx, w)).toBe(0x1_6733); // course 1 hole 7's rim
    w.elev = 2; w.tile = 0x61;
    expect(waterLevel(ctx, w)).toBe(0x1_6733); // its open water, one step lower
  });

  it('the skips: -1 without spin or near the middle, 1 at 4-5 from it, 2 at 6', () => {
    const w = emptyWork();
    const n = (tb: number, spin: number): number => {
      w.spinX = spin; w.spinY = 0;
      skipCount(w, tb);
      return w.waterSkips;
    };
    expect([n(0, 0), n(6, 0x100), n(3, 0x100), n(2, 0x100), n(1, 0x100), n(0, 0x100), n(12, 0x100), n(10, 0x100)])
      .toEqual([0xffff, 0xffff, 0xffff, 1, 1, 2, 2, 1]);
  });

  // the ability modes' branches, ported as read and untraced (BallMode is always 0 so far)
  const pond = (mode: number, tile: number, extra: Partial<ReturnType<typeof emptyWork>> = {}) => {
    const w = emptyWork();
    Object.assign(w, { mode, tile, pTile: tile, elev: 3, xf: 0x8000, yf: 0x8000, z: 0x1_0f86, ground: 0x1_0f86, code: 4, air: 1, vz: 0xff00 }, extra);
    return w;
  };
  const ctxOf = (): Ctx => ({ rules, course: {} } as unknown as Ctx);

  it('Wheel (6) and UFO (10) ride the level; rolling, the friction is quartered', () => {
    for (const mode of [6, 0x0a]) {
      const w = pond(mode, 0x67);
      expect(waterLand(ctxOf(), w, { kind: -1, timer: 0 })).toEqual({ next: 'landing', entry: 'full' });
      expect([w.ground, w.code, w.waterWalk, w.onOverlay]).toEqual([0x1_6733, 0, 1, 0]);
      const r = pond(mode, 0x61, { air: 0, rollMu: 0x0c00, elev: 2 });
      expect(waterHit(ctxOf(), r).next).toBe('rolling');
      expect([r.ground, r.rollMu, r.waterWalk]).toEqual([0x1_6733, 0x0300, 1]);
    }
    const dry = pond(6, 0x67, { xf: 0xf000 }); // out of the region: off the level
    waterLand(ctxOf(), dry, { kind: -1, timer: 0 });
    expect(dry.waterWalk).toBe(0);
  });

  it('Freeze (9) ices the water under the level ($47), then rides it like the others', () => {
    const w = pond(9, 0x61, { elev: 2 });
    waterLand(ctxOf(), w, { kind: -1, timer: 0 });
    expect([w.waterFreeze, w.tailSfx, w.ground, w.waterWalk, w.onOverlay]).toEqual([1, 0x47, 0x1_6733, 1, 0]);
    const next = pond(0, 0x61, { elev: 2, waterFreeze: 1 }); // iced: even mode 0 rides it
    waterLand(ctxOf(), next, { kind: -1, timer: 0 });
    expect([next.ground, next.onOverlay]).toEqual([0x1_6733, 0]);
  });

  it('with $69CA set the water is plain ground', () => {
    const w = pond(0, 0x61, { elev: 2, waterOff: 1 });
    expect(waterLand(ctxOf(), w, { kind: -1, timer: 0 })).toEqual({ next: 'landing', entry: 'full' });
    expect([w.onOverlay, w.vz, w.waterSplash]).toEqual([0, 0xff00, 0]);
  });

  it('$80:87DD from the power-on state: the game\'s first calls (web_water_roll\'s watch, frames 1240-1246)', () => {
    const s = { a: 0x0701, b: 0x0001 };
    rngNext(s);
    expect([s.a, s.b]).toEqual([33664, 366]);
    rngNext(s);
    expect([s.a, s.b]).toEqual([16832, 32987]);
    rngNext(s);
    expect([s.a, s.b]).toEqual([8416, 49480]);
  });
});
