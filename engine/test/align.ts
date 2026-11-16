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
  /** The pc of the record's first write: the store `$82:F1xx`, or a reaction's or an object's (recordings only). */
  pc?: string;
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
  /** $D872, the block's in-the-water flag (trace_ball.py `wet`; absent from older recordings). */
  wet?: number;
  /** The copy ability's block words $D852, $D856, $D85A, $D85E (trace_ball.py; absent from older recordings). */
  stock?: number;
  worn?: number;
  mode?: number;
  latch?: number;
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

/** One flow event: [frame, name, value, line?] (tools/snesstep/trace_flow.py; the line in newer recordings). */
export type FlowEvent = [number, string, number | string] | [number, string, number | string, number];

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

/**
 * The copy ability's block words at the matched ball states (trace_ball.py's
 * side fields `$D852`-`$D85E`, as the store left them: the stock, the worn,
 * the mode, the latch; the engine's readBall at the frame's end), the first
 * ten differences. A hazard's code reaches the block after the store
 * (`$82:DBBB`), and $14's is gone by the next one (Kirby's state code B ends
 * it in one step): an engine hit code (12 and up) where the game shows the
 * value of the engine's frame before is that write.
 */
export function compareAbilityFields(
  pairs: Array<[BallTraceFrame, BallTraceFrame]>,
  engineAt: (frame: number) => BallTraceFrame | undefined,
): string[] {
  const bad: string[] = [];
  const s16 = (v: number | undefined): number => ((v ?? 0) << 16) >> 16; // the latch is signed ($82:C8A0 BMI)
  for (const [g, e] of pairs) {
    for (const k of ['stock', 'worn', 'mode', 'latch'] as const) {
      if (g[k] === undefined) continue;
      const want = s16(g[k]);
      const got = s16(e[k]);
      if (want === got) continue;
      if ((k === 'worn' || k === 'mode') && got >= 0x0c && s16(engineAt(e.f - 1)?.[k]) === want) continue;
      bad.push(`${k} at ${g.f}: the game's ${want}, the engine's ${got}`);
    }
    if (bad.length >= 10) break;
  }
  return bad;
}

/** The game's changes of one field inside the window must be found, in
 *  order, among the engine's, each within `tol` frames. */
export function matchChanges(
  game: FlowEvent[], engine: FlowEvent[], name: string, from: number, to: number, tol = 2,
): string | null {
  const want = valueChanges(game, name).filter(([f]) => f >= from && f <= to);
  const got = valueChanges(engine, name);
  let j = 0;
  for (const [f, v] of want) {
    let k = j;
    while (k < got.length && !(got[k][1] === v && Math.abs(got[k][0] - f) <= tol)) {
      if (got[k][0] > f + tol) break;
      k++;
    }
    if (k >= got.length || got[k][1] !== v || Math.abs(got[k][0] - f) > tol) {
      const near = got.filter(([g]) => Math.abs(g - f) <= 6).map(([g, x]) => `${g}:${x}`).join(' ');
      return `${name}: the game's ${v} at ${f} has no match (engine near it: ${near || 'nothing'})`;
    }
    j = k + 1;
  }
  return null;
}

/** The value a field holds on every frame of [from, to]. */
export function perFrame(events: FlowEvent[], name: string, from: number, to: number): Map<number, number> {
  const own = events.filter((e) => e[1] === name);
  const out = new Map<number, number>();
  let v = 0;
  let i = 0;
  for (let f = Math.min(from, own[0]?.[0] ?? from); f <= to; f++) {
    while (i < own.length && own[i][0] <= f) v = own[i++][2] as number;
    if (f >= from) out.set(f, v);
  }
  return out;
}

export function cameraWorst(game: FlowEvent[], engine: FlowEvent[], name: string, from: number, to: number): { worst: number; at: number } {
  const g = perFrame(game, name, from, to);
  const e = perFrame(engine, name, from - 2, to + 2);
  let worst = 0;
  let at = -1;
  for (const [f, v] of g) {
    let best = Infinity;
    for (let d = -2; d <= 2; d++) {
      const ev = e.get(f + d);
      if (ev !== undefined) best = Math.min(best, Math.abs(ev - v));
    }
    if (best > worst) {
      worst = best;
      at = f;
    }
  }
  return { worst, at };
}
