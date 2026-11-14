/**
 * The frame-exact comparison with the real game: tools/snesstep/
 * trace_ball.py recorded player 1's ball block every frame of eleven
 * scripted shots; the port must reproduce everything after the launch.
 *
 * The harness mirrors web/src/sim/__tests__/trace.test.ts's approach (the
 * plan's verification list, "trace-shots"): seed from the record before
 * the ball first moves, run one core frame per port step, and compare the
 * sequences of distinct states - hit-stop and lag repeat a state, and the
 * game sometimes runs two physics steps inside one video frame, so a
 * mismatch may be explained by up to two extra steps.
 *
 * The A/Y presses during the roll are injected one record before the
 * frames the web port calibrated (the scripts press at 3020/3200; the game
 * acts two frames later, which the stamps absorb): the engine's arming,
 * like the ROM's $82:DA51, runs after the step and acts on the next one.
 * The end-to-end test (trace-script.test.ts) uses the scripts' own frames
 * instead.
 */
import { describe, expect, it } from 'vitest';
import { createGameWorld } from '../src/core/world';
import { runCoreFrame } from '../src/core/schedule';
import { placeBall, startCourse } from '../src/core/actions';
import { Stall } from '../src/core/systems/stall';
import { drainEvents } from '../src/core/events';
import { BallPos, BallVel, BallAir, BallWork } from '../src/core/traits/ball';
import { Pad } from '../src/core/traits/pad';
import { RomRules } from '../src/core/rules';
import { fromRomCourse } from '../src/core/course-data';
import { Button } from './input-script';
import { s16 } from '../src/core/fixed';
import { distinctStates, launchSeedIndex, BALL_STATE_KEYS, type BallTraceFrame } from './align';
import { haveRules, haveRomTest, loadRomCourse, loadTables, loadTrace } from './fixtures';

const scripts: Record<string, { a?: number[]; y?: number[] }> = {
  web_grounder: { a: [3021] }, web_fly: { a: [3021] }, web_fly_spin: { a: [3021] },
  web_curve: { a: [3021] }, web_aimed: { a: [3021] },
  web_a45: { a: [3021] }, web_a135: { a: [3021] }, web_a225: { a: [3021] }, web_a315: { a: [3021] },
  web_flya: { a: [3201] }, web_gy: { y: [3021] },
};

describe.skipIf(!haveRules || !haveRomTest)('port vs the real game, frame by frame', () => {
  const rules = new RomRules(loadTables());
  const course = fromRomCourse(loadRomCourse());

  for (const [name, presses] of Object.entries(scripts)) {
    const trace = loadTrace(name);
    it.skipIf(!trace)(name, () => {
      const all = trace!.frames;
      const seq = distinctStates(all.slice(launchSeedIndex(all)));
      expect(seq.length).toBeGreaterThan(50);

      // the hole as the game has it: its enemies too, so web_curve's takes
      // and its cup reveal (a 100-frame stall) run as they did
      const world = createGameWorld();
      const ctx = startCourse(world, rules, [course]);
      const s0 = seq[0];
      placeBall(world, {
        xc: s0.xc, xf: s0.xf, yc: s0.yc, yf: s0.yf, z: s0.z,
        vx: s0.vx, vy: s0.vy, vz: s0.vz, air: s0.air,
        aim: s0.aim, elev: s0.elev,
        spinX: s0.spinx, spinY: s0.spiny, spinPending: s0.spinp,
      }, ctx);

      let catchUps = 0;
      for (let i = 1; i < seq.length; i++) {
        const want = seq[i];
        const press =
          (presses.a?.includes(want.f) ? Button.A : 0) |
          (presses.y?.includes(want.f) ? Button.Y : 0);
        let diff: string | null = null;
        // The game's hit-stop freezes the state for 2-4 frames; those port
        // frames produce no new state, so they do not consume the budget.
        let stallFrames = 0;
        for (let extra = 0; extra < 12 + stallFrames; extra++) {
          const stalling = world.get(Stall)!.kind !== 'none';
          if (stalling) stallFrames += 1;
          const pad = world.get(Pad)!;
          world.set(Pad, { ...pad, raw: press });
          runCoreFrame(world, ctx);
          drainEvents(world);
          // the game's ball-lost reset (back on the tee) is flow, not
          // physics: stop comparing once the port's ball is lost
          if (world.queryFirst(BallWork)!.get(BallWork)!.fellOut !== 0) {
            diff = null;
            break;
          }
          const got = readBall(world);
          if (process.env.DBG_TRACE && name === 'web_grounder' && want.f >= 3048 && want.f <= 3052) {
            console.log(`step ${i} f${want.f} extra${extra}: port x ${got.xc}:${got.xf} v ${got.vx},${got.vy},${got.vz} air ${got.air} | want x ${want.xc}:${want.xf} v ${want.vx},${want.vy},${want.vz}`);
          }
          diff = compare(want, got);
          if (!diff) {
            catchUps += extra - stallFrames > 0 ? 1 : 0;
            break;
          }
          if (extra === 0 && !(got.air || got.vx || got.vy)) break;
        }
        if (diff) {
          const ctxWin = seq.slice(Math.max(0, i - 3), i + 1)
            .map((q) => `f${q.f} x${q.xc}:${q.xf} y${q.yc}:${q.yf} z${q.z} v${q.vx},${q.vy},${q.vz} a${q.air}`)
            .join('\n    ');
          const got = readBall(world);
          throw new Error(
            `${name}: step ${i} (game frame ${want.f}) ${diff}\n  trace:\n    ${ctxWin}\n` +
            `  port: x ${got.xc}:${got.xf} y ${got.yc}:${got.yf} z ${got.z} v ${got.vx},${got.vy},${got.vz} air ${got.air}`,
          );
        }
      }
      expect(catchUps).toBeLessThan(Math.max(4, seq.length / 20));
    });
  }
});

function readBall(world: ReturnType<typeof createGameWorld>): BallTraceFrame {
  const e = world.queryFirst(BallPos)!;
  const pos = e.get(BallPos)!;
  const vel = e.get(BallVel)!;
  const air = e.get(BallAir)!;
  return {
    f: 0,
    xc: pos.xc, xf: pos.xf, yc: pos.yc, yf: pos.yf, z: pos.z,
    // the trace's velocities are signed; the port keeps 16-bit patterns
    vx: s16(vel.vx), vy: s16(vel.vy), vz: s16(vel.vz),
    air: air.air ? 1 : 0,
    spinx: 0, spiny: 0, spinp: 0, aim: 0, elev: 0,
  };
}

function compare(want: BallTraceFrame, got: BallTraceFrame): string | null {
  for (const k of BALL_STATE_KEYS) {
    if (want[k] !== got[k]) return `${k}: game ${want[k]} port ${got[k]}`;
  }
  return null;
}
