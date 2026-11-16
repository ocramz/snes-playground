/**
 * The styled terrain (src/game/features/layers/styled.ts) for holes without
 * bitmaps, against the ROM's own art: course 1's eight holes, drawn from
 * their grids with the exemplar patches of tools/terrain_style.py, must
 * match the exported layers (layer_back + layer_front) pixel for pixel on
 * most of the course. Holes 7 and 8 are water holes: the patches have no
 * water, which the rasteriser draws as a plane in the pond's two colours,
 * so they agree less; hole 8's water is its own layer (layer_front_water,
 * the water switch's), on at the load. Every hole has outline tiles
 * ($28-$2D) the patches do not draw.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables } from './fixtures';
import { readPng } from './png';
import { rasterTerrain, waterWet, type StyledCourse, type TerrainStyle, type TerrainStyleJson } from '../src/game/features/layers/styled';
import { waterRegion } from '../src/core/sim/water';
import { emptyWork } from '../src/core/traits/ball';
import { holeDir } from '../src/game/assets/keys';

const assets = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../build/engine/assets');
const haveStyle = existsSync(resolve(assets, 'terrain_style.json')) && existsSync(resolve(assets, 'terrain_style.png'));
const haveHoles = existsSync(resolve(assets, 'holes/007/layer_back.png'));

function loadStyle(): TerrainStyle {
  return {
    json: JSON.parse(readFileSync(resolve(assets, 'terrain_style.json'), 'utf8')) as TerrainStyleJson,
    atlas: readPng(resolve(assets, 'terrain_style.png')),
  };
}

function flatCourse(w: number, h: number, walls = 0): StyledCourse {
  const n = w * h;
  return {
    w, h,
    shape: new Uint8Array(n).fill(1),
    elev: new Uint8Array(n).fill(1),
    walls: new Uint8Array(n).fill(walls),
    layer2: new Uint8Array(n),
    originY: 200,
  };
}

describe.skipIf(!haveRules || !haveStyle)('the styled terrain', () => {
  const rules = haveRules ? new RomRules(loadTables()) : (null as unknown as RomRules);
  const style = haveStyle ? loadStyle() : (null as unknown as TerrainStyle);

  it('is deterministic', () => {
    const a = rasterTerrain(rules, flatCourse(6, 5), style);
    const b = rasterTerrain(rules, flatCourse(6, 5), style);
    expect(Buffer.from(b.pixels).equals(Buffer.from(a.pixels))).toBe(true);
  });

  it('draws a flat cell with the flat patch, the ROM\'s $020/$021 block', () => {
    const c = flatCourse(5, 5);
    const r = rasterTerrain(rules, c, style);
    const flat = style.json.top['01'];
    // the middle cell (2, 2): its left vertex at its top, elevation 1 + 1
    const ax = 32 * 4;
    const ay = c.originY - 16 * 2 - 32;
    let checked = 0;
    for (let v = 16; v < 48; v++) for (let u = 0; u < 64; u++) {
      const k = ((flat.y + v) * style.atlas.width + flat.x + u) * 4;
      if (style.atlas.data[k + 3] === 0) continue;
      const j = ((ay + v - r.y0) * r.width + (ax + u - r.x0)) * 4;
      expect([r.pixels[j], r.pixels[j + 1], r.pixels[j + 2]]).toEqual([
        style.atlas.data[k], style.atlas.data[k + 1], style.atlas.data[k + 2],
      ]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(900);
  });

  it('the water\'s extent is the region test $82:83DD\'s (sim/water.ts)', () => {
    const w = emptyWork();
    for (let t = 0x60; t < 0x70; t++) {
      for (let xf = 0; xf < 0x10000; xf += 0x0800) for (let yf = 0; yf < 0x10000; yf += 0x0800) {
        w.tile = t;
        w.xf = xf;
        w.yf = yf;
        const wet = waterRegion(w) !== 0;
        expect(waterWet(t, xf, yf), `$${t.toString(16)} ${xf} ${yf}`).toBe(wet);
      }
    }
  });

  it('draws a pond in the water\'s colours, and none with the water switched off at the load', () => {
    const c = flatCourse(5, 5);
    const layer2 = c.layer2 as Uint8Array;
    layer2[12] = 0x61;
    const colours = (r: ReturnType<typeof rasterTerrain>): Set<string> => {
      const s = new Set<string>();
      for (let k = 0; k < r.pixels.length; k += 4) if (r.pixels[k + 3]) s.add(`${r.pixels[k]},${r.pixels[k + 1]},${r.pixels[k + 2]}`);
      return s;
    };
    const wet = colours(rasterTerrain(rules, c, style));
    expect(wet.has('49,132,123')).toBe(true);
    expect(wet.has('156,239,231')).toBe(true);
    layer2[0] = 0x5d; // the water switch with the water off at the load ($82:BC59)
    expect(colours(rasterTerrain(rules, c, style)).has('49,132,123')).toBe(false);
  });

  it('draws the walls into the outline mask, and nothing else there', () => {
    const none = rasterTerrain(rules, flatCourse(4, 4), style);
    expect(none.outline.some((v, i) => (i & 3) === 3 && v !== 0)).toBe(false);
    const fenced = rasterTerrain(rules, flatCourse(4, 4, 0x0f), style);
    expect(fenced.outline.filter((v, i) => (i & 3) === 3 && v !== 0).length).toBeGreaterThan(100);
  });

  it.skipIf(!haveHoles)('matches course 1\'s own art', () => {
    // measured 2026-11-16 (the water plane): 98.4 97.2 97.1 94.8 95.8 93.3 93.5 and hole 8's below
    const want = [0.95, 0.95, 0.95, 0.9, 0.93, 0.9, 0.9, 0.85];
    const got: string[] = [];
    for (let hole = 0; hole < 8; hole++) {
      const dir = resolve(assets, holeDir(hole));
      const cj = JSON.parse(readFileSync(resolve(dir, 'course.json'), 'utf8')) as {
        w: number; h: number; shape: number[]; elev: number[]; walls: number[]; tile: number[]; word7: number;
      };
      const back = readPng(resolve(dir, 'layer_back.png'));
      const front = readPng(resolve(dir, 'layer_front.png'));
      // the water switch's holes draw the water on its own layer, over the front
      const waterPath = resolve(dir, 'layer_front_water.png');
      const water = existsSync(waterPath) ? readPng(waterPath) : null;
      const r = rasterTerrain(rules, {
        w: cj.w, h: cj.h, shape: cj.shape, elev: cj.elev, walls: cj.walls, layer2: cj.tile, originY: cj.word7,
      }, style);
      let both = 0;
      let same = 0;
      for (let y = 0; y < back.height; y++) for (let x = 0; x < back.width; x++) {
        const k = (y * back.width + x) * 4;
        const src = water?.data[k + 3] ? water.data : front.data[k + 3] ? front.data : back.data;
        if (!src[k + 3]) continue;
        const px = x - r.x0;
        const py = y - r.y0;
        if (px < 0 || py < 0 || px >= r.width || py >= r.height) continue;
        const j = (py * r.width + px) * 4;
        if (!r.pixels[j + 3]) continue;
        both += 1;
        if (src[k] === r.pixels[j] && src[k + 1] === r.pixels[j + 1] && src[k + 2] === r.pixels[j + 2]) same += 1;
      }
      const share = same / both;
      got.push(`hole ${hole + 1} ${(100 * share).toFixed(1)}%`);
      expect(share, `hole ${hole + 1}`).toBeGreaterThanOrEqual(want[hole]);
    }
    console.log(`styled vs ROM, identical pixels: ${got.join(', ')}`);
  });
});
