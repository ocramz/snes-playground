/**
 * The game's sounds (plans "audio"): the songs from audio.json with their
 * loop points, and the effects by their ROM number.
 *
 * Phaser's WebAudioSound loops a whole marker by scheduling a second source,
 * and has no loop region, so a song is played on its own
 * AudioBufferSourceNode (loop, loopStart, loopEnd from build/spc/wav/
 * index.tsv via tools/export_web.py) through a gain node, into the sound
 * manager's destination. Effects go through `sound.play` (one effect at a
 * time per id, like the APU's effect channels: replaying an id restarts it).
 *
 * Requests, as the event table names them: song n (0 stops the music),
 * `music-mute` (the sink's end sets the music volume to 0), effect 0 (stops
 * the effect playing), an effect number. Approximations (docs/audio.md): the
 * effects were rendered over song 0's tempo, the driver's dropped ticks are
 * not modelled, and libgme's 1.30x level difference is not corrected.
 */
import Phaser from 'phaser';
import type { AudioJson } from '../../assets/schema';
import { sfxKey, songKey } from '../../assets/keys';

export class AudioPlayer {
  private music: { source: AudioBufferSourceNode; gain: GainNode; song: number } | null = null;
  private readonly effects = new Map<number, Phaser.Sound.BaseSound>();

  constructor(private readonly game: Phaser.Game, private readonly audio: AudioJson | null) {}

  private get web(): Phaser.Sound.WebAudioSoundManager | null {
    const m = this.game.sound as Phaser.Sound.WebAudioSoundManager;
    return 'context' in m && m.context ? m : null;
  }

  /** The song playing (0: none). */
  get song(): number {
    return this.music?.song ?? 0;
  }

  playSong(n: number): void {
    this.stopMusic();
    if (n === 0 || !this.audio) return;
    const entry = this.audio.songs[String(n)];
    const mgr = this.web;
    if (!entry || !mgr) return;
    const buffer = this.game.cache.audio.get(songKey(n)) as AudioBuffer | undefined;
    if (!buffer || typeof (buffer as AudioBuffer).getChannelData !== 'function') return;
    const ctx = mgr.context;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    if (entry.loopStart !== undefined && entry.loopEnd !== undefined) {
      source.loop = true;
      source.loopStart = entry.loopStart;
      source.loopEnd = Math.min(entry.loopEnd, buffer.duration);
    }
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(mgr.destination);
    source.start();
    this.music = { source, gain, song: n };
  }

  stopMusic(): void {
    if (!this.music) return;
    try {
      this.music.source.stop();
    } catch {
      // already stopped
    }
    this.music.source.disconnect();
    this.music.gain.disconnect();
    this.music = null;
  }

  muteMusic(): void {
    if (this.music) this.music.gain.gain.value = 0;
  }

  /**
   * The music's volume, 0-1 (`$80:B5F4`'s byte / $FF: object 112 lowers it
   * to $82 while it hums). Like the mute it holds for the song playing; a new
   * song starts at full volume.
   */
  setMusicVolume(v: number): void {
    if (this.music) this.music.gain.gain.value = Math.max(0, Math.min(1, v));
  }

  playEffect(id: number): void {
    const key = sfxKey(id);
    if (!this.game.cache.audio.exists(key)) return;
    let s = this.effects.get(id);
    if (!s) {
      s = this.game.sound.add(key);
      this.effects.set(id, s);
    }
    s.stop();
    s.play();
  }

  stopEffects(): void {
    for (const s of this.effects.values()) s.stop();
  }

  stopAll(): void {
    this.stopMusic();
    this.stopEffects();
  }
}
