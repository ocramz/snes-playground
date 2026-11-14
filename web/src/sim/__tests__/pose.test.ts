// Kirby's animation states over a whole shot, driven the way HoleScene drives
// them, against the states the real game went through on the same sequence of
// presses (tools/snesstep/trace_flow.py web_flow: `$7E:D7D4` over time).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { haveAssets, loadRom, readJson } from '../../../test/load';
import { ClipPlayer } from '../../render/clips';
import type { AtlasJson } from '../../render/atlas';
import { HoleSim, emptyPad, type Pad } from '../hole';
import { KirbyPose, type PoseCtx } from '../pose';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../build');
const flowPath = resolve(root, 'web-test/flow_web_flow.json');
const atlasPath = resolve(root, 'web/sprites.json');

/** HoleScene.stepOnce / animate, without Phaser. */
class Harness {
  sim: HoleSim;
  pose = new KirbyPose();
  clip: ClipPlayer;
  freeze = 0;
  prev = 'aim' as HoleSim['stage'];
  states: { f: number; state: number }[] = [];
  frame = 0;

  constructor(sim: HoleSim, atlas: AtlasJson) {
    this.sim = sim;
    this.clip = new ClipPlayer(atlas);
    this.pose.onStage('aim', 'aim', this.ctx(emptyPad()));
    this.clip.play(this.pose.clip, true);
    this.pose.started();
    this.states.push({ f: 0, state: this.pose.state });
  }

  ctx(pad: Pad): PoseCtx {
    const s = this.sim;
    return {
      stage: s.stage, facing: s.facing, angle16: s.shotAngle16, turning: pad.left || pad.right,
      frozen: this.freeze > 0, squash: s.ball.squash, hp: s.hp, side: s.side, topBack: s.topBack, shotAge: s.shotAge, curlStarted: s.curlStarted,
      clipFinished: this.clip.finished,
    };
  }

  step(pad: Pad): void {
    this.frame += 1;
    if (this.freeze > 0) {
      this.freeze -= 1;
    } else {
      this.sim.tick(pad);
      for (const ev of this.sim.events) {
        if (ev.type === 'hop') this.pose.onHop(ev.air);
        if (ev.type === 'stage') {
          this.pose.onStage(ev.stage, this.prev, this.ctx(emptyPad()));
          this.prev = ev.stage;
        }
      }
      if (this.sim.ball.hitStop > 0 && this.sim.stage === 'roll') this.freeze = this.sim.ball.hitStop;
    }
    this.pose.tick(this.ctx(pad));
    this.clip.play(this.pose.clip, this.pose.restart);
    this.pose.started();
    this.clip.tick();
    const last = this.states[this.states.length - 1];
    if (last.state !== this.pose.state) this.states.push({ f: this.frame, state: this.pose.state });
  }
}

describe.skipIf(!haveAssets || !existsSync(atlasPath))('Kirby pose over a shot', () => {
  const { rom, course } = loadRom();
  const atlas = JSON.parse(readFileSync(atlasPath, 'utf8')) as AtlasJson;

  function play(): { h: Harness; aFirst: number; launch: number; restStart: number } {
    const h = new Harness(new HoleSim(rom, course), atlas);
    const none = emptyPad();
    for (let i = 0; i < 40; i++) h.step({ ...none, left: true });
    for (let i = 0; i < 20; i++) h.step(none);
    const aFirst = h.frame + 1;
    h.step({ ...none, a: true });
    for (let i = 0; i < 80; i++) h.step(none); // the panel opens
    h.step({ ...none, a: true }); // spin -> power
    for (let i = 0; i < 6; i++) h.step(none);
    h.sim.meter = 19;
    h.sim.meterDir = 1;
    h.step({ ...none, a: true }); // latch the power
    let launch = 0;
    let restStart = 0;
    let hops = 0;
    for (let i = 0; i < 4000 && h.sim.stage !== 'aim'; i++) {
      const rolling = h.sim.stage === 'roll';
      const hopNow = rolling && h.sim.ball.cur && (i % 70 === 60) && hops < 2;
      if (hopNow) hops += 1;
      h.step(hopNow ? { ...none, a: true } : none);
      if (!launch && h.sim.stage === 'roll') launch = h.frame;
      if (!restStart && h.sim.stage === 'rest') restStart = h.frame;
    }
    return { h, aFirst, launch, restStart };
  }

  it('goes stand, turn, stand, curl, roll, hop, roll, stand', () => {
    const { h } = play();
    const seq = h.states.map((s) => s.state);
    expect(seq.slice(0, 5)).toEqual([4, 5, 4, 6, 14]);
    expect(seq[seq.length - 1]).toBe(4);
    // never the states the real game does not use in a 1P hole
    expect(seq).not.toContain(7);
    expect(seq).not.toContain(9);
    expect(seq).not.toContain(17);
  });

  it('starts the curl when the camera has arrived at the shot view (19-26 frames on the real game)', () => {
    const { h, aFirst } = play();
    const curl = h.states.find((s) => s.state === 6)!;
    expect(curl.f - aFirst).toBeGreaterThanOrEqual(15);
    expect(curl.f - aFirst).toBeLessThanOrEqual(30);
  });

  it('waits 35 frames between the end of the shot and the next aim', () => {
    const { h, restStart } = play();
    const aim = h.states[h.states.length - 1];
    expect(aim.f - restStart).toBe(35);
  });

  it.skipIf(!existsSync(flowPath))('has the same sequence of states as the real game', () => {
    const flow = readJson<{ events: [number, string, number][] }>(flowPath);
    const real = flow.events.filter((e) => e[1] === 'state' && e[0] >= 2200).map((e) => e[2]);
    const { h } = play();
    const mine = h.states.map((s) => s.state).slice(1);
    // the real run ends with the second aim and hops twice as well
    expect(mine).toEqual(real.slice(0, mine.length));
    expect(mine.length).toBeGreaterThanOrEqual(real.length - 1);
  });
});
