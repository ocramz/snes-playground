/**
 * The snap panels' star trail (sim/snap-stars.ts, systems/snap-trail.ts)
 * against the recorded thread slots of objects 61 and 62
 * (tools/snesstep/trace_actors.py --types 61,62 -> build/engine/rom-test/
 * actors_<name>.json, with the slots' exits).
 *
 * The scenarios are trace-terrain.test.ts's snap panels. Per scenario:
 * - the objects 61 spawned in the window, and the bursts they made;
 * - each recorded star (a slot's run from its spawn to its exit) matched to
 *   the engine's of the same burst and variant: its run of distinct
 *   (x, y, frame index) states must occur, in order, in the engine star's —
 *   the game's lag frames drop scheduler ticks, and a frame that runs two
 *   keeps only the second's state (the rule of hazard-actors.test.ts) — and
 *   it lives as many ticks, unless the game lagged meanwhile.
 *
 * The pure half (no recording needed): the polar step against the table, a
 * script's life, the burst's sign test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { RomRules } from '../src/core/rules';
import { haveRules, haveRomTest, loadTables, loadRomHole, iterationOf, romTestPath } from './fixtures';
import { runFlowScript } from './flow-harness';
import { SnapTrail } from '../src/core/traits/snap';
import { polar, spawnStar, tickStar, burst, type StarRun } from '../src/core/sim/snap-stars';
import { SNAP_SCENARIOS } from './snap-scenarios';

interface GameStar {
  slot: number;
  spawn: number; // iteration
  exit: number; // iteration, -1 past the recording
  variant: number;
  dir: number;
  states: string[];
}

function loadStars(name: string): { stars: GameStar[]; spawners: number[] } | null {
  const path = romTestPath(`actors_${name}.json`);
  if (!existsSync(path)) return null;
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    fields: string[]; records: number[][]; exits?: number[][];
  };
  if (!json.exits) return null;
  const col = (k: string): number => json.fields.indexOf(k);
  const open = new Map<number, GameStar>();
  const stars: GameStar[] = [];
  const spawners: number[] = [];
  // records and exits merged in time order
  const events: Array<{ iter: number; ln: number; kind: 'rec' | 'exit'; r: number[] }> = [
    ...json.records.map((r) => ({ iter: iterationOf(r[0], r[1]), ln: r[0] * 1000 + r[1], kind: 'rec' as const, r })),
    ...json.exits.map((r) => ({ iter: iterationOf(r[0], r[1]), ln: r[0] * 1000 + r[1], kind: 'exit' as const, r })),
  ].sort((a, b) => a.ln - b.ln);
  const seen61 = new Set<number>();
  for (const e of events) {
    const slot = e.r[2];
    const type = e.r[3];
    if (e.kind === 'exit') {
      if (type === 61) seen61.delete(slot);
      const s = open.get(slot);
      if (type === 62 && s) {
        s.exit = e.iter;
        open.delete(slot);
      }
      continue;
    }
    if (type === 61) {
      if (!seen61.has(slot)) spawners.push(e.iter);
      seen61.add(slot);
      continue;
    }
    let s = open.get(slot);
    if (!s) {
      s = { slot, spawn: e.iter, exit: -1, variant: e.r[col('f531C')], dir: e.r[col('f589C')], states: [] };
      open.set(slot, s);
      stars.push(s);
    }
    const st = `${e.r[col('f5F1C')]},${e.r[col('f5F9C')]},${e.r[col('f5D9C')] & 0xffff}`;
    if (s.states[s.states.length - 1] !== st) s.states.push(st);
  }
  return { stars, spawners };
}

interface EngineStar {
  spawn: number;
  last: number;
  variant: number;
  dir: number;
  ox: number; oy: number;
  states: string[];
}

const stateOf = (s: StarRun): string => `${s.x},${s.y},${s.frame & 0xffff}`;

/** A star replayed alone from its burst, its state taken twice a tick (after the thread, after the draw). */
function replay(rules: RomRules, e: EngineStar): string[] {
  const r = spawnStar(rules, e.dir, e.variant, e.ox, e.oy, 0);
  const out: string[] = [];
  const push = (s: StarRun): void => {
    const st = stateOf(s);
    if (out[out.length - 1] !== st) out.push(st);
  };
  while (!r.done) {
    tickStar(rules, r, push);
    if (!r.done) push(r);
  }
  return out;
}

function isSubsequence(want: string[], have: string[]): string | null {
  let j = 0;
  for (const s of want) {
    while (j < have.length && have[j] !== s) j++;
    if (j === have.length) return s;
    j++;
  }
  return null;
}

const SNAPS = SNAP_SCENARIOS;

