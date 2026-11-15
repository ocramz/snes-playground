/**
 * `play-feedback` (reference §12): the frame's events -> sounds, by the
 * event table (features/audio/event-table.ts). The cutscenes' cues arrive in
 * the same list (bridge/frame-loop.ts), so they are played the same way.
 */
import { EVENT_TABLE } from '../features/audio/event-table';
import type { Presentation } from './presentation';

export function playFeedback(p: Presentation): void {
  const audio = p.audio;
  if (!audio) return;
  for (const e of p.events) {
    const row = EVENT_TABLE[e.kind];
    if (!row) continue;
    switch (row.react) {
      case 'sfx':
        if (e.romSfx > 0) audio.playEffect(e.romSfx);
        break;
      case 'song':
        if (e.romSfx === 0) audio.stopMusic();
        else audio.playSong(e.romSfx);
        break;
      case 'stop-sfx':
        audio.stopEffects();
        break;
      case 'mute-music':
        audio.muteMusic();
        break;
      default:
        break;
    }
  }
}
