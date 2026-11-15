/**
 * What the score panel shows (pure; docs/web-demo.md "Score panel": cropped
 * from the game, numbers redrawn). Strokes.n is $D82A, strokes + 1 (1 at the
 * hole's start, +1 at each set-up), so the shot shown is n - 1.
 */
import type { World } from 'koota';
import { Session } from '../../../core/traits/session';
import { findActivePlayer } from '../../../core/traits/player';
import { Career, Stars, Strokes, Tomatoes } from '../../../core/traits/counters';
import { HoleFlow, type FlowPhase } from '../../../core/traits/flow';
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

/** The phases with the shot panel up; the score panel hides then (the web demo's rule; the game's is not known). */
const PANEL_PHASES: ReadonlySet<FlowPhase> = new Set<FlowPhase>(['Spin', 'Power', 'LaunchDelay']);

export function hudHidden(world: World): boolean {
  const phase = world.get(HoleFlow)!.phase;
  return PANEL_PHASES.has(phase) || phase === 'Idle' || phase === 'CourseDone';
}
