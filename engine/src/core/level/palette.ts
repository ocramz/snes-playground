/**
 * The level editor's tile palette (docs/editor.md "Palette"): the layer-2
 * tiles a level may use, grouped, and the shapes each may stand on. The set
 * is the random holes' (the tiles the styled art draws and the solver
 * plays; core/gen/features.ts) plus the water ($61 and the rim $64-$6F,
 * docs/tiles.md "Water"). The placements follow the ROM's (docs/tiles.md,
 * plans/random_holes.md): actors on flat ground (enemies also on the ramps
 * $04/$05, as the ROM's are), friction $20-$23 on the ramp of their fall,
 * the ramp boosts pointing uphill, the water restating the cell's shape.
 */
import { isEnemyTile, TEE_TILE } from '../sweep';
import { rampFall } from './corners';

export type PaletteGroup =
  | 'tee' | 'enemy' | 'hover' | 'tree' | 'rough' | 'friction' | 'boost'
  | 'kicker' | 'arrow' | 'snap' | 'warp' | 'water';

export interface PaletteEntry {
  /** The layer-2 byte; for the water, WATER (the byte follows the cell's shape). */
  code: number;
  group: PaletteGroup;
  label: string;
  /** Shown beside the entry. */
  note?: string;
}

/** The palette's stand-in for the water: the byte painted is waterTile(shape). */
export const WATER = 0x161;

const DIRS = ['N', 'E', 'S', 'W'];

/** $82:B703: the hovering enemies' height in steps. */
const HOVER_STEPS: Record<number, number> = { 0x4d: 3, 0x4e: 1, 0x50: 4, 0x51: 2 };

export const PALETTE: readonly PaletteEntry[] = [
  { code: TEE_TILE, group: 'tee', label: 'tee', note: 'exactly one, on flat ground' },
  ...[0x40, 0x4a, 0x4b, 0x4c].map((c) => ({ code: c, group: 'enemy' as const, label: `enemy ${hex(c)}` })),
  ...[0x4d, 0x4e, 0x50, 0x51].map((c) => ({
    code: c, group: 'hover' as const, label: `hover ${hex(c)}`, note: `hovers ${HOVER_STEPS[c]} steps: only a fly shot hits it`,
  })),
  { code: 0x02, group: 'tree', label: 'tree', note: 'a pillar 3 steps tall' },
  { code: 0x04, group: 'rough', label: 'rough' },
  ...[0, 1, 2, 3].map((d) => ({ code: 0x20 + d, group: 'friction' as const, label: `ice ramp ${DIRS[d]}`, note: `on the ramp falling ${DIRS[d]}` })),
  { code: 0x24, group: 'friction', label: 'ice flat' },
  ...[0, 1, 2, 3].map((d) => ({ code: 0x30 + d, group: 'boost' as const, label: `boost ${DIRS[d]}` })),
  ...[0, 1, 2, 3].map((f) => ({
    code: 0x34 + 2 * f, group: 'boost' as const, label: `boost up ${DIRS[(f + 2) & 3]}`, note: `on the ramp falling ${DIRS[f]}`,
  })),
  ...[0, 1, 2, 3].map((d) => ({
    code: 0x10 + d, group: 'kicker' as const, label: `kicker ${DIRS[d]}`,
    note: 'pushes a rolling ball toward its arrow, the more the further off it heads (none along it), and brakes it; a landing barely moves (docs/tiles.md "Kicker")',
  })),
  ...[0, 1, 2, 3].map((d) => ({ code: 0x14 + d, group: 'arrow' as const, label: `arrow ${DIRS[d]}` })),
  ...[0, 1, 2, 3].map((d) => ({
    code: 0x18 + d, group: 'snap' as const, label: `snap ${DIRS[d]}`, note: d === 1 ? 'no art: draws as plain ground' : undefined,
  })),
  ...[0, 1, 2, 3].map((d) => ({ code: 0xb0 + d, group: 'warp' as const, label: `warp ${DIRS[d]}`, note: 'one pair; the arrow is the exit heading' })),
  { code: WATER, group: 'water', label: 'water', note: 'on flat ground or slopes $04-$0F' },
];

