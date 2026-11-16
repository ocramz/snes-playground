/**
 * The aim stage's other inputs and the score panel (port_v2 phase 7, read
 * 2026-11-16; notes/port-v2-phase7-shell.md): the loop `$81:A680`-`$81:A80A`
 * beside the d-pad and A.
 *
 * - Start opens the pause menu (`$83:AFA7`); while it is open the aim
 *   iteration runs `$81:BDAD` instead of the d-pad. The hole goes on: the
 *   threads, Kirby's pose and the guide keep running.
 * - B held is the spin preset (`$83:B214`): the shot panel comes up and the
 *   d-pad steps the side `$D9B8` and, in a fly shot, the top/back `$D9BA`.
 * - Y held is the look around (`$81:B9A2`): the d-pad moves the camera
 *   inside the hole's bounds; the release pans it back to the aim's target.
 * - The idle timer `$6AC2` (90 quiet iterations) shows the score panel.
 */
import { trait } from 'koota';
import type { CourseState } from './course';

export const AimUi = trait({
  /** $EA7E: the pause menu is open. */
  pause: 0,
  /** $6AC4: its cursor, 0-2. */
  cursor: 0,
  /** $EA80: the spin preset is up (B held; object $10, the panel). */
  preset: 0,
  /** $6AAE: the look around: set while Y is held with the d-pad, cleared once the pan back arrives. */
  look: 0,
  /** $6ABA: the look's arrows ($81:B908): bit 0 on, bit 1 started, bit 2 shown. */
  arrows: 0,
  /** $6ABC: frames until the arrows blink (19 shown, 9 hidden). */
  arrowTimer: 0,
  /** $6B38: aim iterations that skip B ($81:A691): 20 from the spin stage ($81:BF44), 0 after a set-up ($80:F313). */
  lockout: 0,
  /** 1 when this aim iteration reached the pan toward the aim's target ($81:A7B5, $81:A756). */
  pan: 1,
  /**
   * The pause menu's longjmp (`$80:843E`), for the shell to take: 0 none,
   * 1 COURSE SELECT SCREEN (`$16E3`, the map), 2 QUIT (`$16D9`, the title),
   * 3 RESTART (`$16CF`, MAP SELECT's menu only).
   */
  jump: 0,
  /** SELECT's mid-course card (`$81:BCB6` -> `$83:C8DD`): the frame of the press that opened it, 0 none. */
  cardAt: 0,
  /** ... and of the SELECT that closes it, 0 not yet. */
  cardPress: 0,
});

/**
 * The score panel at the screen's bottom (BG3, `$83:AEEB` shows it,
 * `$83:AF82` hides it, `$83:AF96` hides it silently), and the HUD thread's
 * enable `$691A`: the thread (`$84:98EC`, the tomato queue) does nothing
 * while it is 0.
 */
export const ScorePanel = trait({
  /** $EA7C */
  shown: 0,
  /** $691A */
  hudOn: 0,
});

/** The pause menu's items ($83:AFE4: CONTINUE, COURSE SELECT SCREEN, QUIT). */
export const PAUSE_ITEMS = 3;
/** $81:A64A, $81:A6F2, $81:A7D7: the idle timer's start. */
export const IDLE_FRAMES = 90;
/** $81:BF42: the lockout the spin stage leaves for an aim after a cancel. */
export const AIM_LOCKOUT = 20;
/** $83:B276: the preset's d-pad repeat ($6B5C counts up to it). */
export const PRESET_REPEAT = 12;
/** $80:DD07 / $80:DD09: the look's step per frame in x and y. */
export const LOOK_STEP_X = 6;
export const LOOK_STEP_Y = 3;

/** The hole's bounds for the look ($81:B8EB, at the hole's load): x in [-32, $8B98], y in [0, $8B9A + $E0]. */
export function lookBounds(c: CourseState): { xMin: number; xMax: number; yMin: number; yMax: number } {
  return { xMin: -32, xMax: c.mapWidth, yMin: 0, yMax: c.screenBase + 0xe0 };
}
