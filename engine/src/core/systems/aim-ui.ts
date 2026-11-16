/**
 * The aim stage's other inputs and the score panel's sites (port_v2 phase 7,
 * read 2026-11-16; traits/aim-ui.ts, notes/port-v2-phase7-shell.md). The
 * aim iteration (systems/aim.ts) calls these in the game's order.
 */
import type { World } from 'koota';
import { AimUi, ScorePanel, PAUSE_ITEMS, IDLE_FRAMES, PRESET_REPEAT, LOOK_STEP_X, LOOK_STEP_Y, lookBounds } from '../traits/aim-ui';
import { Shot } from '../traits/shot';
import { Camera } from '../traits/camera';
import { Course, courseEntity } from '../traits/course';
import { PAD } from '../sim/aim';
import { Time } from '../traits/time';
import { Screen } from '../traits/screen';
import { emitEvent } from './flow-util';
import { s16 } from '../fixed';

/** `$83:AEEB`: the score panel shows (`$EA7C` = 1, `$691A` = 1). `$69A0` (2P) gates it; 0 in 1P. */
export function showPanel(world: World): void {
  world.set(ScorePanel, { shown: 1, hudOn: 1 });
}

/** `$83:AF82`: the score panel hides (`$691A` = 1). */
export function hidePanel(world: World): void {
  world.set(ScorePanel, { shown: 0, hudOn: 1 });
}

/** `$83:AF96`: the score panel hides and the HUD thread stops (`$691A` = 0). */
export function silentHidePanel(world: World): void {
  world.set(ScorePanel, { shown: 0, hudOn: 0 });
}

export function panelShown(world: World): boolean {
  return world.get(ScorePanel)!.shown !== 0;
}

/**
 * `$83:AFA7`: Start in the aim opens the pause menu: the panel hides
 * silently (`$83:AF96`), `$EA7E` = 1, palette set `$0A`, the window and its
 * text (`$83:AFE4`, CONTINUE / COURSE SELECT SCREEN / QUIT, through
 * `$83:B33D`), the cursor on CONTINUE.
 */
export function openPause(world: World): void {
  silentHidePanel(world);
  world.set(AimUi, { ...world.get(AimUi)!, pause: 1, cursor: 0 });
}

/**
 * `$81:BDAD`, the aim iteration while the menu is open:
 * - B or Start closes it (the idle timer 90, `$691A` = 1, palette set 9,
 *   `$83:B326` puts the BG3 map back);
 * - Up / Down move the cursor within 0-2 (`$81:BE4F`), one press a frame;
 * - A: CONTINUE closes it; COURSE SELECT SCREEN and QUIT longjmp to the
 *   map (`$16E3`) and the title (`$16D9`) through `$80:843E`.
 * No sound is requested (the stepper's log of web_pause).
 */
export function pauseMenu(world: World, pressed: number): void {
  const ui = world.get(AimUi)!;
  const close = (): void => {
    world.set(AimUi, { ...world.get(AimUi)!, pause: 0 });
    world.set(Shot, { ...world.get(Shot)!, idle: IDLE_FRAMES });
    world.set(ScorePanel, { ...world.get(ScorePanel)!, hudOn: 1 });
  };
  if ((pressed & (PAD.B | PAD.START)) !== 0) {
    close();
    return;
  }
  if ((pressed & PAD.UP) !== 0 && ui.cursor - 1 >= 0) {
    world.set(AimUi, { ...ui, cursor: ui.cursor - 1 });
    return;
  }
  if ((pressed & PAD.DOWN) !== 0 && ui.cursor + 1 < PAUSE_ITEMS) {
    world.set(AimUi, { ...ui, cursor: ui.cursor + 1 });
    return;
  }
  if ((pressed & PAD.A) === 0) return;
  if (ui.cursor === 0) close();
  else world.set(AimUi, { ...ui, jump: ui.cursor === 1 ? 1 : 2 });
}

