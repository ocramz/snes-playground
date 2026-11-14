/**
 * `update-actors` (the thread scheduler's tick, `$80:E0C0`, for the hazard
 * actors; sim/actors.ts) and the hole's hazard field. The scheduler runs in
 * the frame helper `$80:8F78` at the end of each main-loop iteration — with
 * the HUD thread (systems/counters.ts) — and not in the frames the cup
 * reveal's decompression wait holds it (TomatoQueue.hold).
 */
import { trait, type World } from 'koota';
import type { Ctx } from '../sim/context';
import type { HazardField } from '../sim/hazards';
import { spawnActor, tickActor, autotileTracks, type BallView } from '../sim/actors';
import type { HoleActors } from '../sweep';
import { BallHoled, BallPos, BallWork } from '../traits/ball';
import { HoleFlow } from '../traits/flow';
import { Reveal } from './reveal';

/** World singleton (AoS): the hole's hazard actors; ctx.course.hazards is this object. */
export const Hazards = trait((): HazardField => ({ actors: [], list: [], atCell: new Int16Array(0) }));

/**
 * `$82:B9C7` and `$82:BA87` at the hole's start: the actors at their cell
 * centres on the ground, object 76's list ($B6BA, record order), the cell
 * index ($ABB8), then the tracks auto-tiled in layer 2.
 */
export function setupHazards(world: World, ctx: Ctx, actors: HoleActors): HazardField {
  const f = world.get(Hazards)!;
  f.actors = [];
  f.list = [];
  f.atCell = new Int16Array(ctx.course.w * ctx.course.h).fill(-1);
  for (const h of actors.hazards) {
    const type = h.type; // an actor id is the object type: $4C 76, $4D 77, $51-$53 81-83
    const a = spawnActor(ctx, type, h.tile, h.x, h.y);
    f.atCell[a.cell] = f.actors.length;
    if (type === 76) f.list.push(f.actors.length);
    f.actors.push(a);
  }
  autotileTracks(ctx.rules, ctx.course.layer2, ctx.course.w, ctx.course.h);
  ctx.course.hazards = f;
  return f;
}

/** One tick of every hazard actor. */
export function tickHazards(world: World, ctx: Ctx): void {
  const f = world.get(Hazards)!;
  if (f.actors.length === 0) return;
  const e = world.queryFirst(BallWork);
  const w = e?.get(BallWork);
  const pos = e?.get(BallPos);
  const phase = world.get(HoleFlow)!.phase;
  const view: BallView = {
    cell: w ? w.cell : -1,
    xf: pos ? pos.xf : 0,
    yf: pos ? pos.yf : 0,
    holed: e ? e.get(BallHoled)!.holed !== 0 : false,
    rolling: phase === 'Rolling' || phase === 'RollEnd',
  };
  const frozen = world.get(Reveal)!.stage !== 'none'; // $6A8C
  for (const a of f.actors) tickActor(ctx, a, view, frozen);
}
