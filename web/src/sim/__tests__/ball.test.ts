// The numbers below are the *emulated* measurements in docs/physics.md, taken
// from the game itself on hole 1 (course 1, hole 1 = MAP00).
import { describe, expect, it } from 'vitest';
import { bareWorld, haveAssets, loadRom } from '../../../test/load';
import { Ball } from '../ball';

const setup = () => {
  const { rom, terrain } = loadRom();
  const world = bareWorld(terrain);
  const ball = new Ball(rom);
  return { rom, terrain, world, ball };
};

describe.skipIf(!haveAssets)('ball physics against docs/physics.md', () => {
  it('rolling friction on flat ground: -12 moving +x, -13 moving -x', () => {
    const { world, ball } = setup();
    ball.place(world, 6, 0x8000, 4, 0x8000);
    ball.vx = 4000;
    ball.step(world);
    expect(ball.vx).toBe(4000 - 12);
    ball.vx = -4000;
    ball.step(world);
    expect(ball.vx).toBe(-4000 + 13);
  });

  it('a still ball on the ramp cell (11,3) goes -43, then -34 a frame more', () => {
    const { world, ball } = setup();
    ball.place(world, 11, 0x8000, 3, 0x8000);
    ball.step(world);
    expect(ball.vx).toBe(-43);
    ball.step(world);
    expect(ball.vx).toBe(-43 - 34);
    ball.step(world);
    expect(ball.vx).toBe(-43 - 68);
  });

  it('flat drop: vz -1728 on landing, leaves at 1058 with vx 892', () => {
    const { world, ball } = setup();
    ball.place(world, 6, 0x4000, 4, 0x8000);
    ball.z = 0xb504;
    ball.vx = 0x400;
    ball.air = true;
    let landVz = 0;
    for (let i = 0; i < 80; i++) {
      const before = ball.vz;
      ball.step(world);
      if (ball.bounced) {
        landVz = before - 64; // the gravity frame before the one that landed
        break;
      }
    }
    expect(ball.bounced).toBe(true);
    expect(ball.vz).toBe(1058);
    expect(ball.vx).toBe(892);
    expect(landVz).toBeLessThan(0);
  });

  it('ramp drop onto (11,3): leaves downhill, vx -1301, vz 1003', () => {
    const { world, ball } = setup();
    ball.place(world, 11, 0x8000, 3, 0x8000);
    ball.z = 0x10f86;
    ball.air = true;
    for (let i = 0; i < 80 && !ball.bounced; i++) ball.step(world);
    expect(ball.bounced).toBe(true);
    expect(ball.vx).toBe(-1301);
    expect(ball.vz).toBe(1003);
  });

  it('settles when it bounces again within 16 frames', () => {
    const { world, ball } = setup();
    ball.place(world, 6, 0x4000, 4, 0x8000);
    ball.z = ball.cur.ground + 100;
    ball.air = true;
    ball.vz = -200;
    for (let i = 0; i < 5; i++) ball.step(world);
    expect(ball.air).toBe(false);
    expect(ball.vz).toBe(0);
  });
});
