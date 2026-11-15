/**
 * `tick-time` (plans/port_v1_koota_phaser4.md "Phaser: scenes, bridge"):
 * the host's display-rate delta in, the number of fixed core frames to run
 * out. Core frames run at the game's 60.0988 Hz; the remainder carries over,
 * so a 60 Hz display runs a second frame about every 600 host frames. After
 * a stall longer than MAX_FRAMES_PER_HOST frames the backlog is dropped
 * rather than fast-forwarded. Pure (no Phaser): the determinism test uses it.
 */
import { FRAME_MS, MAX_FRAMES_PER_HOST } from '../config';

export class FrameClock {
  private acc = 0;

  constructor(
    private readonly frameMs = FRAME_MS,
    private readonly max = MAX_FRAMES_PER_HOST,
  ) {}

  /** Core frames to run for a host frame of `deltaMs`. */
  step(deltaMs: number): number {
    this.acc += Number.isFinite(deltaMs) && deltaMs > 0 ? deltaMs : 0;
    const n = Math.floor(this.acc / this.frameMs);
    if (n > this.max) {
      this.acc = 0;
      return this.max;
    }
    this.acc -= n * this.frameMs;
    return n;
  }

  /** The time carried into the next host frame, ms. */
  get carried(): number {
    return this.acc;
  }

  reset(): void {
    this.acc = 0;
  }
}
