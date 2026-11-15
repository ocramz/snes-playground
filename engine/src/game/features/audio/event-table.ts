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
 * 0 = the silent carrier that stops the music), 'silence', the effect
 * request 0 that stops the effect playing, and 'music-volume', the byte
 * `$80:B5F4` writes to APU port $2142 ($FF full).
 */

export type Reaction = 'sfx' | 'song' | 'stop-sfx' | 'mute-music' | 'music-volume' | 'none';

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
  silence: { ids: [0], site: '$81:C038/$81:C046/$82:E206/$84:8818/$82:81F1/$82:80CC effect request 0 (the last two: into the water); $82:D91E the UFO\'s end', react: 'stop-sfx' },
  launch: { ids: [0x18, 0x19], site: '$82:BFF0 the launch ($19 at full power)', react: 'sfx' },
  modifier: { ids: [0x26], site: '$82:DA97 A/Y armed mid-roll', react: 'sfx' },
  bounce: { ids: [1, 2, 3, 5, 6], site: '$81:9BE5 by vz; $81:9BF4 the spin streak (5, 6)', react: 'sfx' },
  step: { ids: [4], site: '$81:8A2E the ball hits a step', react: 'sfx' },
  wall: { ids: [7], site: '$82:91E6 the outline wall; $81:A3A8 a layer-4 wall flag crossed', react: 'sfx' },
  'wall-star': { ids: [], site: '$81:A37E object 70, the star at a layer-4 wall (subject = the edge)', react: 'none' },
  tile: { ids: [0x1a, 0x5f, 0x60, 0x6f, 0x11, 0x7c, 0x0c, 0x47, 0x48, 0x49, 0x4c], site: 'the step tail: friction, rough, $05, snaps, a cone, an arrow; the water (Freeze $47, a skip or skim $48, in or out $49, in fast $4C)', react: 'sfx' },
  pillar: { ids: [0x71], site: '$82:956C/$82:95F8', react: 'sfx' },
  hazard: { ids: [0x6f], site: '$82:9C9D a bumper', react: 'sfx' },
  'hazard-hit': { ids: [], site: '$82:EED8 object $2F (not drawn)', react: 'none' },
  'snap-trail': { ids: [], site: '$82:A60E object 61, a snap panel passed: the stars (object 62, SnapStarsView)', react: 'none' },
  'water-splash': { ids: [], site: '$82:8604/$82:82A3/$82:8303/$82:8515 a splash, objects 53-57 (WaterFxView)', react: 'none' },
  thrown: { ids: [0x7b], site: '$82:DB9A code $0F, a volcano throws', react: 'sfx' },
  ability: {
    ids: [0x2e, 0x69, 0x09, 0x1a, 0x3b, 0x08, 0x0e, 0x4e, 0x3c, 0x70, 0x78, 0x59, 0x3a, 0x1b, 0x14, 0x4d, 0x72, 0x75, 0x73, 0x74, 0x42, 0x44, 0x21],
    site: 'the copy abilities (core/sim/abilities.ts): $82:DA39 the transformation $2E; the setups (Stone $69, Fireball $08, Needle $4E, Tornado $70, Wheel $78, Spark $59, Hi-Jump $1B, Freeze $14); Stone lands $09 / rebounds $1A, Parasol lands $3B, Fireball\'s hit $0E, Needle sticks $3C, Spark breaks a tree $3A, the thaw $4D, the UFO turns $72; object 49 the UFO\'s hum $75, B $73, wearing off $74, holed $21; the UFO\'s countdown digit $42 ($84:A54F); Parasol opens $44 (state 29\'s script)',
    react: 'sfx',
  },
  'ability-fx': { ids: [], site: 'an ability\'s effect object spawned ($80:DFBA / $80:E4F2; romSfx -1, subject = the type)', react: 'none' },
  'palette-set': { ids: [], site: '$80:D2FE a palette set (Fireball\'s 5; subject = the set)', react: 'none' },
  'enemy-taken': { ids: [0x4f, 0x50], site: '$82:8A92 / $82:8A79 (an ability enemy)', react: 'sfx' },
  'cup-reveal': { ids: [0x1c], site: '$82:8D49 the ring stage', react: 'sfx' },
  switch: { ids: [0x6b, 0x6a, 0x4a, 0x4b], site: '$82:A195/$82:A1E1 the toggles\' switch flips $6A2A; $82:A470 the water switch, then $82:A4ED $4A (the water goes) or $4B (it comes)', react: 'sfx' },
  warp: { ids: [0x76, 0x77], site: '$82:AABC the ball goes in (object 63), $82:AB7C it comes out (object 64)', react: 'sfx' },
  'holed-in': { ids: [], site: '$82:AD13 object 75, the cup\'s rim over Kirby (bridge/sync-cup-mask.ts)', react: 'none' },
  holed: { ids: [0x1f, 0x20, 0x21, 0x22, 0x23], site: '$81:80A5 holedSfx[mode] ($82:AEF5: $21 mode 0, Stone $23, Spark and code 15 $22, Needle and Freeze $1F, ...)', react: 'sfx' },
  'music-mute': { ids: [], site: 'the sink ends: music volume 0', react: 'mute-music' },
  'music-volume': { ids: [0x82, 0xff], site: '$84:87F6 / $84:8811: object 112 lowers the music while it hums, then restores it', react: 'music-volume' },
  'boost-hum': { ids: [0x15], site: '$84:87FD: object 112, every 34 frames on a boost panel', react: 'sfx' },
  'tomato-gain': { ids: [0x52], site: '$83:AC07 the HUD queue', react: 'sfx' },
  'tomato-loss': { ids: [0x10], site: '$83:AC18 the HUD queue', react: 'sfx' },
  'ball-lost': { ids: [0x54], site: '$80:F848', react: 'sfx' },
  'life-lost': { ids: [0x0b], site: '$80:F8D0 / $80:F876', react: 'sfx' },
  'life-object': { ids: [0x77], site: '$80:F89B object $40', react: 'sfx' },
  'game-over': { ids: [], site: '$80:F387 / $80:F3B5', react: 'none' },
  song: { ids: [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 18, 24, 25, 26], site: '$80:B4AC song requests ($7E + n); 6-14 the holes\' ($80:C967)', react: 'song' },
  // the cutscenes' own sounds (features/cutscene/replay.ts), not core's
  cue: { ids: [29, 45, 47, 62, 98, 100, 103], site: 'cutscenes.json cues', react: 'sfx' },
};

/** Song ids that stop the music rather than play one. */
export const SONG_STOP = 0;