/**
 * `$83:B214`, every aim iteration while B is held: the spin preset.
 * - Its first frame: `$EA80` = 1, the repeat `$6B5C` and `$6B62` cleared,
 *   the meter `$FFFF`, the panel object `$10` at (`$83:B322`[player], `$BF`),
 *   and the score panel hides if it showed.
 * - Every frame: the idle timer 90, `$691A` = 0 (the HUD thread stops).
 * - The d-pad: Left/Right step the side `$D9B8` within 0-12; Up/Down the
 *   top/back `$D9BA` within 0-12, only in a fly shot (`$D9B6` ≠ 0). A step
 *   marks the aim changed (`$6AE0`), so the guide is drawn again with the
 *   spin. `$6B5C` repeats a held direction: a step, then one each time it
 *   counts up to 12.
 * - Then `$6B50`/`$6B52` = `$D9B8`/`$D9BA`: the panel shows them.
 */
export function presetStep(world: World, held: number): void {
  const ui = world.get(AimUi)!;
  const shot = { ...world.get(Shot)! };
  if (ui.preset === 0) {
    world.set(AimUi, { ...ui, preset: 1 });
    shot.sideTimer = 0; // $6B5C
    shot.tbTimer = 0; // $6B62
    shot.meter = 0xffff; // $6B3A
    if (panelShown(world)) hidePanel(world); // $83:B24B
  }
  shot.idle = IDLE_FRAMES;
  world.set(ScorePanel, { ...world.get(ScorePanel)!, hudOn: 0 }); // $83:B255
  if ((held & PAD.DPAD) === 0) {
    shot.sideTimer = 0;
  } else {
    // one direction's arm ($83:B266-$83:B28C): the shared repeat, then the step
    const arm = (dir: number, field: 'guideSide' | 'guideTB', down: boolean): void => {
      if ((held & dir) === 0) return;
      if (shot.sideTimer !== 0) {
        shot.sideTimer += 1;
        if (shot.sideTimer < PRESET_REPEAT) return;
        shot.sideTimer = 0;
      }
      if (down ? shot[field] === 0 : shot[field] >= 12) return;
      shot[field] += down ? -1 : 1;
      shot.changed += 1;
      shot.sideTimer += 1;
    };
    arm(PAD.LEFT, 'guideSide', true);
    arm(PAD.RIGHT, 'guideSide', false);
    if (shot.elev !== 0) {
      arm(PAD.UP, 'guideTB', true);
      arm(PAD.DOWN, 'guideTB', false);
    }
  }
  shot.side = shot.guideSide;
  shot.topBack = shot.guideTB;
  world.set(Shot, shot);
}

/** `$81:A6DA`: B released after the preset: the panel object goes (`$80:E060`), `INC $691A`, `$EA80` = 0. */
export function endPreset(world: World): void {
  world.set(AimUi, { ...world.get(AimUi)!, preset: 0 });
  const p = world.get(ScorePanel)!;
  world.set(ScorePanel, { ...p, hudOn: p.hudOn + 1 });
}

/**
 * `$81:B9A2`: Y and the d-pad move the world camera `$38AC`/`$38AE` by
 * (6, 3) a frame while it is inside the bounds (signed 16-bit tests: Right
 * while x < xMax, Left while x ≥ xMin, Up while y < yMax, Down while
 * y ≥ yMin).
 */
export function lookScroll(world: World, held: number): void {
  const b = lookBounds(courseEntity(world).get(Course)!);
  const cam = { ...world.get(Camera)! };
  if ((held & PAD.RIGHT) !== 0 && s16((cam.x - b.xMax) & 0xffff) < 0) cam.x = (cam.x + LOOK_STEP_X) & 0xffff;
  if ((held & PAD.LEFT) !== 0 && s16((cam.x - b.xMin) & 0xffff) >= 0) cam.x = (cam.x - LOOK_STEP_X) & 0xffff;
  if ((held & PAD.UP) !== 0 && s16((cam.y - b.yMax) & 0xffff) < 0) cam.y = (cam.y + LOOK_STEP_Y) & 0xffff;
  if ((held & PAD.DOWN) !== 0 && s16((cam.y - b.yMin) & 0xffff) >= 0) cam.y = (cam.y - LOOK_STEP_Y) & 0xffff;
  world.set(Camera, cam);
}

/**
 * `$81:B908`, at the end of every aim iteration: while `$6ABA` is set, its
 * arrows blink, shown 20 frames and hidden 10 (`$6ABC`: 19, then 9). The
 * view draws the arrows of the directions the camera can still move.
 */
