// The intro and the hole-out (src/render/cutscene.ts) against the frames the
// real game drew, recorded by tools/snesstep/trace_cutscene.py on the c1n run
// (build/web-test/cutscene_hole0.json) and exported to build/web/cutscenes.json.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { haveAssets, loadRom, readJson } from '../../../test/load';
import { CutscenePlayer, type CutscenesJson } from '../../render/cutscene';
import { project } from '../../render/projection';
import { HoleSim, emptyPad } from '../hole';
import type { Terrain } from '../terrain';

const here = fileURLToPath(new URL('.', import.meta.url));
const cutPath = resolve(here, '../../../../build/web/cutscenes.json');
const rawPath = resolve(here, '../../../../build/web-test/cutscene_hole0.json');
const haveCuts = haveAssets && existsSync(cutPath) && existsSync(rawPath);

interface RawFrame { f: number; scroll: [number, number]; objs: [number, number, number, number, string][] }
interface Raw { windows: Record<string, { frames: RawFrame[] }> }

/** The ground at a cell's centre, as HoleScene.groundAt has it. */
function ground(t: Terrain, col: number, row: number): number {
  const idx = row * t.w + col;
  const shape = t.shape[idx];
  return shape ? t.surface(shape, t.elev[idx], 0, 0x8000, 0x8000).z : 0;
}

describe.skipIf(!haveCuts)('cutscenes', () => {
  const cuts = haveCuts ? readJson<CutscenesJson>(cutPath) : null!;
  const raw = haveCuts ? readJson<Raw>(rawPath) : null!;

  it('anchors: the demo puts the tee pad and the cup ring where the game had them', () => {
    const { course, terrain } = loadRom();
    const t = course.tee!;
    const tee = project(course.word7, t.x, 0x8000, t.y, 0x8000, ground(terrain, t.x, t.y));
    expect([tee.x, tee.y - 1]).toEqual(cuts.anchors.tee); // HoleScene draws the tee 1 px up
    // the cup of the recorded run was the enemy at (6, 5); enemies sit at their cell corner
    const cup = project(course.word7, 6, 0, 5, 0, ground(terrain, 6, 5));
    expect([cup.x, cup.y]).toEqual(cuts.anchors.cup);
    expect(course.enemies.some((e) => e.x === 6 && e.y === 5)).toBe(true);
  });

  it('every frame shows what the game showed, at the screen position it had', () => {
    const anchors: [number, number][] = [cuts.anchors.tee, cuts.anchors.cup];
    for (const name of ['intro', 'outro', 'outroHio'] as const) {
      const win = cuts.windows[name];
      const rec = new Map(raw.windows[name].frames.map((f) => [f.f, f]));
      const p = new CutscenePlayer(win, anchors);
      let n = 0;
      while (!p.done) {
        const t = p.t;
        const f = p.next();
        const r = rec.get(win.recorded[0] + t)!;
        // the camera: the scroll, except under the blanked screen before the fade-in
        if (f.brightness > 0) expect([f.scrollX, f.scrollY], `${name} ${r.f} scroll`).toEqual(r.scroll);
        const shown = new Set(f.sprites.map((s) => `${s.frame}@${s.x - r.scroll[0]},${s.y - r.scroll[1]}`));
        // screen-space objects: their stored position is the screen; 74 and 108 keep world positions
        const want = r.objs
          .filter((o) => f.sprites.some((s) => s.frame === 'cs_' + o[4]))
          .map((o) => (o[0] === 74 || o[0] === 108
            ? `cs_${o[4]}@${o[2] - r.scroll[0]},${o[3] - r.scroll[1]}`
            : `cs_${o[4]}@${o[2]},${o[3]}`));
        for (const w of want) expect(shown.has(w), `${name} ${r.f} ${w}`).toBe(true);
        n += want.length;
      }
      expect(n).toBeGreaterThan(win.length / 2);
    }
  });

  it('the hole-out at another cup moves with it', () => {
    const win = cuts.windows.outro;
    const a = new CutscenePlayer(win, [cuts.anchors.tee, cuts.anchors.cup]);
    const b = new CutscenePlayer(win, [cuts.anchors.tee, [cuts.anchors.cup[0] + 64, cuts.anchors.cup[1] - 32]]);
    const fa = a.frameAt(300), fb = b.frameAt(300);
    expect(fb.scrollX - fa.scrollX).toBe(64);
    expect(fb.scrollY - fa.scrollY).toBe(-32);
    // the star and Kirby stay where they were on the screen
    const star = (f: typeof fa) => f.sprites.filter((s) => s.z >= 0).map((s) => [s.x - f.scrollX, s.y - f.scrollY]);
    expect(star(fb)).toEqual(star(fa));
  });

  it('the intro hands over to the aim stage with the camera where the game starts its aim pan', () => {
    const { rom, course } = loadRom();
    const sim = new HoleSim(rom, course);
    const win = cuts.windows.intro;
    sim.startIntro(win.length);
    const last = new CutscenePlayer(win, [cuts.anchors.tee, cuts.anchors.cup]).frameAt(win.length - 1);
    for (let i = 0; i < win.length; i++) {
      sim.tick({ ...emptyPad(), a: i % 2 === 0 }); // nothing answers meanwhile
      expect(sim.stage).toBe('intro');
      expect([sim.camera.scrollX, sim.camera.scrollY]).toEqual([last.scrollX, last.scrollY]);
    }
    expect(sim.strokes).toBe(0);
    // the game's camera from the frame the aim starts (2337), recorded in the same trace
    const after = raw.windows.intro.frames.filter((f) => f.f >= win.recorded[1]).map((f) => f.scroll);
    const got: [number, number][] = [];
    for (let i = 0; i < after.length; i++) {
      sim.tick(emptyPad());
      got.push([sim.camera.scrollX, sim.camera.scrollY]);
    }
    expect(sim.stage).toBe('aim');
    expect(got).toEqual(after);
  });
});
