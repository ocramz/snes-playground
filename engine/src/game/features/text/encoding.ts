/**
 * The game's text encoding (docs/text.md; tools/text.py CHARMAP): a
 * character is the index of its glyph in the 192-tile font, laid out 16 to a
 * row in font.png. Pure: the font builder and the tests share it.
 */

/** Glyph index -> character, for the glyphs that have an ASCII equivalent. */
export const GLYPHS: ReadonlyMap<number, string> = (() => {
  const m = new Map<number, string>();
  m.set(0x1f, ' ');
  m.set(0x20, '@');
  m.set(0x40, '>');
  m.set(0x6b, ',');
  m.set(0x6c, "'");
  '#%()*/:.!<=>?[]'.split('').forEach((c, i) => m.set(0x01 + i, c));
  for (let i = 0; i < 10; i++) m.set(0x10 + i, String(i));
  m.set(0x1c, '+');
  m.set(0x1d, '-');
  for (let i = 0; i < 26; i++) {
    m.set(0x21 + i, String.fromCharCode(65 + i));
    m.set(0x51 + i, String.fromCharCode(97 + i));
  }
  return m;
})();

export const FONT_GLYPHS = 192;
export const GLYPH_SIZE = 8;
export const GLYPHS_PER_ROW = 16;

/**
 * The 192-character string a RetroFont is parsed with: position i is the
 * character drawn with glyph i. Glyphs without an ASCII equivalent (and the
 * duplicate '>' of the cursor at $40, and the blank $00) get private-use code
 * points U+E000 + i, so every position is distinct.
 */
export function retroFontChars(): string {
  const seen = new Set<string>();
  let out = '';
  for (let i = 0; i < FONT_GLYPHS; i++) {
    const c = GLYPHS.get(i);
    if (c !== undefined && !seen.has(c)) {
      seen.add(c);
      out += c;
    } else {
      out += String.fromCharCode(0xe000 + i);
    }
  }
  return out;
}

/** Text the font can draw: unknown characters become spaces. */
export function fontSafe(text: string): string {
  const known = new Set(retroFontChars());
  return [...text].map((c) => (c === '\n' || known.has(c) ? c : ' ')).join('');
}
