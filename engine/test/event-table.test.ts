/**
 * The event table (features/audio/event-table.ts) against the audio export
 * and against what core actually emits (plans phase 7 §7.5 "event-table"):
 * - every sound id the table lists has a rendered file in audio.json;
 * - the eight test courses (played out by the CourseDriver, through the
 *   course's end) and the stepper's scripts (the flow traces' runs, the
 *   hazard, terrain and warp scenarios with their pokes) emit only kinds and
 *   ids the table has;
 * - every cutscene cue the replay plays itself is in the table.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { EVENT_TABLE } from '../src/game/features/audio/event-table';
import { ownCue, SONG_BASE, type WindowName } from '../src/game/features/cutscene/replay';
import { haveAssets, loadAudio, loadCutscenes } from './assets';
import { haveRules, haveRomTest, loadFlow, loadRomHole } from './fixtures';
import { CourseDriver } from './course-driver';
import { runFlowScript, GAME_OFFSET } from './flow-harness';
import { nextHole } from '../src/core/actions';
import type { GameEvent } from '../src/core/events';

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
});

function offTable(events: GameEvent[]): string[] {
  const bad = new Set<string>();
  for (const e of events) {
    const row = EVENT_TABLE[e.kind];
    if (!row) bad.add(`unknown kind ${e.kind}`);
    else if (row.ids.length === 0 ? e.romSfx !== -1 : !row.ids.includes(e.romSfx)) bad.add(`${e.kind} ${e.romSfx}`);
  }
  return [...bad];
}

describe.skipIf(!haveAssets)('the event table vs audio.json', () => {
  it('every effect and song id the table lists has a file', () => {
    const audio = loadAudio();
    for (const [kind, row] of Object.entries(EVENT_TABLE)) {
      for (const id of row.ids) {
        if (row.react === 'sfx') expect(audio.sfx[String(id)], `${kind} sfx ${id}`).toBeDefined();
        if (row.react === 'song' && id !== 0) expect(audio.songs[String(id)], `${kind} song ${id}`).toBeDefined();
      }
    }
  });

  it("the cutscenes' own cues are in the table", () => {
    const cs = loadCutscenes();
    for (const [name, w] of Object.entries(cs.windows)) {
      for (const cue of w.cues) {
        if (!ownCue(name as WindowName, cue)) continue;
        if (cue[1] === 'song') expect(EVENT_TABLE.song.ids, `${name} song ${cue[2]}`).toContain(cue[2] - SONG_BASE);
        else expect(EVENT_TABLE.cue.ids, `${name} sfx ${cue[2]}`).toContain(cue[2]);
      }
    }
  });
});

describe.skipIf(!haveRules)('what core emits is in the table', () => {
  it('the eight test courses, played to the course\'s end', () => {
    const d = new CourseDriver();
    worlds.push(d.world);
    for (let i = 0; i < 8; i++) {
      d.playHole();
      nextHole(d.world);
      d.step(5);
    }
    expect(d.phase).toBe('CourseDone');
    expect(offTable(d.events)).toEqual([]);
  });

  const scripts: Array<{ name: string; to: number; hole?: number; offset?: number; pokes?: boolean }> = [
    { name: 'web_flow', to: 4700 }, { name: 'web_fly', to: 4400 }, { name: 'web_fly_spin', to: 4400 },
    { name: 'web_curve', to: 3700 }, { name: 'web_hole', to: 4700 }, { name: 'web_tomatoes', to: 5200 },
    { name: 'web_ui', to: 3300 },
    { name: 'web_haz80', to: 2760, hole: 3, offset: 2336, pokes: true },
    { name: 'web_haz98', to: 2496, hole: 4, offset: 2332, pokes: true },
    { name: 'web_haz94', to: 2571, hole: 11, offset: 2332, pokes: true },
    { name: 'web_hazad', to: 2799, hole: 54, offset: 2337, pokes: true },
    { name: 'web_hazac', to: 2799, hole: 54, offset: 2337, pokes: true },
    { name: 'web_arrow', to: 3000, hole: 1, offset: 2332, pokes: true },
    { name: 'web_ramps', to: 3000, hole: 1, offset: 2332, pokes: true },
    { name: 'web_step', to: 3000, hole: 2, offset: 2333, pokes: true },
    { name: 'web_warp', to: 2800, hole: 3, offset: 2336, pokes: true },
    { name: 'web_warp_fly', to: 2800, hole: 3, offset: 2336, pokes: true },
    { name: 'web_snap', to: 2560, hole: 54, offset: 2338, pokes: true },
    { name: 'web_snap_land', to: 2560, hole: 54, offset: 2338, pokes: true },
    { name: 'web_snap_back', to: 2560, hole: 29, offset: 2340, pokes: true },
    { name: 'web_snap_fast', to: 2520, hole: 29, offset: 2340, pokes: true },
    { name: 'web_snap_east', to: 2520, hole: 62, offset: 2342, pokes: true },
    ...['roll', 'drop', 'shallow', 'skim', 'climb', 'skip', 'skip_back', 'mod']
      .map((n) => ({ name: `web_water_${n}`, to: 2660, hole: 6, offset: 2332, pokes: true })),
    { name: 'web_water_shot', to: 3640, hole: 6 },
  ];
  for (const s of scripts) {
    it.skipIf(!haveRomTest || !loadFlow(s.name) || (s.hole !== undefined && !loadRomHole(s.hole)))(`${s.name}`, () => {
      const run = runFlowScript(s.name, s.to - (s.offset ?? GAME_OFFSET), { hole: s.hole, offset: s.offset, pokes: s.pokes });
      worlds.push(run.world);
      expect(run.emitted.length).toBeGreaterThan(0);
      expect(offTable(run.emitted)).toEqual([]);
    });
  }
});
