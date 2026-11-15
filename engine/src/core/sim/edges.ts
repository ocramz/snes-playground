/**
 * sub_edge_crossing $81:9001 and its helpers ($81:925E step height,
 * $81:92AC wall flags, $81:9286 diagonal cross product), ported from the
 * raw listing (build/engine/disasm/edges-raw.txt).
 *
 * Sets the frame's step facts:
 *   stepHeight ($DA4C)  the step across the boundary crossed, half steps
 *   edge       ($D9E4)  the boundary's edge index when the step is non-zero
 *   wallEdge   ($D9E6)  the edge index of a layer-4 wall flag, $FFFF none
 *   wallDir    ($D9E8)  wallDirTable[prevShape * 4 + edge]
 *   moveDir    ($6A78)  0-7 the crossing taken, $FFFF when the cell did
 *                       not change; diagPick ($6A74), crossAxis ($6A76)
 *
 * The edge index is the edge of the NEW cell the ball entered by, so the
 * step is level(new, edge) - level(old, opposite edge) ($81:925E: $44/$46
 * the new cell, $4A/$4C the old): > 0 a step up, < 0 a drop. A crossing
 * along y enters by N (edge 0) moving +y and by S (edge 2) moving -y: at
 * $9051 `TAX` leaves X = dx = 0, which `BMI $9075` keeps for +y; only -y
 * loads 2 ($906F). (A first port read edge 2 for both, and the sign the
 * other way round, which made +y ramp edges steps and inverted every
 * non-flush cardinal step; web/src/sim/ball.ts, checked against the game,
 * agrees with this reading.)
 *
 * Quirks kept from the ROM:
 * - the off-course early exit leaves stepHeight untouched ($9015);
 * - a diagonal move checks the step to the cell crossed first and, only
 *   when that is flush, the step from there to the destination ($91FF,
 *   confirmed by web-demo.md "Edge crossing, two axes at once").
 */
import { s16, wrap16 } from '../fixed';
import type { RomRules } from '../rules';
import type { Ctx, Work } from './context';
import { oppositeDir } from '../terrain';

/**
 * The diagonal tie-break ($81:9286): carry set when
 * (-xf) x pYf - pXf x (-yf) >= 0, i.e. pXf x yf - xf x pYf >= 0 — the ball
 * left through the x edge first. The four branches apply it with the signs
 * below, which reduces to two tests on cross = pXf*yf - xf*pYf.
 */
function cross(pXf: number, xf: number, pYf: number, yf: number): number {
  return Math.imul(s16(pXf), s16(yf)) - Math.imul(s16(xf), s16(pYf));
}

function wallFlagAt(course: Ctx['course'], cell: number, maskEdge: number): boolean {
  if (cell < 0 || cell >= course.w * course.h) return false;
  return (course.walls[cell] & (1 << maskEdge) & 0xf) !== 0;
}

/**
 * $81:925E: level(to, toEdge) - level(from, fromEdge), in half steps; `from`
 * is the cell the ball left ($4A/$4C/$4E), `to` the one it entered
 * ($44/$46/$48).
 */
function stepBetween(
  rules: RomRules,
  fromShape: number,
  fromElev: number,
  fromEdge: number,
  toShape: number,
  toElev: number,
  toEdge: number,
): number {
  const from = (2 * fromElev + rules.terrainEdge(fromShape, fromEdge)) & 0xff;
  const to = (2 * toElev + rules.terrainEdge(toShape, toEdge)) & 0xff;
  return to - from;
}

export function crossEdges(ctx: Ctx, w: Work): void {
  w.edge = 0xffff;
  w.wallEdge = 0xffff;
  w.moveDir = 0xffff;

  if (w.shape === 0 && w.pShape === 0) return; // $9015: $DA4C untouched

  const dy = s16(wrap16(w.pYc - w.yc));
  const dx = s16(wrap16(w.pXc - w.xc));

  if (dx === 0 && dy === 0) {
    w.stepHeight = 0; // $902D
    return;
  }
  if (dx === 0 || dy === 0) {
    cardinal(ctx, w, dx, dy);
    return;
  }
  diagonal(ctx, w, dx, dy);
}

