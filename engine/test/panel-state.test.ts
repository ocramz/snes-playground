/**
 * The shot panel's derived state (features/shot-panel/panel-state.ts) on
 * web_ui, the run ui.json was measured on (tools/export_web_ui.py; the aim's
 * A at game frame 2800). The game's pictures are snapshots: snapshot f shows
 * what frame f - 1 built, so the host's picture after core frame n is
 * snapshot n + 1 (`shown(f)` below).
 * - the engine's curl (Spin) lands SPIN_LEAD after the A, as the game's;
 * - the ages are the measured ones: the "1" in snapshot 2846, the panel 2866;
 * - it closes as snapshots 3240-3281 showed (a stepper run, 2026-11-14): the
 *   gauge in 3252, the panel in 3273, the "1" in 3276; the tomato about to be
 *   spent is off in 3242-3249 and 3258-3265;
 * - the gauge and the face show the engine's meter one and two core frames
 *   back.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { World } from 'koota';
import { runFlowScript, GAME_OFFSET } from './flow-harness';
import { haveRules, haveRomTest, loadFlow } from './fixtures';
import { haveAssets, loadUi } from './assets';
import { valueChanges } from './align';
import { CoreHistory } from '../src/game/bridge/history';
import { panelState, SPIN_LEAD } from '../src/game/features/shot-panel/panel-state';
import { panelSprites, type PanelInput } from '../src/game/features/shot-panel/panel-layout';
import { HoleFlow } from '../src/core/traits/flow';
import { Shot } from '../src/core/traits/shot';

const A_FRAME = 2800;

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.destroy();
});

describe.skipIf(!haveRules || !haveRomTest || !loadFlow('web_ui'))('the shot panel on web_ui', () => {
  const history = new CoreHistory();
  const states = new Map<number, PanelInput>();
  const meter = new Map<number, number>();
  let spinAt = -1;
  /** The state drawn for the game's snapshot f. */
  const shown = (f: number): PanelInput => states.get(f - 1)!;
  const run = (): void => {
    const r = runFlowScript('web_ui', 3290 - GAME_OFFSET, {
      until: (world, gameFrame) => {
        history.sample(world, true);
        states.set(gameFrame, panelState(world, history));
        meter.set(gameFrame, world.get(Shot)!.meter);
        if (spinAt < 0 && world.get(HoleFlow)!.phase === 'Spin') spinAt = gameFrame;
        return false;
      },
    });
    worlds.push(r.world);
  };

  it("Spin starts SPIN_LEAD frames after the aim's A, on the game's curl (state 6)", () => {
    run();
    expect(spinAt - A_FRAME).toBe(SPIN_LEAD);
    const game = valueChanges(loadFlow('web_ui')!.events, 'state').find(([, v]) => v === 6)!;
    expect(game[0]).toBe(spinAt);
  });

  it('the ages are snapshot frames from the A', () => {
    expect(shown(2846).age).toBe(46);
    expect(shown(2866).age).toBe(66);
    expect(shown(3250).age).toBe(450);
  });

  it.skipIf(!haveAssets)('the "1", the panel, the gauge and the blink on the measured snapshots', () => {
    const ui = loadUi();
    const names = (f: number): Set<string> => new Set(panelSprites(ui, shown(f)).map((s) => s.f));
    const has = (f: number, part: 'one' | 'panel' | 'gauge'): boolean => {
      const of = part === 'one' ? ui.one : part === 'panel' ? ui.ruler : Object.values(ui.gauge).flat();
      const n = names(f);
      return of.some((p) => n.has(p.f));
    };
    const tomatoes = (f: number): number => panelSprites(ui, shown(f)).filter((s) => s.f === ui.tomato[0].f).length;
    expect(has(2845, 'one')).toBe(false);
    expect(has(2846, 'one')).toBe(true);
    expect(has(2865, 'panel')).toBe(false);
    expect(has(2866, 'panel')).toBe(true);
    expect(has(3200, 'gauge')).toBe(true);
    expect(has(3251, 'gauge')).toBe(true);
    expect(has(3252, 'gauge')).toBe(false);
    expect(has(3272, 'panel')).toBe(true);
    expect(has(3273, 'panel')).toBe(false);
    expect(has(3275, 'one')).toBe(true);
    expect(has(3276, 'one')).toBe(false);
    for (const [f, n] of [[3241, 4], [3242, 3], [3249, 3], [3250, 4], [3257, 4], [3258, 3], [3265, 3], [3266, 4], [3272, 4]]) {
      expect(tomatoes(f), `snapshot ${f}`).toBe(n);
    }
  });

  it("the gauge's and the face's meters are the meter one and two frames back", () => {
    let compared = 0;
    for (let n = 3125; n <= 3249; n++) {
      expect(states.get(n)!.meter1, `n${n} meter1`).toBe(meter.get(n - 1));
      expect(states.get(n)!.meter2, `n${n} meter2`).toBe(meter.get(n - 2));
      compared++;
    }
    expect(compared).toBe(125);
    expect(states.get(3100)!.meter1).toBe(-1); // the spin stage: no meter yet
  });
});
