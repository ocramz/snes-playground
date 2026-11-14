import { describe, expect, it } from 'vitest';
import { GripTracker, distToMeter, handLine, handShape, type HandSample, type Shape } from '../gesture';

/**
 * A hand in image pixels (y down), wrist at the origin, fingers pointing up and
 * slightly fanned. Distances from the wrist: MCP 90, then for an open hand PIP 135
 * and tip 180, for a fist PIP 110 (the front of the fist) and tip 70 (folded back).
 */
function hand(shape: 'open' | 'fist', opts: { curled?: number } = {}): Float32Array {
  const kp = new Float32Array(21 * 3);
  const set = (k: number, d: number, deg: number): void => {
    const a = ((deg - 90) * Math.PI) / 180;
    kp[3 * k] = d * Math.cos(a); kp[3 * k + 1] = d * Math.sin(a); kp[3 * k + 2] = 1;
  };
  set(1, 30, -40); set(2, 55, -35); set(3, 75, -30); set(4, 95, -28); // thumb
  const fingers = [[5, 6, 7, 8, -12], [9, 10, 11, 12, -3], [13, 14, 15, 16, 6], [17, 18, 19, 20, 15]];
  fingers.forEach(([mcp, pip, dip, tip, deg], i) => {
    const curled = shape === 'fist' ? i < (opts.curled ?? 4) : i >= 4 - (opts.curled ?? 0);
    set(mcp, 90, deg);
    if (curled) { set(pip, 110, deg); set(dip, 95, deg); set(tip, 70, deg); }
    else { set(pip, 135, deg); set(dip, 160, deg); set(tip, 180, deg); }
  });
  return kp;
}

describe('handShape', () => {
  it('tells a fist from an open hand', () => {
    expect(handShape(hand('open'))).toBe('open');
    expect(handShape(hand('fist'))).toBe('fist');
  });
  it('is scale- and rotation-free', () => {
    for (const shape of ['open', 'fist'] as const) {
      const kp = hand(shape);
      const rot = new Float32Array(kp.length);
      const c = Math.cos(1.1), s = Math.sin(1.1);
      for (let k = 0; k < 21; k++) {
        const x = kp[3 * k] * 0.4, y = kp[3 * k + 1] * 0.4;
        rot[3 * k] = 300 + c * x - s * y; rot[3 * k + 1] = 200 + s * x + c * y;
      }
      expect(handShape(rot)).toBe(shape);
    }
  });
  it('gives no answer for a hand half open', () => {
    expect(handShape(hand('fist', { curled: 2 }))).toBeNull();
  });
  it('accepts a fist with one finger out', () => {
    expect(handShape(hand('fist', { curled: 3 }))).toBe('fist');
  });
});

describe('handLine and the energy', () => {
  it('measures the tilt counter-clockwise, as on the screen (y up)', () => {
    expect(handLine({ x: -0.2, y: 0 }, { x: 0.2, y: 0 }).angle).toBeCloseTo(0);
    // right hand higher: the line turns counter-clockwise, positive
    expect(handLine({ x: -0.2, y: 0 }, { x: 0.2, y: 0.4 }).angle).toBeCloseTo(45);
    expect(handLine({ x: -0.2, y: 0.4 }, { x: 0.2, y: 0 }).angle).toBeCloseTo(-45);
    expect(handLine({ x: 0, y: 0 }, { x: 0.3, y: 0.4 }).dist).toBeCloseTo(0.5);
  });
  it('maps the distance linearly onto the meter, clamped', () => {
    const o = { distMin: 0.1, distMax: 0.55 };
    expect(distToMeter(0.05, o)).toBe(0);
    expect(distToMeter(0.1, o)).toBe(0);
    expect(distToMeter(0.4, o)).toBe(42); // two thirds of the way
    expect(distToMeter(0.55, o)).toBe(63);
    expect(distToMeter(1.2, o)).toBe(63);
  });
});

