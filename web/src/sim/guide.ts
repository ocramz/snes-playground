// The shot guide: where the game predicts the ball goes. Measured on the real
// game (tools/snesstep/trace_flow.py, hole 1): the aim stage's camera target
// `$6AAA/$6AAC` is the END of this prediction, and over 110 aim angles it equals
// a ball launched at FULL power (meter 63) from Kirby, run for 40 steps if it
// rolls and until its first landing if it flies, projected to the screen
// (within the 1 px that the game's integer position drops).
// The dots and the cone of the guide are drawn along the same path.

import { Ball, type BallWorld } from './ball';
import { launchVelocity, shotPower, shotSpin } from './shot';
import type { Rom } from './tables';
import { project } from '../render/projection';

export const GUIDE_METER = 63;
/** Steps a rolling guide runs ($6AAA/$6AAC against 110 aim angles: 40 steps, not 39 or 41). */
export const GUIDE_ROLL_STEPS = 40;

export interface GuidePoint {
  /** the ball's projected position (course bitmap pixels), z included */
  x: number;
  y: number;
  /** distance travelled in the world so far, in cells */
  d: number;
}

export interface Guide {
  points: GuidePoint[];
  /** where the path ends */
  end: GuidePoint;
  /** the guide ball left the course */
  lost: boolean;
}

export interface GuideInput {
  xc: number; xf: number; yc: number; yf: number;
  aim: number; elevation: number; side: number; topBack: number;
}

export function computeGuide(rom: Rom, world: BallWorld, word7: number, g: GuideInput): Guide {
  const fly = g.elevation !== 0;
  const ball = new Ball(rom);
  ball.place(world, g.xc, g.xf, g.yc, g.yf);
  const power = shotPower(rom, GUIDE_METER, fly);
  const v = launchVelocity(rom, power, g.aim, g.elevation);
  const s = shotSpin(rom, power, g.aim, g.elevation, g.side, g.topBack);
  ball.vx = v.vx; ball.vy = v.vy; ball.vz = v.vz; ball.air = fly;
  ball.aim = g.aim; ball.elevation = g.elevation;
  ball.spinX = s.spinX; ball.spinY = s.spinY; ball.spinPending = s.pending;

  const at = (d: number): GuidePoint => {
    const p = project(word7, ball.xc, ball.xf, ball.yc, ball.yf, ball.z);
    return { x: p.x, y: p.y, d };
  };
  const points: GuidePoint[] = [at(0)];
  let d = 0;
  let px = g.xc + g.xf / 65536, py = g.yc + g.yf / 65536;
  let lost = false;
  const limit = fly ? 600 : GUIDE_ROLL_STEPS;
  for (let t = 1; t <= limit; t++) {
    ball.step(world);
    const x = ball.xc + ball.xf / 65536, y = ball.yc + ball.yf / 65536;
    d += Math.hypot(x - px, y - py);
    px = x; py = y;
    points.push(at(d));
    if (ball.lost) { lost = true; break; }
    if (fly && ball.bounced) break;
  }
  return { points, end: points[points.length - 1], lost };
}
