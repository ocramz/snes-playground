/**
 * The shot guide, $81:A9B8 (read 2026-11-14; build/engine/disasm/
 * flow-guide.txt, flow-guide-end.txt): a silent simulation of the shot at
 * full power from the aim stage's origin, whose first end is where the aim
 * camera looks ($6AAA/$6AAC, written at $81:AE29 from end 0 only).
 *
 * The driver is ported as read:
 * - power from the meter's top ($81:C2E9 with A = $6B3C), the spin from the
 *   guide's selectors $D9B8/$D9BA ($81:C1D5), the launch ($81:BA0B);
 * - airborne = 1 - $6AD8; the probe, z = ground, the previous-frame copy;
 * - by the shot kind $6AD6 ($81:AA34): 0 rolls until 40 steps ($81:AA3E) or
 *   the airborne flag changes (a drop: over a gap the end is put on the
 *   crossed edge, $81:AA5C-$81:AAA5); 2 (fly) runs until the first landing
 *   while $6ACE = 1, else records an end at each landing until $6ACE ends,
 *   at most 496 steps, and turns into the rolling guide (40 more steps) when
 *   the ball settles ($81:ABDD); a fall into a gap ends it at the last
 *   point over ground ($81:AC3D); kind 1 is kind 0 with 80 steps;
 * - a dot every 3 steps (5 in a fly shot), $81:AC93.
 *
 * The guide's own step, $81:AF82-$81:B44B, is a separate routine built on
 * the same primitives (probe, edges, wall and step bounce, reflection, the
 * spin impulse, the outline wall); it is NOT ported. The engine runs the
 * kernel entries of BALL_STEP instead (plans/port_v1_koota_phaser4.md),
 * silently ($6AC0 = 0). docs/web-demo.md found the guide's ends to match
 * that for 105 of 110 aims; test/flow.test.ts measures the engine's.
 */
import type { Ctx, Work } from './context';
import { shotPower, launchVelocity, shotSpin } from './shot';
import { probe } from './probe';
import { runKernelStep, cloneWork } from '../systems/ball-step';
import { project, type ProjectionOrigin } from '../projection';
import { METER_TOP } from '../traits/shot';
import type { GuideEnd, GuidePoint } from '../traits/guide';

export interface GuideShot {
  aim: number;
  elev: number;
  kind: number; // $6AD6
  grounder: number; // $6AD8
  guideSide: number; // $D9B8
  guideTB: number; // $D9BA
  ends: number; // $6ACE
  originXf: number; originXc: number; originYf: number; originYc: number; originZ: number;
}

export interface GuideResult {
  points: GuidePoint[];
  ends: GuideEnd[];
  steps: number;
  /**
   * $6A18 as the guide left it. The ROM's guide runs on the real work copy;
   * the next real step reloads the block, but $6A18 (the outline wall's last
   * connection code) is not in the block, so the next guide — and the shot's
   * first steps — start from this value. The caller writes it back.
   */
  wallCode: number;
  /** $6A28 and $DA0A as the guide left them (written back for the boost hum, systems/boost-hum.ts). */
  boostFlash: number;
  tile: number;
  /**
   * $DA3A and $6A72 as the guide's last rolling step left them, or null when
   * it never rolled. The guide's own rolling step sets them with its own
   * rule ($81:B23A-$81:B24C: class 0 on surface code 0, else class 1, mode
   * ignored), not the real step's ($81:80C5); the real step recomputes them
   * on every rolling frame, so they matter only to a ball that rolls on the
   * frame it lands: a snap panel's landing (sim/dispatch.ts snapLand, the
   * friction of web_snap_land's landing frame, $07B0).
   */
  rollMu: number | null;
  classIndex: number;
}

/** $81:AA3E: the step limit by shot kind. */
const MAX_STEPS = [40, 80, 496];

