/**
 * The water's effects in the frame (sim/water.ts, sim/water-fx.ts):
 *
 * - `noteWater`, from the step's `water-effects` entry: the splash the
 *   handler spawned, the two bubble emitters of an entry ($82:85DD), Kirby's
 *   palette ($82:8604), the stopped effects ($80:B542 with 0) and Kirby's
 *   state 14 after a skip ($82:82B9).
 * - `tickWaterFx`, in the thread tick (list 6 of `$80:E0C0`): the splashes
 *   (a 57 spawns its 58, which runs in the same tick), then the emitters.
 *
 * The objects read Kirby as the scheduler finds him: his projected point
 * ($81:A21E: `$091E,X` = `$DA58`, `$093E,X` = `$8B9A` - `$DA5C`), the block's
 * `$D872`, `$D8A6`, the tomatoes, his facing and whether he stands
 * (`$D842`: the set-up to the roll's start).
 */
import type { World } from 'koota';
import type { Ctx } from '../sim/context';
import { BallWet, BallAir, BallWork, type BallWorkFields } from '../traits/ball';
import { BallScreen, Pose, PoseState } from '../traits/pose';
import { findActivePlayer, activePlayer } from '../traits/player';
import { Tomatoes } from '../traits/counters';
import { HoleFlow, type FlowPhase } from '../traits/flow';
import { WaterFx, GameRng, KirbyPalette } from '../traits/water';
import { spawnSplash, spawnBubbles, tickSplash, tickBubble, type FxSource, type SplashRun } from '../sim/water-fx';
import { emitEvent } from './flow-util';

/** `$D842` is set by the set-up ($80:C679) and cleared as the roll starts ($82:C282). */
const STANDING: ReadonlySet<FlowPhase> = new Set(['ShotSetup', 'Aim', 'PanToShot', 'Spin', 'Power', 'LaunchDelay']);

/** The step's facts, inside the tile dispatch. */
export function noteWater(world: World, ctx: Ctx, w: BallWorkFields): void {
  if (w.waterSplash !== 0) {
    world.get(WaterFx)!.splashes.push(spawnSplash(ctx.rules, w.waterSplash));
    emitEvent(world, 'water-splash'); // the object, not a sound: the view reads WaterFx
  }
  if (w.waterBubbles !== 0) world.get(WaterFx)!.bubbles.push(...spawnBubbles());
  const e = activePlayer(world);
  if (w.waterPalette >= 0) e.set(KirbyPalette, { wet: w.waterPalette });
  if (w.waterSilence !== 0) emitEvent(world, 'silence', 0); // $80:B542 with A = 0
  if (w.kirbyRoll !== 0) e.set(Pose, { ...e.get(Pose)!, state: PoseState.Roll, timer: 0 });
}

function source(world: World, ctx: Ctx): FxSource | null {
  const e = findActivePlayer(world);
  if (!e) return null;
  const sc = e.get(BallScreen)!;
  const pose = e.get(Pose)!;
  const phase = world.get(HoleFlow)!.phase;
  return {
    x: sc.x & 0xffff,
    y: (ctx.course.screenBase - sc.y) & 0xffff,
    queue: 0, // relative: the engine sorts by Kirby's depth, not by OAM queues
    wet: e.get(BallWet)!.wet,
    frozen: e.get(BallWork)!.waterFreeze,
    tomatoes: e.get(Tomatoes)!.n,
    standing: STANDING.has(phase),
    facing: pose.facing & 7,
    air: e.get(BallAir)!.air,
  };
}

export function tickWaterFx(world: World, ctx: Ctx): void {
  const fx = world.get(WaterFx);
  if (!fx || (fx.splashes.length === 0 && fx.bubbles.length === 0)) return;
  const src = source(world, ctx);
  if (!src) return;
  const born: SplashRun[] = [];
  for (const s of fx.splashes) {
    const b = tickSplash(ctx.rules, s, src);
    if (b) born.push(b);
  }
  for (const s of born) {
    const b2 = tickSplash(ctx.rules, s, src); // spawned during the tick: it runs now
    if (b2) born.push(b2);
  }
  const rng = world.get(GameRng)!;
  for (const b of fx.bubbles) tickBubble(ctx.rules, rng, b, src, fx.between);
  fx.splashes = fx.splashes.filter((s) => !s.done).concat(born.filter((s) => !s.done));
  fx.bubbles = fx.bubbles.filter((b) => !b.done);
}
