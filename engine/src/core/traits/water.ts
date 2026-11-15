/**
 * The water's effects (sim/water-fx.ts): the live splashes (objects 53-58)
 * and bubble emitters (object 67), and the game's random number state
 * (`$0079`/`$007B`, sim/rng.ts), which in a 1P hole only the bubbles draw
 * on. World singleton; the splashes and bubbles are reset at the hole's
 * start, the random state is not (the game's carries over from the menus;
 * the tests seed it from the recording).
 */
import { trait } from 'koota';
import type { BubbleRun, SplashRun } from '../sim/water-fx';
import type { RngState } from '../sim/rng';

export interface WaterFxState {
  splashes: SplashRun[];
  bubbles: BubbleRun[];
  /** Tests: called between an object's thread and its draw, every tick (a tick can straddle a recorded frame). */
  between?: (r: SplashRun | BubbleRun) => void;
}

export const WaterFx = trait((): WaterFxState => ({ splashes: [], bubbles: [] }));

/** The game's random numbers ($80:87DD). The power-on value is what $80:BF98/$80:BF9E store. */
export const GameRng = trait((): RngState => ({ a: 0x0701, b: 0x0001 }));

/**
 * Kirby's OBJ palette 0 colours 2-8 ($82:8604 -> sub_cgram_partial): 1 while
 * the last write was the wet set (`$98:C796`), 0 for the dry one
 * (`$98:C77A`). Per player; the view picks Kirby's frames by it.
 */
export const KirbyPalette = trait({ wet: 0 });