/** $9037: one axis changed. */
function cardinal(ctx: Ctx, w: Work, dx: number, dy: number): void {
  const { rules } = ctx;
  w.moveDir = 2; // $9037's default
  let edge: number;
  if (dx < 0) {
    w.moveDir = 1; // +x, entered by W
    edge = 3;
  } else if (dx > 0) {
    w.moveDir = 3; // -x, entered by E
    edge = 1;
  } else if (dy < 0) {
    edge = 0; // +y, entered by N: X = dx = 0 ($9051 TAX, $906D BMI); $6A78 stays 2
  } else {
    w.moveDir = 0; // -y, entered by S
    edge = 2;
  }
  const step = stepBetween(rules, w.pShape, w.pElev, oppositeDir(edge), w.shape, w.elev, edge);
  if (step !== 0) w.edge = edge;
  // $9089: the old cell's wall flag on the shared edge (mask = opposite)
  if (wallFlagAt(ctx.course, w.pCell, oppositeDir(edge))) {
    w.wallEdge = edge;
    w.wallDir = ctx.rules.table('wallDirTable')[w.pShape * 4 + edge] & 0xff;
  }
  w.stepHeight = step;
}

/** $9096: both axes changed. */
function diagonal(ctx: Ctx, w: Work, dx: number, dy: number): void {
  void ctx.course;
  let edge: number;
  let edge2: number; // $52: the intermediate cell's far edge
  let second: number; // $54/$6A76: the intermediate cell
  const c = cross(w.pXf, w.xf, w.pYf, w.yf);
  if (dx >= 0 && dy >= 0) {
    w.moveDir = 7;
    if (c >= 0) {
      w.diagPick = 3; edge = 1; edge2 = 2; second = w.pCell - 1;
    } else {
      w.diagPick = 0; edge = 2; edge2 = 1; second = w.cell + 1;
    }
  } else if (dx >= 0 && dy < 0) {
    w.moveDir = 6;
    if (c <= 0) {
      w.diagPick = 3; edge = 1; edge2 = 0; second = w.pCell - 1;
    } else {
      w.diagPick = 2; edge = 0; edge2 = 1; second = w.cell + 1;
    }
  } else if (dx < 0 && dy >= 0) {
    w.moveDir = 4;
    if (c <= 0) {
      w.diagPick = 1; edge = 3; edge2 = 2; second = w.pCell + 1;
    } else {
      w.diagPick = 0; edge = 2; edge2 = 3; second = w.cell - 1;
    }
  } else {
    w.moveDir = 5;
    if (c >= 0) {
      w.diagPick = 1; edge = 3; edge2 = 0; second = w.pCell + 1;
    } else {
      w.diagPick = 2; edge = 0; edge2 = 3; second = w.cell - 1;
    }
  }
  w.crossAxis = second;

  const n = ctx.course.w * ctx.course.h;
  const s2shape = second >= 0 && second < n ? ctx.course.shape[second] : 0;
  const s2elev = second >= 0 && second < n ? ctx.course.elev[second] : 0;

  // Boundary 1 ($91FF): old cell -> intermediate. A drop checks the old
  // cell's wall flag ($9208); a flush boundary checks it unconditionally
  // ($9219).
  const step1 = stepBetween(ctx.rules, w.pShape, w.pElev, oppositeDir(edge), s2shape, s2elev, edge);
  if (step1 !== 0) {
    if (step1 < 0) wallCheck(ctx, w, w.pCell, oppositeDir(edge), edge);
    w.edge = edge;
    w.stepHeight = step1;
    return;
  }
  wallCheck(ctx, w, w.pCell, oppositeDir(edge), edge);

  // Boundary 2 ($9221): intermediate -> current cell.
  const step2 = stepBetween(ctx.rules, s2shape, s2elev, oppositeDir(edge2), w.shape, w.elev, edge2);
  if (step2 !== 0) w.edge = edge2;
  w.stepHeight = step2;
  // $9248: only when boundary 1 raised no wall flag, whatever step2 is.
  if (w.wallEdge === 0xffff) {
    wallCheck(ctx, w, second, oppositeDir(edge2), edge2);
  }
}

/** $81:92AC: wall flag on `maskEdge` of `cell` sets wallEdge/wallDir. */
function wallCheck(ctx: Ctx, w: Work, cell: number, maskEdge: number, edge: number): void {
  if (wallFlagAt(ctx.course, cell, maskEdge)) {
    w.wallEdge = edge;
    w.wallDir = ctx.rules.table('wallDirTable')[w.pShape * 4 + edge] & 0xff;
  }
}
