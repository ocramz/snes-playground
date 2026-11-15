/**
 * The hole's entities (plans phase 6 §2): the load-time actor sweep
 * ($82:B320) against the exporter's lists, the hole root's teardown, and
 * what web_flow's two takes leave behind (the stars, the owners, the cup).
 */
import { describe, expect, it } from 'vitest';
import { $internal } from 'koota';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { sweepActors } from '../src/core/sweep';
import { createGameWorld } from '../src/core/world';
import { startCourse, startHole, nextHole } from '../src/core/actions';
import { InHole, IsHole, IsEnemy, IsCup, Cell, TakenBy, EnemyKind, IsPillar, IsTee } from '../src/core/traits/hole';
import { Visual } from '../src/core/traits/visual';
import { Course, courseEntity } from '../src/core/traits/course';
import { Shot } from '../src/core/traits/shot';
import { Stars, Tomatoes, Strokes } from '../src/core/traits/counters';
import { BallWork } from '../src/core/traits/ball';
import { HoleFlow } from '../src/core/traits/flow';
import { runFlowScript } from './flow-harness';
import { haveRules, haveRomTest, loadRomCourse, loadRomHole, loadTables } from './fixtures';

const cells = (a: Array<{ x: number; y: number }>): string[] => a.map((c) => `${c.x},${c.y}`);

describe.skipIf(!haveRules || !haveRomTest)('the hole entities', () => {
  const rules = new RomRules(loadTables());

  it("the sweep finds the exporter's enemies and objects on the 8 holes of course 1", () => {
    let seen = 0;
    for (let n = 0; n < 8; n++) {
      const json = loadRomHole(n);
      if (!json) continue;
      seen++;
      const a = sweepActors(rules, json);
      expect(cells(a.enemies).sort(), `hole ${n} enemies`).toEqual(cells(json.enemies).sort());
      const objects = [...a.pillars, ...a.hazards].map((o) => `${o.x},${o.y}:${o.type}`).sort();
      expect(objects, `hole ${n} objects`).toEqual(json.objects.map((o) => `${o.x},${o.y}:${o.type}`).sort());
      expect(a.tee, `hole ${n} tee`).toEqual({ x: json.tee.x, y: json.tee.y });
      // the enemy list's order is the sweep's: rows down, each row from its last column
      const course = fromRomCourse(json);
      expect(cells(course.enemies)).toEqual(cells(a.enemies));
      for (let i = 1; i < a.enemies.length; i++) {
        const p = a.enemies[i - 1];
        const q = a.enemies[i];
        expect(p.y < q.y || (p.y === q.y && p.x > q.x)).toBe(true);
      }
    }
    expect(seen).toBe(8);
  });

  it("hole 1's list is (8,3), (8,5), (6,5); hover 0, no ability (tile $4C)", () => {
    const a = sweepActors(rules, loadRomCourse());
    expect(cells(a.enemies)).toEqual(['8,3', '8,5', '6,5']);
    expect(a.enemies.map((e) => [e.tile, e.hover, e.ability])).toEqual([[0x4c, 0, 0], [0x4c, 0, 0], [0x4c, 0, 0]]);
    expect(a.pillars).toHaveLength(4);
  });

  it('startHole spawns the hole under one root; the next hole tears it down', () => {
    const world = createGameWorld();
    const c0 = fromRomCourse(loadRomCourse());
    startCourse(world, rules, [c0, c0]);
    expect(world.query(IsHole)).toHaveLength(1);
    expect(world.query(IsEnemy)).toHaveLength(3);
    expect(world.query(IsPillar)).toHaveLength(4);
    expect(world.query(IsTee)).toHaveLength(1);
    expect(world.query(InHole('*'))).toHaveLength(3 + 4 + 1);
    const root = world.queryFirst(IsHole)!;
    nextHole(world);
    expect(root.isAlive()).toBe(false);
    expect(world.query(IsHole)).toHaveLength(1);
    expect(world.query(InHole('*'))).toHaveLength(3 + 4 + 1);
    expect(world.get(HoleFlow)!.phase).toBe('ShotSetup');
  });

  it("web_flow's takes: two stars, the owners, and (6,5) turned into the cup", () => {
    const run = runFlowScript('web_flow', 3530 - 2332);
    const w = run.world;
    const player = w.queryFirst(BallWork)!;
    expect(player.get(Stars)!.n).toBe(2);
    expect(player.get(Tomatoes)!.n).toBe(4); // 4 - 1 + 1, then the second +1 is capped
    expect(player.get(Strokes)!.n).toBe(3); // the second set-up
    const byCell = new Map(w.query(IsEnemy, Cell).map((e) => [`${e.get(Cell)!.x},${e.get(Cell)!.y}`, e]));
    expect(byCell.get('8,3')!.targetFor(TakenBy)).toBe(player);
    expect(byCell.get('8,5')!.targetFor(TakenBy)).toBe(player);
    expect(byCell.get('8,3')!.get(Visual)!.kind).toBe('star');
    const cup = byCell.get('6,5')!;
    expect(cup.has(IsCup)).toBe(true);
    expect(cup.targetFor(TakenBy)).toBeUndefined();
    expect(cup.get(Visual)!.kind).toBe('cup');
    expect(cup.get(EnemyKind)!.listIndex).toBe(2);
    const c = courseEntity(w).get(Course)!;
    expect(c.layer2[5 * c.w + 6]).toBe(0x08);
    // $82:8B5C's target, which the second set-up snapped to 180 (game 3507)
    const shot = w.get(Shot)!;
    expect([shot.targetXc, shot.targetXf, shot.targetYc, shot.targetYf]).toEqual([6, 0x8c00, 5, 0x7800]);
    expect(shot.aim).toBe(180);
    // the course data the hole was loaded from is untouched (layer 2 is a copy)
    expect(fromRomCourse(loadRomCourse()).tile[5 * 12 + 6]).toBe(0x4c);
    // a fresh start of the hole brings the enemies back
    startHole(w, 0);
    expect(w.query(IsCup)).toHaveLength(0);
    expect(w.query(IsEnemy).filter((e) => e.targetFor(TakenBy) !== undefined)).toHaveLength(0);
    expect(courseEntity(w).get(Course)!.layer2[5 * 12 + 6]).toBe(0x4c);
  });
});

describe.skipIf(!haveRules || !haveRomTest)('Visual\'s bit in the world', () => {
  // Koota 0.6.6 loops forever creating a tracking query (Removed, Changed:
  // the bridge's bind-views) over a trait on a generation's last bit, 2^30
  // (core/world.ts). createGameWorld registers Visual first.
  it('stays off the last bit of its generation, whatever hole comes first', () => {
    const rules = new RomRules(loadTables());
    for (const h of [0, 3]) {
      const world = createGameWorld();
      startCourse(world, rules, [fromRomCourse(loadRomHole(h)!)]);
      const inst = (world as unknown as Record<symbol, { traitInstances: Array<{ bitflag: number } | undefined> }>)[$internal]
        .traitInstances[(Visual as unknown as { id: number }).id];
      expect(inst?.bitflag).toBeLessThan(2 ** 30);
      world.destroy();
    }
  });
});
