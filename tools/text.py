#!/usr/bin/env python3
"""Find, decode and render text stored in the game's font-tile encoding.

The game does not store ASCII. A character *is* the index of its glyph tile
in the BG3 font, so the encoding can be read straight off the font sheet
rather than guessed from example strings. The font is `gfx_course_font` at
`$90:FBBC (0x087BBC)`: a HAL stream that unpacks to 3,328 bytes, of which
3,072 are uploaded to VRAM word `$4000` as 192 2bpp tiles by graphics set B
entry 1 (`$80:CDE3`).

Rendered 16 tiles to a row, that sheet reads:

    $00  blank    $01-$0F  # % ( ) * / : . ! < = > ? [ ]
    $10-$19  0-9   $1B-$1D  + - (and a plus-minus at $1B)
    $1E  solid block         $1F  space
    $20  @        $21-$3A  A-Z
    $3B-$3F  five kanji (字 左 右 上 下)
    $40  right-pointing cursor   $41-$45  ° 「 」 、 ･
    $50  blank    $51-$6A  a-z
    $6B  ,        $6C  '
    $6D onward    empty boxes, unused

Two things that were previously uncertain are settled by the sheet: the
digits really are `$10-$19`, and space is **`$1F`**, not `$00`. `$00` is a
blank tile too, but strings use `$1F`.

`sub_text_draw` at `$83:B406 (0x01B406)` walks a string, ORs `$3C00` into
each glyph -- palette 7 with the priority bit -- and stores it into the BG3
tilemap staging buffer. Bytes `$F0-$FF` are control codes dispatched through
`tbl_text_control $83:B46A`; `$FE` is a newline (`$83:B44C` advances the row
and resets the column) and `$FF` ends the string. So the pause menu at
`$83:AFE4` reads

    FE 1F*4 40 1F "CONTINUE" FE FE 1F*6 "COURSE SELECT SCREEN" FE ... FF

i.e. a newline, four spaces, the cursor glyph, then the entries.

    python3 tools/text.py --strings              # every string in the ROM
    python3 tools/text.py --scan --min 6         # looser: runs of letters
    python3 tools/text.py --decode 23 2F 2E 34 29 2E 35 25
    python3 tools/text.py --render '$83:AFE4' -o build/text/menu.png
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from halcomp import decompress  # noqa: E402
from lorom import AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

FONT = (0x90, 0xFBBC)
FONT_TILES = 192
GLYPH_ATTR = 0x3C00        # palette 7 + priority, ORed in by $83:B406

# Read off the font sheet; see the module docstring.
CHARMAP = {0x00: " ", 0x1F: " ", 0x20: "@", 0x40: ">", 0x6B: ",", 0x6C: "'"}
for _i, _c in enumerate("#%()*/:.!<=>?[]"):
    CHARMAP[0x01 + _i] = _c
for _i in range(10):
    CHARMAP[0x10 + _i] = chr(ord("0") + _i)
CHARMAP[0x1C] = "+"
CHARMAP[0x1D] = "-"
for _i in range(26):
    CHARMAP[0x21 + _i] = chr(ord("A") + _i)
    CHARMAP[0x51 + _i] = chr(ord("a") + _i)

CONTROL = {0xFE: "\n", 0xFF: None}      # None = end of string

# Glyphs that exist but have no ASCII equivalent; kept out of CHARMAP so a
# scan does not mistake a table of small numbers for text.
NAMED = {0x1B: "{+-}", 0x1E: "{block}", 0x3B: "{kanji:ji}", 0x3C: "{kanji:left}",
         0x3D: "{kanji:right}", 0x3E: "{kanji:up}", 0x3F: "{kanji:down}",
         0x41: "{deg}", 0x42: "{open}", 0x43: "{close}", 0x44: "{comma-jp}",
         0x45: "{middot}"}


def decode(raw, stop=True):
    """Decode bytes to text. Stops at $FF when `stop`."""
    out = []
    for b in raw:
        if b == 0xFF and stop:
            break
        if b in CONTROL:
            out.append(CONTROL[b] or "")
        elif b in CHARMAP:
            out.append(CHARMAP[b])
        elif b in NAMED:
            out.append(NAMED[b])
        else:
            out.append("{%02X}" % b)
    return "".join(out)


def is_glyph(b):
    """A byte that prints as a visible character."""
    return (b in CHARMAP and CHARMAP[b] != " ") or b in NAMED


def is_alnum(b):
    """A letter or digit.

    The punctuation glyphs occupy `$01-$0F`, which is also what a table of
    small numbers looks like, so a run has to be judged on its letters or
    the scan reports every jump table in the ROM as prose.
    """
    return 0x10 <= b <= 0x19 or 0x21 <= b <= 0x3A or 0x51 <= b <= 0x6A


def find_strings(data, start, end, min_letters=4, max_len=512):
    """Yield (offset, length, text) for $FF-terminated glyph runs.

    A string is accepted when it ends in `$FF`, contains at least
    `min_letters` letters or digits, is majority letters once spaces are
    discounted, and holds nothing but glyphs, spaces and control codes in
    between. Judging on letters rather than on any glyph is what keeps jump
    tables out: the punctuation glyphs are `$01-$0F`, indistinguishable from
    a table of small numbers.
    """
    i = start
    while i < end:
        if not is_alnum(data[i]) and data[i] not in (0x1F, 0xFE):
            i += 1
            continue
        j, letters, other = i, 0, 0
        while j < end and j - i < max_len:
            b = data[j]
            if b == 0xFF:
                break
            if is_alnum(b):
                letters += 1
            elif is_glyph(b):
                other += 1
            elif b not in (0x1F, 0x00, 0xFE):
                break
            j += 1
        if (j < end and data[j] == 0xFF and letters >= min_letters
                and letters >= other):
            yield i, j - i + 1, decode(data[i:j])
            i = j + 1
        else:
            i += 1


def scan(data, start, end, min_len):
    """Looser: runs of >= min_len printable glyphs, no terminator needed."""
    i = start
    while i < end:
        if not is_alnum(data[i]):
            i += 1
            continue
        j, letters = i, 0
        while j < end:
            b = data[j]
            if is_alnum(b):
                letters += 1
            elif not is_glyph(b) and b not in (0x1F, 0x00):
                break
            j += 1
        if letters >= min_len:
            yield i, decode(data[i:j], stop=False).strip()
        i = max(j, i + 1)


def font_tiles(d):
    blob, _ = decompress(d, snes_to_file(*FONT))
    from tiles import decode_tiles
    return decode_tiles(blob[:FONT_TILES * 16], 2)


def render_string(d, raw, scale=3, columns=26):
    """Draw a string with the real font, the way $83:B406 lays it out."""
    from PIL import Image
    tiles = font_tiles(d)
    lines, cur = [], []
    for b in raw:
        if b == 0xFF:
            break
        if b == 0xFE:
            lines.append(cur)
            cur = []
        elif b < 0xF0:
            cur.append(b)
    lines.append(cur)
    width = max(columns, max((len(l) for l in lines), default=1))
    img = Image.new("RGB", (width * 8, len(lines) * 8), (24, 24, 32))
    px = img.load()
    shades = [(24, 24, 32), (120, 120, 140), (255, 255, 255), (200, 200, 210)]
    for row, line in enumerate(lines):
        for col, b in enumerate(line):
            if b >= len(tiles):
                continue
            for y in range(8):
                for x in range(8):
                    px[col * 8 + x, row * 8 + y] = shades[tiles[b][y][x]]
    if scale != 1:
        resample = getattr(Image, "Resampling", Image).NEAREST
        img = img.resize((img.width * scale, img.height * scale), resample)
    return img


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("start", nargs="?", help="start address")
    ap.add_argument("end", nargs="?", help="end address")
    ap.add_argument("--strings", action="store_true",
                    help="find $FF-terminated strings (the default)")
    ap.add_argument("--scan", action="store_true",
                    help="looser scan for runs of letters")
    ap.add_argument("--min", type=int, default=4, help="minimum letters")
    ap.add_argument("--decode", nargs="+", metavar="HEX",
                    help="decode bytes given on the command line")
    ap.add_argument("--render", help="render the string at this address")
    ap.add_argument("--font-sheet", action="store_true",
                    help="render the font with its index over each glyph")
    ap.add_argument("--scale", type=int, default=3)
    ap.add_argument("-o", "--out", help="PNG path, or the TSV for --strings")
    args = ap.parse_args()

    if args.decode:
        raw = bytes(int(x, 16) for x in args.decode)
        print(decode(raw))
        return 0

    try:
        d = load_rom()
        start = 0
        end = len(d)
        if args.start:
            kind, value = parse_addr(args.start)
            start = snes_to_file(*value) if kind == "snes" else value
        if args.end:
            kind, value = parse_addr(args.end)
            end = (snes_to_file(*value) if kind == "snes" else value) + 1
    except (RomError, AddressError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    if args.font_sheet:
        from tiles import render_sheet
        img = render_sheet(font_tiles(d), 2, width=16, scale=args.scale)
        path = args.out or "build/text/font.png"
        _ensure(path)
        img.save(path)
        print("wrote {} ({} glyphs)".format(path, FONT_TILES))
        return 0

    if args.render:
        kind, value = parse_addr(args.render)
        off = snes_to_file(*value) if kind == "snes" else value
        raw = d[off:off + 512]
        path = args.out or "build/text/string.png"
        _ensure(path)
        render_string(d, raw, args.scale).save(path)
        print("wrote {}".format(path))
        print(decode(raw))
        return 0

    if args.scan:
        for off, text in scan(d, start, end, args.min):
            bank, addr = file_to_snes(off)
            print("{}  {}  {}".format(fmt_file(off), fmt_snes(bank, addr), text))
        return 0

    rows = list(find_strings(d, start, end, args.min))
    path = args.out or "build/text/strings.tsv"
    _ensure(path)
    with open(path, "w") as f:
        f.write("file_offset\tsnes_addr\tlength\ttext\n")
        for off, n, text in rows:
            bank, addr = file_to_snes(off)
            f.write("{}\t{}\t{}\t{}\n".format(
                fmt_file(off), fmt_snes(bank, addr), n,
                text.replace("\n", "\\n").replace("\t", " ")))
    print("wrote {} ({} strings)".format(path, len(rows)))
    for off, n, text in rows[:12]:
        bank, addr = file_to_snes(off)
        print("  {}  {}".format(fmt_snes(bank, addr),
                                text.replace("\n", " / ")[:64]))
    return 0


def _ensure(path):
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)


if __name__ == "__main__":
    sys.exit(main())