export function simulateGuide(ctx: Ctx, live: Work, shot: GuideShot, origin: ProjectionOrigin): GuideResult {
  const gctx: Ctx = { ...ctx, presentation: false };
  const w = cloneWork(live);
  // $81:BB18: the work copy back at the aim stage's origin
  w.xf = shot.originXf; w.xc = shot.originXc;
  w.yf = shot.originYf; w.yc = shot.originYc;
  w.z = shot.originZ;
  // $81:A9BE-$81:A9E5
  w.airFrames = 0;
  w.launchLock = 0;
  w.lost = 0;
  w.holed = 0;
  w.mode = 0;
  w.shotAim = shot.aim;
  w.shotElev = shot.elev;
  w.modifierKind = -1;
  w.modifierTimer = 0;
  w.modifierWindow = 0;
  const fly = shot.elev !== 0 && shot.elev !== 0xffff;
  const power = shotPower(ctx.rules, METER_TOP, fly); // $81:C2E9, A = $6B3C
  shotSpin(ctx.rules, w, shot.guideSide, shot.guideTB, power); // $81:A9FB
  launchVelocity(ctx.rules, w, power, shot.grounder !== 0 ? 0 : -1); // $81:A9FE
  w.air = shot.grounder ^ 1; // $81:AA0E
  probe(gctx, w); // $81:AA17
  w.z = w.ground; // $81:BB3D
  copyPrev(w); // $81:8751

  const out: GuideResult = { points: [], ends: [], steps: 0, wallCode: 0, boostFlash: 0, tile: 0, rollMu: null, classIndex: 0 };
  let max = MAX_STEPS[Math.min(2, Math.max(0, shot.kind))];
  let dotIn = 1; // $6AD4
  let gapPending: GuideEnd | null = null; // $6AD0 and the slot $81:AC3D saved
  let rolling = shot.kind !== 2;
  const dot = (): void => {
    out.points.push({ xc: w.xc, xf: w.xf, yc: w.yc, yf: w.yf, z: w.z, air: w.air });
  };
  const end = (): void => {
    // $81:AD97: the pending gap end, else the ball where it is
    const e = gapPending ?? at(w.xc, w.xf, w.yc, w.yf, w.z);
    gapPending = null;
    const p = project(origin, e.xc, e.xf, e.yc, e.yf, e.z);
    out.ends.push({ ...e, sx: p.x, sy: p.y });
  };

  for (;;) {
    out.steps += 1; // $B744
    const rolling0 = w.air === 0;
    runKernelStep(gctx, w);
    if (rolling0) {
      // $81:B23A: X = 0 on surface code 0, else 2; $DA3A = $80:DC49,X
      out.classIndex = w.code !== 0 ? 2 : 0; // STX $6A72
      out.rollMu = ctx.rules.table('rollFriction')[out.classIndex >> 1];
    }
    const airChanged = w.air !== w.pAir;
    if (rolling) {
      // $81:AA46-$81:AAEE
      if (airChanged) {
        if (w.shape === 0) {
          // $81:AA61: over a gap — back to the last ground, on the crossed edge
          w.z = w.pZ;
          w.ground = w.pGround;
          w.code = w.pCode;
          w.shape = w.pShape;
          switch (w.edge & 3) {
            case 0: w.yf = 0; break; // $81:AA9D
            case 1: w.xc += 1; w.xf = 0; break; // $81:AAA2
            case 2: w.yc += 1; w.yf = 0; break; // $81:AA9A
            case 3: w.xf = 0; break; // $81:AAA5
          }
        }
        end();
        break;
      }
      if (w.air !== 0) {
        end();
        break;
      }
      if (--dotIn === 0) {
        dotIn = 3;
        dot();
      }
      if (out.steps >= max) {
        end();
        break;
      }
      continue;
    }
    // fly shot, $81:ABCD-$81:AC3A
    if (airChanged) {
      // $81:ABDD: settled; 40 more rolling steps
      max = MAX_STEPS[0] + out.steps;
      rolling = true;
      if (--dotIn === 0) {
        dotIn = 3;
        dot();
      }
      if (out.steps >= max) {
        end();
        break;
      }
      continue;
    }
    // $81:AC3D: over ground and above z 0, or the first point past it
    if (w.shape !== 0 && w.z >= 0) {
      gapPending = null;
    } else if (gapPending === null) {
      gapPending = at(w.pXc, w.pXf, w.pYc, w.pYf, w.pGround);
    } else if (w.z < 0) {
      end();
      break;
    }
    if (w.bounced !== 0) {
      // $6AC6 = 1 ($81:B1A3): a landing records an end
      end();
      if (out.ends.length >= shot.ends) break;
    }
    if (--dotIn === 0) {
      dotIn = 5;
      dot();
    }
    if (out.steps >= max) {
      end();
      break;
    }
  }
  out.wallCode = w.wallCode;
  out.boostFlash = w.boostFlash;
  out.tile = w.tile;
  return out;
}

function at(xc: number, xf: number, yc: number, yf: number, z: number): GuideEnd {
  return { xc, xf, yc, yf, z, sx: 0, sy: 0 };
}

/** $81:8751's copy, as begin-ball-step does it. */
function copyPrev(w: Work): void {
  w.pAir = w.air;
  w.pOnOverlay = w.onOverlay;
  w.pXf = w.xf; w.pXc = w.xc;
  w.pYf = w.yf; w.pYc = w.yc;
  w.pZ = w.z;
  w.pCell = w.cell; w.pShape = w.shape;
  w.pElev = w.elev; w.pQuad = w.quad;
  w.pCode = w.code; w.pGround = w.ground;
  w.pTile = w.tile;
}