describe('GripTracker', () => {
  const at = (x: number, y: number, shape: Shape | null): HandSample => ({ active: true, x, y, shape });
  const gone: HandSample = { active: false, x: 0, y: 0, shape: null };
  /** Feed one pose of both hands for `secs` at 30 Hz; returns the time after. */
  const hold = (g: GripTracker, t: number, secs: number, l: HandSample, r: HandSample): number => {
    const n = Math.round(secs * 30);
    for (let i = 0; i < n; i++) { t += 1 / 30; g.update(t, [l, r]); }
    return t;
  };
  /** the line through (0, 0) at `deg`, `dist` long, centred */
  const line = (deg: number, dist: number, shape: Shape | null): [HandSample, HandSample] => {
    const a = (deg * Math.PI) / 180, hx = (Math.cos(a) * dist) / 2, hy = (Math.sin(a) * dist) / 2;
    return [at(-hx, -hy, shape), at(hx, hy, shape)];
  };

  it('grips on two fists, follows the line, and shoots on opening with the last fist values', () => {
    const g = new GripTracker({ smooth: 0 });
    let t = hold(g, 0, 0.1, ...line(0, 0.3, 'fist'));
    expect(g.state.grip).toBe(false); // 0.15 s of fists first
    t = hold(g, t, 0.2, ...line(0, 0.3, 'fist'));
    expect(g.state.grip).toBe(true);
    t = hold(g, t, 0.3, ...line(30, 0.4, 'fist'));
    expect(g.state.angle).toBeCloseTo(30);
    expect(g.state.meter).toBe(distToMeter(0.4, g.o));
    // opening: the hands drift while the fingers come out; that must not count
    t = hold(g, t, 0.06, ...line(50, 0.5, null));
    t = hold(g, t, 0.2, ...line(50, 0.5, 'open'));
    expect(g.state.grip).toBe(false);
    const shot = g.takeShot();
    expect(shot).not.toBeNull();
    expect(shot!.angle).toBeCloseTo(30);
    expect(shot!.meter).toBe(distToMeter(0.4, g.o));
    expect(g.takeShot()).toBeNull(); // once
  });

  it('clamps the tilt', () => {
    const g = new GripTracker({ smooth: 0, maxAngle: 80 });
    hold(g, 0, 0.3, ...line(85, 0.3, 'fist'));
    expect(g.state.angle).toBeCloseTo(80);
  });

  it('smooths the line', () => {
    const g = new GripTracker({ smooth: 0.06 });
    let t = hold(g, 0, 0.3, ...line(0, 0.3, 'fist'));
    t = hold(g, t, 1 / 30, ...line(30, 0.3, 'fist'));
    expect(g.state.angle).toBeGreaterThan(5);
    expect(g.state.angle).toBeLessThan(30);
    hold(g, t, 0.5, ...line(30, 0.3, 'fist'));
    expect(g.state.angle).toBeCloseTo(30, 1);
  });

  it('does not shoot when the hands open together (meter 0)', () => {
    const g = new GripTracker({ smooth: 0 });
    let t = hold(g, 0, 0.3, ...line(0, 0.05, 'fist'));
    expect(g.state.grip).toBe(true);
    t = hold(g, t, 0.3, ...line(0, 0.05, 'open'));
    expect(g.state.grip).toBe(false);
    expect(g.takeShot()).toBeNull();
  });

  it('ends a grip without a shot when a hand leaves the view', () => {
    const g = new GripTracker({ smooth: 0, lostHold: 0.5 });
    let t = hold(g, 0, 0.3, ...line(20, 0.3, 'fist'));
    const [l] = line(20, 0.3, 'fist');
    t = hold(g, t, 0.3, l, gone);
    expect(g.state.grip).toBe(true); // a short dropout is held
    t = hold(g, t, 0.4, l, gone);
    expect(g.state.grip).toBe(false);
    hold(g, t, 0.3, ...line(20, 0.3, 'open'));
    expect(g.takeShot()).toBeNull();
  });

  it('keeps the grip while only one hand opens', () => {
    const g = new GripTracker({ smooth: 0 });
    let t = hold(g, 0, 0.3, ...line(0, 0.3, 'fist'));
    const [l] = line(0, 0.3, 'fist');
    const [, r] = line(0, 0.3, 'open');
    t = hold(g, t, 0.5, l, r);
    expect(g.state.grip).toBe(true);
    expect(g.takeShot()).toBeNull();
  });
});
