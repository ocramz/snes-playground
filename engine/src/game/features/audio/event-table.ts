/**
 * The event table (plans/port_v1_koota_phaser4.md "The event model"): every
 * event kind core emits (and the cutscenes' cues), the sound ids it can
 * carry and what the view does with it. Pure; the event-table test checks
 * that every id has a rendered file in audio.json and that the test courses
 * and the flow scripts emit nothing outside this table. docs/engine.md
 * (phase 8) prints it.
 *
 * `romSfx` is an effect number (decimal; the request byte to `$80:B542`),
 * except for kind 'song', where it is the song number n (request $7E + n;
 * 0 = the silent carrier that stops the music), and 'silence', the effect
 * request 0 that stops the effect playing.
 */

export type Reaction = 'sfx' | 'song' | 'stop-sfx' | 'mute-music' | 'none';

export interface EventRow {
  /** The ids the kind can carry; empty = never a sound (romSfx -1). */
  ids: readonly number[];
  /** The original's site (the emitting system has the detail). */
  site: string;
  react: Reaction;
}

export const EVENT_TABLE: Readonly<Record<string, EventRow>> = {
  'aim-tick': { ids: [0x53], site: '$81:A98B the aim turns', react: 'sfx' },
  'aim-confirm': { ids: [0x34], site: '$81:A791 A in the aim stage', react: 'sfx' },
  'spin-side': { ids: [0x46], site: '$81:C16C the side selector', react: 'sfx' },
  'spin-tb': { ids: [0x42, 0x3d], site: '$81:C19F/$81:C1A4 top/back passes 6 / reaches 0 or 12', react: 'sfx' },
  'power-start': { ids: [0x57], site: 'Power t = 4, the meter starts', react: 'sfx' },
  silence: { ids: [0], site: '$81:C038/$81:C046/$82:E206 effect request 0', react: 'stop-sfx' },
  launch: { ids: [0x18, 0x19], site: '$82:BFF0 the launch ($19 at full power)', react: 'sfx' },
  modifier: { ids: [0x26], site: '$82:DA97 A/Y armed mid-roll', react: 'sfx' },
  bounce: { ids: [1, 2, 3, 5, 6], site: '$81:9BE5 by vz; $81:9BF4 the spin streak (5, 6)', react: 'sfx' },
  step: { ids: [4], site: '$81:8A2E the ball hits a step', react: 'sfx' },
  wall: { ids: [7], site: '$82:91E6 the outline wall', react: 'sfx' },
  tile: { ids: [0x1a, 0x5f, 0x60, 0x6f, 0x11, 0x7c, 0x0c], site: 'the step tail: friction, rough, $05, snaps, a cone, an arrow', react: 'sfx' },
  pillar: { ids: [0x71], site: '$82:956C/$82:95F8', react: 'sfx' },
  hazard: { ids: [0x6f], site: '$82:9C9D a bumper', react: 'sfx' },
  'hazard-hit': { ids: [], site: '$82:EED8 object $2F (not drawn)', react: 'none' },
  thrown: { ids: [0x7b], site: '$82:DB9A code $0F, a volcano throws', react: 'sfx' },
  'enemy-taken': { ids: [0x4f, 0x50], site: '$82:8A92 / $82:8A79 (an ability enemy)', react: 'sfx' },
  'cup-reveal': { ids: [0x1c], site: '$82:8D49 the ring stage', react: 'sfx' },
  warp: { ids: [0x76, 0x77], site: '$82:AABC the ball goes in (object 63), $82:AB7C it comes out (object 64)', react: 'sfx' },
  'holed-in': { ids: [], site: '$82:AD13 object 75, the cup\'s rim over Kirby (bridge/sync-cup-mask.ts)', react: 'none' },
  holed: { ids: [0x21], site: '$81:80A5 holedSfx[mode] ($82:AEF5)', react: 'sfx' },
  'music-mute': { ids: [], site: 'the sink ends: music volume 0', react: 'mute-music' },
  'tomato-gain': { ids: [0x52], site: '$83:AC07 the HUD queue', react: 'sfx' },
  'tomato-loss': { ids: [0x10], site: '$83:AC18 the HUD queue', react: 'sfx' },
  'ball-lost': { ids: [0x54], site: '$80:F848', react: 'sfx' },
  'life-lost': { ids: [0x0b], site: '$80:F8D0 / $80:F876', react: 'sfx' },
  'life-object': { ids: [0x77], site: '$80:F89B object $40', react: 'sfx' },
  'game-over': { ids: [], site: '$80:F387 / $80:F3B5', react: 'none' },
  song: { ids: [0, 11, 17, 18, 24, 25, 26], site: '$80:B4AC song requests ($7E + n)', react: 'song' },
  // the cutscenes' own sounds (features/cutscene/replay.ts), not core's
  cue: { ids: [29, 45, 47, 62, 98, 100, 103], site: 'cutscenes.json cues', react: 'sfx' },
};

/** Song ids that stop the music rather than play one. */
export const SONG_STOP = 0;
