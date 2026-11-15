/**
 * The load-time actor sweep ($82:B320, docs/tiles.md "Actors"; read
 * 2026-11-14): every cell, row by row from y = 0, and **within a row from
 * the last column to the first** ($82:B32D LDA $8B92 / DEC; $82:B35D DEX /
 * DEC $00 / BPL), its layer-2 byte looked up in the actor table $82:BDBC.
 * $FFFF is "no actor"; otherwise $82:B3AF records an actor and spawns that
 * thread object type. `$82:B5BF` then builds the enemy list `$69DE` from
 * the records whose kind is $40-$57, in record order, at most 16. Pure: the
 * hole's entities and the test fixtures both come from here.
 *
 * So hole 1's list is (8,3), (8,5), (6,5): the exporter's `enemies` (x
 * ascending) has the same cells in another order.
 */
import type { RomRules } from './rules';

export const ACTOR_PILLAR = 0x48; // type 72, tile $02
export const ACTOR_ENEMY = 0x49; // type 73, tiles $40-$52, $57
export const TEE_TILE = 0x0c;
/** $82:B5D4: the enemy list holds 16 entries. */
export const ENEMY_LIST_MAX = 16;

export interface EnemySpawn {
  x: number;
  y: number;
  tile: number;
  /** $591C: the species, tile - $40 after folding $50-$52 onto $4D-$4F. */
  species: number;
  /** $531C: the copy ability ($82:B6EB[species]); 0 none, $0B roulette. */
  ability: number;
  /** $5B1C: the hover height in steps ($82:B703[tile - $4D] & 7 for $4D-$52). */
  hover: number;
  listIndex: number;
}

export interface ActorSpawn {
  x: number;
  y: number;
  tile: number;
  /** The thread object type ($82:BDBC). */
  type: number;
}

export interface HoleActors {
  tee: { x: number; y: number } | null;
  enemies: EnemySpawn[];
  pillars: ActorSpawn[];
  hazards: ActorSpawn[];
}

/** Is the tile one of the enemy tiles (actor $0049)? Matches $82:BDBC. */
export function isEnemyTile(tile: number): boolean {
  return (tile >= 0x40 && tile <= 0x52) || tile === 0x57;
}

/** $82:B648: tiles $50-$52 count as $4D-$4F for the species. */
export function enemySpecies(tile: number): number {
  const t = tile >= 0x50 && tile < 0x53 ? tile - 0x50 + 0x4d : tile;
  return t - 0x40;
}

/** $82:B683-$82:B69F: the hover height of an enemy tile, in height steps. */
export function enemyHover(rules: RomRules, tile: number): number {
  if (tile >= 0x53 || tile < 0x4d) return 0;
  return rules.table('enemyHover')[tile - 0x4d] & 7;
}

export function sweepActors(
  rules: RomRules,
  data: { w: number; h: number; tile: ArrayLike<number> },
): HoleActors {
  const ids = rules.table('actorIds');
  const ability = rules.table('enemyAbility');
  const out: HoleActors = { tee: null, enemies: [], pillars: [], hazards: [] };
  for (let y = 0; y < data.h; y++) for (let x = data.w - 1; x >= 0; x--) {
    const tile = data.tile[y * data.w + x] & 0xff;
    if (tile === 0) continue;
    if (tile === TEE_TILE && out.tee === null) out.tee = { x, y };
    const id = ids[tile];
    if (id === 0xffff) continue;
    if (id === ACTOR_ENEMY) {
      if (out.enemies.length >= ENEMY_LIST_MAX) continue;
      const species = enemySpecies(tile);
      out.enemies.push({
        x, y, tile, species,
        ability: ability[species] & 0xff,
        hover: enemyHover(rules, tile),
        listIndex: out.enemies.length,
      });
    } else if (id === ACTOR_PILLAR) {
      out.pillars.push({ x, y, tile, type: id });
    } else {
      out.hazards.push({ x, y, tile, type: id });
    }
  }
  return out;
}

/**
 * $82:B44B-$82:B476: the Z an actor's position is projected with — the
 * cell's elevation x $5A82 ($80:A367) plus $82:B477[shape], the ground at
 * the cell's corner (one step on flat ground). The same value is the actor
 * record's $B5B8/$B5F8, and the cup's target Z ($6B74/$6B76).
 */
export function actorGround(
  rules: RomRules,
  course: { w: number; shape: ArrayLike<number>; elev: ArrayLike<number> },
  x: number, y: number,
): number {
  const i = y * course.w + x;
  return (course.elev[i] & 0xff) * 0x5a82 + (rules.table('actorGround')[course.shape[i] & 0xff] & 0xffff);
}
