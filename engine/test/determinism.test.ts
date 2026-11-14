/**
 * The host frame is deterministic (plans/port_v1_koota_phaser4.md
 * "Verification": determinism): splitting the same core frames into host
 * frames of 1, 2 or 3 (and a mixed pattern) gives the same world and the same
 * event list, drained once per host frame (bridge/frame-loop.ts).
 *
 * - ROM hole 1 played out by web_hole.txt, the stepper's input script, to
 *   HoleOver;
 * - test course t1 played by a pad policy that reads the world (the aim, a
 *   spin-stage A, a weak meter), as the browser's player would.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { createGameWorld } from '../src/core/world';
import { startCourse } from '../src/core/actions';
import { RomRules } from '../src/core/rules';
import { fromRomCourse, type CourseData } from '../src/core/course-data';
import { Time } from '../src/core/traits/time';
import { HoleFlow } from '../src/core/traits/flow';
import { runHostFrame } from '../src/game/bridge/frame-loop';
import { CoreHistory } from '../src/game/bridge/history';
import { heldAt, parseInputScript } from './input-script';
import { haveRules, haveRomTest, inputScriptPath, loadRomCourse, loadTables } from './fixtures';
import { GAME_OFFSET, sample } from './flow-harness';
import { loadTestCourses } from './course-driver';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
});

interface Outcome {
  state: Record<string, number>;
  phase: string;
  frame: number;
  events: string[];
}

function play(course: CourseData, frames: number, pattern: number[], readPad: (w: World) => number): Outcome {
  const rules = new RomRules(loadTables());
  const world = createGameWorld();
  worlds.push(world);
  startCourse(world, rules, [course]);
  const history = new CoreHistory();
  const events: string[] = [];
  let done = 0;
  for (let i = 0; done < frames; i++) {
    const n = Math.min(pattern[i % pattern.length], frames - done);
    // an entity id packs its world's number, so only whether there is a subject compares
    for (const e of runHostFrame(world, n, { readPad, history })) events.push(`${e.frame}:${e.kind}:${e.romSfx}:${e.subject !== 0}`);
    done += n;
  }
  return { state: sample(world), phase: world.get(HoleFlow)!.phase, frame: world.get(Time)!.frame, events };
}

const PATTERNS = [[2], [3], [1, 3, 2, 4]];

describe.skipIf(!haveRules || !haveRomTest)('the host frame splits', () => {
  it('ROM hole 1 by web_hole.txt: the same world and events in host frames of 1, 2, 3 and mixed', () => {
    const script = parseInputScript(readFileSync(inputScriptPath('web_hole'), 'utf8'));
    const readPad = (w: World): number => heldAt(script, w.get(Time)!.frame + 1 + GAME_OFFSET);
    const course = fromRomCourse(loadRomCourse());
    const frames = 4700 - GAME_OFFSET;
    const one = play(course, frames, [1], readPad);
    expect(one.events.length).toBeGreaterThan(20);
    expect(one.events.some((e) => e.includes(':holed:'))).toBe(true);
    for (const p of PATTERNS) {
      const other = play(course, frames, p, readPad);
      expect(other.frame, `pattern ${p}`).toBe(one.frame);
      expect(other.phase, `pattern ${p}`).toBe(one.phase);
      expect(other.state, `pattern ${p}`).toEqual(one.state);
      expect(other.events, `pattern ${p}`).toEqual(one.events);
    }
  });

  it('test course t1 by a pad policy: the same world and events', () => {
    const rules = new RomRules(loadTables());
    const t1 = loadTestCourses(rules).find((c) => c.name === 't1-flat')!;
    const policy = (w: World): number => {
      const flow = w.get(HoleFlow)!;
      const t = w.get(Time)!.frame + 1 - flow.since;
      if (flow.phase === 'Aim' && (t === 20 || t === 21)) return 0x0100; // right: turn
      if (flow.phase === 'Aim' && t === 40) return 0x0080;
      if (flow.phase === 'Spin' && t === 60) return 0x0080;
      if (flow.phase === 'Power' && t === 20) return 0x0080;
      return 0;
    };
    const one = play(t1, 1500, [1], policy);
    expect(one.events.some((e) => e.includes(':launch:'))).toBe(true);
    for (const p of PATTERNS) {
      const other = play(t1, 1500, p, policy);
      expect(other.state, `pattern ${p}`).toEqual(one.state);
      expect(other.events, `pattern ${p}`).toEqual(one.events);
    }
  });
});
