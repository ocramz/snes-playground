/**
 * `take-enemy` (read 2026-11-14): the half of the enemy-tile handler that
 * touches the hole — `$82:8A2E` (sub_enemy_hit) and `$82:8A98`
 * (loc_enemy_taken), 1 player:
 *
 *   $82:8A2E  the enemy through the cell's actor index $ABB8; owner $539C
 *             not 2 (taken) -> $82:8B0F, a 2-player steal, nothing in 1P
 *             ability $531C 0 -> sfx $4F; else sfx $50 and 4 frames
 *             ($82:8A83; copy abilities are deferred: the ability is only
 *             stocked, and the roulette $57 is taken as none)
 *   $82:8A98  owner = the player, stars + 1 ($6A10), tomato +1 queued
 *             ($82:8B41 -> $83:ABAD; object 93, the star, is presentation)
 *   $82:8ABC  no cup yet ($69FE < 0) and one enemy left ($82:8ACE == 1):
 *             it becomes the cup ($82:8AEE, $82:8B5C) — the step blocks for
 *             the reveal (systems/reveal.ts)
 */
import type { World } from 'koota';
import { Cell, EnemyKind, IsCup, IsEnemy, TakenBy } from '../traits/hole';
import { Visual } from '../traits/visual';
import { Stars, StockedAbility } from '../traits/counters';
import type { BallWorkFields } from '../traits/ball';
import type { Ctx } from '../sim/context';
import { emitEvent } from './flow-util';
import { pushTomato } from './counters';
import { freeEnemies, startReveal } from './reveal';
import { activePlayer } from '../traits/player';

/** $82:8A83: the wait after an ability enemy's take (copy abilities deferred). */
export const ABILITY_TAKE_FRAMES = 4;

export interface TakeStall {
  kind: 'cupReveal' | 'takeWait';
  frames: number;
  state: number;
}

export function takeEnemy(world: World, ctx: Ctx, w: BallWorkFields): TakeStall | null {
  if (w.enemyHit === 0) return null;
  const cell = w.enemyHit - 1;
  w.enemyHit = 0;
  const x = cell % ctx.course.w;
  const y = Math.floor(cell / ctx.course.w);
  let enemy: import('koota').Entity | undefined;
  for (const e of world.query(IsEnemy, Cell)) {
    const c = e.get(Cell)!;
    if (c.x === x && c.y === y) {
      enemy = e;
      break;
    }
  }
  if (enemy === undefined) return null; // no actor on the cell (a placed test grid)
  if (enemy.has(IsCup) || enemy.targetFor(TakenBy) !== undefined) return null; // $82:8B0F
  const kind = enemy.get(EnemyKind)!;
  const player = activePlayer(world);
  const ability = kind.ability === 0x0b ? 0 : kind.ability; // the roulette: deferred
  emitEvent(world, 'enemy-taken', ability !== 0 ? 0x50 : 0x4f, enemy);
  if (ability !== 0) player.set(StockedAbility, { id: ability }); // $82:8A70: $D852
  enemy.add(TakenBy(player));
  enemy.set(Visual, { kind: 'star' });
  player.set(Stars, { n: player.get(Stars)!.n + 1 });
  pushTomato(world, 1);
  if (world.queryFirst(IsCup) === undefined) {
    const free = freeEnemies(world);
    if (free.length === 1) {
      startReveal(world, ctx, free[0], ability !== 0 ? ABILITY_TAKE_FRAMES : 0);
      return { kind: 'cupReveal', frames: 0, state: 0 };
    }
  }
  return ability !== 0 ? { kind: 'takeWait', frames: ABILITY_TAKE_FRAMES, state: 0 } : null;
}
