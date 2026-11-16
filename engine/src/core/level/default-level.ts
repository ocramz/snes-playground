/**
 * The level the editor opens on when the URL carries none: a fenced island
 * with a raised terrace (made with the editor's own raise, so its slopes are
 * the ones a user gets), the tee and three enemies. The solver holes it out
 * (test/level-play.test.ts).
 */
import { HoleGrid } from '../gen/grid';
import { TEE_TILE } from '../sweep';
import { autoFence, paintTile, raise, type Level } from './ops';
import { rectCells } from './select';

export const DEFAULT_NAME = 'CUSTOM_001';

export function defaultLevel(): Level {
  const g = new HoleGrid(14, 10);
  g.rect(1, 1, 12, 8, { shape: 0x01, elev: 1 });
  let level: Level = { name: DEFAULT_NAME, grid: g };
  level = raise(level, rectCells(g, 8, 3, 10, 6), 1, 'slope').level;
  level = paintTile(level, new Set([g.at(2, 4)]), TEE_TILE).level;
  level = paintTile(level, new Set([g.at(5, 2)]), 0x40).level;
  level = paintTile(level, new Set([g.at(9, 4)]), 0x4a).level;
  level = paintTile(level, new Set([g.at(5, 7)]), 0x4b).level;
  level = paintTile(level, new Set([g.at(3, 7)]), 0x02).level;
  return autoFence(level).level;
}
