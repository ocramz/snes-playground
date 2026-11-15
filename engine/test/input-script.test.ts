import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Button, heldAt, parseInputScript } from './input-script';
import { inputScriptPath } from './fixtures';

describe('parseInputScript', () => {
  it('parses FRAME BUTTONS [HOLD] with the SNES bit layout', () => {
    const script = parseInputScript('100 A 2\n200 LEFT+B 1\n');
    expect(script).toEqual([
      { frame: 100, hold: 2, pad: 1, buttons: Button.A, line: 1 },
      { frame: 200, hold: 1, pad: 1, buttons: Button.LEFT | Button.B, line: 2 },
    ]);
  });

  it('defaults HOLD to 1, treats NONE as no buttons, takes 2: as pad 2', () => {
    const script = parseInputScript('10 NONE\n20 2:A+B 3\n');
    expect(script[0]).toMatchObject({ frame: 10, hold: 1, buttons: 0 });
    expect(script[1]).toMatchObject({ frame: 20, hold: 3, pad: 2, buttons: Button.A | Button.B });
  });

  it('skips comments and blank lines, keeps the source line number', () => {
    const script = parseInputScript('# header\n\n  300 START 2   # title menu\n');
    expect(script).toHaveLength(1);
    expect(script[0]).toMatchObject({ frame: 300, buttons: Button.START, hold: 2, line: 3 });
  });

  it('rejects unknown buttons and malformed lines with the line number', () => {
    expect(() => parseInputScript('1 Q')).toThrow('line 1: unknown button Q');
    expect(() => parseInputScript('1 A 2 3')).toThrow("expected 'FRAME BUTTONS [HOLD]'");
    expect(() => parseInputScript('x A')).toThrow("expected 'FRAME BUTTONS [HOLD]'");
  });

  it('parses every committed script the traces were recorded with', () => {
    for (const name of ['web_grounder', 'web_fly', 'web_flow', 'web_ui', 'two_player']) {
      const script = parseInputScript(readFileSync(inputScriptPath(name), 'utf8'));
      expect(script.length).toBeGreaterThan(0);
      for (const e of script) {
        expect(e.frame).toBeGreaterThanOrEqual(0);
        expect(e.hold).toBeGreaterThanOrEqual(1);
      }
    }
    // web_grounder opens the game: START at 400 held 2 frames (its first entry).
    const first = parseInputScript(readFileSync(inputScriptPath('web_grounder'), 'utf8'))[0];
    expect(first).toMatchObject({ frame: 400, buttons: Button.START, hold: 2, pad: 1 });
    // No committed script uses the 2: prefix today; that path is covered
    // by the synthetic case above.
  });
});

describe('heldAt', () => {
  const script = parseInputScript('10 A 3\n12 B 2\n20 2:A 9\n');

  it('unions the pad-1 entries covering the frame, over [frame, frame+hold)', () => {
    expect(heldAt(script, 9)).toBe(0);
    expect(heldAt(script, 10)).toBe(Button.A);
    expect(heldAt(script, 12)).toBe(Button.A | Button.B);
    expect(heldAt(script, 13)).toBe(Button.B);
    expect(heldAt(script, 14)).toBe(0);
  });

  it('ignores pad 2', () => {
    expect(heldAt(script, 20)).toBe(0);
  });
});
