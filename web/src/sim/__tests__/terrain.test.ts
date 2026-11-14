import { describe, expect, it } from 'vitest';
import { haveAssets, haveGolden, loadGolden, loadRom } from '../../../test/load';
import { emptyProbe } from '../terrain';

describe.skipIf(!haveAssets || !haveGolden)('terrain vs tools/terrain.py', () => {
  it('matches Tables.surface_z on every cell and sample', () => {
    const { terrain } = loadRom();
    const g = loadGolden();
    expect(g.w).toBe(terrain.w);
    const p = emptyProbe();
    let n = 0;
    for (let row = 0; row < g.h; row++) {
      for (let col = 0; col < g.w; col++) {
        for (const yf of g.fracs) {
          for (const xf of g.fracs) {
            terrain.probe(col, row, xf, yf, p);
            const want = g.z[n++];
            if (p.ground !== want) {
              throw new Error(`cell (${col},${row}) xf=${xf} yf=${yf}: got ${p.ground}, want ${want}`);
            }
          }
        }
      }
    }
    expect(n).toBe(g.z.length);
  });
});
