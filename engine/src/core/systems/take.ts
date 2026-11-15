/**
 * `take-enemy` (read 2026-11-14): the half of the enemy-tile handler that
 * touches the hole — `$82:8A2E` (sub_enemy_hit) and `$82:8A98`
 * (loc_enemy_taken), 1 player:
 *
 *   $82:8A2E  the enemy through the cell's actor index $ABB8; owner $539C
 *             not 2 (taken) -> $82:8B0F, a 2-player steal, nothing in 1P
 *             ability $531C 0 -> sfx $4F; else the stock $D9C4 (the
 *             store writes $D852), the latch $D9CA 0, sfx $50 and 4 frames
 *             ($82:8A83), the latch 0 again (the roulette $57, $82:8DD2,
 *             is step 9's: taken as none)
 *   $82:8A98  owner = the player, stars + 1 ($6A10), tomato +1 queued
 *             ($82:8B41 -> $83:ABAD; object 93, the star, is presentation)
 *   $82:8ABC  no cup yet ($69FE < 0) and one enemy left ($82:8ACE == 1):
 *             it becomes the cup ($82:8AEE, $82:8B5C) — the step blocks for
 *             the reveal (systems/reveal.ts)
 */
import type { World } from 'koota';
import { StockedAbility } from '../traits/counters';
import { AbilityFx } from '../traits/ability-fx';
import { Cell, EnemyKind, IsCup, IsEnemy, TakenBy } from '../traits/hole';
import { Visual } from '../traits/visual';
import { Stars } from '../traits/counters';
import type { BallWorkFields } from '../traits/ball';
import type { Ctx } from '../sim/context';
import { emitEvent } from './flow-util';
import { pushTomato } from './counters';
import { freeEnemies, startReveal } from './reveal';
import { activePlayer } from '../traits/player';

/** $82:8A83: the wait after an ability enemy's take ($80:8FB6: 4 frame-helper calls). */
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
  const enemy = enemyAt(world, ctx, cell);
  if (enemy === undefined) return null; // no actor on the cell (a placed test grid)
  if (enemy.has(IsCup) || enemy.targetFor(TakenBy) !== undefined) return null; // $82:8B0F
  const kind = enemy.get(EnemyKind)!;
  const ability = kind.ability === 0x0b ? 0 : kind.ability; // the roulette $82:8DD2: step 9
  if (ability === 0) {
    // $82:8A54: $D862,Y = $1E, the HUD's face for 30 ticks (systems/ability-fx.ts), then sfx $4F
    const fx = world.get(AbilityFx);
    if (fx) fx.hud.face = 0x1e;
    emitEvent(world, 'enemy-taken', 0x4f, enemy);
    return finishTake(world, ctx, enemy);
  }
  // $82:8A67-$82:8A70: the stock (the store writes it to $D852) and the
  // shot's use latch back to 0, so the ability can be used in this shot;
  // sfx $50, then 4 frames ($82:8A83), the latch cleared again ($82:8A8A),
  // and the rest of the take (take-enemy-finish)
  w.stock = ability;
  w.latch = 0;
  // $82:8A70: and the block's $D852 at once (the HUD reads it in the 4 frames)
  const player = activePlayer(world);
  player.set(StockedAbility, { ...player.get(StockedAbility)!, id: ability });
  emitEvent(world, 'enemy-taken', 0x50, enemy);
  w.takePending = cell + 1;
  return { kind: 'takeWait', frames: ABILITY_TAKE_FRAMES, state: 0 };
}

/** The take's second half after an ability enemy's 4 frames ($82:8A8A-). */
export function finishTakeEnemy(world: World, ctx: Ctx, w: BallWorkFields): TakeStall | null {
  if (w.takePending === 0) return null;
  const enemy = enemyAt(world, ctx, w.takePending - 1)!;
  w.takePending = 0;
  w.latch = 0; // $82:8A8A
  return finishTake(world, ctx, enemy);
}

/** $82:8A98-: the owner, the stars, the tomato, and the cup when one enemy is left. */
function finishTake(world: World, ctx: Ctx, enemy: import('koota').Entity): TakeStall | null {
  const player = activePlayer(world);
  enemy.add(TakenBy(player));
  enemy.set(Visual, { kind: 'star' });
  player.set(Stars, { n: player.get(Stars)!.n + 1 });
  pushTomato(world, 1);
  if (world.queryFirst(IsCup) === undefined) {
    const free = freeEnemies(world);
    if (free.length === 1) {
      startReveal(world, ctx, free[0]);
      return { kind: 'cupReveal', frames: 0, state: 0 };
    }
  }
  return null;
}

function enemyAt(world: World, ctx: Ctx, cell: number): import('koota').Entity | undefined {
  const x = cell % ctx.course.w;
  const y = Math.floor(cell / ctx.course.w);
  for (const e of world.query(IsEnemy, Cell)) {
    const c = e.get(Cell)!;
    if (c.x === x && c.y === y) return e;
  }
  return undefined;
}
