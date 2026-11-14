/**
 * End to end (plans/port_v1_koota_phaser4.md verification, "trace-script"):
 * each recorded shot is replayed from the stepper's own input script
 * (tools/snesstep/inputs/web_*.txt) — no seed, no pokes. The aim stage,
 * the panel and the meter must produce the game's launch exactly (aim,
 * elevation, velocity, spin), and from there every ball state the game
 * recorded must follow (test/align.ts, matchBallStates).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { runFlowScript, GAME_OFFSET } from './flow-harness';
import { distinctStates, launchSeedIndex, matchBallStates } from './align';
import { haveRules, haveRomTest, loadTrace } from './fixtures';
import { BallWork } from '../src/core/traits/ball';

const SCRIPTS = [
  'web_grounder', 'web_fly', 'web_fly_spin', 'web_curve', 'web_aimed',
  'web_a45', 'web_a135', 'web_a225', 'web_a315', 'web_flya', 'web_gy',
  'web_flow', 'web_ui',
];

const stats: string[] = [];

describe.skipIf(!haveRules || !haveRomTest)('the real game, end to end from its input scripts', () => {
  afterAll(() => {
    if (process.env.TRACE_STATS) console.log(stats.join('\n'));
  });
  for (const name of SCRIPTS) {
    const trace = loadTrace(name);
    it.skipIf(!trace)(name, () => {
      const all = trace!.frames;
      const seed = launchSeedIndex(all);
      // the trace ends where trace_ball.py stopped; the engine runs a little
      // longer so the last recorded state can still be matched
      const lastF = all[all.length - 1].f;
      const run = runFlowScript(name, lastF - GAME_OFFSET + 20, {
        until: (w) => w.queryFirst(BallWork)!.get(BallWork)!.fellOut !== 0,
      });
      const game = distinctStates(all.slice(seed));
      // the launch: the trace's seed record carries the shot's numbers
      const s0 = all[seed];
      const launch = run.ball.find((b) => b.vx === s0.vx && b.vy === s0.vy && b.vz === s0.vz && (b.vx | b.vy | b.vz) !== 0);
      expect(launch, `${name}: the engine never launched with v (${s0.vx}, ${s0.vy}, ${s0.vz})`).toBeDefined();
      expect({ aim: launch!.aim, elev: launch!.elev, spinx: launch!.spinx, spiny: launch!.spiny, spinp: launch!.spinp })
        .toEqual({ aim: s0.aim, elev: s0.elev, spinx: s0.spinx, spiny: s0.spiny, spinp: s0.spinp });
      // compare up to the ball falling out: the game's last comparable
      // state is the frozen one (v = 0 below -$11_0000, $81:89B2); after it
      // comes the lost ball's reset on the tee, which is flow, not physics
      const lostAt = game.findIndex((g) => g.z < -0x110000 && g.vx === 0 && g.vy === 0 && g.vz === 0);
      const gameCut = lostAt >= 0 ? game.slice(0, lostAt + 1) : game;
      const engine = distinctStates(run.ball);
      const r = matchBallStates(gameCut, engine);
      stats.push(`${name}: ${r.matched}/${gameCut.length} states, ${r.skips} catch-ups`);
      expect(r.error, `${name}`).toBeNull();
      expect(r.skips).toBeLessThan(Math.max(4, r.matched / 20));
    });
  }
});
