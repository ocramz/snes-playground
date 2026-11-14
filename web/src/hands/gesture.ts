// Two hands as a putting control: both fists closed is a grip, during which the
// tilt of the line between the hands is the aim and their distance the energy;
// both hands opened again shoot. Pure (no DOM, no model), so it is unit-tested
// (src/hands/__tests__/gesture.test.ts) and the e2e scripts can feed it directly.

/** The 21 keypoints are MediaPipe's layout (@ocramz/handpose `KP`). */
const WRIST = 0;
/** [mcp, pip, tip] of index, middle, ring, pinky. The thumb folds across the palm in a fist; it is left out. */
const FINGERS: readonly (readonly [number, number, number])[] = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];

export type Shape = 'fist' | 'open';

/**
 * Above this the fingertip is farther from the wrist than the middle joint by enough to
 * call the finger extended; below CURLED it has folded back past it. An adult finger
 * held straight gives about 1.3 (wrist-PIP 13.5 cm, wrist-tip 18 cm), one in a fist
 * about 0.75. Both are ratios of 2D image distances, so they hold at any depth and
 * survive a fair amount of foreshortening (the two distances shrink together).
 */
export const EXTENDED = 1.1;
export const CURLED = 0.95;

/** Fist, open or neither (a hand in between, or too few fingers clear): `kp` is 21 x (x, y, v). */
export function handShape(kp: ArrayLike<number>): Shape | null {
  const wx = kp[3 * WRIST], wy = kp[3 * WRIST + 1];
  let ext = 0, curl = 0;
  for (const [, pip, tip] of FINGERS) {
    const dp = Math.hypot(kp[3 * pip] - wx, kp[3 * pip + 1] - wy);
    const dt = Math.hypot(kp[3 * tip] - wx, kp[3 * tip + 1] - wy);
    if (!(dp > 0)) continue;
    const r = dt / dp;
    if (r > EXTENDED) ext += 1;
    else if (r < CURLED) curl += 1;
  }
  if (curl >= 3) return 'fist';
  if (ext >= 3) return 'open';
  return null;
}

/** The keypoints that do not move when the hand opens or closes: the wrist and the four finger MCPs. */
export const PALM: readonly number[] = [WRIST, ...FINGERS.map((f) => f[0])];

/** One hand as the grip reads it: screen-plane position (metres, x right as on screen, y up) and shape. */
export interface HandSample {
  active: boolean;
  x: number;
  y: number;
  shape: Shape | null;
}

export interface GripOptions {
  /** hand distance (m) for meter 0 and meter 63 */
  distMin: number;
  distMax: number;
  /** the line's tilt is clamped to +-this (degrees); past ~90 the tracker swaps the hands */
  maxAngle: number;
  /** both fists for this long (s) start a grip */
  gripHold: number;
  /** both open for this long (s) shoot */
  openHold: number;
  /** a hand missing for this long (s) ends the grip without a shot */
  lostHold: number;
  /** time constant (s) of the smoothing of the angle and the distance */
  smooth: number;
}

export const GRIP_DEFAULTS: GripOptions = {
  distMin: 0.10, distMax: 0.55, maxAngle: 80,
  gripHold: 0.15, openHold: 0.10, lostHold: 0.5, smooth: 0.06,
};

export const METER_MAX = 63;

export interface Shot { angle: number; meter: number }

export interface GripState {
  /** both fists are closed (debounced): aim and energy follow the hands */
  grip: boolean;
  /** tilt of the left-to-right line, degrees, counter-clockwise positive */
  angle: number;
  /** distance between the hands, metres */
  dist: number;
  /** the energy, 0-63 */
  meter: number;
  /** both hands tracked */
  both: boolean;
}

/** The line from the left hand to the right one: tilt (degrees, CCW positive) and length. */
export function handLine(l: { x: number; y: number }, r: { x: number; y: number }): { angle: number; dist: number } {
  const dx = r.x - l.x, dy = r.y - l.y;
  return { angle: (Math.atan2(dy, dx) * 180) / Math.PI, dist: Math.hypot(dx, dy) };
}

