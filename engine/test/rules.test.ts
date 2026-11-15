import { describe, expect, it } from 'vitest';
import { RomRules } from '../src/core/rules';
import { haveRules, loadTables } from './fixtures';

describe.skipIf(!haveRules)('RomRules over build/engine/rules/tables.json', () => {
  const rules = new RomRules(loadTables());

  it('keeps every table\'s $bank:addr source', () => {
    expect(rules.source('terrainEdge')).toBe('$81:9310');
    expect(rules.source('ramp')).toBe('$88:8190');
    expect(rules.source('atanDeg')).toBe('$80:A928');
  });

  it('zUnit is $5A82, one height step (docs/terrain.md)', () => {
    expect(rules.zUnit).toBe(0x5a82);
    expect(rules.heightZ(1)).toBe(0x5a82);
    expect(rules.heightZ(2)).toBe(0xb504);
    expect(rules.heightZ(0x0f)).toBe(0x0f * 0x5a82);
  });

  it('terrain tables match the documented shape table (docs/terrain.md)', () => {
    expect(rules.table('terrainEdge')).toHaveLength(28 * 4);
    expect(rules.table('terrainQuad')).toHaveLength(28 * 4);
    expect(rules.table('terrainQuadDiag')).toHaveLength(28 * 4);
    expect(rules.table('terrainDiagBias')).toHaveLength(28);
    // gap and flat
    for (const d of [0, 1, 2, 3]) {
      expect(rules.terrainEdge(0x00, d)).toBe(0);
      expect(rules.terrainEdge(0x01, d)).toBe(2);
    }
    // ramp $04: edges 0 1 2 1, all quadrants code 1
    expect([0, 1, 2, 3].map((d) => rules.terrainEdge(0x04, d))).toEqual([0, 1, 2, 1]);
    expect([0, 1, 2, 3].map((q) => rules.terrainQuad(0x04, q))).toEqual([1, 1, 1, 1]);
    // mound $02: quadrants 1 2 3 4
    expect([0, 1, 2, 3].map((q) => rules.terrainQuad(0x02, q))).toEqual([1, 2, 3, 4]);
    // diag bias: $10-$13 and $18-$1B are 0, $14-$17 are $5A82
    for (const s of [0x10, 0x11, 0x12, 0x13, 0x18, 0x19, 0x1a, 0x1b]) {
      expect(rules.terrainDiagBias(s), `shape ${s}`).toBe(0);
    }
    for (const s of [0x14, 0x15, 0x16, 0x17]) {
      expect(rules.terrainDiagBias(s), `shape ${s}`).toBe(0x5a82);
    }
  });

  it('ramp runs 22 .. 46316 (docs/terrain.md)', () => {
    expect(rules.table('ramp')).toHaveLength(1024);
    expect(rules.ramp(0)).toBe(22);
    expect(rules.ramp(1023)).toBe(46316);
  });

  it('atanDeg covers 0 .. 45 degrees', () => {
    expect(rules.table('atanDeg')).toHaveLength(256);
    expect(rules.atanDeg(0)).toBe(0);
    expect(rules.atanDeg(255)).toBe(45);
  });

  it('exposes the documented constants', () => {
    expect(rules.const_('bounceMinFrames')).toBe(0x10); // $80:DCFD, physics.md
  });

  it('exposes the outline pulse walk', () => {
    expect(rules.outlineWalk).toHaveLength(30);
    for (const i of rules.outlineWalk) expect(i).toBeGreaterThanOrEqual(0);
  });

  it('throws a useful error for a missing table or const', () => {
    expect(() => rules.table('nope')).toThrow('no table nope');
    expect(() => rules.const_('nope')).toThrow('no const nope');
  });
});
