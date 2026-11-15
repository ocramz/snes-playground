/**
 * The cup reveal's own frames (systems/reveal.ts) on course 1's first four
 * holes, as the autoplay replay (build/emu/autoplay/course1) shows them:
 * the stepper's `--log-pc` on $82:8B5C (the take), $82:8D5A (the pan stage),
 * $82:8C4F (the ring), $82:8C27 (the pan back), $82:8C45 (the end) and
 * $80:B542 (sfx $1C), and a watch on the camera ($38AC/$38AE) and the cup's
 * projection ($ECBB/$ECBD). Measured 2026-11-14 (notes/engine-phase6-holes.md):
 *
 *   hole  take  camera      cup     $ECBB/$ECBD  ring   $1C    97's end  pan back
 *   1     3003  (317,338)   (6,5)   (384,222)    +8     +39    +100      -
 *   2     4344  (566,539)   (3,17)  (672,430)    +8     +39    +100      -
 *   3     5684  (163,466)   (6,7)   (448,318)    +38    +68    +129      +158
 *   4     7123  (602,610)   (6,22)  (928,526)    +43    +73    +134      (not logged)
 *
 * Hole 4's pan stage begins at 7131 but its first pan writes the camera at
 * 7133 (hole 3: 5692, 5693): the game lags a frame there, which the engine
 * does not model (it has no cycle counts), so hole 4 is allowed that frame.
 */
import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../src/core/world';
import { startCourse } from '../src/core/actions';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { Camera } from '../src/core/traits/camera';
import { Cell, IsEnemy } from '../src/core/traits/hole';
import { drainEvents } from '../src/core/events';
import { startReveal, tickReveal } from '../src/core/systems/reveal';
import { Reveal } from '../src/core/traits/reveal';
import { haveRules, loadRomHole, loadTables } from './fixtures';

const CASES = [
  { hole: 0, cam: [317, 338], cup: [6, 5], proj: [384, 222], ring: 8, sfx: 39, end: 100, back: 100 },
  { hole: 1, cam: [566, 539], cup: [3, 17], proj: [672, 430], ring: 8, sfx: 39, end: 100, back: 100 },
  { hole: 2, cam: [163, 466], cup: [6, 7], proj: [448, 318], ring: 38, sfx: 68, end: 129, back: 158 },
  // the game's numbers less its lag frame (see the header): 43, 73, 134
  { hole: 3, cam: [602, 610], cup: [6, 22], proj: [928, 526], ring: 42, sfx: 72, end: 133, back: -1 },
];

describe.skipIf(!haveRules)("the cup reveal's frames (course 1, holes 1-4)", () => {
  const rules = new RomRules(loadTables());
  for (const c of CASES) {
    const json = loadRomHole(c.hole);
    it.skipIf(!json)(`hole ${c.hole + 1}: the cup at (${c.cup}), the camera at (${c.cam})`, () => {
      const world = createGameWorld();
      const ctx = startCourse(world, rules, [fromRomCourse(json!)]);
      world.set(Camera, { ...world.get(Camera)!, x: c.cam[0], y: c.cam[1] });
      const cup = world.query(IsEnemy, Cell).find((e) => e.get(Cell)!.x === c.cup[0] && e.get(Cell)!.y === c.cup[1])!;
      startReveal(world, ctx, cup);
      const r0 = world.get(Reveal)!;
      expect([r0.panX, r0.panY]).toEqual(c.proj);
      expect(r0.onScreen).toBe(c.ring === 8 ? 1 : 0);
      drainEvents(world);
      let ring = -1;
      let sfx = -1;
      let end = -1;
      let back = -1;
      for (let f = 1; f < 400 && back < 0; f++) {
        if (tickReveal(world)) back = f;
        const r = world.get(Reveal)!;
        if (ring < 0 && r.stage === 'ring') ring = f;
        if (end < 0 && (r.stage === 'panBack' || back > 0)) end = f;
        if (drainEvents(world).some((e) => e.kind === 'cup-reveal' && e.romSfx === 0x1c)) sfx = f;
      }
      expect({ ring, sfx, end }).toEqual({ ring: c.ring, sfx: c.sfx, end: c.end });
      if (c.back > 0) expect(back).toBe(c.back);
      // the pan back ends on the camera saved at the take
      expect([world.get(Camera)!.x, world.get(Camera)!.y]).toEqual(c.cam);
    });
  }
});
