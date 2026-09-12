#!/usr/bin/env python3
"""Extract per-hole course data from the bank $88 pointer tables.

Bank $88 holds eleven tables of 256 three-byte long pointers each, starting
at $88:A770 (0x042770) and 0x300 apart. The game indexes them with the
16-bit value at $7E:ABB6 (= hole index * 3); see the loader at $82:B16B
which does `LDX $ABB6 / LDA $88:B670,X / TAY / LDA $88:B672,X / TYX / LDY
#dest / JSL sub_hal_decompress`. Indices 0..243 are populated; unused slots
all point at one shared default entry.

    table  addr      what (measured on index 0)
    0      $88:A770  raw 28-byte hole header, NOT compressed; 16 bytes of
                     fields then a 12-byte space-padded name like "MAP00"
    1-4    $88:AA70  compressed, width*height bytes each: grid layers
                     1 = terrain shape, 2 = special tiles, 3 = elevation,
                     4 = edge wall flags. Sizes run 12x12 to 28x28; header
                     words 1 and 2 give the dimensions
    5-7    $88:B670  compressed, one 16-bit entry per map row: first column,
                     last column, and word offset into tables 8/9
    8-9    $88:BF70  compressed, 704-16880 bytes; the BG1 and BG2 tilemaps,
                     row-packed against tables 5-7. See tools/coursemap.py
    10     $88:C570  compressed, ~150 bytes: 16-bit table, meaning unknown

Everything is written under build/courses/<index>/ with the table number
in the file name, plus headers.tsv listing every populated index.

    python3 tools/courses.py
    python3 tools/courses.py --index 5 --dump     # hexdump instead of files
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from halcomp import CompressionError, decompress  # noqa: E402
from lorom import fmt_file, fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

TABLE_BASE = 0xA770
TABLE_BANK = 0x88
TABLE_COUNT = 11
ENTRIES = 256
HEADER_SIZE = 28


def entry(d, table, index):
    off = snes_to_file(TABLE_BANK, TABLE_BASE + 0x300 * table) + 3 * index
    addr = int.from_bytes(d[off:off + 2], "little")
    bank = d[off + 2]
    return bank, addr


def default_entries(d):
    """Per table, the pointer that appears most often (the unused-slot filler)."""
    from collections import Counter
    out = []
    for t in range(TABLE_COUNT):
        c = Counter(entry(d, t, i) for i in range(ENTRIES))
        out.append(c.most_common(1)[0][0])
    return out


def header(d, index):
    bank, addr = entry(d, 0, index)
    off = snes_to_file(bank, addr)
    raw = d[off:off + HEADER_SIZE]
    fields = [int.from_bytes(raw[i:i + 2], "little") for i in range(0, 16, 2)]
    name = raw[16:28].decode("ascii", "replace").strip()
    return off, fields, name, raw


# Header word meanings, established by checking all 232 holes:
#   word 0 = cell count, exactly equal to the decompressed size of tables 1-4
#   word 1 = grid width, word 2 = grid height, and word 0 == word1 * word2
#   word 4 = tilemap width in 8-pixel tiles = 4 * (width + height)
#   word 5 = tilemap height in tiles, and the length of tables 5, 6 and 7
#   word 3 = word4 * word5, the rectangular tilemap area
# Word 6 is always zero; word 7 is a multiple of 8 whose meaning is unknown.
W_CELLS, W_WIDTH, W_HEIGHT = 0, 1, 2


def render_grid(cells, width, height, scale=20, path=None):
    """Render one grid layer as a labelled colour map.

    Distinct byte values get distinct colours from a fixed cycle, so the same
    value looks the same across layers and across holes. The value is drawn
    in each cell, because the point of looking at these is to read the
    numbers, not to admire them.
    """
    from PIL import Image, ImageDraw
    palette = [
        (25, 25, 30), (200, 60, 60), (60, 170, 90), (70, 110, 210),
        (215, 165, 55), (165, 90, 200), (70, 190, 200), (225, 130, 170),
        (140, 150, 60), (110, 110, 120), (230, 110, 60), (90, 200, 150),
        (170, 70, 110), (130, 170, 230), (200, 200, 90), (150, 100, 70),
    ]
    img = Image.new("RGB", (width * scale, height * scale), (0, 0, 0))
    dr = ImageDraw.Draw(img)
    for i, v in enumerate(cells[:width * height]):
        x, y = (i % width) * scale, (i // width) * scale
        dr.rectangle([x, y, x + scale - 1, y + scale - 1],
                     fill=palette[v % len(palette)], outline=(0, 0, 0))
        if v:
            dr.text((x + 3, y + 5), "{:02X}".format(v), fill=(255, 255, 255))
    if path:
        parent = os.path.dirname(os.path.abspath(path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent)
        img.save(path)
    return img


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/courses")
    ap.add_argument("--index", type=int, help="only this hole index")
    ap.add_argument("--dump", action="store_true", help="print instead of writing files")
    ap.add_argument("--grids", action="store_true",
                    help="also render tables 1-4 as PNG colour maps")
    args = ap.parse_args()

    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    defaults = default_entries(d)
    indices = [args.index] if args.index is not None else [
        i for i in range(ENTRIES) if entry(d, 0, i) != defaults[0]]

    if not args.dump and not os.path.isdir(args.out):
        os.makedirs(args.out)
    rows = []
    for i in indices:
        off, fields, name, raw = header(d, i)
        rows.append((i, off, name, fields))
        if args.dump:
            print("index {:3d}: header {} name {!r} fields {}".format(
                i, fmt_file(off), name, " ".join("{:04X}".format(f) for f in fields)))
        else:
            hole_dir = os.path.join(args.out, "{:03d}_{}".format(i, name or "noname"))
            if not os.path.isdir(hole_dir):
                os.makedirs(hole_dir)
            with open(os.path.join(hole_dir, "t00_header.bin"), "wb") as f:
                f.write(raw)
        for t in range(1, TABLE_COUNT):
            bank, addr = entry(d, t, i)
            src = snes_to_file(bank, addr)
            try:
                out, used = decompress(d, src)
            except CompressionError as e:
                print("index {} table {}: {} at {}: {}".format(
                    i, t, fmt_snes(bank, addr), fmt_file(src), e), file=sys.stderr)
                continue
            if args.dump:
                print("  table {:2d}: {} ({}) {} -> {} bytes: {}{}".format(
                    t, fmt_snes(bank, addr), fmt_file(src), used, len(out),
                    " ".join("{:02X}".format(x) for x in out[:24]),
                    " ..." if len(out) > 24 else ""))
            else:
                with open(os.path.join(hole_dir, "t{:02d}_{:02X}{:04X}.bin".format(
                        t, bank, addr)), "wb") as f:
                    f.write(out)
                if args.grids and 1 <= t <= 4:
                    w, h = fields[W_WIDTH], fields[W_HEIGHT]
                    if w and h and len(out) >= w * h:
                        render_grid(out, w, h,
                                    path=os.path.join(hole_dir,
                                                      "t{:02d}_grid.png".format(t)))
    if not args.dump:
        with open(os.path.join(args.out, "headers.tsv"), "w") as f:
            f.write("index\tfile_offset\tname\tfields\n")
            for i, off, name, fields in rows:
                f.write("{}\t{}\t{}\t{}\n".format(
                    i, fmt_file(off), name, " ".join("{:04X}".format(x) for x in fields)))
        print("wrote {} holes to {}".format(len(rows), args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
