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
  haveAssets,
  loadAtlas,
  loadAudio,
  loadCutscenes,
  loadHoleCourse,
  loadHoleLayers,
  loadUi,
} from './assets';

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

    it('covers the hole song, the asleep and fall songs and the hole-out songs', () => {
      const { songs } = loadAudio();
      expect(Object.keys(songs).sort()).toEqual(['11', '17', '18', '24', '25', '26']);
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

  describe('the eight shipped course-1 holes', () => {
    it('course.json is rectangular and layers.json names files that exist', () => {
      for (let hole = 0; hole < 8; hole++) {
        const course = loadHoleCourse(hole);
        const dir = `holes/0${hole}`;
        expect(course.shape, dir).toHaveLength(course.w * course.h);
        expect(course.elev, dir).toHaveLength(course.w * course.h);
        expect(course.walls, dir).toHaveLength(course.w * course.h);
        expect(course.tile, dir).toHaveLength(course.w * course.h);
        const layers = loadHoleLayers(hole);
        for (const file of Object.keys(layers.files)) {
          expect(assetExists(`${dir}/${file}`), `${dir}/${file}`).toBe(true);
        }
      }
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
});
