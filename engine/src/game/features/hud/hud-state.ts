/**
 * What the score panel shows (pure; docs/web-demo.md "Score panel": cropped
 * from the game, numbers redrawn). Strokes.n is $D82A, strokes + 1 (1 at the
 * hole's start, +1 at each set-up), so the shot shown is n - 1.
 */
import type { World } from 'koota';
import { Session } from '../../../core/traits/session';
import { findActivePlayer } from '../../../core/traits/player';
import { Career, Stars, Strokes, Tomatoes } from '../../../core/traits/counters';
import { HoleFlow } from '../../../core/traits/flow';
import { AimUi, ScorePanel, lookBounds } from '../../../core/traits/aim-ui';
import { Course } from '../../../core/traits/course';
import { Camera } from '../../../core/traits/camera';
import { AbilityFx } from '../../../core/traits/ability-fx';

export interface HudState {
  hole: number;
  shot: number;
  tomatoes: number;
  stars: number;
  lives: number;
  /** The copy ability's icon: its picture (the upload descriptor), its ground's colour (BGR555). */
  icon: number;
  ground: number;
}

export function hudState(world: World): HudState | null {
  const ball = findActivePlayer(world);
  const session = world.get(Session);
  if (ball === undefined || !session || session.holeIndex < 0) return null;
  return {
    hole: session.holeIndex + 1,
    shot: Math.max(0, ball.get(Strokes)!.n - 1),
    tomatoes: ball.get(Tomatoes)!.n,
    stars: ball.get(Stars)!.n,
    lives: world.get(Career)!.lives,
    icon: world.get(AbilityFx)?.hud.icon ?? -1,
    ground: world.get(AbilityFx)?.hud.ground ?? 0x001f,
  };
}

/**
 * The score panel shows exactly when the game's `$EA7C` is set (port_v2
 * phase 7: core's ScorePanel, written at the game's sites: the aim's idle
 * timer and Y, the HUD thread's tomato display, the lost ball, the
 * out-of-tomatoes sleep, the hole-out). Outside a hole it is hidden.
 */
export function hudHidden(world: World): boolean {
  const phase = world.get(HoleFlow)!.phase;
  if (phase === 'Idle' || phase === 'CourseDone') return true;
  return world.get(ScorePanel)!.shown === 0;
}

/** The pause menu ($83:AFA7): open, and the cursor's item. */
export function pauseState(world: World): { open: boolean; cursor: number } {
  const ui = world.get(AimUi)!;
  return { open: ui.pause !== 0, cursor: ui.cursor };
}

/**
 * The look's arrows ($81:B908): while `$6ABA` bit 2 is set, an arrow for each
 * way the camera can still move (`$81:B943`-`$81:B99D`, the bounds'
 * signed tests).
 */
export function lookArrowsState(world: World): { up: boolean; right: boolean; down: boolean; left: boolean } {
  const ui = world.get(AimUi)!;
  const none = { up: false, right: false, down: false, left: false };
  if (world.get(HoleFlow)!.phase !== 'Aim' || (ui.arrows & 4) === 0) return none;
  const c = world.queryFirst(Course)?.get(Course);
  if (!c) return none;
  const b = lookBounds(c);
  const cam = world.get(Camera)!;
  const s = (v: number): number => ((v & 0xffff) >= 0x8000 ? (v & 0xffff) - 0x10000 : v & 0xffff);
  return {
    up: s(cam.y - b.yMax) < 0,
    right: s(cam.x - b.xMax) < 0,
    down: s(cam.y - b.yMin) >= 0,
    left: s(cam.x - b.xMin) >= 0,
  };
}
