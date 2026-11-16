/**
 * DEMOPLAY SELECT's demos (docs/emulation.md "DEMOPLAY"; notes/
 * port-v2-phase5-abilities.md "The demo clock"): a record per demo in the
 * ROM (`$88:C880`, tables.json `demos`), a header and an input stream.
 *
 * - `$83:DA41` copies the record's 20 header words to the addresses of
 *   `$83:DA7C` (tables.json `demoHeader`): the 2P flag `$17FF`, the course
 *   and hole `$6A5A`/`$6A5E`, the random state `$0079`/`$007B`, `$6A58`,
 *   the stocks carried into the hole `$DA90`/`$DA92`, the lives
 *   `$D7F4`/`$D7F6`, the tomatoes `$D7F0`/`$D7F2`, `$D7E0`/`$D7E2` and
 *   `$ECFB`-`$ED05`. It sets the stream's count `$C6` to 1 and leaves it
 *   disarmed (`$C0` = 0).
 * - `$82:B2DC` arms it (`$C0` = 1) at the hole's set-up.
 * - `$83:DAAA` ticks it once per call of the frame helper `$80:8F78` (from
 *   the vblank wait `$80:845F`): it keeps the last pad in `$CC`, counts
 *   `$C6` down and, at 0, loads the next (pad, count) pair into `$C4`/`$C6`
 *   (a count of 0 ends the stream: the pad is 0 from then on, for 65535
 *   ticks). It then writes the pad the game reads: held `$0067` = `$C4`,
 *   pressed `$006B` = ¬`$CC` & `$C4`. Disarmed, it writes held = 0 and
 *   leaves pressed alone.
 *
 * So the stream's clock is the game's iterations, not the video frames: a
 * lag frame (no `$80:8F78`) does not tick it, and every frame of a nested
 * wait (a hit-stop, the take's 4 frames, the transformation's 48) does.
 * The help texts the demos stop on (`$ED5B`, `$82:F7EE`) run inside the
 * frame helper after the tick and freeze the world; the engine does not
 * play them.
 */
import type { World } from 'koota';
import type { RomRules } from './rules';
import { Stall } from './traits/stall';
import { TomatoQueue } from './traits/counters';

/** One record: its header by address, and its stream's (pad, count) pairs. */
export interface DemoRecord {
  index: number;
  header: Map<number, number>;
  stream: Array<[number, number]>;
}

/** tables.json `demos` (a directory of 20 offsets, then the records) -> record k. */
export function demoRecord(rules: RomRules, k: number): DemoRecord {
  const t = rules.table('demos');
  const addrs = rules.table('demoHeader');
  let o = t[k];
  const header = new Map<number, number>();
  for (let i = 0; i < addrs.length; i++) header.set(addrs[i], t[o++]);
  const stream: Array<[number, number]> = [];
  for (;;) {
    const pad = t[o];
    const count = t[o + 1];
    o += 2;
    stream.push([pad, count]);
    if (count === 0) break;
  }
  return { index: k, header, stream };
}

/** The ROM hole a record plays: `$6A5A` x 8 + `$6A5E` (`$82:B0A4`). */
export function demoHole(rec: DemoRecord): number {
  return (rec.header.get(0x6a5a)! << 3) + rec.header.get(0x6a5e)!;
}

/** The stream's state, `$83:DAAA`'s direct page words. */
export interface DemoCursor {
  /** `$C4`: the pad of the current pair. */
  pad: number;
  /** `$C6`: ticks left on it (16-bit). */
  left: number;
  /** `$C8`: the next pair's index. */
  next: number;
}

/** `$83:DA41`: the stream as the header copy leaves it (`$C4` as power-on RAM, 0). */
export function demoCursor(): DemoCursor {
  return { pad: 0, left: 1, next: 0 };
}

/** `$83:DAAA`, armed: one tick. Returns the pad the game then reads. */
export function tickDemo(rec: DemoRecord, c: DemoCursor): { held: number; pressed: number } {
  const prev = c.pad;
  c.left = (c.left - 1) & 0xffff;
  if (c.left === 0) {
    const [pad, count] = rec.stream[Math.min(c.next, rec.stream.length - 1)];
    c.left = count;
    c.pad = count === 0 ? 0 : pad; // $83:DAE2: a count of 0 loads the count (0) as the pad
    c.next += 1;
  }
  return { held: c.pad, pressed: ~prev & c.pad & 0xffff };
}

/**
 * Does the coming core frame tick the stream (does the ROM call its frame
 * helper `$80:8F78` in it)? Every frame does but the lag frames the engine
 * models: the idle frames of the guide's and the APU's lag (`tickStall`: a
 * stall of those kinds with more than one frame left), where the main loop
 * is busy, and the cup reveal's decompression frames (`TomatoQueue.hold`,
 * systems/reveal.ts), where the thread scheduler does not run either.
 */
export function isIterationFrame(world: World): boolean {
  const s = world.get(Stall)!;
  if ((s.kind === 'guideLag' || s.kind === 'apuLag') && s.framesLeft > 1) return false;
  return world.get(TomatoQueue)!.hold === 0;
}
