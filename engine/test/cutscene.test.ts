/**
 * The cutscene replay (features/cutscene/replay.ts) against the recording it
 * is made from (build/web-test/cutscene_hole0.json, tools/snesstep/
 * trace_cutscene.py over c1n), and the anchors the engine computes against
 * the ones the export recorded (plans phase 7 §7.5 "cutscene").
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { createGameWorld } from '../src/core/world';
import { startCourse } from '../src/core/actions';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { BallScreen } from '../src/core/traits/pose';
import { activePlayer } from '../src/core/traits/player';
import { Course, courseEntity } from '../src/core/traits/course';
import { cellCorner, kirbyPoint, teePad, teePadPoint } from '../src/game/bridge/placement';
import {
  cueEvents, outroIndex, ownCue, replayFrame, INTRO_CORE_AT, OUTRO_ARRIVAL, type WindowName,
} from '../src/game/features/cutscene/replay';
import { haveAssets, loadCutscenes, loadHoleCourse } from './assets';
import { haveRules, loadTables, readJson } from './fixtures';
import { GAME_OFFSET } from './flow-harness';

const here = fileURLToPath(new URL('.', import.meta.url));
const tracePath = resolve(here, '../../build/web-test/cutscene_hole0.json');
const haveTrace = existsSync(tracePath);

interface TraceFrame {
  f: number;
  scroll: [number, number];
  inidisp: number;
  objs: Array<[number, number, number, number, string]>;
}
interface Trace {
  windows: Record<string, { frames: TraceFrame[] }>;
}

const WORLD_TYPES = new Set([74, 108]);
const TYPES: Record<WindowName, Set<number>> = {
  intro: new Set([104, 105, 106, 107, 108, 109]),
  outro: new Set([74, 108, 128, 129, 132]),
  outroHio: new Set([74, 108, 128, 129, 132, 17, 99, 100, 103, 130, 131]),
};

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
});

describe.skipIf(!haveAssets || !haveRules)('cutscene anchors', () => {
  it('hole 1: the tee pad and the cup ring land where the recorded run had them', () => {
    const rules = new RomRules(loadTables());
    const world = createGameWorld();
    worlds.push(world);
    startCourse(world, rules, [fromRomCourse(loadHoleCourse(0))]);
    const course = courseEntity(world).get(Course)!;
    const kirby = kirbyPoint(course, activePlayer(world).get(BallScreen)!);
    const { anchors } = loadCutscenes();
    // the intro's camera [-128, -111] from the tee pad is the hole's start
    // camera (Kirby at screen (128, 112)): the pad is Kirby's point, 1 px up
    expect(teePadPoint(kirby)).toEqual({ x: anchors.tee[0], y: anchors.tee[1] });
    expect(teePad(rules, course)).toEqual({ x: anchors.tee[0], y: anchors.tee[1] });
    // c1n's cup was the enemy at (6, 5); the ring sits at its cell's corner
    expect(cellCorner(rules, course, 6, 5)).toEqual({ x: anchors.cup[0], y: anchors.cup[1] });
  });
});

describe.skipIf(!haveAssets || !haveTrace)('cutscene replay vs the recording', () => {
  const trace = haveTrace ? readJson<Trace>(tracePath) : null;
  for (const name of ['intro', 'outro', 'outroHio'] as WindowName[]) {
    it(`${name}: every sprite where the game drew it, on every lit frame`, () => {
      const cs = loadCutscenes();
      const w = cs.windows[name];
      const anchors = { tee: { x: cs.anchors.tee[0], y: cs.anchors.tee[1] }, cup: { x: cs.anchors.cup[0], y: cs.anchors.cup[1] } };
      const byFrame = new Map(trace!.windows[name].frames.map((fr) => [fr.f, fr]));
      let checked = 0;
      for (let i = 0; i < w.length; i++) {
        if (w.brightness[i] === 0) continue; // the camera before the first lit frame is filled in
        const fr = byFrame.get(w.recorded[0] + i)!;
        const r = replayFrame(w, i, anchors);
        expect(r.scroll, `${name} ${i} scroll`).toEqual({ x: fr.scroll[0], y: fr.scroll[1] });
        const want = fr.objs.filter((o) => TYPES[name].has(o[0])).map(([typ, , x, y, pic]) =>
          // world types keep world coordinates; the others screen ones
          `cs_${pic}@${WORLD_TYPES.has(typ) ? x : x + fr.scroll[0]},${WORLD_TYPES.has(typ) ? y : y + fr.scroll[1]}`);
        const got = r.sprites.map((s) => `${s.key}@${s.x},${s.y}`);
        expect(got.sort(), `${name} ${i}`).toEqual(want.sort());
        checked += got.length;
      }
      expect(checked).toBeGreaterThan(100);
    });
  }
});

describe.skipIf(!haveAssets)('cutscene timing and cues', () => {
  it('the intro holds the core until game frame 2333, the set-up', () => {
    const w = loadCutscenes().windows.intro;
    expect(w.recorded[0] + INTRO_CORE_AT).toBe(GAME_OFFSET + 1);
    expect(w.recorded[1]).toBe(w.recorded[0] + w.length);
  });

  it('the hole-out index: f - H until the camera arrives, then from 29', () => {
    expect(outroIndex(100, 100, 0)).toBe(0);
    expect(outroIndex(110, 100, 0)).toBe(10);
    expect(outroIndex(200, 100, 0)).toBe(OUTRO_ARRIVAL - 1); // still panning: held
    expect(outroIndex(140, 100, 140)).toBe(OUTRO_ARRIVAL);
    expect(outroIndex(150, 100, 140)).toBe(OUTRO_ARRIVAL + 10);
  });

  it("the outros' songs and $21 are core's; the intro's cues and the outros' other effects are the replay's", () => {
    const cs = loadCutscenes();
    const intro = cueEvents('intro', cs.windows.intro, 0, cs.windows.intro.length, 7);
    expect(intro.filter((e) => e.kind === 'song').map((e) => e.romSfx)).toEqual([11, 11]);
    // another hole's intro plays its own song at the same cues (course 1 hole 5: song 7)
    const five = cueEvents('intro', cs.windows.intro, 0, cs.windows.intro.length, 7, loadHoleCourse(4).song);
    expect(five.filter((e) => e.kind === 'song').map((e) => e.romSfx)).toEqual([7, 7]);
    expect(five.filter((e) => e.kind === 'cue').map((e) => e.romSfx)).toEqual([100, 98, 47]);
    expect(intro.filter((e) => e.kind === 'cue').map((e) => e.romSfx)).toEqual([100, 98, 47]);
    for (const name of ['outro', 'outroHio'] as WindowName[]) {
      const w = cs.windows[name];
      const own = w.cues.filter((c) => ownCue(name, c));
      expect(own.every((c) => c[1] === 'sfx' && c[2] !== 0x21), name).toBe(true);
      expect(own.map((c) => c[2]).sort(), name).toEqual(
        name === 'outro' ? [103, 29] : [103, 29, 45, 62, 62, 62]);
    }
    // core's HoleOut timeline (systems/hole-flow.ts HOLEOUT_*) is the recording's
    const outro = cs.windows.outro;
    expect(outro.cues.find((c) => c[2] === 0x97)![0]).toBe(OUTRO_ARRIVAL + 31);
    expect(outro.cues.find((c) => c[2] === 0x96)![0]).toBe(OUTRO_ARRIVAL + 147);
    expect(outro.length).toBe(OUTRO_ARRIVAL + 410);
    const hio = cs.windows.outroHio;
    expect(hio.cues.find((c) => c[2] === 0x98)![0]).toBe(OUTRO_ARRIVAL + 58);
    expect(hio.cues.find((c) => c[2] === 0x96)![0]).toBe(OUTRO_ARRIVAL + 498);
    expect(hio.length).toBe(OUTRO_ARRIVAL + 760);
  });
});
