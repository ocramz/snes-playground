/**
 * Per-core-frame samples the presentation needs but core does not keep
 * (pure; no Phaser). The host samples after every tick, so a view drawn once
 * per host frame still sees every core frame's value:
 *
 * - the power meter's last three values: the panel's gauge shows the meter
 *   one frame old and its face two frames old (tools/export_web_ui.py: only
 *   lags 1 and 2 make the pictures a pure function of the meter);
 * - the frame each flow phase was last entered on (HoleFlow.since), so the
 *   panel can time itself from the curl (Spin) and the latch (LaunchDelay)
 *   after the phase has moved on;
 * - a tick counter that runs while the core is held (the intro), for the
 *   presentation's own timers (the outline pulse, the guide's march).
 */
import type { World } from 'koota';
import { HoleFlow, type FlowPhase } from '../../core/traits/flow';
import { Shot } from '../../core/traits/shot';
import { Time } from '../../core/traits/time';

export interface FrameSample {
  frame: number;
  phase: FlowPhase;
  meter: number;
}

const METER_PHASES: ReadonlySet<FlowPhase> = new Set<FlowPhase>(['Power', 'LaunchDelay']);

export class CoreHistory {
  private recent: FrameSample[] = [];
  private readonly entered = new Map<FlowPhase, number>();
  /** Ticks since the hole began, the held ones included. */
  ticks = 0;

  reset(): void {
    this.recent = [];
    this.entered.clear();
    this.ticks = 0;
  }

  /** After each tick; `ran` is false while the core was held. */
  sample(world: World, ran: boolean): void {
    this.ticks += 1;
    if (!ran) return;
    const flow = world.get(HoleFlow)!;
    this.entered.set(flow.phase, flow.since);
    this.recent.unshift({ frame: world.get(Time)!.frame, phase: flow.phase, meter: world.get(Shot)!.meter & 0xffff });
    if (this.recent.length > 3) this.recent.length = 3;
  }

  /** The core frame `phase` was last entered on, or undefined. */
  since(phase: FlowPhase): number | undefined {
    return this.entered.get(phase);
  }

  /**
   * The meter `n` core frames before the latest one (1 or 2), or -1 when the
   * meter was not running then (the panel then shows its static face and no
   * gauge; tools/check_web_ui.py's convention).
   */
  meterAgo(n: number): number {
    const s = this.recent[n];
    if (!s || !METER_PHASES.has(s.phase) || s.meter === 0xffff) return -1;
    return s.meter;
  }
}
