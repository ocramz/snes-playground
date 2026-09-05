#!/usr/bin/env python3
"""Find and decode text stored in the game's font-tile encoding.

The game does not store ASCII. Observed in ROM (e.g. "CONTINUE" at
$83:AFEB / 0x01AFEB and "Congratulations" at $83:FB09 / 0x01FB09) and
consistent throughout: a character is the index of its glyph tile, and the
font is laid out so that

    'A'-'Z'  ->  0x21-0x3A   (ASCII - 0x20)
    'a'-'z'  ->  0x51-0x6A   (ASCII - 0x10)
    '0'-'9'  ->  0x10-0x19   (ASCII - 0x20)   unconfirmed, by analogy
    ' '      ->  0x00 and 0x7F both seen as separators

Anything else is printed as {XX}. Punctuation indices are not yet mapped.

    python3 tools/text.py                 # scan the whole ROM
    python3 tools/text.py --min 6 '$83:8000' '$83:FFFF'
    python3 tools/text.py --decode 23 2F 2E 34 29 2E 35 25
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

CHARMAP = {}
for c in range(ord("A"), ord("Z") + 1):
    CHARMAP[c - 0x20] = chr(c)
for c in range(ord("a"), ord("z") + 1):
    CHARMAP[c - 0x10] = chr(c)
for c in range(ord("0"), ord("9") + 1):
    CHARMAP[c - 0x20] = chr(c)
CHARMAP[0x00] = " "
CHARMAP[0x7F] = " "


def decode(raw):
    return "".join(CHARMAP.get(b, "{%02X}" % b) for b in raw)


def is_letter(b):
    return b in CHARMAP and CHARMAP[b] not in " "


def scan(data, start, end, min_len):
    """Yield (offset, decoded) for runs of >= min_len letters/digits,
    allowing single separators inside a run."""
    i = start
    while i < end:
        if not is_letter(data[i]):
            i += 1
            continue
        j = i
        letters = 0
        while j < end:
            b = data[j]
            if is_letter(b):
                letters += 1
                j += 1
            elif b in (0x00, 0x7F) and j + 1 < end and is_letter(data[j + 1]) and letters:
                j += 1
            else:
                break
        if letters >= min_len:
            yield i, decode(data[i:j])
        i = j


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("range", nargs="*", help="START END addresses (default whole ROM)")
    ap.add_argument("--min", type=int, default=5, help="minimum letters per hit")
    ap.add_argument("--decode", nargs="+", help="decode these hex bytes and exit")
    args = ap.parse_args()

    if args.decode:
        print(decode(bytes(int(x, 16) for x in args.decode)))
        return 0
    try:
        data = load_rom()
        start, end = 0, len(data)
        if args.range:
            if len(args.range) != 2:
                ap.error("give START and END")
            k, v = parse_addr(args.range[0])
            start = snes_to_file(*v) if k == "snes" else v
            k, v = parse_addr(args.range[1])
            end = (snes_to_file(*v) if k == "snes" else v) + 1
    except (RomError, AddressError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    for off, text in scan(data, start, end, args.min):
        b, a = file_to_snes(off)
        print("{}  {}  {}".format(fmt_file(off), fmt_snes(b, a), text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
