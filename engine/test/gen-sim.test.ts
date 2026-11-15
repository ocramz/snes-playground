/**
 * The random holes' shot simulator (src/core/gen/shot-sim.ts) against the
 * whole world: the same shot from the tee, played silently on the kernels
 * and through every system of the frame (test/gen-replay.ts), must come to
 * rest on the same position. Also times the kernel loop, which decides
 * whether the browser can generate on its main thread (plans/random_holes.md
 * phase 0).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables } from './fixtures';
import { CourseDriver, loadTestCourses } from './course-driver';
import { replayShot } from './gen-replay';
import { simContext, simulateShot, teeWork, type ShotSpec } from '../src/core/gen/shot-sim';

const drivers: CourseDriver[] = [];

describe.skipIf(!haveRules)('the shot simulator', () => {
  afterEach(() => {
    for (const d of drivers.splice(0)) d.world.destroy();
  });
  const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);

  const cases: Array<{ hole: number; shot: ShotSpec }> = [
    { hole: 0, shot: { aim: 20, meter: 40, fly: false } }, // t1: flat, walls
    { hole: 0, shot: { aim: 300, meter: 63, fly: true } },
    { hole: 1, shot: { aim: 10, meter: 50, fly: false } }, // t2: ramps, a hill and a hollow
    { hole: 2, shot: { aim: 90, meter: 50, fly: false } }, // t3: diagonals
    { hole: 3, shot: { aim: 75, meter: 63, fly: false } }, // t4: terraces and steps
    { hole: 4, shot: { aim: 0, meter: 63, fly: false } }, // t5: islands, a fall
    { hole: 5, shot: { aim: 0, meter: 30, fly: false } }, // t6: the surface tiles
  ];

  for (const { hole, shot } of cases) {
    it(`hole ${hole + 1}: aim ${shot.aim} meter ${shot.meter} ${shot.fly ? 'fly' : 'grounder'}`, () => {
      const holes = loadTestCourses(rules);
      const data = holes[hole];
      const ctx = simContext(rules, data);
      const sim = simulateShot(ctx, teeWork(ctx, data.tee), shot);
      const d = new CourseDriver([data]);
      drivers.push(d);
      const live = replayShot(d, shot);
      expect(sim.outcome).not.toBe('timeout');
      expect(live.lost).toBe(sim.outcome === 'lost');
      if (sim.outcome === 'rest') {
        const w = sim.work;
        expect(live.pos).toEqual({ xc: w.xc, xf: w.xf, yc: w.yc, yf: w.yf, z: w.z });
      }
    });
  }

  it('times the kernel loop', () => {
    const data = loadTestCourses(rules)[0];
    const ctx = simContext(rules, data);
    const from = teeWork(ctx, data.tee);
    let steps = 0;
    const t0 = performance.now();
    for (let aim = 0; aim < 360; aim += 15) {
      steps += simulateShot(ctx, from, { aim, meter: 63, fly: false }).steps;
      steps += simulateShot(ctx, from, { aim, meter: 63, fly: true }).steps;
    }
    const ms = performance.now() - t0;
    console.log(`kernel loop: ${steps} steps in ${ms.toFixed(1)} ms, ${((ms * 1000) / steps).toFixed(2)} us a step`);
    expect(steps).toBeGreaterThan(0);
  });
});