export function distToMeter(dist: number, o: Pick<GripOptions, 'distMin' | 'distMax'> = GRIP_DEFAULTS): number {
  const f = (dist - o.distMin) / (o.distMax - o.distMin);
  return Math.round(METER_MAX * Math.max(0, Math.min(1, f)));
}

/**
 * The grip as a small state machine over time. update() once per hand-tracking frame
 * with the time in seconds; a shot, when the hands open after a grip, waits in
 * `pending` until takeShot(). The shot carries the values of the last frame on which
 * both hands were still fists, so the opening itself (fingers moving, the palm centre
 * shifting a little) does not move the aim or the energy.
 */
export class GripTracker {
  readonly o: GripOptions;
  readonly state: GripState = { grip: false, angle: 0, dist: 0, meter: 0, both: false };
  pending: Shot | null = null;
  /** the last decided shape per hand (a frame in between keeps it) */
  private shape: [Shape | null, Shape | null] = [null, null];
  private fistSince = -1;
  private openSince = -1;
  private lostSince = -1;
  private lastT = -1;
  private seeded = false;

  constructor(opts: Partial<GripOptions> = {}) {
    this.o = { ...GRIP_DEFAULTS, ...opts };
  }

  reset(): void {
    this.state.grip = false;
    this.pending = null;
    this.fistSince = this.openSince = this.lostSince = -1;
    this.shape = [null, null];
    this.seeded = false;
  }

  takeShot(): Shot | null {
    const s = this.pending;
    this.pending = null;
    return s;
  }

  /** `hands[0]` is the hand on the left of the screen, `hands[1]` the one on the right. */
  update(t: number, hands: readonly [HandSample, HandSample]): GripState {
    const o = this.o, st = this.state;
    const dt = this.lastT < 0 ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    const [l, r] = hands;
    st.both = l.active && r.active;
    for (let i = 0; i < 2; i++) {
      const h = hands[i];
      if (!h.active) this.shape[i] = null;
      else if (h.shape) this.shape[i] = h.shape;
    }
    const fists = st.both && this.shape[0] === 'fist' && this.shape[1] === 'fist';
    const open = st.both && this.shape[0] === 'open' && this.shape[1] === 'open';
    // this frame's own shapes, not the held ones: a frame in between (the hands opening)
    // must not move the line
    const fistsNow = st.both && l.shape === 'fist' && r.shape === 'fist';

    // the line, smoothed; it only moves while both hands are fists during a grip, so
    // the values a shot takes are those of the last such frame
    if (st.both && (fistsNow || !st.grip)) {
      const line = handLine(l, r);
      const angle = Math.max(-o.maxAngle, Math.min(o.maxAngle, line.angle));
      if (!this.seeded) {
        st.angle = angle; st.dist = line.dist; this.seeded = true;
      } else {
        const a = o.smooth > 0 ? 1 - Math.exp(-dt / o.smooth) : 1;
        st.angle += a * (angle - st.angle);
        st.dist += a * (line.dist - st.dist);
      }
      st.meter = distToMeter(st.dist, o);
    }
    if (!st.both) this.seeded = st.grip; // a new line starts fresh unless a grip holds it

    if (!st.grip) {
      if (fists) {
        if (this.fistSince < 0) this.fistSince = t;
        if (t - this.fistSince >= o.gripHold) {
          st.grip = true;
          this.openSince = this.lostSince = -1;
        }
      } else this.fistSince = -1;
      return st;
    }

    // gripping
    if (!st.both) {
      if (this.lostSince < 0) this.lostSince = t;
      if (t - this.lostSince >= o.lostHold) this.release();
      return st;
    }
    this.lostSince = -1;
    if (open) {
      if (this.openSince < 0) this.openSince = t;
      if (t - this.openSince >= o.openHold) {
        // a release with the hands together (meter 0) is not a shot
        if (st.meter > 0) this.pending = { angle: st.angle, meter: st.meter };
        this.release();
      }
    } else this.openSince = -1;
    return st;
  }

  private release(): void {
    this.state.grip = false;
    this.fistSince = this.openSince = this.lostSince = -1;
  }
}
