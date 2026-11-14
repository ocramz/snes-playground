// HoleSim.requestShot, the hand-gesture page's shot: from the aim stage straight to
// the curl, the launch HAND_CURL_FRAMES after Kirby starts to curl.
import { describe, expect, it } from 'vitest';
import { haveAssets, loadRom } from '../../../test/load';
import { HAND_CURL_FRAMES, HoleSim, SFX, emptyPad } from '../hole';
import { launchVelocity, shotPower } from '../shot';

describe.skipIf(!haveAssets)('the hand shot', () => {
  for (const aim of [0, 135, 180, 300]) {
    it(`aim ${aim}: curls once the camera is there, launches ${HAND_CURL_FRAMES} frames later`, () => {
      const { rom, course } = loadRom();
      const sim = new HoleSim(rom, course);
      for (let i = 0; i < 120; i++) sim.tick(emptyPad()); // the aim camera settles
      sim.setAim(aim);
      expect(sim.aim).toBe(aim);
      expect(sim.requestShot(40)).toBe(true);
      sim.tick(emptyPad());
      expect(sim.stage).toBe('curl');
      expect(sim.events).toContainEqual({ type: 'sfx', id: SFX.launch });
      expect(sim.events).toContainEqual({ type: 'stage', stage: 'curl' });
      expect(sim.strokes).toBe(1);
      expect(sim.hp).toBe(3);
      expect(sim.meter).toBe(40);
      expect(sim.handShot).toBe(true);

      let curlAt = -1, rollAt = -1;
      for (let t = 1; t < 400 && rollAt < 0; t++) {
        sim.tick(emptyPad());
        if (curlAt < 0 && sim.curlStarted) curlAt = t;
        if (sim.stage === 'roll') rollAt = t;
      }
      expect(curlAt).toBeGreaterThan(0);
      expect(rollAt - curlAt).toBe(HAND_CURL_FRAMES);
      expect(sim.handShot).toBe(false);
      // the ball leaves as the power A would have sent it
      const v = launchVelocity(rom, shotPower(rom, 40, false), aim, 0);
      expect({ vx: sim.ball.vx, vy: sim.ball.vy, vz: sim.ball.vz }).toEqual(v);
    });
  }

  it('is refused outside the aim stage, and dropped if the stage changes first', () => {
    const { rom, course } = loadRom();
    const sim = new HoleSim(rom, course);
    sim.startIntro(10);
    sim.tick(emptyPad());
    expect(sim.requestShot(30)).toBe(false);
    for (let i = 0; i < 20; i++) sim.tick(emptyPad());
    expect(sim.stage).toBe('aim');
    sim.setAim(400);
    expect(sim.aim).toBe(40);
    sim.setAim(-30);
    expect(sim.aim).toBe(330);
  });
});
