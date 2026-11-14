// Kirby's facing and shot angle come from the game's own table ($81:8E98),
// not from a formula: phi = 0 gives $D7C4 = 2 and $D7CC = 5 on the real game.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { haveAssets, loadRom, readJson } from '../../../test/load';
import { HoleSim } from '../hole';

const flowPath = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../build/web-test/flow_web_flow.json');

interface Flow { events: [number, string, number][] }

describe.skipIf(!haveAssets)('facing', () => {
  const { rom, course } = loadRom();
  const sim = new HoleSim(rom, course);
  const at = (aim: number): { f8: number; f16: number } => {
    sim.aim = aim;
    return { f8: sim.facing, f16: sim.shotAngle16 };
  };

  it('matches the snapshots of the real game (phi 0 -> 2 and 5)', () => {
    expect(at(0)).toEqual({ f8: 2, f16: 5 });
    // after the first shot of web_flow the game auto-aims at 180 and shows 6 and 13
    expect(at(180)).toEqual({ f8: 6, f16: 13 });
  });

  it('turns the way the game turns: +x faces down-right, +y up-right, -x up-left, -y down-left', () => {
    expect(at(0).f8).toBe(2);
    expect(at(90).f8).toBe(0);
    expect(at(180).f8).toBe(6);
    expect(at(270).f8).toBe(4);
    // 8 sectors of 45 degrees, centred on the multiples of 45
    for (let k = 0; k < 8; k++) expect(at(k * 45).f8).toBe((2 - k + 8) & 7);
  });

  it.skipIf(!existsSync(flowPath))('agrees with every aim value of the recorded sweep', () => {
    const flow = readJson<Flow>(flowPath);
    const series = (name: string): [number, number][] =>
      flow.events.filter((e) => e[1] === name).map((e) => [e[0], e[2]]);
    const val = (s: [number, number][], f: number): number => {
      let v = 0;
      for (const [fr, x] of s) { if (fr <= f) v = x; else break; }
      return v;
    };
    const aim = series('aim'), facing = series('facing'), angle = series('angle');
    let checked = 0;
    for (let f = 2340; f <= 2680; f++) {
      // $81:BB4A runs after the aim changes: the facing may lag it by a few frames
      const ok = [0, 1, 2, 3].some((k) => {
        const p = at(((val(aim, f - k) % 360) + 360) % 360);
        return p.f8 === val(facing, f) && p.f16 === val(angle, f);
      });
      expect(ok, `frame ${f} aim ${val(aim, f)}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(300);
  });
});
