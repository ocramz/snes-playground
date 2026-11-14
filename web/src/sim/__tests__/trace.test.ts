// Frame-exact comparison with the real game: tools/snesstep/trace_ball.py
// records player 1's ball block every frame of a scripted shot; the port must
// reproduce everything after the launch.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bareWorld, haveAssets, loadRom, readJson } from '../../../test/load';
import { Ball } from '../ball';

interface Frame {
  f: number; xc: number; xf: number; yc: number; yf: number; z: number;
  vx: number; vy: number; vz: number; air: number;
  spinx: number; spiny: number; spinp: number; aim: number; elev: number;
}

const here = fileURLToPath(new URL('.', import.meta.url));
const dir = resolve(here, '../../../../build/web-test');
// Buttons pressed during the roll, as the frame whose state they first change
// (the scripts press at 3020 / 3200; the game acts two frames later).
const scripts: Record<string, { a?: number[]; y?: number[] }> = {
  web_grounder: { a: [3022] }, web_fly: { a: [3022] }, web_fly_spin: { a: [3022] },
  web_curve: { a: [3022] }, web_aimed: { a: [3022] },
  web_a45: { a: [3022] }, web_a135: { a: [3022] }, web_a225: { a: [3022] }, web_a315: { a: [3022] },
  web_flya: { a: [3202] }, web_gy: { y: [3022] },
};
const names = Object.keys(scripts);

const same = (a: Frame, b: Ball): string | null => {
  const got = { xc: b.xc, xf: b.xf, yc: b.yc, yf: b.yf, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, air: b.air ? 1 : 0 };
  for (const k of Object.keys(got) as (keyof typeof got)[]) {
    if (got[k] !== a[k]) return `${k}: game ${a[k]} port ${got[k]}`;
  }
  return null;
};

describe.skipIf(!haveAssets)('port vs the real game, frame by frame', () => {
  for (const name of names) {
    const path = resolve(dir, `trace_${name}.json`);
    it.skipIf(!existsSync(path))(name, () => {
      const { rom, terrain } = loadRom();
      const world = bareWorld(terrain);
      const all = readJson<{ frames: Frame[] }>(path).frames;
      // distinct consecutive states from the launch on (hit-stop and lag repeat)
      // The launch writes the block piecemeal; the state just before the ball
      // first moves is the complete one.
      const moved = (a: Frame, b: Frame): boolean =>
        a.xc !== b.xc || a.xf !== b.xf || a.yc !== b.yc || a.yf !== b.yf || a.z !== b.z;
      let first = 1;
      while (first < all.length && !(moved(all[first - 1], all[first]) && (all[first - 1].vx || all[first - 1].vy || all[first - 1].vz))) first++;
      const start = first - 1;
      const seq: Frame[] = [];
      for (const s of all.slice(start)) {
        const l = seq[seq.length - 1];
        if (!l || ['xc', 'xf', 'yc', 'yf', 'z', 'vx', 'vy', 'vz', 'air'].some((k) => l[k as keyof Frame] !== s[k as keyof Frame])) seq.push(s);
      }
      const s0 = seq[0];
      const ball = new Ball(rom);
      ball.place(world, s0.xc, s0.xf, s0.yc, s0.yf);
      ball.z = s0.z; ball.vx = s0.vx; ball.vy = s0.vy; ball.vz = s0.vz;
      ball.air = s0.air === 1;
      ball.elevation = s0.elev; ball.aim = s0.aim;
      ball.spinX = s0.spinx; ball.spinY = s0.spiny; ball.spinPending = s0.spinp;
      // The game now and then runs two physics steps inside one video frame
      // (it lags, then catches up), which shows as one change in the trace. So
      // a mismatch is allowed to be explained by up to two extra steps.
      let catchUps = 0;
      for (let i = 1; i < seq.length; i++) {
        let diff: string | null = null;
        let firstPort = '';
        for (let extra = 0; extra < 3; extra++) {
          ball.step(world, { a: !!scripts[name].a?.includes(seq[i].f), y: !!scripts[name].y?.includes(seq[i].f) });
          while (ball.hitStop > 0) ball.hitStop -= 1; // the game waits; the state does not change
          diff = same(seq[i], ball);
          if (extra === 0) firstPort = `x ${ball.xc}:${ball.xf} y ${ball.yc}:${ball.yf} z ${ball.z} v ${ball.vx},${ball.vy},${ball.vz} air ${ball.air} events ${ball.events.map((e) => e.type)} cur(${ball.cur.col},${ball.cur.row} tile ${ball.cur.tile}) [${diff}]`;
          if (!diff) {
            catchUps += extra > 0 ? 1 : 0;
            break;
          }
          if (extra === 0 && !(ball.air || ball.vx || ball.vy)) break;
        }
        if (ball.lost) break; // the game puts the ball back on the tee: not physics
        if (diff) {
          const win = seq.slice(Math.max(0, i - 3), i).map((q) => `f${q.f} x${q.xc}:${q.xf} y${q.yc}:${q.yf} z${q.z} v${q.vx},${q.vy},${q.vz} a${q.air}`).join('\n    ');
          throw new Error(`${name}: step ${i} (game frame ${seq[i].f}) ${diff}\n  before:\n    ${win}\n` +
            `  game: ${JSON.stringify(seq[i])}\n  first port step: ${firstPort}\n  port: x ${ball.xc}:${ball.xf} y ${ball.yc}:${ball.yf} z ${ball.z} v ${ball.vx},${ball.vy},${ball.vz} air ${ball.air}`);
        }
      }
      expect(catchUps).toBeLessThan(Math.max(4, seq.length / 20));
      expect(seq.length).toBeGreaterThan(50);
    });
  }
});
