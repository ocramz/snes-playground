/**
 * The random holes (src/core/gen, plans/random_holes.md): the layouts are
 * legal by construction and pass the authored-course validator; a seed
 * always gives the same hole; the solver finds plans; and a plan, played
 * through the whole world shot by shot (test/gen-replay.ts), rests where
 * the solver said after every shot and holes out at the end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables } from './fixtures';
import { CourseDriver } from './course-driver';
import { replayShot } from './gen-replay';
import { buildHole, generateCourse, generateHole, runToEnd, PRESETS, type Difficulty } from '../src/core/gen/generate';
import { solveNow } from '../src/core/gen/solve';
import { HoleGrid } from '../src/core/gen/grid';
import { Rng } from '../src/core/gen/rng';
import { isEnemyTile } from '../src/core/sweep';

const ALLOWED = new Set<number>([
  0x00, 0x02, 0x04, 0x0c,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b,
  0x20, 0x21, 0x22, 0x23, 0x24, 0x30, 0x31, 0x32, 0x33, 0x34, 0x36, 0x38, 0x3a,
  0x40, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x50, 0x51,
  0xb0, 0xb1, 0xb2, 0xb3,
]);

const drivers: CourseDriver[] = [];
/** The solver plays hundreds of shots a hole: the slow tests get more than vitest's 5 s. */
const SLOW = 60_000;

describe('the generator\'s random numbers and grid', () => {
  it('a seed gives one sequence', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const xs = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(xs);
    expect(new Rng(1235).next()).not.toBe(xs[0]);
  });

  it('writes the authored format', () => {
    const g = new HoleGrid(3, 2);
    g.rect(0, 0, 2, 1, { shape: 1, elev: 2 });
    g.put(1, 0, { tile: 0x0c });
    g.fence();
    const j = g.toJson('t', 'about');
    expect(j.shape).toEqual(['01 01 01', '01 01 01']);
    expect(j.tile).toEqual(['.. 0C ..', '.. .. ..']);
    expect(j.walls).toEqual(['09 01 03', '0C 04 06']);
  });
});

describe.skipIf(!haveRules)('random holes', () => {
  afterEach(() => {
    for (const d of drivers.splice(0)) d.world.destroy();
  });
  const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);

  it('200 layouts per difficulty: valid, flush but for the step-downs, actors on low shapes, ported tiles only', () => {
    for (const difficulty of [0, 1, 2] as Difficulty[]) {
      let built = 0;
      for (let seed = 1; seed <= 200; seed++) {
        const b = buildHole(rules, seed * 2654435761, difficulty, 'x');
        if (!b) continue;
        built += 1;
        const { data } = b;
        for (let i = 0; i < data.w * data.h; i++) {
          const t = data.tile[i];
          expect(ALLOWED.has(t), `tile $${t.toString(16)}`).toBe(true);
          if (isEnemyTile(t) || t === 0x02 || t === 0x0c) expect(data.shape[i]).toBe(0x01);
          if (t !== 0) expect(data.shape[i]).not.toBe(0);
        }
        expect(data.enemies.length).toBeGreaterThanOrEqual(2);
        expect(data.elev.every((e) => e <= 0x0f)).toBe(true);
      }
      expect(built).toBeGreaterThan(190);
    }
  }, SLOW);

  it('the layouts have no edge the layout did not ask for', () => {
    // buildHole rejects them; check the rate of rejection stays nil
    let rejected = 0;
    for (let seed = 1; seed <= 300; seed++) if (!buildHole(rules, seed, 2, 'x')) rejected += 1;
    expect(rejected).toBe(0);
  }, SLOW);

  it('a seed always gives the same hole', () => {
    for (const seed of [7, 99, 123456]) {
      const a = runToEnd(generateHole(rules, seed, 0, { difficulty: 1 }));
      const b = runToEnd(generateHole(rules, seed, 0, { difficulty: 1 }));
      expect(JSON.stringify(b.json)).toBe(JSON.stringify(a.json));
      expect(b.solution?.plan).toEqual(a.solution?.plan);
    }
  }, SLOW);

  it('the solver finds plans within the presets\' par windows', () => {
    // seeds 1-12 solve 12, 11 and 6 of 12 (easy, normal, hard). Hard fell from
    // 8 when the boost panels' rolling handlers were ported exactly
    // (web_boost, web_boost_side): over 30 seeds 29, 28 and 20 solve.
    const least = [8, 8, 6];
    for (const difficulty of [0, 1, 2] as Difficulty[]) {
      let solved = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const b = buildHole(rules, seed * 7919, difficulty, 'x')!;
        const sol = solveNow(rules, b.data);
        if (sol.ok) solved += 1;
      }
      expect(solved, `difficulty ${difficulty}`).toBeGreaterThanOrEqual(least[difficulty]);
    }
    const course = runToEnd(generateCourse(rules, 2026, 8, { difficulty: 1 }));
    expect(course).toHaveLength(8);
    for (const h of course) {
      expect(h.solution?.ok).toBe(true);
      expect(h.solution!.par).toBeGreaterThanOrEqual(PRESETS[1].par[0]);
      expect(h.solution!.par).toBeLessThanOrEqual(PRESETS[1].par[1]);
    }
  }, SLOW);

  for (const [seed, difficulty] of [[11, 0], [2026, 1], [31337, 2]] as Array<[number, Difficulty]>) {
    it(`seed ${seed} (${['easy', 'normal', 'hard'][difficulty]}): the plan, replayed through the world, holes out`, () => {
      const hole = runToEnd(generateHole(rules, seed, 0, { difficulty }));
      const plan = hole.solution!.plan;
      const d = new CourseDriver([hole.data]);
      drivers.push(d);
      for (let k = 0; k < plan.length; k++) {
        const live = replayShot(d, plan[k].shot);
        expect(live.lost).toBe(false);
        if (k + 1 < plan.length) expect(live.pos).toEqual(plan[k + 1].from);
        else expect(live.holed).toBe(true);
      }
      d.untilPhase('HoleOver', 3000);
    }, SLOW);
  }
});
