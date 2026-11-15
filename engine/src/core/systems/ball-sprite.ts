/**
 * `update-ball-sprite` (after update-camera, before update-pose): the roll
 * loop's $82:F4FD, Kirby's OAM priority $D96A (sim/priority.ts), on the
 * frames that run the presentation (camera.ts `rollLoopPresents`). The
 * set-up and the lost ball's reset put it back to 3 (hole-flow.ts).
 *
 * On the fall's first frame the presentation's song request blocks the loop
 * in the APU handshake (Stall apuLag), and $82:F4FD runs after it: web_fly
 * stores the 1 at 3256, the frame the lag ends, not at 3252. So a frame that
 * began the lag leaves the priority to the lag's last (ordinary) frame.
 */
import type { World } from 'koota';
import { BallWork } from '../traits/ball';
import { BallSprite } from '../traits/pose';
import { Stall } from '../traits/stall';
import type { Ctx } from '../sim/context';
import { kirbyPriority } from '../sim/priority';
import { ball } from './flow-util';
import { rollLoopPresents } from './camera';

export function updateBallSprite(world: World, ctx: Ctx): void {
  if (!rollLoopPresents(world)) return;
  if (world.get(Stall)!.kind === 'apuLag') return; // the rest of this iteration comes after the handshake
  const e = ball(world);
  const prio = kirbyPriority(ctx.rules, ctx.course, e.get(BallWork)!);
  if (e.get(BallSprite)!.prio !== prio) e.set(BallSprite, { prio });
}
