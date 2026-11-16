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
  /** Object 111's second colour, BG palette 7 colour 1 (absent from older exports). */
  glowWalk?: { about: string; stepFrames: number; values: number[] };
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
  /** Object 111's hook $84:81B7: the order into glowColours and its step (emulated). */
  readonly glowWalk: { stepFrames: number; values: number[] } | null;
  private readonly tables = new Map<string, Int32Array>();
  private readonly sources = new Map<string, string>();

  constructor(json: TablesJson) {
    this.zUnit = json.zUnit;
    this.outlineWalk = json.outlineWalk.values;
    this.glowWalk = json.glowWalk ? { stepFrames: json.glowWalk.stepFrames, values: json.glowWalk.values } : null;
    for (const [key, c] of Object.entries(json.consts)) this.consts.set(key, c.value);
    if (Array.isArray(json.dispatchHandlers)) {
      this.setDispatchHandlers(json.dispatchHandlers as Array<{ id: number; name: string }>);
    }
    for (const [key, v] of Object.entries(json)) {
      if (key === 'about' || key === 'zUnit' || key === 'consts' || key === 'outlineWalk' || key === 'glowWalk') continue;
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

  // --- the tile dispatch (docs/tiles.md; build_tables in tools/export_web.py) ---

  private handlerNames: string[] = [];
  private handlerIds = new Map<string, number>();

  /** Called once after construction with tables.json's dispatchHandlers. */
  setDispatchHandlers(handlers: Array<{ id: number; name: string }>): void {
    this.handlerNames = [];
    this.handlerIds.clear();
    for (const h of handlers) {
      this.handlerNames[h.id] = h.name;
      this.handlerIds.set(h.name, h.id);
    }
  }

  /** The landing-dispatch handler name for a layer-2 tile value. */
  landHandler(tile: number): string {
    return this.handlerNames[this.table('landDispatch')[tile]] ?? 'land';
  }

  /** The hit-dispatch handler name for a layer-2 tile value. */
  hitHandler(tile: number): string {
    return this.handlerNames[this.table('hitDispatch')[tile]] ?? 'roll';
  }

  /** $81:8E98: the 32-direction form of a heading in degrees. */
  dir32(deg: number): number {
    return this.table('degToDir32')[deg];
  }

  /** $81:92D0 via wallDirTable: indexed prevShape * 4 + edge. */
  wallDir(i: number): number {
    return this.table('wallDirTable')[i];
  }
}
