/**
 * Levels from the editor play: the default level and a level through the
 * URL codec pass the lint, the solver finds a plan, and the plan replayed
 * through the whole world holes out (the pattern of gen.test.ts). On a
 * pond made with the editor's operations, the solver's shot simulator
 * comes to rest exactly where the world does for shots into the water,
 * which is what lets the editor trust its par on water
 * (lint.ts WATER_SOLVER_VERIFIED).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables } from './fixtures';
import { CourseDriver } from './course-driver';
import { replayShot } from './gen-replay';
import { solveNow } from '../src/core/gen/solve';
import { simContext, simulateShot, teeWork, type ShotSpec } from '../src/core/gen/shot-sim';
import { HoleGrid } from '../src/core/gen/grid';
import type { CourseData } from '../src/core/course-data';
import { autoFence, paintTile, raise, type Level } from '../src/core/level/ops';
import { rectCells } from '../src/core/level/select';
import { WATER, isWaterTile } from '../src/core/level/palette';
import { lintLevel } from '../src/core/level/lint';
import { decodeLevel, encodeLevel } from '../src/core/level/codec';
import { defaultLevel } from '../src/core/level/default-level';

const drivers: CourseDriver[] = [];
const SLOW = 60_000;

/** A fenced island with a pond lowered into it and flooded, the tee west of it. */
function pondLevel(): Level {
  const g = new HoleGrid(14, 9);
  g.rect(1, 1, 12, 7, { shape: 0x01, elev: 1 });
  let l: Level = { name: 'POND', grid: g };
  l = raise(l, rectCells(g, 5, 3, 8, 5), -1, 'slope').level;
  l = paintTile(l, rectCells(g, 4, 2, 9, 6), WATER).level;
  l = paintTile(l, new Set([g.at(2, 4)]), 0x0c).level;
  l = paintTile(l, new Set([g.at(11, 2)]), 0x40).level;
  l = paintTile(l, new Set([g.at(11, 6)]), 0x4a).level;
  return autoFence(l).level;
}

describe.skipIf(!haveRules)('levels play', () => {
  afterEach(() => {
    for (const d of drivers.splice(0)) d.world.destroy();
  });
  const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);

  const holesOut = (data: CourseData): number => {
    const sol = solveNow(rules, data);
    expect(sol.ok, sol.why).toBe(true);
    const d = new CourseDriver([data]);
    drivers.push(d);
    for (let k = 0; k < sol.plan.length; k++) {
      const live = replayShot(d, sol.plan[k].shot);
      expect(live.lost).toBe(false);
      if (k + 1 < sol.plan.length) expect(live.pos).toEqual(sol.plan[k + 1].from);
      else expect(live.holed).toBe(true);
    }
    d.untilPhase('HoleOver', 3000);
    return sol.par;
  };

  it('the default level, through a URL, solves and holes out', async () => {
    const shared = await decodeLevel(await encodeLevel(defaultLevel()));
    const lint = lintLevel(shared, rules);
    expect(lint.ok).toBe(true);
    expect(lint.solverSafe).toBe(true);
    const par = holesOut(lint.data!);
    expect(par).toBeGreaterThanOrEqual(2);
    expect(par).toBeLessThanOrEqual(5);
  }, SLOW);

  it('the pond is water all over its bed and rim', () => {
    const l = pondLevel();
    let wet = 0;
    for (let i = 0; i < l.grid.w * l.grid.h; i++) if (isWaterTile(l.grid.tile[i])) wet += 1;
    expect(wet).toBe(6 * 5);
    const lint = lintLevel(l, rules);
    expect(lint.ok).toBe(true);
    expect(lint.steps).toEqual([]);
  });

  const shots: ShotSpec[] = [
    { aim: 0, meter: 20, fly: false }, // rolls in off the bank
    { aim: 0, meter: 45, fly: false },
    { aim: 10, meter: 63, fly: false }, // across the pond
    { aim: 0, meter: 30, fly: true }, // dropped in
    { aim: 350, meter: 63, fly: true },
    { aim: 0, meter: 50, fly: false, topBack: 0 }, // top spin: skips
    { aim: 5, meter: 63, fly: false, topBack: 12 },
  ];
  for (const shot of shots) {
    it(`water: aim ${shot.aim} meter ${shot.meter} ${shot.fly ? 'fly' : 'grounder'} spin ${shot.topBack ?? 6} rests where the world does`, () => {
      const data = lintLevel(pondLevel(), rules).data!;
      const ctx = simContext(rules, data);
      let wet = false;
      const sim = simulateShot(ctx, teeWork(ctx, data.tee), shot, undefined, (w) => {
        if (w.onOverlay !== 0) wet = true;
      });
      const d = new CourseDriver([data]);
      drivers.push(d);
      const live = replayShot(d, shot);
      expect(sim.outcome).not.toBe('timeout');
      expect(live.lost).toBe(sim.outcome === 'lost');
      if (sim.outcome === 'rest') {
        const w = sim.work;
        expect(live.pos).toEqual({ xc: w.xc, xf: w.xf, yc: w.yc, yf: w.yf, z: w.z });
      }
      // every shot of the list ends up in the pond (measured 2026-11-16: 95-157 wet steps each)
      expect(wet).toBe(true);
    }, SLOW);
  }

  it('the pond solves and its plan holes out', () => {
    holesOut(lintLevel(pondLevel(), rules).data!);
  }, SLOW);
});
