/**
 * Alignment of the stepper's ball traces (build/engine/rom-test/trace_*.json,
 * written by tools/snesstep/trace_ball.py) with the port's frames.
 *
 * Why this exists (docs/web-demo.md, plans/port_v1_koota_phaser4.md risk 2):
 * the game copies the work ball back to the player block in a burst of
 * stores that can straddle a frame boundary, so a per-frame snapshot is
 * torn — the tracer cuts on bursts instead, which means two physics steps
 * can merge into one record and the stamps lag the port by 1-2 frames. The
 * harness therefore compares *sequences of distinct states*, not record i
 * against frame i, and tolerates the stamped frame numbers.
 */

/** One trace record: player 1's ball block plus the shot context. */
export interface BallTraceFrame {
  f: number;
  /** The scanline of the record's first write (trace_ball.py; recordings only). */
  ln?: number;
  xc: number;
  xf: number;
  yc: number;
  yf: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  air: number;
  spinx: number;
  spiny: number;
  spinp: number;
  aim: number;
  elev: number;
}

/** The fields a frame-exact comparison covers (position, height, velocity, airborne). */
export const BALL_STATE_KEYS = ['xc', 'xf', 'yc', 'yf', 'z', 'vx', 'vy', 'vz', 'air'] as const;

export interface BallTrace {
  name: string;
  frames: BallTraceFrame[];
}

function sameState(a: BallTraceFrame, b: BallTraceFrame): boolean {
  return BALL_STATE_KEYS.every((k) => a[k] === b[k]);
}

/**
 * The distinct consecutive ball states of a trace: hit-stop and lag repeat
 * a state, burst tearing splits one, and neither should count as a step.
 */
export function distinctStates(frames: BallTraceFrame[]): BallTraceFrame[] {
  const out: BallTraceFrame[] = [];
  for (const s of frames) {
    const last = out[out.length - 1];
    if (!last || !sameState(last, s)) out.push(s);
  }
  return out;
}

function moved(a: BallTraceFrame, b: BallTraceFrame): boolean {
  return a.xc !== b.xc || a.xf !== b.xf || a.yc !== b.yc || a.yf !== b.yf || a.z !== b.z;
}

/**
 * The index of the trace record to seed from: the state just before the
 * ball first moves with a nonzero velocity. The launch writes the block
 * piecemeal, so earlier records are incomplete (web/src/sim/__tests__/
 * trace.test.ts). Seed the port from this record and compare from the next
 * distinct state on.
 */
export function launchSeedIndex(frames: BallTraceFrame[]): number {
  let first = 1;
  while (
    first < frames.length &&
    !(moved(frames[first - 1], frames[first]) &&
      (frames[first - 1].vx !== 0 || frames[first - 1].vy !== 0 || frames[first - 1].vz !== 0))
  ) {
    first++;
  }
  return first - 1;
}

/** One flow event: [frame, name, value] (tools/snesstep/trace_flow.py). */
export type FlowEvent = [number, string, number | string];

export interface FlowTrace {
  name: string;
  events: FlowEvent[];
}

/**
 * The value sequence of one flow field, in order, dropping consecutive
 * repeats. The flow tests compare these sequences and allow each event's
 * frame to be off by a small tolerance (±2 frames for state/aim/camera),
 * so they need the changes, not the raw per-frame samples.
 */
export function valueChanges(events: FlowEvent[], name: string): Array<[number, number | string]> {
  const out: Array<[number, number | string]> = [];
  for (const [f, n, v] of events) {
    if (n !== name) continue;
    const last = out[out.length - 1];
    if (!last || last[1] !== v) out.push([f, v]);
  }
  return out;
}

/**
 * The ball-state comparison of an end-to-end run: the game's distinct
 * states must appear, in order, among the engine's, each within
 * `maxSkip` engine states of the last match — the game sometimes runs two
 * steps between two of its block writes (a lag catch-up), so one of the
 * engine's states can be missing from the trace, never the other way
 * round. Returns null when every game state matched, else a description.
 */
export function matchBallStates(
  game: BallTraceFrame[],
  engine: BallTraceFrame[],
  maxSkip = 2,
): { error: string | null; matched: number; skips: number; pairs: Array<[BallTraceFrame, BallTraceFrame]> } {
  let j = engine.findIndex((e) => sameState(e, game[0]));
  if (j < 0) {
    return { error: `the game's launch state (f${game[0].f}) never occurs in the engine's run`, matched: 0, skips: 0, pairs: [] };
  }
  const pairs: Array<[BallTraceFrame, BallTraceFrame]> = [[game[0], engine[j]]];
  let skips = 0;
  for (let i = 1; i < game.length; i++) {
    let k = j + 1;
    while (k < engine.length && k <= j + 1 + maxSkip && !sameState(engine[k], game[i])) k++;
    if (k >= engine.length || k > j + 1 + maxSkip) {
      const want = game[i];
      const got = engine[j + 1];
      const diff = got ? BALL_STATE_KEYS.filter((key) => want[key] !== got[key]).map((key) => `${key}: game ${want[key]} engine ${got[key]}`).join(', ') : 'engine ended';
      return {
        error: `game state ${i} (f${want.f}) not found after engine f${engine[j].f}: ${diff}`,
        matched: i,
        skips,
        pairs,
      };
    }
    skips += k - (j + 1);
    j = k;
    pairs.push([game[i], engine[j]]);
  }
  return { error: null, matched: game.length, skips, pairs };
}
