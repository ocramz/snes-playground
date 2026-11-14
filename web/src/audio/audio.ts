// Music with loop points and one-shot effects, straight on WebAudio. (Phaser's
// sound API has no loop points; the game's songs have an intro and a loop.)
// Everything degrades to silence if the files are missing.

interface AudioJson {
  music?: { file: string; loopStart: number; loopEnd: number };
  jingle?: string;
  sfx?: Record<string, string>;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private meta: AudioJson = {};
  private buffers = new Map<string, AudioBuffer>();
  private music: AudioBufferSourceNode | null = null;
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
    if (this.meta.music) jobs.push(this.load('music', this.meta.music.file));
    if (this.meta.jingle) jobs.push(this.load('jingle', this.meta.jingle));
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

  playMusic(): void {
    const buf = this.buffers.get('music');
    if (!this.ctx || !buf || !this.meta.music || this.music) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = this.meta.music.loopStart;
    src.loopEnd = this.meta.music.loopEnd;
    src.connect(this.master!);
    src.start();
    this.music = src;
  }

  /** The hole-in jingle (song 17, 2.8 s), once. */
  jingle(): void {
    const buf = this.buffers.get('jingle');
    if (!this.ctx || !buf || this.muted) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master!);
    src.start();
  }

  stopMusic(): void {
    this.music?.stop();
    this.music = null;
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
