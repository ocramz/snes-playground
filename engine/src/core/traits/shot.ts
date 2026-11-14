import { trait } from 'koota';

/**
 * World singleton: the shot being set up and taken (plans/port_v1_koota_
 * phaser4.md "World singletons"). The original keeps these as globals of
 * the shot driver; one shot is in progress at a time (2P alternates turns),
 * so they are not per player. Every field names its WRAM word; the flow
 * systems (aim, spin, power, launch) own them and the ball step reads aim
 * and elevation through the work copy.
 *
 * Signed quantities (the selector and meter directions) are kept as plain
 * JS numbers; the words the step consumes (aim, elevation, power) stay the
 * raw 16-bit patterns the 65816 holds ($FFFF for the set-up's "none").
 */
export const Shot = trait({
  /** $D9B4: aim phi, degrees 0-359 (0 = +x, 90 = +y). */
  aim: 0,
  /** $D9B6: elevation, degrees: 0 grounder, 60 fly shot ($FFFF during set-up). */
  elev: 0,
  /** $6AD6: the shot-kind state of the d-pad handler: 0 grounder, 1 grounder
   *  after a Down press, 2 fly shot ($81:B5F9/$81:B661). */
  kind: 0,
  /** $6AD8: 1 while a grounder is chosen; the launch then uses elevation 0
   *  ($81:BA13). */
  grounder: 1,
  /** $6ADE: frames a direction has been held ($81:B555): the auto-repeat
   *  starts at 15 (+3 per step), Up waits until 30 after a turn. */
  hold: 0,
  /** $6AE0: the aim or the shot kind changed in this aim iteration. */
  changed: 0,
  /** $6B50 / $6B52: the side and top/back selectors, 0-12, 6 = none. */
  side: 6,
  topBack: 6,
  /** $D9B8 / $D9BA: the selectors the shot guide sees. */
  guideSide: 6,
  guideTB: 6,
  /** $6B5C: frames until the next side step ($81:C1C7; 1, then 8). */
  sideTimer: 1,
  /** $6B62: frames until the next top/back step ($6B5E = 3, doubled at 0/6/12). */
  tbTimer: 3,
  /** $6B60: the top/back direction, -1 or +1. */
  tbDir: -1,
  /** $6B3A: the power meter, 0-63 ($6B3C). */
  meter: 0,
  /** $6B3E: the meter's direction, +1 or -1. */
  meterDir: 1,
  /** $6ADC: the shot power P ($81:C2E6). */
  power: 0,
  /** $6B54 / $6B58: the selectors latched at the shot; they pick the roll's
   *  animation state ($82:C815-$82:C84E). */
  rollSide: 6,
  rollTB: 6,
  /** $6AE2-$6AEC: the ball's position when the aim stage began ($81:BAF3);
   *  the guide starts from it and a lost ball goes back to it. */
  originXf: 0x8000,
  originXc: 0,
  originYf: 0x8000,
  originYc: 0,
  originZ: 0,
  /** $6B44 / $6B46: the shot view, Kirby + ($81:C0F0, $81:C0F8)[quarter]. */
  viewX: 0,
  viewY: 0,
  /** $6B6C-$6B72: the aim target ($82:8E41 nearest free enemy, $82:8B5C the
   *  cup), as cell + 16-bit fraction. */
  targetXf: 0x8000,
  targetXc: 0,
  targetYf: 0x8000,
  targetYc: 0,
  /** $6ACE: how many guide ends to record (1 while the aim moves, then $6ACC). */
  guideEnds: 1,
  /** $6ADA: aim iterations until a fly shot's full guide is drawn (16). */
  guideTimer: 0,
  /** $6AC2: idle aim iterations until the score panel shows (90; recorded,
   *  not acted on in phase 5). */
  idle: 90,
});

/** $6B3C: the meter's top (set at $83:DFCF; emulated: 63). */
export const METER_TOP = 63;
/** $6B5E: the top/back step period ($83:DFE7; emulated: 3). */
export const TB_PERIOD = 3;
/** $6ACC: the number of ends of a fly shot's full guide ($83:DFDA; emulated: 3). */
export const GUIDE_FULL_ENDS = 3;
