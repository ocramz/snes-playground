import { describe, expect, it } from 'vitest';
import { distinctStates, launchSeedIndex, valueChanges, type BallTraceFrame } from './align';

function rec(over: Partial<BallTraceFrame>): BallTraceFrame {
  return { f: 0, xc: 0, xf: 0, yc: 0, yf: 0, z: 0, vx: 0, vy: 0, vz: 0, air: 0,
           spinx: 0, spiny: 0, spinp: 0, aim: 0, elev: 0, ...over };
}

describe('distinctStates', () => {
  it('drops consecutive records identical on the ball state, keeps the rest', () => {
    const frames = [
      rec({ f: 1, xc: 5 }),
      rec({ f: 2, xc: 5, spinx: 9 }),  // spin is not a ball-state field
      rec({ f: 3, xc: 6 }),            // moved
      rec({ f: 4, xc: 6 }),            // hit-stop repeat
      rec({ f: 5, xc: 6, vx: 1 }),     // velocity changed: a new state
    ];
    const out = distinctStates(frames);
    expect(out.map((r) => r.f)).toEqual([1, 3, 5]);
  });
});

describe('launchSeedIndex', () => {
  it('is the record just before the ball first moves with a velocity', () => {
    const frames = [
      rec({ f: 100, xc: 6, xf: 7 }),                 // at rest on the tee
      rec({ f: 101, xc: 6, xf: 7, spinx: 1 }),       // launch burst, incomplete
      rec({ f: 102, xc: 6, xf: 7, vx: 3 }),          // the complete pre-move state
      rec({ f: 103, xc: 7, xf: 1, vx: 3 }),          // first move
      rec({ f: 104, xc: 8, vx: 3 }),
    ];
    expect(launchSeedIndex(frames)).toBe(2);
  });

  it('seeds from the launch record even when the burst gives it a torn stamp', () => {
    const frames = [
      rec({ f: 100, xc: 6, xf: 7 }),
      rec({ f: 101, xc: 6, xf: 7, vx: 3, vz: 2 }),   // launched, not yet moved
      rec({ f: 102, xc: 7, xf: 1, vx: 3, vz: 2 }),
    ];
    expect(launchSeedIndex(frames)).toBe(1);
  });

  it('returns the last record when the ball never moves', () => {
    expect(launchSeedIndex([rec({ f: 1 }), rec({ f: 2 })])).toBe(1);
  });
});

describe('valueChanges', () => {
  it('extracts one field’s change sequence, dropping repeats', () => {
    const events: Array<[number, string, number | string]> = [
      [10, 'state', 4],
      [11, 'aim', 180],
      [12, 'state', 4],
      [20, 'state', 6],
      [21, 'aim', 181],
    ];
    expect(valueChanges(events, 'state')).toEqual([[10, 4], [20, 6]]);
    expect(valueChanges(events, 'aim')).toEqual([[11, 180], [21, 181]]);
    expect(valueChanges(events, 'missing')).toEqual([]);
  });
});
