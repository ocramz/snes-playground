/**
 * The screen's brightness (port_v2 phase 7): the game's `$007E` (0-15, the
 * fades `$80:8FC8` / `$80:8FD8` step it once a frame through `$007F`/`$0080`)
 * and the forced blank (`$007D` bit 7). Core sets it where the shell's
 * screens fade (the RESULT card, and later the menus); the view draws a black
 * veil of 1 - bright / 15. The hole's own fades are the cutscene replay's.
 */
import { trait } from 'koota';

export const Screen = trait({
  /** $007E: 0-15. */
  bright: 15,
  /** $007D bit 7: the forced blank, nothing shown. */
  blank: 0,
});
