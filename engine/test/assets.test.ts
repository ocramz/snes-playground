/**
 * Integrity of the asset pipeline's output (the `assets` row of the plan's
 * verification list). Still to come with their subsystems: every
 * `Visual.kind` resolving to a texture/clip (the view catalog) and every
 * event kind's `romSfx` resolving to an audio key (the event table).
 */
import { describe, expect, it } from 'vitest';
import { haveRules, loadTables } from './fixtures';
import {
  assetExists,
  exportedHoles,
  haveAssets,
  loadAtlas,
  loadAudio,
  loadCutscenes,
  loadHoleCourse,
  loadHoleLayers,
  loadManifest,
  loadUi,
} from './assets';
import { holeDir } from '../src/game/assets/keys';

/**
 * The hole songs of courses 1-8, `$80:C99D`[course] -> [hole] - $7E (the
 * plan's table; emulated on the whole-game replay, notes/port-v2-phase1-courses.md).
 */
const HOLE_SONGS = [
  [11, 11, 11, 11, 7, 7, 7, 13],
  [6, 6, 6, 6, 6, 6, 6, 13],
  [11, 11, 11, 11, 11, 11, 11, 13],
  [14, 14, 14, 14, 14, 14, 14, 13],
  [10, 10, 10, 10, 8, 8, 8, 13],
  [9, 9, 9, 9, 9, 9, 9, 13],
  [10, 10, 11, 11, 6, 6, 6, 13],
  [12, 12, 12, 12, 12, 12, 12, 13],
];

const has = (tiles: number[], lo: number, hi: number): boolean => tiles.some((t) => t >= lo && t <= hi);

