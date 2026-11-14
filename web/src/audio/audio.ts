// Music with loop points and one-shot effects, straight on WebAudio. (Phaser's
// sound API has no loop points; the game's songs have an intro and a loop.)
// Everything degrades to silence if the files are missing.

interface SongFile { file: string; loopStart?: number; loopEnd?: number }

interface AudioJson {
  music?: SongFile;
  /** by the game's song number (a request of id $7E + n plays song n) */
  songs?: Record<string, SongFile>;
  sfx?: Record<string, string>;
}

/** The hole's song (course 1). */
export const HOLE_SONG = 11;

export class GameAudio {
  private ctx: AudioContext | null = null;
  private meta: AudioJson = {};
  private buffers = new Map<string, AudioBuffer>();
  private music: AudioBufferSourceNode | null = null;
  /** the song playing, like the sound driver's current song ($7E:1004) */
  private song = -1;
  private master: GainNode | null = null;
  muted = false;

  /** Call from a key press: browsers only start audio after a gesture. */
  async unlock(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(this.ctx.destination);
    try {
      this.meta = (await (await fetch('audio.json')).json()) as AudioJson;
    } catch {
      this.meta = {};
    }
    const jobs: Promise<void>[] = [];
    if (!this.meta.songs && this.meta.music) this.meta.songs = { [HOLE_SONG]: this.meta.music };
    for (const [n, s] of Object.entries(this.meta.songs ?? {})) jobs.push(this.load(`song${n}`, s.file));
    for (const [id, file] of Object.entries(this.meta.sfx ?? {})) jobs.push(this.load(`sfx${id}`, file));
    await Promise.all(jobs);
  }

  private async load(key: string, file: string): Promise<void> {
    if (!this.ctx) return;
    // ogg first; an mp3 of the same name is next to it for browsers without vorbis
    for (const f of [file, file.replace(/\.ogg$/, '.mp3')]) {
      try {
        const res = await fetch(f);
        if (!res.ok) continue;
        this.buffers.set(key, await this.ctx.decodeAudioData(await res.arrayBuffer()));
        return;
      } catch {
        /* try the next one; missing or undecodable stays silent */
      }
    }
  }

  /** The hole's music. */
  playMusic(): void { this.playSong(HOLE_SONG); }

  /**
   * Song n, as the game's `sub_spc_play_song` requests it (id $7E + n): one song at a
   * time, a new one replaces the old, the same one again is ignored, song 0 is silence.
   */
  playSong(n: number): void {
    if (n === this.song && this.music) return;
    this.stopMusic();
    this.song = n;
    const buf = this.buffers.get(`song${n}`);
    const meta = this.meta.songs?.[String(n)];
    if (!this.ctx || !buf || !meta) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (meta.loopStart !== undefined && meta.loopEnd !== undefined) {
      src.loop = true;
      src.loopStart = meta.loopStart;
      src.loopEnd = meta.loopEnd;
    }
    src.connect(this.master!);
    src.start();
    this.music = src;
  }

  stopMusic(): void {
    this.music?.stop();
    this.music = null;
    this.song = -1;
  }

  sfx(id: number): void {
    const buf = this.buffers.get(`sfx${id}`);
    if (!this.ctx || !buf || this.muted) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master!);
    src.start();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.7;
  }
}
