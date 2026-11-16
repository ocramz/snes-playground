/**
 * The save as a world singleton (port_v2 phase 7; core/save.ts has the rules,
 * docs/save.md the layout). `version` goes up on every write, so the host's
 * save store knows when to persist; `member` is the member playing (`$EAB7`,
 * -1 for none: the dev menu's and the random holes' courses keep no save);
 * `last` the last course's result (`$EC4B`, `$D7E0`, `$EC4D`) for the shell.
 */
import { trait } from 'koota';
import { emptySave, type CourseResult, type SaveData } from '../save';

export interface SaveState {
  data: SaveData;
  version: number;
  member: number;
  last: CourseResult | null;
}

export const Save = trait((): SaveState => ({ data: emptySave(), version: 0, member: -1, last: null }));

/** Mark the save written (the host persists it). */
export function touchSave(s: SaveState): void {
  s.version += 1;
}
