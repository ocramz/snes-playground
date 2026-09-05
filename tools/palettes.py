#!/usr/bin/env python3
"""Find and render SNES palettes.

CGRAM colours are 15-bit little-endian words, 0BBBBBGGGGGRRRRR. The game's
CGRAM staging buffer is $7E:0400-$05FF (see sub_dma_cgram at $80:8250,
which DMAs it to $2122); palettes are copied there from ROM with MVN, so
they are stored raw and can be found by scanning.

    python3 tools/palettes.py render '$98:C000' 0x200 -o build/pal/c000.png
    python3 tools/palettes.py scan '$98:C000' '$98:FFFF'        # candidates
    python3 tools/palettes.py extract '$98:C000' 0x200 -o build/pal/c000.bin

A "candidate" is 16 aligned words with bit 15 clear, at least 6 distinct
colours and entry 0 black-or-transparent-like (any value allowed, it is
usually 0). Expect false positives in code-free tables; check with `render`.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import snes_color  # noqa: E402


def words(data, off, n):
    return [int.from_bytes(data[off + 2 * i:off + 2 * i + 2], "little") for i in range(n)]


def looks_like_palette(ws, min_distinct=6):
    if any(w & 0x8000 for w in ws):
        return False
    if len(set(ws)) < min_distinct:
        return False
    # Reject runs that are mostly one repeated value or an ascending ramp
    # of small ints (pointer tables and counters trip the bit-15 test).
    if all(w < 0x40 for w in ws):
        return False
    return True


def scan(data, start, end, min_distinct=6):
    """Yield (offset, run_length_in_rows) for runs of consecutive candidate
    16-colour rows on 32-byte alignment relative to the scan start."""
    off = start
    while off + 32 <= end:
        if looks_like_palette(words(data, off, 16), min_distinct):
            run = 1
            while off + 32 * (run + 1) <= end and \
                    looks_like_palette(words(data, off + 32 * run, 16), min_distinct):
                run += 1
            yield off, run
            off += 32 * run
        else:
            off += 2


def render(data, off, length, cell=12, path=None):
    from PIL import Image
    n = length // 2
    ws = words(data, off, n)
    rows = (n + 15) // 16
    img = Image.new("RGB", (16 * cell, rows * cell), (40, 40, 40))
    px = img.load()
    for i, w in enumerate(ws):
        r, g, b = snes_color(w)
        x0, y0 = (i % 16) * cell, (i // 16) * cell
        for y in range(cell - 1):
            for x in range(cell - 1):
                px[x0 + x, y0 + y] = (r, g, b)
    if path:
        parent = os.path.dirname(os.path.abspath(path))
        if not os.path.isdir(parent):
            os.makedirs(parent)
        img.save(path)
    return img


def _to_off(text):
    kind, value = parse_addr(text)
    return snes_to_file(*value) if kind == "snes" else value


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan")
    s.add_argument("start")
    s.add_argument("end")
    s.add_argument("--min-rows", type=int, default=1)
    r = sub.add_parser("render")
    r.add_argument("address")
    r.add_argument("length")
    r.add_argument("-o", "--output", required=True)
    r.add_argument("--file", help="render from this raw file instead of the ROM")
    e = sub.add_parser("extract")
    e.add_argument("address")
    e.add_argument("length")
    e.add_argument("-o", "--output", required=True)
    args = ap.parse_args()

    try:
        if args.cmd == "render" and args.file:
            with open(args.file, "rb") as f:
                data = f.read()
            off = int(args.address, 0)
        else:
            data = load_rom()
    except (RomError, OSError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    try:
        if args.cmd == "scan":
            start, end = _to_off(args.start), _to_off(args.end) + 1
            for off, run in scan(data, start, end):
                if run >= args.min_rows:
                    b, a = file_to_snes(off)
                    print("{}  {}  {:3d} rows ({} bytes)".format(
                        fmt_file(off), fmt_snes(b, a), run, run * 32))
        elif args.cmd == "render":
            if not args.file:
                off = _to_off(args.address)
            render(data, off, int(args.length, 0), path=args.output)
            print("wrote {}".format(args.output))
        else:
            off = _to_off(args.address)
            length = int(args.length, 0)
            parent = os.path.dirname(os.path.abspath(args.output))
            if not os.path.isdir(parent):
                os.makedirs(parent)
            with open(args.output, "wb") as f:
                f.write(data[off:off + length])
            print("wrote {} bytes to {}".format(length, args.output))
    except AddressError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
