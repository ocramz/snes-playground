/**
 * The cutscene director in the host frame (features/cutscene/director.ts,
 * bridge/frame-loop.ts), on ROM hole 1:
 * - the intro holds the core for INTRO_CORE_AT ticks, then the set-up runs
 *   under the intro's last frames; the hole's song is the intro's cue;
 * - web_hole.txt plays the hole out: the hole-out starts when the ball has
 *   sunk, with core's holed effect $21, as the recording's index 2,
 *   reaches index 29 on core's arrival C, and core's songs and HoleOver land
 *   on the recording's indices (25 at 60, 24 at 176, HoleOver after 438);
 *   the replay adds $1D and $67 at their indices.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { createGameWorld } from '../src/core/world';
import { startCourse } from '../src/core/actions';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { Time } from '../src/core/traits/time';
import { HoleFlow } from '../src/core/traits/flow';
import { Course, courseEntity } from '../src/core/traits/course';
import { Cell, IsCup } from '../src/core/traits/hole';
import type { GameEvent } from '../src/core/events';
import { runHostFrame } from '../src/game/bridge/frame-loop';
import { CoreHistory } from '../src/game/bridge/history';
import { cellCorner, teePad } from '../src/game/bridge/placement';
import { CutsceneDirector } from '../src/game/features/cutscene/director';
import { INTRO_CORE_AT, OUTRO_ARRIVAL, type Anchors } from '../src/game/features/cutscene/replay';
import { heldAt, parseInputScript } from './input-script';
import { haveRules, haveRomTest, inputScriptPath, loadRomCourse, loadTables } from './fixtures';
import { haveAssets, loadCutscenes } from './assets';
import { GAME_OFFSET } from './flow-harness';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
});

function setUp(): { world: World; director: CutsceneDirector; rules: RomRules } {
  const rules = new RomRules(loadTables());
  const world = createGameWorld();
  worlds.push(world);
  startCourse(world, rules, [fromRomCourse(loadRomCourse())]);
  const anchors = (): Anchors | null => {
    const c = courseEntity(world).get(Course)!;
    const cup = world.queryFirst(IsCup);
    const cell = cup?.get(Cell);
    return { tee: teePad(rules, c), cup: cell ? cellCorner(rules, c, cell.x, cell.y) : { x: 0, y: 0 } };
  };
  return { world, director: new CutsceneDirector(loadCutscenes(), anchors), rules };
}

describe.skipIf(!haveAssets || !haveRules || !haveRomTest)('the cutscene director', () => {
  it('the intro holds the core 164 ticks, the set-up runs under its last frames, and it cues the hole song', () => {
    const { world, director } = setUp();
    expect(director.startIntro()).toBe(true);
    const history = new CoreHistory();
    const events: GameEvent[] = [];
    const host = (n: number): void => {
      events.push(...runHostFrame(world, n, {
        readPad: () => 0,
        history,
        beforeTick: (w) => director.beforeTick(w),
        afterTick: (w, ran) => director.afterTick(w, ran),
        takeCues: () => director.takeCues(),
      }));
    };
    const f0 = world.get(Time)!.frame;
    host(INTRO_CORE_AT);
    expect(world.get(Time)!.frame).toBe(f0); // held
    expect(director.active).toBe('intro');
    host(1);
    expect(world.get(Time)!.frame).toBe(f0 + 1);
    expect(world.get(HoleFlow)!.phase).toBe('ShotSetup');
    host(3);
    expect(director.active).toBe('intro');
    host(1);
    expect(director.active).toBeNull(); // 168 frames
    expect(history.ticks).toBe(169);
    const songs = events.filter((e) => e.kind === 'song').map((e) => e.romSfx);
    expect(songs).toEqual([11, 11]);
    expect(events.filter((e) => e.kind === 'cue').map((e) => e.romSfx)).toEqual([100, 98, 47]);
  });

  it('web_hole: the hole-out follows core from the holed frame to HoleOver', () => {
    const { world, director } = setUp();
    const script = parseInputScript(readFileSync(inputScriptPath('web_hole'), 'utf8'));
    const events: GameEvent[] = [];
    const index = new Map<number, number>();
    let holed = -1;
    let over = -1;
    let c = -1;
    for (let i = 0; i < 4800 - GAME_OFFSET && over < 0; i++) {
      events.push(...runHostFrame(world, 1, {
        readPad: (w) => heldAt(script, w.get(Time)!.frame + 1 + GAME_OFFSET),
        beforeTick: (w) => director.beforeTick(w),
        afterTick: (w, ran) => {
          director.afterTick(w, ran);
          const f = w.get(Time)!.frame;
          if (director.active) index.set(f, director.position.index);
          if (holed < 0 && director.active) holed = f;
          if (over < 0 && w.get(HoleFlow)!.phase === 'HoleOver') over = f;
          if (w.get(HoleFlow)!.phase === 'HoleOut' && w.get(HoleFlow)!.length > 0) c = w.get(HoleFlow)!.since + w.get(HoleFlow)!.length;
        },
        takeCues: () => director.takeCues(),
      }));
    }
    expect(holed).toBeGreaterThan(0);
    expect(director.active).toBe('outro');
    const at = (kind: string, id: number): number => events.find((e) => e.kind === kind && e.romSfx === id)!.frame;
    expect(at('holed', 0x21)).toBe(holed);
    expect(index.get(holed)).toBe(2);
    expect(index.get(c)).toBe(OUTRO_ARRIVAL);
    expect(index.get(c - 1)).toBeLessThan(OUTRO_ARRIVAL);
    expect(index.get(at('song', 25))).toBe(60);
    expect(index.get(at('song', 24))).toBe(176);
    expect(index.get(over - 1)).toBe(438);
    expect(index.get(at('cue', 29))).toBe(215);
    expect(index.get(at('cue', 103))).toBe(301);
    expect(events.filter((e) => e.kind === 'cue').map((e) => e.romSfx)).toEqual([29, 103]);
  });
});
