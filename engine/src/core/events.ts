/**
 * The event model (plans/port_v1_koota_phaser4.md, "The event model, one
 * rule for the whole codebase"): an event is an entity carrying
 * `Event {kind, frame, seq, romSfx}` + payload + `EventOf(subject)`, living
 * until the host frame ends. Core systems emit; only the bridge and the
 * tests drain. Kernels never emit — they write facts, and the systems that
 * call them turn facts into events.
 */
import { trait } from 'koota';

export const Event = trait({
  kind: '',
  frame: 0,
  seq: 0,
  /** The ROM sfx/song id, when the original requests one ($80:B542). -1 none. */
  romSfx: -1,
  /** The subject entity (the ball, the hole, ...), 0 none. */
  subject: 0,
});

let seqCounter = 0;

export interface EmitApi {
  frame: number;
}

/** Spawn one event entity on the world. Returns its entity id. */
export function emit(world: import('koota').World, api: EmitApi, kind: string, romSfx = -1, subject = 0): number {
  const e = world.spawn(
    Event({ kind, frame: api.frame, seq: seqCounter++, romSfx, subject }),
  );
  return e;
}

/**
 * All pending events in `seq` order, then destroyed. The bridge calls this
 * once per host frame; the headless harness once per core frame.
 */
export interface GameEvent {
  id: number;
  kind: string;
  frame: number;
  seq: number;
  romSfx: number;
  subject: number;
}

export function drainEvents(world: import('koota').World): GameEvent[] {
  const found: Array<{ e: import('koota').Entity; ev: GameEvent }> = [];
  for (const e of world.query(Event)) {
    const ev = e.get(Event)!;
    found.push({
      e,
      ev: { id: e, kind: ev.kind, frame: ev.frame, seq: ev.seq, romSfx: ev.romSfx, subject: ev.subject },
    });
  }
  found.sort((a, b) => a.ev.seq - b.ev.seq);
  const out = found.map((f) => f.ev);
  for (const { e } of found) e.destroy();
  return out;
}
