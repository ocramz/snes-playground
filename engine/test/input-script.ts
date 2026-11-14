/**
 * Parser for the stepper's input scripts (tools/snesstep/inputs/*.txt), the
 * same files the real game was traced with. The format (docs/emulation.md,
 * tools/snesstep/src/main.rs `parse_input`):
 *
 *   FRAME BUTTONS [HOLD]    one per line; `#` starts a comment anywhere
 *
 * - BUTTONS is `+`-joined names from B Y SELECT START UP DOWN LEFT RIGHT A X
 *   L R, or NONE for no buttons.
 * - A `2:` prefix on the BUTTONS field makes the entry pad 2's (`2:A+B`).
 * - HOLD defaults to 1. An entry covers frames [FRAME, FRAME+HOLD); the pad
 *   state for a frame is the union of the entries that cover it, and it is
 *   latched at that frame's vblank.
 * - The bit layout is the SNES $4218/$4219 one, identical to the stepper's
 *   BUTTONS table: B $8000, Y $4000, SELECT $2000, START $1000, UP $0800,
 *   DOWN $0400, LEFT $0200, RIGHT $0100, A $0080, X $0040, L $0020, R $0010.
 */
export const Button = {
  B: 0x8000,
  Y: 0x4000,
  SELECT: 0x2000,
  START: 0x1000,
  UP: 0x0800,
  DOWN: 0x0400,
  LEFT: 0x0200,
  RIGHT: 0x0100,
  A: 0x0080,
  X: 0x0040,
  L: 0x0020,
  R: 0x0010,
} as const;

export type ButtonName = keyof typeof Button;

export interface InputEntry {
  /** First frame the buttons are down. */
  frame: number;
  /** Frames [frame, frame+hold) are covered. */
  hold: number;
  /** 1 or 2. */
  pad: 1 | 2;
  /** OR of the Button bits. */
  buttons: number;
  /** Source line, 1-based, for error messages and debugging. */
  line: number;
}

export function parseInputScript(text: string): InputEntry[] {
  const out: InputEntry[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].split('#', 1)[0].trim();
    if (!line) continue;
    const bad = (): never => {
      throw new Error(`input script line ${i + 1}: expected 'FRAME BUTTONS [HOLD]', got ${JSON.stringify(lines[i])}`);
    };
    const fields = line.split(/\s+/);
    if (fields.length < 2 || fields.length > 3) bad();
    const frame = Number(fields[0]);
    if (!Number.isInteger(frame) || frame < 0) bad();
    const hold = fields.length === 3 ? Number(fields[2]) : 1;
    if (!Number.isInteger(hold) || hold < 0) bad();
    const pad: 1 | 2 = fields[1].startsWith('2:') ? 2 : 1;
    const names = (pad === 2 ? fields[1].slice(2) : fields[1]).split('+');
    let buttons = 0;
    for (const raw of names) {
      const name = raw.toUpperCase();
      if (name === 'NONE') continue;
      const bit = Button[name as ButtonName];
      if (bit === undefined) throw new Error(`input script line ${i + 1}: unknown button ${name}`);
      buttons |= bit;
    }
    out.push({ frame, hold, pad, buttons, line: i + 1 });
  }
  return out;
}

/**
 * The pad-1 button mask the script drives at `frame`: the union of every
 * pad-1 entry covering it. (Pad 2 is a 2P concern and is deferred.)
 */
export function heldAt(script: InputEntry[], frame: number): number {
  let held = 0;
  for (const e of script) {
    if (e.pad === 1 && frame >= e.frame && frame < e.frame + e.hold) held |= e.buttons;
  }
  return held;
}
