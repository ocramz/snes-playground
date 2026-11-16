/**
 * The hole's entities (plans/port_v1_koota_phaser4.md "Hole entities";
 * docs/tiles.md "Actors", docs/physics.md "Enemies and the cup").
 *
 * `startHole` spawns one root (`IsHole` + `HoleInfo`) and, from the load-time
 * actor sweep ($82:B320), the tee, the enemies, the pillars and the hazard
 * actors. Every one of them carries `InHole(root)`, so destroying the root
 * tears the hole down (`autoDestroy: 'orphan'`).
 */
import { relation, trait } from 'koota';

export const IsHole = trait();
export const HoleInfo = trait({ index: 0, name: '' });
/** Every hole entity points at its root; destroying the root destroys it. */
export const InHole = relation({ autoDestroy: 'orphan' });

/** The cell an actor stands on ($B538/$B578 of its actor record). */
export const Cell = trait({ x: 0, y: 0 });

/** The tee: the hole's `$0C` cell ($82:ACBF). */
export const IsTee = trait();

/**
 * An enemy: layer-2 tiles $40-$52 and $57 (actor $0049, object type 73).
 * `tile` is the unfolded layer-2 byte; `ability` the copy ability it gives
 * ($82:B6EB by species; deferred, recorded only); `listIndex` its place in
 * the enemy list `$69DE` (the sweep's row-major order, up to 16).
 */
export const IsEnemy = trait();
export const EnemyKind = trait({ tile: 0, species: 0, ability: 0, listIndex: 0 });
/** $5B1C: the hover height in height steps ($82:B69F; 0 for most enemies). */
export const Hover = trait({ steps: 0 });
/**
 * $539C: the player who took the enemy (2 = free until then). Exclusive:
 * an enemy has one owner (2P moves it, `$82:8B0F`; deferred).
 */
export const TakenBy = relation({ exclusive: true });
/** The last free enemy became the cup ($82:8B5C: kind $B4B8 = 8). */
export const IsCup = trait();

/** A pillar (tile $02, actor $0048, object type 72: the trees). */
export const IsPillar = trait();

/** A hazard actor (actor ids $4C, $4D, $51-$53: object types 76, 77, 81-83). */
export const IsHazardActor = trait();
export const ActorType = trait({ type: 0, tile: 0 });
