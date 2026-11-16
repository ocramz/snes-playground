/**
 * The players, and the handle to the one whose turn it is.
 *
 * The game keeps one block per player ($D87A-$D96E: each field is one word
 * per player, every 4 bytes) and one work copy, loaded by `$82:F030` from
 * the block at X = `$7E:1803` — 0 for player 1, 2 for player 2, the one
 * whose turn it is (docs/physics.md "The ball's state"). Kirby's state
 * follows the same pattern (`$D7D4` / `$D7D6`).
 *
 * In the engine each player is one entity (`spawnPlayer`, core/world.ts)
 * carrying its ball, its work copy, its pose and its counters, tagged
 * `IsPlayer`; `IsActivePlayer` stands for `$1803`. Core and game alike reach
 * "the player" only through `activePlayer` / `findActivePlayer`, never by
 * querying for a trait the player entity happens to carry (checked by
 * test/no-phaser-in-core.test.ts), so a turn change only has to move the tag.
 */
import { trait, type Entity, type World } from 'koota';

/** A player entity: the per-player block, the work copy, Kirby's pose, the counters. */
export const IsPlayer = trait();
/** The player whose turn it is (`$7E:1803`): exactly one `IsPlayer` carries it once a course starts. */
export const IsActivePlayer = trait();

/** The player whose turn it is, or undefined before the first course. */
export function findActivePlayer(world: World): Entity | undefined {
  return world.queryFirst(IsActivePlayer);
}

/** The player whose turn it is, for the code that runs only inside a hole: throws when there is none. */
export function activePlayer(world: World): Entity {
  const e = world.queryFirst(IsActivePlayer);
  if (e === undefined) throw new Error('no active player');
  return e;
}
