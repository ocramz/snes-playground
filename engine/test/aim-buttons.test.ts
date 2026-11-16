/**
 * The aim's other inputs against the recorded game (port_v2 phase 7; the
 * scripts tools/snesstep/inputs/web_{pause,look,bspin,lr,cancel,idle}.txt
 * on hole 1, recorded by trace_flow.py into build/engine/rom-test):
 *
 * - web_pause: Start opens the pause menu, the cursor moves and clamps, B
 *   closes it, Start again, A on CONTINUE; then a shot.
 * - web_look: Y with the d-pad moves the camera ($81:B9A2), the release
 *   pans it back, Y alone shows the score panel.
 * - web_bspin: B held is the spin preset ($83:B214): the side and, in a fly
 *   shot, the top/back step with the 12-frame repeat; the shot keeps the side.
 * - web_lr: L and R snap the aim by octants ($81:B729).
 * - web_cancel: B in the spin stage ($81:C089), back to the aim with the
 *   lockout of 20 iterations ($6B38).
 * - web_idle: the idle timer shows the score panel; A hides it.
 *
 * Each field's changes in the window must appear in the engine's, in order,
 * within ±2 frames (align.ts matchChanges), as in flow.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { runFlowScript, GAME_OFFSET } from './flow-harness';
import { matchChanges, cameraWorst } from './align';
import { haveRules, haveRomTest, loadFlow } from './fixtures';

const UI = ['panel', 'hudon', 'pause', 'pcur', 'preset', 'gside', 'gtb', 'look', 'lookl', 'lock'];
/**
 * Fields checked on some runs only: the idle timer counts iterations, so a
 * guide's lag the engine estimates (a fly shot's) shifts it by a frame
 * (web_bspin 2468); the preset's repeat `$6B5C` is the spin stage's side
 * timer too, which starts from the power-on value in the engine.
 */
const EXTRA: Record<string, string[]> = {
  web_pause: ['idle'], web_idle: ['idle'], web_lr: ['idle'], web_look: ['idle'], web_cancel: ['idle'],
};
const FLOW = ['state', 'aim', 'elev', 'side', 'tb', 'meter', 'strokes', 'facing', 'angle'];

const RUNS: Array<{ name: string; from: number; to: number; fields?: string[] }> = [
  { name: 'web_pause', from: 2333, to: 3100 },
  { name: 'web_look', from: 2333, to: 2950 },
  { name: 'web_bspin', from: 2333, to: 2900 },
  { name: 'web_bspin', from: 2333, to: 2700, fields: ['prep'] },
  { name: 'web_lr', from: 2333, to: 2880 },
  { name: 'web_cancel', from: 2333, to: 2900 },
  { name: 'web_idle', from: 2333, to: 2980 },
  // SELECT's mid-course card (2500-2740): the brightness, the panel, the song again
  { name: 'web_select', from: 2333, to: 2880, fields: ['bright', 'panel', 'hudon', 'state', 'aim', 'idle'] },
  // until QUIT's longjmp (2660): the shell takes over from there
  { name: 'web_pause_quit', from: 2333, to: 2659 },
];

describe.skipIf(!haveRules || !haveRomTest)("the aim's other inputs vs the recorded game", () => {
  for (const { name, from, to, fields } of RUNS) {
    const want = loadFlow(name);
    describe.skipIf(!want)(name, () => {
      const run = want ? runFlowScript(name, to - GAME_OFFSET + 3) : null;
      for (const field of fields ?? [...UI, ...FLOW, ...(EXTRA[name] ?? [])]) {
        it(field, () => {
          const game = field === 'bright' ? want!.events.map((e) => (e[1] === 'bright' ? [e[0], e[1], Number(e[2]) & 0xff] as typeof e : e)) : want!.events;
          expect(matchChanges(game, run!.events, field, from, to)).toBeNull();
        });
      }
      it('camera within 2 px (x) and 8 px (y)', () => {
        const x = cameraWorst(want!.events, run!.events, 'cx38', from, to);
        const y = cameraWorst(want!.events, run!.events, 'cy38', from, to);
        expect(x.worst, `x worst at ${x.at}`).toBeLessThanOrEqual(2);
        expect(y.worst, `y worst at ${y.at}`).toBeLessThanOrEqual(8);
      });
    });
  }
});