export function lookArrows(world: World): void {
  const ui = { ...world.get(AimUi)! };
  if (ui.arrows === 0) return;
  if ((ui.arrows & 2) === 0) {
    ui.arrows = 2; // $81:B90E: AND #2, then ORA #2 (bit 0 is dropped)
    ui.arrowTimer = 0;
  }
  ui.arrowTimer -= 1;
  if (ui.arrowTimer < 0) {
    ui.arrows ^= 4;
    ui.arrowTimer = (ui.arrows & 4) !== 0 ? 0x13 : 0x09;
  }
  world.set(AimUi, ui);
}


/**
 * `$81:BCB6`, at the top of every aim iteration: SELECT pressed (outside MAP
 * SELECT's `$ED9B`) shows the mid-course card, BEST and YOUR SCORE, and the
 * iteration blocks in it (web_card: SELECT at 5100, closed at 5300):
 * - the fade out, 14 at S + 1 to 0 at S + 15, the blank at S + 16, where
 *   `$83:AF96` hides the score panel silently and `$83:C8DD` builds the cards;
 * - the fade in, 1 at S + 31 to 15 at S + 45 (the cards slide in, `$80:B600`);
 * - SELECT pressed again (P): the fade out to the blank at P + 16; the hole's
 *   graphics back; at P + 26 the fade in starts, the hole's song is requested
 *   again (`$80:C967`), the idle timer 90, `$691A` = 1, the pause closed;
 *   15 at P + 40, where the iteration goes on.
 * Returns true while the card holds the iteration.
 */
export const SCORECARD_FADE = 16;
export const SCORECARD_IN = 30;
export const SCORECARD_BACK = 26;

export function scorecard(world: World, pressed: number, song: number): boolean {
  const ui = world.get(AimUi)!;
  const f = world.get(Time)!.frame;
  if (ui.cardAt === 0) {
    if ((pressed & PAD.SELECT) === 0) return false;
    world.set(AimUi, { ...ui, cardAt: f, cardPress: 0 });
    return true;
  }
  const scr = (bright: number, blank = 0): void => world.set(Screen, { bright, blank });
  if (ui.cardPress === 0) {
    const k = f - ui.cardAt;
    if (k < SCORECARD_FADE) scr(15 - k);
    else if (k === SCORECARD_FADE) {
      scr(0, 1);
      silentHidePanel(world);
    } else if (k > SCORECARD_IN && k <= SCORECARD_IN + 15) scr(k - SCORECARD_IN);
    if (k >= SCORECARD_IN + 15 && (pressed & PAD.SELECT) !== 0) world.set(AimUi, { ...ui, cardPress: f });
    return true;
  }
  const j = f - ui.cardPress;
  if (j < SCORECARD_FADE) scr(15 - j);
  else if (j === SCORECARD_FADE) scr(0, 1);
  else if (j === SCORECARD_BACK) {
    scr(1);
    emitEvent(world, 'song', song); // $81:BD78 -> $80:C967
    world.set(Shot, { ...world.get(Shot)!, idle: IDLE_FRAMES });
    world.set(ScorePanel, { ...world.get(ScorePanel)!, hudOn: 1 });
    world.set(AimUi, { ...world.get(AimUi)!, pause: 0 });
  } else if (j > SCORECARD_BACK && j < SCORECARD_BACK + 14) scr(j - SCORECARD_BACK + 1);
  else if (j >= SCORECARD_BACK + 14) {
    scr(15);
    world.set(AimUi, { ...world.get(AimUi)!, cardAt: 0, cardPress: 0 });
    return false; // $81:BDAC RTS: the iteration goes on this frame
  }
  return true;
}

/**
 * The head of `$81:A619` (with the set-up's `$80:C5F1`): the look, its
 * arrows, the preset and the pause cleared (`$81:A620`-`$81:A629`); Y held
 * already starts the look (`$81:A672`). The idle timer is the set-up's.
 */
export function aimHead(world: World, held: number): void {
  const y = (held & PAD.Y) !== 0;
  world.set(AimUi, { ...world.get(AimUi)!, look: y ? 1 : 0, arrows: y ? 1 : 0, preset: 0, pause: 0 });
}
