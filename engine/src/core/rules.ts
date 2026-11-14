/**
 * RomRules: the ROM constant tables (build/engine/rules/tables.json,
 * tools/export_web.py --only tables) as typed arrays with accessors. Every
 * table's `source` ($bank:addr) is kept so a number can be traced to the
 * ROM. Values the exporter marked signed are already sign-extended in the
 * JSON; unsigned words (e.g. $FFFF markers) are kept as-is, so the typed
 * arrays are Int32 throughout.
 */

export interface TablesJson {
  about: string;
  zUnit: number;
  consts: Record<string, { source: string; value: number }>;
  outlineWalk: { about: string; values: number[] };
  [key: string]: unknown;
}

interface RawTable {
  source: string;
  width: number;
  values: number[];
}

export class RomRules {
  /** One height step in 16.16 world Z ($5A82; docs/terrain.md). */
  readonly zUnit: number;
  /** Named 16-bit constants, by key (bounceMinFrames, restSpeed, ...). */
  readonly consts = new Map<string, number>();
  /** The outline pulse order into outlineColours (emulated, 3 frames/step). */
  readonly outlineWalk: number[];
  private readonly tables = new Map<string, Int32Array>();
  private readonly sources = new Map<string, string>();

  constructor(json: TablesJson) {
    this.zUnit = json.zUnit;
    this.outlineWalk = json.outlineWalk.values;
    for (const [key, c] of Object.entries(json.consts)) this.consts.set(key, c.value);
    for (const [key, v] of Object.entries(json)) {
      if (key === 'about' || key === 'zUnit' || key === 'consts' || key === 'outlineWalk') continue;
      const t = v as RawTable;
      this.tables.set(key, Int32Array.from(t.values));
      this.sources.set(key, t.source);
    }
  }

  /** A table by its tables.json key; throws with the source if absent. */
  table(name: string): Int32Array {
    const t = this.tables.get(name);
    if (!t) throw new Error(`tables.json has no table ${name}`);
    return t;
  }

  /** The table's $bank:addr in the ROM. */
  source(name: string): string {
    return this.sources.get(name) ?? '?';
  }

  const_(name: string): number {
    const v = this.consts.get(name);
    if (v === undefined) throw new Error(`tables.json has no const ${name}`);
    return v;
  }

  // --- the terrain tables (docs/terrain.md), with their ROM addresses ---

  /** $81:9310: surface level at the four edge midpoints, half steps, N E S W. */
  terrainEdge(shape: number, dir: number): number {
    return this.table('terrainEdge')[shape * 4 + dir];
  }

  /** $81:9D81: the shape code of one quadrant (0-8). */
  terrainQuad(shape: number, quadrant: number): number {
    return this.table('terrainQuad')[shape * 4 + quadrant];
  }

  /** $81:9569: per-quadrant surface offset for shapes $10-$1B ($FFFF = ramp). */
  terrainQuadDiag(shape: number, quadrant: number): number {
    return this.table('terrainQuadDiag')[shape * 4 + quadrant];
  }

  /** $81:9629: per-shape Z bias for the diagonal families. */
  terrainDiagBias(shape: number): number {
    return this.table('terrainDiagBias')[shape];
  }

  /** $88:8000 / $88:80C8: Z(h) = h x $5A82 as a 32-bit value, h = 0..99. */
  heightZ(h: number): number {
    return (this.table('heightZHi')[h] << 16) | this.table('heightZLo')[h];
  }

  /** $88:8190: the 1024-entry linear ramp, 22 .. 46316. */
  ramp(i: number): number {
    return this.table('ramp')[i];
  }

  /** $80:A928: arctangent in degrees 0-45 by ratio index 0-255. */
  atanDeg(i: number): number {
    return this.table('atanDeg')[i];
  }
}
