import type { AtlasJson, Clip } from './atlas';

/** Plays a clip one 60 Hz tick at a time (frame-accurate, pausable). */
export class ClipPlayer {
  private clip: Clip | null = null;
  private name = '';
  private index = 0;
  private left = 0;
  finished = false;

  constructor(private readonly atlas: AtlasJson) {}

  get current(): string { return this.name; }

  play(name: string, restart = false): void {
    if (!restart && name === this.name) return;
    const clip = this.atlas.clips[name];
    if (!clip) {
      this.clip = null; this.name = name;
      return;
    }
    this.name = name;
    this.clip = clip;
    this.index = 0;
    this.left = clip.frames[0].d;
    this.finished = false;
  }

  /** Frame name now showing, or null for an unknown clip. */
  get frame(): string | null {
    return this.clip ? this.clip.frames[this.index].f : null;
  }

  tick(): void {
    const c = this.clip;
    if (!c || this.finished) return;
    this.left -= 1;
    if (this.left > 0) return;
    if (this.index + 1 < c.frames.length) {
      this.index += 1;
    } else if (c.loop) {
      this.index = c.loopStart;
    } else {
      this.finished = true;
      return;
    }
    this.left = c.frames[this.index].d;
  }
}
