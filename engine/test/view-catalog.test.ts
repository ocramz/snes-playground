/**
 * Every name the views draw with exists in the exported atlases (plans
 * phase 7 §7.5 "view-catalog"): each Visual kind core spawns, every clip
 * poseClip can ask for, the hazards' frames, the shot panel's and the
 * guide's pictures, the cutscenes' frames.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { Visual } from '../src/core/traits/visual';
import { KIND_ART, CUP_RING_FRAME, SHADOW_FRAME, enemyClip, hazardFrame, HAZARD_TYPES } from '../src/game/features/catalog-data';
import { CUP_MASK_FRAME } from '../src/game/features/enemies/cup-mask';
import { OBJ63, OBJ64 } from '../src/game/features/warp/warp-frames';
import { SNAP_STAR_FRAMES, SNAP_STAR_TABLE, SNAP_STAR_TYPE } from '../src/game/features/env/snap-star-frames';
import { poseClip, KEEP, ENGINE_POSE_STATES } from '../src/game/features/kirby/pose-clips';
import { panelFrames } from '../src/game/features/shot-panel/panel-layout';
import { exportedHoles, haveAssets, loadAtlas, loadCutscenes, loadHoleCourse, loadObjects, loadUi } from './assets';
import { enemySpecies } from '../src/core/sweep';
import { haveRules, loadTables } from './fixtures';
import { RomRules } from '../src/core/rules';
import { CourseDriver } from './course-driver';
import { nextHole } from '../src/core/actions';

const drivers: CourseDriver[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.world.destroy();
});

function kindsOf(world: World, into: Set<string>): void {
  for (const e of world.query(Visual)) into.add(e.get(Visual)!.kind);
}

describe.skipIf(!haveAssets)('the view catalog vs the atlases', () => {
  it('every kind\'s frame and clip exist (and the ring, the shadow)', () => {
    const atlas = loadAtlas();
    for (const [kind, art] of Object.entries(KIND_ART)) {
      if (art.atlas !== 'atlas') continue;
      if (art.clip) expect(atlas.clips[art.clip], `${kind} clip ${art.clip}`).toBeDefined();
      if (art.frame) expect(atlas.frames[art.frame], `${kind} frame ${art.frame}`).toBeDefined();
    }
    expect(atlas.frames[CUP_RING_FRAME]).toBeDefined();
    expect(atlas.frames[SHADOW_FRAME]).toBeDefined();
    // the cup's rim (object 75): its top-left at the cell corner + (16, 2)
    const mask = atlas.frames[CUP_MASK_FRAME];
    expect(mask).toBeDefined();
    expect([mask.w, mask.h, mask.ox, mask.oy]).toEqual([32, 32, -16, -2]);
  });

  it('the warp\'s objects 63 and 64 have every picture warp-frames names', () => {
    const objects = loadObjects();
    expect(objects).not.toBeNull();
    for (const [type, list] of [[63, OBJ63], [64, OBJ64]] as const) {
      for (const [, table, index] of list) {
        const name = objects!.objects![String(type)]?.frames[table]?.[index];
        expect(name, `${type} ${table}:${index}`).toBeTruthy();
        expect(objects!.frames[name!]).toBeDefined();
      }
    }
  });

  it('the snap panels\' stars (object 62) have their five pictures', () => {
    const objects = loadObjects();
    expect(objects).not.toBeNull();
    const sheet = objects!.objects![String(SNAP_STAR_TYPE)];
    expect(sheet?.tables[SNAP_STAR_TABLE]).toBe('$89:9485');
    for (const index of SNAP_STAR_FRAMES) {
      const name = sheet!.frames[SNAP_STAR_TABLE]?.[index];
      expect(name, `62 ${index}`).toBeTruthy();
      expect(objects!.frames[name!]).toBeDefined();
    }
  });

  it('every clip poseClip names exists, for every state, facing, angle, variant, tomato count and air', () => {
    const { clips } = loadAtlas();
    const missing = new Set<string>();
    for (const state of [...ENGINE_POSE_STATES, 2, 7, 9, 10, 17, 18, 19]) {
      for (let facing = 0; facing < 8; facing++) for (let angle = 0; angle < 16; angle++)
        for (let variant = 0; variant <= 10; variant++) for (let tomatoes = 0; tomatoes <= 4; tomatoes++)
          for (const air of [0, 1]) {
            const c = poseClip({ state, facing, angle, variant, tomatoes, air });
            if (c !== null && c !== KEEP && !clips[c]) missing.add(`${state}:${c}`);
          }
    }
    expect([...missing]).toEqual([]);
    expect(poseClip({ state: 1, facing: 0, angle: 0, variant: 0, tomatoes: 4, air: 0 })).toBeNull();
  });

  it('the hazards have a picture for every spawn tile and thread frame, in the table $84:DD55 gives', () => {
    const objects = loadObjects();
    expect(objects).not.toBeNull();
    const tables = new RomRules(loadTables()).table('hazardFrameTables');
    const frames: Record<number, number> = { 76: 2, 77: 12, 81: 4, 82: 4, 83: 4 };
    const tiles: Record<number, number[]> = {
      76: Array.from({ length: 16 }, (_, i) => 0x80 + i),
      77: Array.from({ length: 8 }, (_, i) => 0x90 + i),
      81: [0xa0], 82: [0xa1], 83: [0xa2],
    };
    for (const type of HAZARD_TYPES) {
      for (const tile of tiles[type]) for (let f = 0; f < frames[type]; f++) {
        const name = hazardFrame(objects, tables, type, tile, f);
        expect(name, `${type} tile ${tile.toString(16)} frame ${f}`).not.toBeNull();
        expect(objects!.frames[name!], name!).toBeDefined();
      }
      expect(hazardFrame(objects, tables, type, tiles[type][0], 0xffff)).toBe(hazardFrame(objects, tables, type, tiles[type][0], 0));
    }
    // the table by tile, against the sheets' sightings (notes/port-v2-phase1-courses.md)
    const table = (type: number, tile: number): string =>
      objects!.objects![String(type)].tables[objects!.objects![String(type)].frames.findIndex((row) => row.includes(hazardFrame(objects, tables, type, tile, 0)!))];
    expect([0x80, 0x84, 0x89, 0x8c].map((t) => table(76, t))).toEqual(['$89:CCA7', '$89:CCAB', '$89:CCAF', '$89:CCB3']);
    expect([0x90, 0x91, 0x92, 0x93, 0x95, 0x96].map((t) => table(77, t))).toEqual(
      ['$89:CC47', '$89:CC5F', '$89:CC77', '$89:CC8F', '$89:CC5F', '$89:CC77']);
  });

  it('every enemy species on the shipped holes has its own idle clip (trace_enemies.py)', () => {
    const atlas = loadAtlas();
    const species = new Set<number>();
    for (const index of exportedHoles()) for (const en of loadHoleCourse(index).enemies) species.add(enemySpecies(en.tile));
    expect(species.size).toBeGreaterThan(10);
    for (const sp of species) {
      const clip = enemyClip(atlas, sp);
      expect(clip, 'species ' + (0x40 + sp).toString(16)).not.toBe('enemy_idle');
      for (const { f } of atlas.clips[clip].frames) expect(atlas.frames[f], clip + ' -> ' + f).toBeDefined();
    }
    // $4C, the hole-1 sheet's species: 8 pictures of 8 frames (every frame of a 400-frame window)
    expect(atlas.clips.enemy_4C_idle.frames.map((x) => x.d)).toEqual([8, 8, 8, 8, 8, 8, 8, 8]);
    expect(enemyClip(atlas, 0x30)).toBe('enemy_idle');
  });

  it('the shot panel and the guide name only ui.json frames; the cutscenes only atlas frames', () => {
    const ui = loadUi();
    for (const f of panelFrames(ui)) expect(ui.frames[f], f).toBeDefined();
    const atlas = loadAtlas();
    const cs = loadCutscenes();
    for (const [name, w] of Object.entries(cs.windows)) {
      for (const row of w.sprites) for (const [key] of row) expect(atlas.frames[key], `${name} ${key}`).toBeDefined();
    }
  });

  it.skipIf(!haveRules)('every Visual kind the test courses spawn, take and reveal is in the catalog', () => {
    const kinds = new Set<string>();
    const d = new CourseDriver();
    drivers.push(d);
    for (let i = 0; i < 8; i++) {
      kindsOf(d.world, kinds);
      d.playHole();
      kindsOf(d.world, kinds);
      nextHole(d.world); // the host's call: the driver's world waits in HoleOver
    }
    for (const k of kinds) expect(KIND_ART[k], k).toBeDefined();
    expect([...kinds].sort()).toEqual(['ball', 'cup', 'enemy', 'hazard', 'pillar', 'star', 'tee']);
  });
});
