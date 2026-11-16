/**
 * The copy abilities' presentation state (sim/kirby-colours.ts,
 * systems/ability-fx.ts; notes/port-v2-phase5-abilities.md): Kirby's
 * colours, the HUD's ability display, and the palette objects. World
 * singleton; the colours and the objects are reset at the hole's start, the
 * HUD's phases are not (they run free from the course's panel set-up,
 * `$83:AA4B`; the tests seed them from the recording).
 */
import { trait } from 'koota';
import type { BurntRun, SparkPalRun, UfoPalRun } from '../sim/kirby-colours';
import type { AbilityObject } from '../sim/ability-objects';

export interface AbilityHudState {
  /** `$5B1C` of the HUD object: the outline's phase (0-41). */
  outlinePhase: number;
  /** `$551C`: the icon ground's phase (0-31). */
  iconPhase: number;
  /** The icon ground's colour (OBJ palette 1 colour 9, `$0532`), BGR555. */
  ground: number;
  /** `$D862`: the ability-0 take's face, ticks left (30 from the take). */
  face: number;
  /**
   * The icon's picture: the upload descriptor `$84:9B88` (the stock's,
   * `$84:9E07`/`$84:9E67`/`$84:9E78`) or the UFO's countdown (`$84:A554`,
   * `$84:A584`) last queued; the view draws it (hud.json `ability`).
   */
  icon: number;
  /** The draw's memory: `$531C` the stock, `$559C` the latch, `$569C` `$6AC0`, `$BA` the index. */
  seenStock: number;
  seenLatch: number;
  seenMode: number;
  index: number;
  /** Object 49's countdown on the icon (`$84:A4E6`): `$559C`, `$551C`, `$561C`; off when null. */
  ufo: { timer: number; step: number; digits: number; started: boolean } | null;
}

export interface AbilityFxState {
  /** Kirby's OBJ palette 0 colours 2-8 (the CGRAM shadow `$0504`-`$0510`), BGR555. */
  colours: number[];
  hud: AbilityHudState;
  /** Object 29, the burnt fade. */
  burnt: BurntRun | null;
  /** Object 36, Spark's colours. */
  spark: SparkPalRun | null;
  /** Object 50, the UFO's colours. */
  ufo: UfoPalRun | null;
  /** Object 27 alive: Freeze's frost restores set 3 when it goes on `$D76C`. */
  frost: boolean;
  /** The drawn objects (sim/ability-objects.ts), in slot order. */
  objects: AbilityObject[];
  /**
   * Object 49's thread (`$85:ADA0`), its sounds: the hum's timer `$549C`,
   * its loop (A flying, B `$D77A` = 1, C wearing off), the holed countdown `$569C`.
   */
  ufoBody: { started: boolean; hum: number; loop: 'A' | 'B' | 'C'; holed: number } | null;
}

/** The icon's descriptors: Kirby standing (`$84:9E67`), the face after an ability-0 take (`$84:9E78`). */
export const HUD_STANDING = 0x9e67;
export const HUD_FACE = 0x9e78;

/** Set 3, dry (tables.json `kirbyDry`, `$98:C77A`): the power-on colours. */
export const DRY_COLOURS = [0x2c9c, 0x453f, 0x61df, 0x7a7f, 0x7f5f, 0x0c63, 0x18e2];

export const AbilityFx = trait((): AbilityFxState => ({
  colours: [...DRY_COLOURS],
  hud: {
    outlinePhase: 0, iconPhase: 0, ground: 0x001f, face: 0, icon: HUD_STANDING,
    seenStock: 0x9999, seenLatch: 0x9999, seenMode: 0, index: 0, ufo: null,
  },
  burnt: null,
  spark: null,
  ufo: null,
  frost: false,
  objects: [],
  ufoBody: null,
}));