describe.skipIf(!haveRules || !haveRomTest)('the snap panels\' stars vs the recorded objects 61 and 62', () => {
  for (const s of SNAPS) {
    it.skipIf(!loadStars(s.name) || !loadRomHole(s.hole))(`${s.name}`, () => {
      const game = loadStars(s.name)!;
      const engineStars: EngineStar[] = [];
      const ids = new Map<StarRun, EngineStar>();
      let spawners = 0;
      let lastSpawners = 0;
      const run = runFlowScript(s.name, s.to - s.offset + 40, {
        hole: s.hole, offset: s.offset, pokes: true,
        until: (world, gameFrame) => {
          const t = world.get(SnapTrail)!;
          if (t.spawners.length > lastSpawners) spawners += t.spawners.length - lastSpawners;
          lastSpawners = t.spawners.length;
          for (const star of t.stars) {
            let e = ids.get(star);
            if (!e) {
              e = { spawn: gameFrame, last: gameFrame, variant: star.variant, dir: star.dir, ox: star.ox, oy: star.oy, states: [] };
              ids.set(star, e);
              engineStars.push(e);
            }
            e.last = gameFrame;
            const st = stateOf(star);
            if (e.states[e.states.length - 1] !== st) e.states.push(st);
          }
          return false;
        },
      });
      const rules = new RomRules(loadTables());
      try {
        const inWindow = game.stars.filter((g) => g.spawn > s.from && g.spawn <= s.to);
        const gameSpawners = game.spawners.filter((f) => f > s.from && f <= s.to);
        expect(spawners, 'objects 61').toBe(gameSpawners.length);
        // bursts: the game's spawn iterations, in order, and the engine's
        const bursts = (list: Array<{ spawn: number }>): number[] => [...new Set(list.map((x) => x.spawn))].sort((a, b) => a - b);
        const gb = bursts(inWindow);
        const eb = bursts(engineStars);
        expect(eb.length, 'bursts').toBe(gb.length);
        expect(inWindow.length).toBe(gb.length * 4);
        for (const g of inWindow) {
          const k = gb.indexOf(g.spawn);
          const e = engineStars.find((x) => x.spawn === eb[k] && x.variant === g.variant)!;
          expect(e, `burst ${k} variant ${g.variant}`).toBeDefined();
          expect(e.dir, `burst ${k} variant ${g.variant}: dir16`).toBe(g.dir);
          const both = replay(rules, e);
          expect(isSubsequence(e.states, both), 'the engine\'s frames are the replay\'s').toBeNull();
          const miss = isSubsequence(g.states, both);
          expect(miss, `burst ${k} (game ${g.spawn}) variant ${g.variant}: state ${miss} of ${g.states.join(' ')} not in ${both.join(' ')}`).toBeNull();
        }
      } finally {
        run.world.destroy();
      }
    });
  }
});

describe.skipIf(!haveRules)('the stars\' motion and scripts ($80:E97C, $80:EA26, $85:CFE1)', () => {
  const rules = new RomRules(loadTables());
  const T = rules.table('polarTrig');

  it('the polar table: 256 at angle 0, the quarter turn at 64, its quirks kept', () => {
    expect(T.length).toBe(320);
    expect([T[0], T[64], T[128], T[192]]).toEqual([256, 0, -256, 0]);
    expect([T[63], T[319]]).toEqual([2, 0]); // not a mirror image: copied, not computed
  });

  it('polar: (r >> 6) x T, the product\'s low 16 bits >> 2, both arithmetic', () => {
    // 3 px ($0300) up ($40): r >> 6 = 12; dx = 12 x T[64] = 0; dy = 12 x T[128] = -3072, >> 2 = -768
    expect(polar(rules, 0x0300, 0x40)).toEqual([0, 0xfd00]);
    // 6 px at $B9 (down and left): 24 x T[$B9], 24 x T[$F9], each >> 2
    const want = (c: number): number => (((24 * c) << 16 >> 16) >> 2) & 0xffff;
    expect(polar(rules, 0x0600, 0xb9)).toEqual([want(T[0xb9]), want(T[0xb9 + 64])]);
    // a negative r shifts arithmetically ($80:EA39: SEC/ROR)
    expect(polar(rules, 0xfa00, 0)).toEqual([(-24 * 256 >> 2) & 0xffff, 0]);
  });

  it('one script\'s life: dir 0, variant 2 hides 7 ticks, then rises; 20 ticks drawn', () => {
    const s = spawnStar(rules, 0, 2, 100, 200, 0);
    const frames: number[] = [];
    let ticks = 0;
    while (!s.done && ticks < 64) {
      tickStar(rules, s);
      if (!s.done) frames.push(s.frame);
      ticks += 1;
    }
    // -:7 [48/3/C0/0068] 0:3 1:3 2:3 3:2 4:2, then the exit tick
    expect(frames).toEqual([...Array(7).fill(-1), 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4]);
    expect(ticks).toBe(21); // 20 drawn, then the exit tick (web_snap: spawned 2498, freed 2518)
    expect(s.y).toBeLessThan(200); // it went up
  });

  it('the burst: four stars, variants 3 2 1 0, only along the arrow', () => {
    const at = { x: 50, y: 60, dir16: 12 };
    expect(burst(rules, { ...at, tile: 0x18, vx: 0, vy: 0xff00 }).map((s) => s.variant)).toEqual([3, 2, 1, 0]);
    expect(burst(rules, { ...at, tile: 0x18, vx: 0, vy: 0 })).toEqual([]); // 0 counts as positive
    expect(burst(rules, { ...at, tile: 0x19, vx: 0, vy: 0 })).toHaveLength(4);
    expect(burst(rules, { ...at, tile: 0x1a, vx: 0, vy: 0xff00 })).toEqual([]);
    expect(burst(rules, { ...at, tile: 0x1b, vx: 0xff00, vy: 0 })).toHaveLength(4);
    expect(burst(rules, { ...at, tile: 0x14, vx: 0, vy: 0xff00 })).toEqual([]);
    expect(burst(rules, { ...at, tile: 0x18, vx: 0, vy: 0xff00, dir16: 2 })[0].queueAdd).toBe(1);
    expect(burst(rules, { ...at, tile: 0x18, vx: 0, vy: 0xff00, dir16: 11 })[0].queueAdd).toBe(1);
    expect(burst(rules, { ...at, tile: 0x18, vx: 0, vy: 0xff00, dir16: 3 })[0].queueAdd).toBe(0);
  });
});
