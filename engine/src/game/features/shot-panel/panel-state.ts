/**
 * The shot panel's state, derived from the world (pure). Core has no panel
 * flags: the panel's objects ($10 the panel, $12 the "1", $18 the meter) are
 * presentation spawns of the shot thread (notes/engine-phase5-flow.md). Their
 * timing is measured on web_ui (panel-layout.ts) from the aim's A; the shot
 * thread spawns them after the pan, from the curl, so the age is counted from
 * the Spin phase's start (the curl) plus SPIN_LEAD, the A -> curl of that run
 * (pinned by test/panel-state.test.ts).
 *
 * Frames: a snapshot f of the stepper holds the WRAM at the end of frame
 * f - 1 and shows the picture built in it, so what the host draws after core
 * frame n is the game's snapshot n + 1 (DISPLAY_LAG). ui.json's ages and the
 * tomato's blink were measured on snapshots; the meter's lags (history.ts)
 * and the closings below are in core frames.
 *
 * Closing, from R, the core frame the meter latched (LaunchDelay's start;
 * web_ui R = 3250, snapshots 3240-3281): the gauge goes at R + 1 (the meter
 * reads 0, whose gauge is empty), the panel at R + 22 (the roll's first
 * frame), the "1" at R + 25.
 */
import type { World } from 'koota';
import { HoleFlow, type FlowPhase } from '../../../core/traits/flow';
import { Shot } from '../../../core/traits/shot';
import { Time } from '../../../core/traits/time';
import { Camera } from '../../../core/traits/camera';
import { BallScreen } from '../../../core/traits/pose';
import { BallWork } from '../../../core/traits/ball';
import { Tomatoes } from '../../../core/traits/counters';
import type { CoreHistory } from '../../bridge/history';
import type { PanelInput } from './panel-layout';

/** web_ui: the aim's A at 2800, the curl (state 6) at 2826. */
export const SPIN_LEAD = 26;
/** The picture drawn after core frame n is the game's snapshot n + 1. */
export const DISPLAY_LAG = 1;
/** From the latch: the panel goes with the roll's first frame, the "1" three frames later. */
export const PANEL_CLOSE_AT = 22;
export const ONE_CLOSE_AT = 25;
/** The tomato about to be spent blinks with this period, from the curl. */
export const TOMATO_BLINK = 16;

const OPEN: ReadonlySet<FlowPhase> = new Set<FlowPhase>(['Spin', 'Power', 'LaunchDelay', 'Rolling']);

const s16 = (v: number): number => {
  const w = v & 0xffff;
  return w >= 0x8000 ? w - 0x10000 : w;
};

export const HIDDEN: PanelInput = {
  x: 0, y: 0, age: 0, visible: false, side: 6, topBack: 6, meter1: -1, meter2: -1, hp: 0,
};

export function panelState(world: World, history: CoreHistory): PanelInput {
  const flow = world.get(HoleFlow)!;
  if (!OPEN.has(flow.phase)) return HIDDEN;
  const spin = history.since('Spin');
  if (spin === undefined) return HIDDEN;
  const f = world.get(Time)!.frame;
  const latch = flow.phase === 'LaunchDelay' || flow.phase === 'Rolling' ? history.since('LaunchDelay') : undefined;
  if (latch !== undefined && f - latch >= ONE_CLOSE_AT) return HIDDEN;
  if (flow.phase === 'Rolling' && latch === undefined) return HIDDEN;
  const ball = world.queryFirst(BallWork);
  if (ball === undefined) return HIDDEN;
  const sc = ball.get(BallScreen)!;
  const cam = world.get(Camera)!;
  const shot = world.get(Shot)!;
  const blinking = flow.phase === 'Power' || flow.phase === 'LaunchDelay';
  return {
    x: s16(sc.x - cam.x),
    y: s16(cam.y - sc.y),
    age: SPIN_LEAD + (f + DISPLAY_LAG - spin),
    visible: true,
    side: shot.side,
    topBack: shot.topBack,
    meter1: history.meterAgo(1),
    meter2: history.meterAgo(2),
    hp: ball.get(Tomatoes)!.n,
    panel: latch === undefined || f - latch < PANEL_CLOSE_AT,
    one: true,
    blinkOff: blinking && (((f + DISPLAY_LAG - spin) % TOMATO_BLINK) + TOMATO_BLINK) % TOMATO_BLINK < TOMATO_BLINK / 2,
  };
}
