/**
 * The tee and the enemies of a random hole (plans/random_holes.md).
 *
 * - The tee ($0C) on plain flat ground in the path's first slot, with solid
 *   ground all round it where there is such a cell (docs/tiles.md: the tee
 *   is on $01 in all 212 ROM layouts).
 * - The enemies on plain flat ground ($01: actors must stand on shapes below
 *   $10, $82:B477), one in the path's last slot and in the branch, the rest
 *   spread over the other slots; at least two cells from the tee and from
 *   each other. Only ability-0 species (copy abilities are deferred; the
 *   validator rejects the others): $40, $4A-$4C, and the hovering $4D, $4E,
 *   $50, $51, which only a fly shot can hit (sim/enemy.ts).
 */
import type { RomRules } from '../rules';
import { enemySpecies, TEE_TILE } from '../sweep';
import { enclosed, flatCells, type Layout } from './layout';
import type { Rng } from './rng';

export const GROUND_ENEMIES = [0x40, 0x4a, 0x4b, 0x4c];
export const HOVER_ENEMIES = [0x4d, 0x4e, 0x50, 0x51];

export interface PlaceParams {
  /** The number of enemies, [min, max]. */
  enemies: [number, number];
  /** The chance an enemy is a hovering one. */
  hover: number;
  /** The chance one enemy shares the tee's slot. */
  nearTee: number;
}

export interface Placed {
  tee: { x: number; y: number };
  enemies: Array<{ x: number; y: number; tile: number }>;
}

export function placeActors(rng: Rng, rules: RomRules, layout: Layout, p: PlaceParams): Placed | null {
  const { grid, slots } = layout;
  const ability = rules.table('enemyAbility');
  const kinds = (list: number[]): number[] => list.filter((t) => (ability[enemySpecies(t)] & 0xff) === 0);
  const ground = kinds(GROUND_ENEMIES);
  const hover = kinds(HOVER_ENEMIES);

  const teeSlot = flatCells(grid, slots[0]);
  const inner = teeSlot.filter((c) => enclosed(grid, c.x, c.y));
  const teeCands = inner.length > 0 ? inner : teeSlot;
  if (teeCands.length === 0) return null;
  const tee = rng.pick(teeCands);
  grid.put(tee.x, tee.y, { tile: TEE_TILE });

  // which slots get an enemy: the path's end and the branch first
  const n = rng.int(p.enemies[0], p.enemies[1]);
  const order: number[] = [];
  const leaves = slots.map((_, k) => k).filter((k) => k > 0 && !slots.some((s) => s.parent === k));
  order.push(...rng.shuffle(leaves));
  const middle = rng.shuffle(slots.map((_, k) => k).filter((k) => k > 0 && !leaves.includes(k)));
  order.push(...middle);
  if (rng.chance(p.nearTee) || order.length === 0) order.splice(Math.min(order.length, 1), 0, 0);
  while (order.length < n) order.push(rng.int(slots.length > 1 ? 1 : 0, slots.length - 1));

  const taken: Array<{ x: number; y: number }> = [tee];
  const far = (c: { x: number; y: number }): boolean =>
    taken.every((t) => Math.max(Math.abs(t.x - c.x), Math.abs(t.y - c.y)) >= 2);
  const enemies: Placed['enemies'] = [];
  for (const k of order) {
    if (enemies.length >= n) break;
    const cands = flatCells(grid, slots[k]).filter(far);
    if (cands.length === 0) continue;
    const c = rng.pick(cands);
    const tile = hover.length > 0 && rng.chance(p.hover) ? rng.pick(hover) : rng.pick(ground);
    grid.put(c.x, c.y, { tile });
    taken.push(c);
    enemies.push({ ...c, tile });
  }
  if (enemies.length < 2) return null;
  return { tee, enemies };
}
