// A headless player: brute-force aim and power until the three enemies are
// taken and the cup is holed, using only the pad.
import { describe, expect, it } from 'vitest';
import { haveAssets, loadRom } from '../../../test/load';
import { HoleSim, SPIN_READY, emptyPad, type Pad } from '../hole';

const press = (sim: HoleSim, key: keyof Pad): void => {
  sim.tick({ ...emptyPad(), [key]: true });
  sim.tick(emptyPad());
};

/** Take one shot and run until the roll ends. Returns the stage reached. */
function shoot(sim: HoleSim, aim: number, elev: number, meter: number, side = 6, topBack = 6): string {
  sim.aim = aim;
  sim.elevation = elev;
  press(sim, 'a'); // aim -> spin
  while (sim.shotAge < SPIN_READY) sim.tick(emptyPad()); // Kirby curls, the panel opens
  sim.side = side;
  sim.topBack = topBack;
  press(sim, 'a'); // spin -> power
  for (let i = 0; i < 6; i++) sim.tick(emptyPad()); // the meter starts a few frames later
  sim.meter = meter - 1;
  sim.meterDir = 1;
  sim.tick({ ...emptyPad(), a: true }); // latch the power
  for (let i = 0; i < 4000; i++) {
    sim.tick(emptyPad());
    if (['aim', 'done', 'fail'].includes(sim.stage) && i > 30) break;
  }
  return sim.stage;
}

describe.skipIf(!haveAssets)('headless player', () => {
  it('takes the three enemies and sinks the cup', () => {
    const { rom, course } = loadRom();
    const shots: { aim: number; elev: number; meter: number }[] = [];
    const fresh = (): HoleSim => {
      const s = new HoleSim(rom, course);
      for (const sh of shots) shoot(s, sh.aim, sh.elev, sh.meter);
      return s;
    };
    let sim = fresh();
    for (let n = 0; n < 8 && sim.stage !== 'done'; n++) {
      const before = { stars: sim.stars, hp: sim.hp };
      let found: { aim: number; elev: number; meter: number } | null = null;
      search: for (const elev of [0, 60]) {
        for (let meter = 8; meter <= 63; meter += 5) {
          for (let aim = 0; aim < 360; aim += 3) {
            const t = fresh();
            const st = shoot(t, aim, elev, meter);
            if (st === 'done' || t.stars > before.stars) { found = { aim, elev, meter }; break search; }
          }
        }
      }
      expect(found, `no shot found at stroke ${n + 1}`).not.toBeNull();
      shots.push(found!);
      sim = fresh();
    }
    expect(sim.stage).toBe('done');
    expect(sim.stars).toBe(2);
    expect(sim.strokes).toBeLessThanOrEqual(8);
    console.log(`holed in ${sim.strokes}: ${JSON.stringify(shots)}`);
  }, 120000);
});