function hex(v: number): string {
  return `$${v.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** The palette's entry for a byte (water: any $61, $64-$6F). */
export function paletteEntry(tile: number): PaletteEntry | null {
  if (isWaterTile(tile)) return PALETTE.find((e) => e.code === WATER)!;
  return PALETTE.find((e) => e.code === tile) ?? null;
}

/** The water ($60 + the shape): $61 open water, the rim $64-$6F. $60, $62, $63 hang the ROM. */
export function isWaterTile(t: number): boolean {
  return t === 0x61 || (t >= 0x64 && t <= 0x6f);
}

/** The water byte a cell of this shape takes, or null (only $01 and $04-$0F hold water). */
export function waterTile(shape: number): number | null {
  if (shape === 0x01 || (shape >= 0x04 && shape <= 0x0f)) return 0x60 + shape;
  return null;
}

export function isActorTile(t: number): boolean {
  return t === TEE_TILE || t === 0x02 || isEnemyTile(t) || (t >= 0xb0 && t <= 0xb9);
}

/**
 * Why `tile` may not stand on `shape` (null: it may). The palette's codes
 * only; WATER is resolved against the shape.
 */
export function placementError(tile: number, shape: number): string | null {
  if (tile === 0) return null;
  if (shape === 0) return 'nothing stands on a gap';
  const flatOnly = (what: string): string | null => (shape === 0x01 ? null : `${what} goes on flat ground ($01)`);
  if (tile === WATER || isWaterTile(tile)) {
    return waterTile(shape) === null ? 'water goes on flat ground or the slopes $04-$0F' : null;
  }
  if (tile === TEE_TILE) return flatOnly('the tee');
  if (isEnemyTile(tile)) return shape === 0x01 || shape === 0x04 || shape === 0x05 ? null : 'enemies stand on $01, $04 or $05';
  if (tile >= 0x20 && tile <= 0x23) return shape === 0x04 + (tile - 0x20) ? null : `this ice goes on the ramp $0${(4 + tile - 0x20).toString(16)}`;
  if (tile === 0x34 || tile === 0x36 || tile === 0x38 || tile === 0x3a) {
    const f = (tile - 0x34) / 2;
    return shape === 0x04 + f ? null : `this boost goes on the ramp $0${(4 + f).toString(16)}`;
  }
  if (paletteEntry(tile)) return flatOnly('it');
  return `$${tile.toString(16)} is not in the palette`;
}

/** The byte to paint for a palette code on a cell of this shape. */
export function paintByte(code: number, shape: number): number | null {
  if (code === WATER) return waterTile(shape);
  return code;
}

/**
 * A cell's tile after its shape changed: the water follows the shape, the
 * ice and the boosts follow a ramp's fall (and turn into their flat kin),
 * actors stay (lint reports them); 0 when the marking cannot stay.
 */
export function adaptTile(tile: number, shape: number): number {
  if (tile === 0) return 0;
  if (shape === 0) return 0;
  if (isActorTile(tile)) return tile;
  const fall = rampFall(shape);
  if (isWaterTile(tile)) return waterTile(shape) ?? 0;
  if ((tile >= 0x20 && tile <= 0x24)) {
    if (fall >= 0) return 0x20 + fall;
    return shape === 0x01 ? 0x24 : 0;
  }
  if (tile === 0x34 || tile === 0x36 || tile === 0x38 || tile === 0x3a) {
    if (fall >= 0) return 0x34 + 2 * fall;
    // the boost pushed uphill: on flat ground it keeps that heading
    const uphill = (((tile - 0x34) / 2) + 2) & 3;
    return shape === 0x01 ? 0x30 + uphill : 0;
  }
  if (tile >= 0x30 && tile <= 0x33 && fall >= 0) return 0x34 + 2 * fall;
  return placementError(tile, shape) === null ? tile : 0;
}
