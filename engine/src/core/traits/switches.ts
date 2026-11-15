/**
 * The switches' and the swirls' threads (port_v2 phase 6; systems/switches.ts,
 * docs/courses.md "The switches' objects"): what the views draw. World
 * singleton, reset at the hole's start. The switches' state itself
 * (`$6A2A`, `$69CA`) is the work copy's (traits/ball.ts), where the
 * kernels read it.
 */
import { trait } from 'koota';

/**
 * Object 127 (`$84:DB6A`, hook `$84:DB97`): one per swirl pair present at
 * the load (`$82:BBAE`), uploading the pair's 14 tiles from a list of 10
 * frames while its group is on, and keeping the last one while it is off.
 */
export interface SwirlAnim {
  /** `$531C`: the pair, 0-5 ($70/$71 ... $7A/$7B); its group is pair >> 1. */
  pair: number;
  /** `$539C`: the record list, 0 for the first object spawned, 1 for the others ($14 bytes on). */
  list: number;
  /** `$541C`: the frame uploaded, -1 none yet (the course page's tiles). */
  frame: number;
  /** `$549C`: the hook's countdown. */
  wait: number;
}

/**
 * Objects 117 / 118 (`$84:85FB` / `$84:864C`, hook `$84:869D`): the switch's
 * four colours, two sets by its state, alternating every 4 frames.
 */
export interface SwitchColours {
  /** The state the thread last saw (`$6A2A` / `$69CA`). */
  on: number;
  /** `$531C`: the set the hook writes next, 0 or 1. */
  next: number;
  /** `$539C`: the countdown to that write. */
  wait: number;
  /** The set in CGRAM, -1 none written yet. */
  shown: number;
}

export interface SwitchesState {
  anims: SwirlAnim[];
  /** Object 117, the toggles' switch (null: no `$5A`/`$5B` on the hole). */
  toggle: SwitchColours | null;
  /** Object 118, the water switch (null: no `$5C`/`$5D`). */
  water: SwitchColours | null;
  /**
   * The water's dissolve (`$80:9120` / `$80:9208`): the steps done, 0-64,
   * each one pixel position of every water tile; `appear` 1 while the water
   * comes in. At rest: 64, and `appear` = the water on.
   */
  dissolve: { step: number; appear: number };
  /** Object 113's clock: the frames its hook ran (`$84:8533` stops while `$69CA` is set). */
  rippleTicks: number;
}

export const Switches = trait((): SwitchesState => ({
  anims: [],
  toggle: null,
  water: null,
  dissolve: { step: 64, appear: 1 },
  rippleTicks: 0,
}));
