// The ROM tables the physics reads, as exported by tools/export_web.py
// (build/web/tables.json). Every entry carries its $bank:addr in `source`.

export interface Table {
  source: string;
  width: number;
  values: number[];
}

export interface Const {
  source: string;
  value: number;
}

export interface TablesJson {
  zUnit: number;
  terrainEdge: Table;
  terrainQuad: Table;
  terrainQuadDiag: Table;
  terrainDiagBias: Table;
  heightZLo: Table;
  heightZHi: Table;
  ramp: Table;
  sinDeg: Table;
  atanDeg: Table;
  crestShape: Table;
  frictionClass: Table;
  rollFriction: Table;
  ballGravity: Table;
  slopeAccelX: Table;
  slopeAccelY: Table;
  launchX: Table;
  launchY: Table;
  stepDampMaskX: Table;
  stepDampMaskY: Table;
  reflectIndex: Table;
  reflectMatrix: Table;
  powerGround: Table;
  powerFly: Table;
  spinGroundTB: Table;
  curve: Table;
  spinFlyTB: Table;
  spinFlySide: Table;
  buttonModifier: Table;
  cupDepth: Table;
  degToDir32: Table;
  consts: Record<string, Const>;
}

export interface CourseJson {
  index: number;
  name: string;
  w: number;
  h: number;
  bitmap: { w: number; h: number };
  word7: number;
  zUnit: number;
  shape: number[];
  elev: number[];
  walls: number[];
  tile: number[];
  tee: { x: number; y: number; elevation: number } | null;
  enemies: { x: number; y: number; tile: number; actor: number }[];
  objects: { x: number; y: number; tile: number; actor: number; type: number }[];
  edgeTiles: { x: number; y: number; tile: number }[];
}

/** Flattened, typed copies of the tables for the hot path. */
export class Rom {
  readonly zUnit: number;
  readonly edge: Uint8Array;
  readonly quad: Uint16Array;
  readonly quadDiag: Uint16Array;
  readonly diagBias: Uint16Array;
  readonly zLo: Uint16Array;
  readonly zHi: Uint16Array;
  readonly ramp: Uint16Array;
  readonly sin: Int16Array;
  readonly atan: Uint8Array;
  readonly crest: Uint8Array;
  readonly frictionClass: Uint16Array;
  readonly rollFriction: Uint16Array;
  readonly ballGravity: Int16Array;
  readonly slopeX: Int16Array;
  readonly slopeY: Int16Array;
  readonly launchX: Int16Array;
  readonly launchY: Int16Array;
  readonly stepMaskX: Uint16Array;
  readonly stepMaskY: Uint16Array;
  readonly reflectIndex: Uint16Array;
  readonly reflect: Int16Array;
  readonly powerGround: Uint16Array;
  readonly powerFly: Uint16Array;
  readonly spinGroundTB: Int8Array;
  readonly curve: Int8Array;
  readonly spinFlyTB: Int16Array;
  readonly spinFlySide: Int8Array;
  readonly buttonMod: Int16Array;
  readonly cupDepth: Uint16Array;
  /** $81:8E98: heading in degrees (0-360) to one of 32 sectors; Kirby's facing and shot angle come from it. */
  readonly degToDir32: Uint8Array;
  readonly c: Record<string, number>;

  constructor(t: TablesJson) {
    this.zUnit = t.zUnit;
    this.edge = Uint8Array.from(t.terrainEdge.values);
    this.quad = Uint16Array.from(t.terrainQuad.values);
    this.quadDiag = Uint16Array.from(t.terrainQuadDiag.values);
    this.diagBias = Uint16Array.from(t.terrainDiagBias.values);
    this.zLo = Uint16Array.from(t.heightZLo.values);
    this.zHi = Uint16Array.from(t.heightZHi.values);
    this.ramp = Uint16Array.from(t.ramp.values);
    this.sin = Int16Array.from(t.sinDeg.values);
    this.atan = Uint8Array.from(t.atanDeg.values);
    this.crest = Uint8Array.from(t.crestShape.values);
    this.frictionClass = Uint16Array.from(t.frictionClass.values);
    this.rollFriction = Uint16Array.from(t.rollFriction.values);
    this.ballGravity = Int16Array.from(t.ballGravity.values);
    this.slopeX = Int16Array.from(t.slopeAccelX.values);
    this.slopeY = Int16Array.from(t.slopeAccelY.values);
    this.launchX = Int16Array.from(t.launchX.values);
    this.launchY = Int16Array.from(t.launchY.values);
    this.stepMaskX = Uint16Array.from(t.stepDampMaskX.values);
    this.stepMaskY = Uint16Array.from(t.stepDampMaskY.values);
    this.reflectIndex = Uint16Array.from(t.reflectIndex.values);
    this.reflect = Int16Array.from(t.reflectMatrix.values);
    this.powerGround = Uint16Array.from(t.powerGround.values);
    this.powerFly = Uint16Array.from(t.powerFly.values);
    this.spinGroundTB = Int8Array.from(t.spinGroundTB.values);
    this.curve = Int8Array.from(t.curve.values);
    this.spinFlyTB = Int16Array.from(t.spinFlyTB.values);
    this.spinFlySide = Int8Array.from(t.spinFlySide.values);
    this.buttonMod = Int16Array.from(t.buttonModifier.values);
    this.cupDepth = Uint16Array.from(t.cupDepth.values);
    this.degToDir32 = Uint8Array.from(t.degToDir32.values);
    this.c = {};
    for (const [k, v] of Object.entries(t.consts)) this.c[k] = v.value;
  }
}
