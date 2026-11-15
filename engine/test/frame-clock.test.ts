/** `tick-time`: fixed core frames at 60.0988 Hz from the display's deltas. */
import { describe, expect, it } from 'vitest';
import { FrameClock } from '../src/game/bridge/tick-time';
import { FRAME_MS, MAX_FRAMES_PER_HOST } from '../src/game/config';

describe('FrameClock', () => {
  it('runs 60.0988 frames a second from 60 Hz host frames, carrying the remainder', () => {
    const c = new FrameClock();
    let frames = 0;
    for (let i = 0; i < 6000; i++) frames += c.step(1000 / 60);
    // 100 s of host time
    expect(frames).toBe(Math.floor(100_000 / FRAME_MS));
    expect(c.carried).toBeGreaterThanOrEqual(0);
    expect(c.carried).toBeLessThan(FRAME_MS);
  });

  it('runs 2 or 3 frames on a slow host frame and caps a stall, dropping the backlog', () => {
    const c = new FrameClock();
    expect(c.step(FRAME_MS * 2.5)).toBe(2);
    expect(c.step(FRAME_MS * 0.5)).toBe(1);
    expect(c.step(FRAME_MS * 40)).toBe(MAX_FRAMES_PER_HOST);
    expect(c.carried).toBe(0);
    expect(c.step(0)).toBe(0);
    expect(c.step(Number.NaN)).toBe(0);
    expect(c.step(-5)).toBe(0);
  });
});
