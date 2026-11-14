import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../src/core/world';
import { Pad } from '../src/core/traits/pad';
import { Time } from '../src/core/traits/time';
import { runHeadless } from './headless';
import { latchPad } from '../src/core/systems/pad';
import { Button, parseInputScript } from './input-script';

describe('runHeadless', () => {
  it('latches the pad per frame (pressed = held & ~prev) and runs the step', () => {
    const world = createGameWorld();
    const script = parseInputScript('2 A 2\n4 B 1\n');
    const seen: Array<{ f: number; held: number; pressed: number }> = [];
    runHeadless(
      world,
      script,
      6,
      (w) => {
        const time = w.get(Time)!;
        w.set(Time, { frame: time.frame + 1 });
        latchPad(w);
      },
      (w, f) => {
        const pad = w.get(Pad)!;
        seen.push({ f, held: pad.held, pressed: pad.pressed });
      },
    );
    expect(world.get(Time)!.frame).toBe(6);
    expect(seen).toEqual([
      { f: 0, held: 0, pressed: 0 },
      { f: 1, held: 0, pressed: 0 },
      { f: 2, held: Button.A, pressed: Button.A },
      { f: 3, held: Button.A, pressed: 0 },
      { f: 4, held: Button.B, pressed: Button.B },
      { f: 5, held: 0, pressed: 0 },
    ]);
  });
});