describe.skipIf(!haveAssets)('build/engine/assets', () => {
  describe('sprite atlas', () => {
    it('every clip frame exists in the atlas, with a positive duration', () => {
      const atlas = loadAtlas();
      for (const [name, clip] of Object.entries(atlas.clips)) {
        expect(clip.frames.length, name).toBeGreaterThan(0);
        for (const { f, d } of clip.frames) {
          expect(atlas.frames[f], `${name} -> ${f}`).toBeDefined();
          expect(d, `${name} -> ${f}`).toBeGreaterThanOrEqual(1);
        }
        expect(clip.loopStart, name).toBeLessThan(clip.frames.length);
        // next is an animation state number (kirbyanim's next_state), not a clip
        if (clip.next !== null) expect(clip.next, `${name}.next`).toBeGreaterThanOrEqual(0);
      }
    });

    it('every frame rect lies inside the atlas image', () => {
      const atlas = loadAtlas();
      const [w, h] = atlas.size;
      for (const [name, f] of Object.entries(atlas.frames)) {
        expect(f.x, name).toBeGreaterThanOrEqual(0);
        expect(f.y, name).toBeGreaterThanOrEqual(0);
        expect(f.x + f.w, name).toBeLessThanOrEqual(w);
        expect(f.y + f.h, name).toBeLessThanOrEqual(h);
      }
      expect(assetExists(atlas.image)).toBe(true);
    });

    it('has the clips the Pose trait drives and the hole-1 objects', () => {
      const { clips } = loadAtlas();
      for (const name of [
        'ball_roll', 'ball_sink', 'hop_ground', 'hop_air',
        'enemy_idle', 'star', 'cup_open',
        'aim_facing0', 'aim_facing7',
        'curl_into_ball_angle00', 'curl_into_ball_angle15',
        'tired_health0', 'tired_health2',
      ]) {
        expect(clips[name], name).toBeDefined();
      }
    });
  });

  describe('shot-panel sprites (ui.json)', () => {
    it('frames lie inside the image and the measured timing is pinned', () => {
      const ui = loadUi();
      const [w, h] = ui.size;
      for (const [name, f] of Object.entries(ui.frames)) {
        expect(f.x + f.w, name).toBeLessThanOrEqual(w);
        expect(f.y + f.h, name).toBeLessThanOrEqual(h);
      }
      // measured (docs/web-demo.md): "1" at +46, panel at +66, ready +70,
      // meter starts 5 frames after the spin-stage A
      expect(ui.timing.one).toBe(46);
      expect(ui.timing.panel).toBe(66);
      expect(ui.timing.ready).toBe(70);
      expect(ui.timing.meterStart).toBe(5);
      expect(assetExists(ui.image)).toBe(true);
    });
  });

  describe('audio.json', () => {
    it('has a looping music track and lists only files that exist', () => {
      const audio = loadAudio();
      expect(audio.music.loopStart).toBeLessThan(audio.music.loopEnd!);
      for (const entry of [audio.music, ...Object.values(audio.songs)]) {
        // a song without loop points (17, 18: they play once) has neither
        if (entry.loopStart !== undefined) expect(entry.loopStart).toBeLessThanOrEqual(entry.loopEnd!);
        expect(assetExists(entry.file), entry.file).toBe(true);
      }
      for (const file of Object.values(audio.sfx)) {
        expect(assetExists(file), file).toBe(true);
      }
    });

    it('covers the hole songs, the asleep and fall songs and the hole-out songs', () => {
      const { songs } = loadAudio();
      expect(Object.keys(songs).map(Number).sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 24, 25, 26]);
    });
  });

  describe('cutscenes.json', () => {
    it('has the intro and both hole-outs, anchored, with cues the audio map covers', () => {
      const cutscenes = loadCutscenes();
      expect(cutscenes.anchors.tee).toHaveLength(2);
      expect(cutscenes.anchors.cup).toHaveLength(2);
      expect(Object.keys(cutscenes.windows).sort()).toEqual(['intro', 'outro', 'outroHio']);
      const audio = loadAudio();
      for (const [name, w] of Object.entries(cutscenes.windows)) {
        expect(['tee', 'cup'], name).toContainEqual(w.anchor);
        expect(w.length, name).toBeGreaterThan(0);
        expect(w.camera, name).toHaveLength(w.length);
        for (const [f, kind, id] of w.cues) {
          expect(f, name).toBeGreaterThanOrEqual(0);
          if (kind === 'song') {
            // cue ids are the APU request id $7E + n; song 0 ($7E) is the
            // silent carrier that stops the music, deliberately not exported
            const n = id - 0x7e;
            if (n !== 0) expect(audio.songs[String(n)], `${name} song ${id}`).toBeDefined();
          } else {
            expect(audio.sfx[String(id)], `${name} sfx ${id}`).toBeDefined();
          }
        }
      }
    });

    it('records the night palette as a full CGRAM pair', () => {
      const { nightPalette } = loadCutscenes();
      expect(nightPalette.day).toHaveLength(512);
      expect(nightPalette.night).toHaveLength(512);
    });
  });

  describe('the shipped ROM holes', () => {
    it('the manifest lists courses 1-8, eight holes each, by ROM index', () => {
      const courses = loadManifest().courses ?? [];
      expect(courses.map((c) => c.course)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      for (const c of courses) {
        expect(c.holes.map((h) => h.index), `course ${c.course + 1}`).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((h) => c.course * 8 + h));
        for (const h of c.holes) expect(h.dir).toBe(holeDir(h.index));
      }
    });

    it('course.json is rectangular and layers.json names files that exist', () => {
      for (const index of exportedHoles()) {
        const course = loadHoleCourse(index);
        const dir = holeDir(index);
        expect(course.index, dir).toBe(index);
        expect(course.shape, dir).toHaveLength(course.w * course.h);
        expect(course.elev, dir).toHaveLength(course.w * course.h);
        expect(course.walls, dir).toHaveLength(course.w * course.h);
        expect(course.tile, dir).toHaveLength(course.w * course.h);
        const layers = loadHoleLayers(index);
        for (const file of Object.keys(layers.files)) {
          expect(assetExists(`${dir}/${file}`), `${dir}/${file}`).toBe(true);
        }
      }
    });

    it("each hole's song is its course's list's, and audio.json has it", () => {
      const { songs } = loadAudio();
      for (const index of exportedHoles()) {
        const song = loadHoleCourse(index).song;
        expect(song, `hole ${index}`).toBe(HOLE_SONGS[index >> 3]?.[index & 7]);
        expect(songs[String(song)], `hole ${index} song ${song}`).toBeDefined();
      }
    });

    it('the palette cycles follow the tiles: ripple, boost, warp or snap panels', () => {
      for (const index of exportedHoles()) {
        const { tile } = loadHoleCourse(index);
        const layers = loadHoleLayers(index);
        const cycles = layers.cycles ?? [];
        const course = index >> 3;
        const want: string[] = [];
        // $82:BCD7: the boost panels first, then the water
        if (has(tile, 0x30, 0x3b)) want.push('boost');
        else if (has(tile, 0x60, 0x6f)) want.push('ripple');
        // $82:BD29: the snap tiles first, then the warp panels
        if (has(tile, 0x18, 0x1b) || has(tile, 0xb0, 0xb9)) want.push('panels');
        expect(cycles.map((c) => c.name), `hole ${index}`).toEqual(want);
        for (const c of cycles) {
          const overlays = Object.keys(layers.files).filter((f) => new RegExp(`^layer_(back|front)_${c.name}\\d\\.png$`).test(f));
          expect(overlays.length, `hole ${index} ${c.name} overlays`).toBeGreaterThan(0);
          for (const f of overlays) expect(c.order, `${index} ${f}`).toContain(Number(f.slice(-5, -4)));
          if (c.name === 'ripple') {
            // $84:84AF[$6A5C]: E030 + $120 per course, A B A C every 8 frames
            expect(c.colours[0], `hole ${index}`).toBe(`$98:${(0xe030 + 0x120 * course).toString(16).toUpperCase()}`);
            expect(c.order).toEqual([0, 1, 0, 2]);
            expect(c.stepFrames).toBe(8);
          } else if (c.name === 'boost') {
            expect(c.colours).toEqual(['$98:C200', '$98:C208', '$98:C210', '$98:C218']);
            expect(c.stepFrames).toBe(4);
          } else {
            const snap = has(tile, 0x18, 0x1b);
            expect(c.object, `hole ${index}`).toBe(snap ? 115 : 114);
            expect(c.colours).toEqual(['$98:DCDA', '$98:DCE4', '$98:DCEE', '$98:DCD0']);
            expect(c.stepFrames, `hole ${index}`).toBe(snap ? 4 : 8);
          }
        }
      }
    });

    it('course 1 keeps its ripple holes (7 and 8) and its panels holes (4, 6 and 8)', () => {
      const names = (i: number): string[] => (loadHoleLayers(i).cycles ?? []).map((c) => c.name);
      expect([0, 1, 2, 3, 4, 5, 6, 7].map(names)).toEqual([[], [], [], ['panels'], [], ['panels'], ['ripple'], ['ripple', 'panels']]);
    });
  });
});

describe.skipIf(!haveRules)('the outline pulse in tables.json', () => {
  it('is 15 colours from $98:D3E6 and a 30-step walk inside the table', () => {
    const tables = loadTables() as Record<string, { source: string; values: number[] }>;
    const colours = tables.outlineColours;
    expect(colours.source).toBe('$98:D3E6');
    expect(colours.values).toHaveLength(15);
    const walk = tables.outlineWalk.values;
    expect(walk).toHaveLength(30);
    for (const i of walk) {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(colours.values.length);
    }
  });

  it("has object 111's second colour: 4 colours from $98:D4C8, 1 2 3 2 1 0 every 6 frames", () => {
    const tables = loadTables() as Record<string, { source: string; values: number[]; stepFrames?: number }>;
    expect(tables.glowColours.source).toBe('$98:D4C8');
    expect(tables.glowColours.values).toEqual([0x0019, 0x18d7, 0x253b, 0x295e]);
    expect(tables.glowWalk.values).toEqual([1, 2, 3, 2, 1, 0]);
    expect(tables.glowWalk.stepFrames).toBe(6);
  });
});
