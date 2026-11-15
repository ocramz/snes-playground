/**
 * The event timeline against the recorded game (plans/port_v1_koota_phaser4.md
 * verification, "events"): every sound the game requests from its main
 * loop or its physics — `$80:B542` (effects) and `$80:B4AC` (songs), logged
 * by tools/snesstep/trace_flow.py into build/engine/rom-test/sounds_*.json —
 * must be an event the engine emits on the same frame with the same id.
 *
 * Frames are the main loop's iterations: a request in the first lines of a
 * video frame belongs to the iteration of the frame before (the loop runs
 * past the vblank; fixtures.ts `iterationOf`). Requests from presentation
 * objects (the thread code of banks $84/$85: the spin streak's whoosh, the
 * reveal's sparkle, ...) and Kirby's animation scripts ($87: the tired
 * pose's pant) are the bridge's, not core's, and are left out.
 * Song events carry the song's number, the request byte - $7E.
 */
import { describe, expect, it } from 'vitest';
import { runFlowScript, GAME_OFFSET } from './flow-harness';
import { haveRules, haveRomTest, loadSounds, type SoundRequest } from './fixtures';

const RUNS: Array<{ name: string; from: number; to: number }> = [
  { name: 'web_flow', from: 2333, to: 3530 },
  { name: 'web_curve', from: 2333, to: 3500 },
  { name: 'web_ui', from: 2333, to: 3295 },
  { name: 'web_fly', from: 2333, to: 3915 },
  { name: 'web_fly_spin', from: 2333, to: 3915 },
  // the second shot, the sink, the hole-out to the blank before the RESULT card
  { name: 'web_hole', from: 2333, to: 4331 },
  { name: 'web_tomatoes', from: 2333, to: 4070 },
];

/** Presentation objects (banks $84/$85) and Kirby's animation scripts ($87)
 *  request their own sounds (bridge side), except those core runs: object
 *  112's hum (systems/boost-hum.ts): $84:87FD sound $15, $84:8818 sound 0;
 *  the UFO countdown's digit $42 on the HUD's icon (systems/ability-fx.ts,
 *  $84:A54F) (the callers are the JSLs' return addresses). */
export const CORE_OBJECT_CALLERS = new Set([
  '$84:8801', '$84:881C', '$84:A553',
  // object 49's (the UFO's) hum, its phases and its holed sounds; Kirby's state-29 script's $44
  // (the scripts' sound op returns to $87:8576 for every script: by its id there)
  '$85:AE17', '$85:AE2A', '$85:AE52', '$85:AE8C', '$87:8576:68',
]);
export function fromCore(r: SoundRequest): boolean {
  return !/^\$8[457]:/.test(r[5]) || CORE_OBJECT_CALLERS.has(r[5]) || CORE_OBJECT_CALLERS.has(`${r[5]}:${r[4]}`);
}

export function compareSounds(
  game: SoundRequest[],
  engine: Array<{ gameFrame: number; kind: string; romSfx: number }>,
  from: number,
  to: number,
): string[] {
  const want = game.filter((r) => r[2] >= from && r[2] <= to && fromCore(r))
    .map((r) => ({ f: r[2], kind: r[3], id: r[3] === 'song' ? r[4] - 0x7e : r[4], caller: r[5] }));
  // only the sound requests ($80:B542 / $80:B4AC): not the music volume's port writes
  const got = engine.filter((e) => e.gameFrame >= from && e.gameFrame <= to && e.romSfx >= 0 && e.kind !== 'music-volume')
    .map((e) => ({ f: e.gameFrame, kind: e.kind === 'song' ? 'song' : 'sfx', id: e.romSfx, name: e.kind, used: false }));
  const bad: string[] = [];
  for (const w of want) {
    const hit = got.find((g) => !g.used && g.f === w.f && g.kind === w.kind && g.id === w.id);
    if (hit) hit.used = true;
    else bad.push(`missing: the game's ${w.kind} $${w.id.toString(16)} at ${w.f} (${w.caller})`);
  }
  for (const g of got) if (!g.used) bad.push(`extra: the engine's ${g.name} $${g.id.toString(16)} at ${g.f}`);
  return bad;
}

describe.skipIf(!haveRules || !haveRomTest)('the event timeline vs the game\'s sound requests', () => {
  for (const { name, from, to } of RUNS) {
    const sounds = loadSounds(name);
    it.skipIf(!sounds)(name, () => {
      const run = runFlowScript(name, to - GAME_OFFSET + 3);
      expect(compareSounds(sounds!, run.emitted, from, to)).toEqual([]);
    });
  }
});
