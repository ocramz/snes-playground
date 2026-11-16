/**
 * The hazards on the t7 test course (courses/t7-hazards.course.json), as
 * unit checks of what the recorded scenarios (trace-hazards.test.ts) do not
 * reach: the fixed box `$A2` (in no ROM hole: `$82:9858` / `$82:987B`), the
 * isolated track tiles that auto-tile into it (`$82:BA87`), the `$05` tile's
 * throw, and the actors' thread programs from their spawn.
 *
 * Each case shoots from the tee, then puts the ball where it is wanted, the
 * way the trace scenarios poke the game (CourseDriver, placeBall).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CourseDriver, loadTestCourses } from './course-driver';
import { haveRules, loadTables } from './fixtures';
import { RomRules } from '../src/core/rules';
import { courseEntity, Course } from '../src/core/traits/course';
import { BallAir, BallVel } from '../src/core/traits/ball';
import { activePlayer } from '../src/core/traits/player';
import { Pose } from '../src/core/traits/pose';
import { TomatoQueue } from '../src/core/traits/counters';
import { Hazards } from '../src/core/traits/hazards';
import { HURT_POSE } from '../src/core/systems/hazard-reaction';
import { placeBall } from '../src/core/actions';
import { s16 } from '../src/core/fixed';

const STEP = 0x5a82; // one height step: the top of a flat elevation-0 cell

let drivers: CourseDriver[] = [];
afterEach(() => {
  for (const d of drivers) d.world.destroy(); // Koota keeps at most 16 worlds
  drivers = [];
});

function t7(): CourseDriver {
  const rules = new RomRules(loadTables());
  const hole = loadTestCourses(rules).find((c) => c.name === 't7-hazards')!;
  const d = new CourseDriver([hole]);
  drivers.push(d);
  return d;
}

function tile(d: CourseDriver, x: number, y: number): number {
  const c = courseEntity(d.world).get(Course)!;
  return c.layer2[y * c.w + x];
}

/** Roll the ball east on the ground from (x - 1, frac $A000) of row y. */
function rollEastInto(d: CourseDriver, x: number, y: number, vx = 0x0600): void {
  placeBall(d.world, { xc: x - 1, xf: 0xa000, yc: y, yf: 0x8000, z: STEP, vx, vy: 0, vz: 0, air: 0 });
}

/** The sound requests $id since `from` (the box's comes as 'hazard', the $05 tile's as a tail 'tile'). */
function sfx(d: CourseDriver, id: number, from: number): Array<{ t: number; kind: string }> {
  return d.events.filter((e) => e.romSfx === id && e.t >= from).map((e) => ({ t: e.t, kind: e.kind }));
}

describe.skipIf(!haveRules)('the hazards on t7', () => {
  it('auto-tiles the isolated track tiles into the fixed box $A2, whose bumper stands still', () => {
    const d = t7();
    expect(tile(d, 4, 2)).toBe(0xa2); // $80, object 76's
    expect(tile(d, 4, 6)).toBe(0xa2); // $98, no actor
    expect(tile(d, 11, 7)).toBe(0xa2);
    const bumper = d.world.get(Hazards)!.actors.find((a) => a.type === 76)!;
    const at = [bumper.x, bumper.y];
    d.step(300);
    expect(bumper.moving).toBe(false); // $84:DED6: no mover on $A2
    expect([bumper.x, bumper.y]).toEqual(at);
    expect(bumper.frame === 0 || bumper.frame === 1).toBe(true);
  });

  it('bounces a ball rolled into $A2 back and costs a tomato', () => {
    const d = t7();
    d.shoot();
    const from = d.frame;
    const pushed = d.world.get(TomatoQueue)!.pushed;
    rollEastInto(d, 11, 7);
    d.until(() => sfx(d, 0x6f, from).length > 0, 60, 'the hit');
    expect(sfx(d, 0x6f, from)[0].kind).toBe('hazard'); // $82:9C8D
    // $82:9728 brings the speed to $0800 first; the reflect ($82:E6B4, the
    // box's side as a plane) then turns it back and sheds some (the game's
    // web_haz94 on the bobbing box: -1788 -> +1145)
    const v = activePlayer(d.world).get(BallVel)!;
    expect(s16(v.vx)).toBeLessThan(0);
    expect(d.world.get(TomatoQueue)!.pushed).toBe(pushed + 1); // $83:ABC5
    d.step(1);
    expect(activePlayer(d.world).get(Pose)!.state).toBe(HURT_POSE); // $D780 = $14
    // the latch ($6A22) holds while the ball stays in the box: one hit only
    d.step(20);
    expect(sfx(d, 0x6f, from)).toHaveLength(1);
  });

  it('bounces a ball dropped onto $A2 up, at no less than $0300', () => {
    const d = t7();
    d.shoot();
    const from = d.frame;
    // above the box's cube (its centre $3B00 over the ground, half $58E0)
    placeBall(d.world, { xc: 11, xf: 0x8000, yc: 7, yf: 0x8000, z: STEP + 0x3b00 + 0x5a00, vx: 0, vy: 0, vz: 0, air: 1 });
    d.until(() => sfx(d, 0x6f, from).length > 0, 60, 'the landing on the box');
    const e = activePlayer(d.world);
    expect(s16(e.get(BallVel)!.vz)).toBeGreaterThanOrEqual(0x0300); // $82:EF9B
    expect(e.get(BallAir)!.air).not.toBe(0);
  });

  it('throws a ball rolled onto $05 along its heading ($0474, vz $0880)', () => {
    const d = t7();
    d.shoot();
    const from = d.frame;
    const pushed = d.world.get(TomatoQueue)!.pushed;
    rollEastInto(d, 10, 4);
    d.until(() => sfx(d, 0x6f, from).length > 0, 60, 'the $05 tile');
    expect(sfx(d, 0x6f, from)[0].kind).toBe('tile'); // $82:A5A3, the step's tail
    d.step(1); // the reaction ($82:DB9A) runs after the step
    const e = activePlayer(d.world);
    expect(e.get(BallAir)!.air).toBe(1);
    const v = e.get(BallVel)!;
    expect(s16(v.vz)).toBeGreaterThan(0x0800); // $0880, less a frame's gravity at most
    expect(s16(v.vx)).toBeGreaterThan(0x0400); // east, at $0474
    expect(Math.abs(s16(v.vy))).toBeLessThan(0x0040);
    expect(d.world.get(TomatoQueue)!.pushed).toBe(pushed + 1);
  });

  it('runs the actors\' thread programs from their spawn', () => {
    const d = t7();
    const actors = d.world.get(Hazards)!.actors;
    const of = (t: number) => actors.find((a) => a.type === t)!;
    const states = new Map<number, number[]>();
    const bob: number[] = [];
    for (let i = 0; i < 1200; i++) {
      d.step(1);
      for (const t of [81, 82, 83]) {
        const l = states.get(t) ?? [];
        if (l[l.length - 1] !== of(t).dir) l.push(of(t).dir);
        states.set(t, l);
      }
      bob.push(of(77).step);
    }
    // 81 never erupts; 82 and 83 go idle -> erupting -> spewing -> idle
    expect(states.get(81)).toEqual([0]);
    for (const t of [82, 83]) expect(states.get(t)!.slice(0, 4)).toEqual([0, 1, 2, 0]);
    // 77 on $90: 22 steps of 9 ticks, round and round
    expect(new Set(bob).size).toBe(22);
    const firstStep0 = bob.indexOf(0);
    expect(bob[firstStep0 + 22 * 9]).toBe(0);
    expect(bob[firstStep0 + 22 * 9 - 1]).toBe(21);
  });
});
