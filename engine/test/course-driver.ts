/**
 * A headless player for the test courses (test/hole-flow.test.ts): real
 * shots through the pad, and, during the roll, the ball put where
 * tools/snesstep/autoplay.py's pokes put it (docs/physics.md "Playing a
 * course"):
 * - onto an enemy: airborne, 0.4 cell short of the centre, moving inward
 *   at $2000 a frame, half a step above the enemy's own height;
 * - onto the cup: at the centre ($8000), grounded and still; nothing is
 *   touched once it is holed, the ball sinks on its own.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { World } from 'koota';
import { createGameWorld } from '../src/core/world';
import { runCoreFrame } from '../src/core/schedule';
import { startCourse, placeBall } from '../src/core/actions';
import { drainEvents, type GameEvent } from '../src/core/events';
import { RomRules } from '../src/core/rules';
import { fromAuthoredCourse, type AuthoredCourseJson, type CourseData } from '../src/core/course-data';
import { Pad } from '../src/core/traits/pad';
import { Time } from '../src/core/traits/time';
import { HoleFlow, type FlowPhase } from '../src/core/traits/flow';
import { Cell, EnemyKind, Hover, IsCup, IsEnemy, TakenBy } from '../src/core/traits/hole';
import { Course, courseEntity } from '../src/core/traits/course';
import { Stall } from '../src/core/traits/stall';
import { loadTables } from './fixtures';

const dir = resolve(fileURLToPath(new URL('.', import.meta.url)), '../courses');

export function loadTestCourses(rules: RomRules): CourseData[] {
  return readdirSync(dir).filter((f) => f.endsWith('.course.json')).sort()
    .map((f) => fromAuthoredCourse(JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as AuthoredCourseJson,
      { enemyAbility: rules.table('enemyAbility') }));
}

export interface Logged extends GameEvent {
  /** Frames since the driver started. */
  t: number;
}

export class CourseDriver {
  readonly world: World;
  readonly rules: RomRules;
  readonly events: Logged[] = [];
  /** Buttons held for the next frames. */
  private hold: Array<{ raw: number; frames: number }> = [];
  /** Hold A whenever the RESULT card is up (port_v2 phase 7), so the course goes on by itself. */
  cardButton = true;

  constructor(holes?: CourseData[]) {
    this.rules = new RomRules(loadTables());
    this.world = createGameWorld();
    startCourse(this.world, this.rules, holes ?? loadTestCourses(this.rules));
  }

  get frame(): number {
    return this.world.get(Time)!.frame;
  }

  get phase(): FlowPhase {
    return this.world.get(HoleFlow)!.phase;
  }

  /** Frames since the current phase began. */
  get t(): number {
    return this.frame - this.world.get(HoleFlow)!.since;
  }

  step(n = 1): void {
    for (let i = 0; i < n; i++) {
      let raw = 0;
      if (this.hold.length > 0) {
        raw = this.hold[0].raw;
        if (--this.hold[0].frames <= 0) this.hold.shift();
      } else if (this.phase === 'Card' && this.cardButton) {
        raw = 0x0080; // A on the RESULT card ($83:D48C waits for it held)
      }
      this.world.set(Pad, { ...this.world.get(Pad)!, raw });
      runCoreFrame(this.world);
      for (const ev of drainEvents(this.world)) this.events.push({ ...ev, t: ev.frame });
    }
  }

  press(raw: number, frames = 2): void {
    this.hold.push({ raw, frames });
  }

  /** Step until `pred`, failing after `max` frames. */
  until(pred: () => boolean, max = 5000, what = 'the condition'): void {
    for (let i = 0; i < max; i++) {
      if (pred()) return;
      this.step();
    }
    throw new Error(`${what} not reached in ${max} frames (phase ${this.phase})`);
  }

  untilPhase(phase: FlowPhase, max = 5000): void {
    this.until(() => this.phase === phase, max, phase);
  }

  /**
   * A weak shot from the set-up: A in the aim stage, A to end the spin
   * stage, A two frames into the power stage (meter 2). Returns when the ball
   * rolls.
   */
  shoot(meterAt = 7): void {
    this.untilPhase('Aim');
    this.step(20);
    this.press(0x0080);
    this.untilPhase('Spin');
    this.step(50);
    this.press(0x0080);
    this.untilPhase('Power');
    this.step(meterAt - 1);
    this.press(0x0080);
    this.untilPhase('Rolling');
  }

  private ground(x: number, y: number): number {
    const c = courseEntity(this.world).get(Course)!;
    const i = y * c.w + x;
    return ((c.elev[i] + 1) * 0x5a82) | 0; // the top of a flat cell
  }

  /** Throw the ball into the enemy at (x, y) (it must be on flat ground). */
  hitEnemy(x: number, y: number): void {
    const e = this.enemyAt(x, y);
    const h = e.get(Hover)!.steps * 0x5a82;
    placeBall(this.world, {
      xc: x, xf: 0x8000 - 0x6666, yc: y, yf: 0x8000,
      z: this.ground(x, y) + h + 0x2d41, vx: 0x2000, vy: 0, vz: 0, air: 1,
    });
  }

  /** Set the ball still on the cup's centre. */
  onCup(): void {
    const cup = this.world.queryFirst(IsCup);
    if (cup === undefined) throw new Error('no cup yet');
    const { x, y } = cup.get(Cell)!;
    placeBall(this.world, { xc: x, xf: 0x8000, yc: y, yf: 0x8000, z: this.ground(x, y), vx: 0, vy: 0, vz: 0, air: 0 });
  }

  enemyAt(x: number, y: number): import('koota').Entity {
    for (const e of this.world.query(IsEnemy, Cell)) {
      const c = e.get(Cell)!;
      if (c.x === x && c.y === y) return e;
    }
    throw new Error(`no enemy at ${x},${y}`);
  }

  /** The free enemies' cells in list order. */
  freeEnemies(): Array<{ x: number; y: number }> {
    return this.world.query(IsEnemy, Cell, EnemyKind)
      .filter((e) => !e.has(IsCup) && e.targetFor(TakenBy) === undefined)
      .sort((a, b) => a.get(EnemyKind)!.listIndex - b.get(EnemyKind)!.listIndex)
      .map((e) => ({ ...e.get(Cell)! }));
  }

  /**
   * Play the current hole out the autoplay way: one weak shot, then every
   * free enemy but the last, then the cup; up to HoleOver.
   */
  playHole(): void {
    this.shoot();
    for (const c of this.freeEnemies().slice(0, -1)) {
      this.hitEnemy(c.x, c.y);
      this.until(() => this.world.queryFirst(IsCup) !== undefined || this.enemyAt(c.x, c.y).targetFor(TakenBy) !== undefined, 400, `the take at ${c.x},${c.y}`);
      this.until(() => this.phase === 'Rolling' && this.world.get(Time) !== undefined, 400);
    }
    this.until(() => this.world.queryFirst(IsCup) !== undefined, 400, 'the cup');
    // the reveal stalls the step; wait it out before the next placement
    this.until(() => (this.world.get(HoleFlow)!.phase !== 'Rolling') || this.idle(), 400, 'the reveal');
    this.onCup();
    this.untilPhase('HoleOver', 2000);
  }

  private idle(): boolean {
    return (this.world.get(Stall)!.kind as string) === 'none';
  }
}

