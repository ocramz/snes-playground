/**
 * The level editor's site (docs/editor.md "The site"): the songs
 * tools/stage_editor_site.py keeps are the songs a level can request, the
 * event table's less the ROM holes' own (6-14 but HOLE_SONG). A song missing
 * there would be a failed request on the published page.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EVENT_TABLE, SONG_STOP } from '../src/game/features/audio/event-table';
import { HOLE_SONG } from '../src/core/traits/flow';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('the editor site\'s songs', () => {
  it('LEVEL_SONGS are the songs a level requests', () => {
    const src = readFileSync(resolve(here, '../../tools/stage_editor_site.py'), 'utf8');
    const m = /^LEVEL_SONGS = \[([\d, ]+)\]/m.exec(src);
    expect(m).not.toBeNull();
    const staged = m![1].split(',').map((s) => Number(s.trim())).sort((a, b) => a - b);
    const level = EVENT_TABLE.song.ids
      .filter((n) => n !== SONG_STOP && (n < 6 || n > 14 || n === HOLE_SONG))
      .sort((a, b) => a - b);
    expect(staged).toEqual(level);
  });
});
