#!/usr/bin/env python3
"""Catalogue every HAL-compressed stream in the ROM, decompress it, guess
what it is, and render tile sheets.

Streams the ROM itself points at are decoded first, at the offset the
pointer gives: immediate decompressor calls, the bank `$88` course tables
and the course backdrop tables. Only the gaps between those are then
brute-forced. The order matters. A blind scan is greedy and non-overlapping,
so a chance decode that starts a few bytes early swallows the real stream
behind it -- 157 referenced streams used to be lost inside 110 such hits,
the font at `$90:FBBC` among them, and their output files began at the
wrong offset.

The result is cached in build/gfx/streams.tsv so the minute-long scan runs
once. For each stream this writes

    build/gfx/bin/<file>_<snes>.bin       decompressed bytes
    build/gfx/png/<file>_<snes>_4bpp.png  greyscale 4bpp sheet (size % 32 == 0)
    build/gfx/png/<file>_<snes>_2bpp.png  also, when the data looks 2bpp
    build/gfx/png/<file>_<snes>_pal.png   palette swatch, for palette-like data

and build/gfx/index.tsv with one row per stream: offset, SNES address,
packed size, unpacked size, ratio, guessed kind, 4bpp-coherence score.

The kind guess is a heuristic:
  palette   size <= 1 KB, multiple of 32, every word has bit 15 clear
  tilemap   even size >= 256, few distinct high bytes, many distinct low bytes
  tiles4    size % 32 == 0 and the plane-2/3 half of each tile overlaps the
            plane-0/1 half (score >= 0.35); sprites and BG tiles
  tiles2    size % 16 == 0 with low overlap score
  data      anything else
Always look at the PNG before believing the label.

    python3 tools/extract_gfx.py                 # everything
    python3 tools/extract_gfx.py --only '$8E:EC7F'   # one stream
    python3 tools/extract_gfx.py --rescan        # ignore the cache
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from halcomp import CompressionError, decompress  # noqa: E402
from lorom import AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file  # noqa: E402
from palettes import looks_like_palette, render as render_palette  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import decode_tiles, render_sheet  # noqa: E402

OUT = "build/gfx"
MIN_OUT = 128
MIN_RATIO = 1.2

# A=bank X=addr Y=dest, then one of these: sub_hal_decompress, sub_load_asset,
# sub_load_asset_vram, sub_decompress_queue (A also carries the dest bank in
# its high byte there, so only the low byte is the source bank).
DECOMPRESS_CALLS = ((0x80, 0x9F18), (0x80, 0xCA9F), (0x80, 0xCAA9), (0x80, 0xA032))
# sub_load_course_backdrop $80:D6A8: two tables of 8 x (bank16, addr16).
BACKDROP_TABLES = ((0x80, 0xD748, "backdrop tiles"), (0x80, 0xD768, "backdrop map"))
CODE_END = 0x040000


def known_starts(data):
    """{file offset: reason} for every stream something in the ROM names."""
    out = {}

    def note(bank, addr, why):
        if addr < 0x8000 or (bank & 0x7F) > 0x1F:
            return
        try:
            off = snes_to_file(bank, addr)
            decompress(data, off)
        except (AddressError, CompressionError, IndexError):
            return
        out.setdefault(off, why)

    for tb, ta in DECOMPRESS_CALLS:
        tail = bytes((ta & 0xFF, ta >> 8, tb))
        for i in range(9, CODE_END - 4):
            if data[i] not in (0x22, 0x5C) or data[i + 1:i + 4] != tail:
                continue
            pre = data[i - 9:i]
            if pre[0] == 0xA9 and pre[3] == 0xA2 and pre[6] == 0xA0:
                note(pre[1], int.from_bytes(pre[4:6], "little"),
                     "call at {}".format(fmt_snes(*file_to_snes(i))))

    from courses import ENTRIES, TABLE_COUNT, default_entries, entry
    defaults = default_entries(data)
    for t in range(TABLE_COUNT):
        for i in range(ENTRIES):
            bank, addr = entry(data, t, i)
            if (bank, addr) != defaults[t]:
                note(bank, addr, "course table {}".format(t))

    for tb, ta, why in BACKDROP_TABLES:
        base = snes_to_file(tb, ta)
        for i in range(8):
            bank = int.from_bytes(data[base + 4 * i:base + 4 * i + 2], "little")
            addr = int.from_bytes(data[base + 4 * i + 2:base + 4 * i + 4], "little")
            note(bank & 0xFF, addr, "{} {}".format(why, i))
    return out


def scan_gap(data, start, end):
    """Brute-force [start, end) for streams that end inside it."""
    p = start
    while p < end:
        try:
            out, used = decompress(data, p)
        except (CompressionError, IndexError):
            p += 1
            continue
        if p + used <= end and len(out) >= MIN_OUT and used > 1 and \
                len(out) / used >= MIN_RATIO:
            yield p, used, len(out), "-"
            p += used
        else:
            p += 1


def scan_all(data):
    """[(offset, packed, unpacked, reason)]: referenced streams, then gaps."""
    rows = []
    for off, why in sorted(known_starts(data).items()):
        out, used = decompress(data, off)
        rows.append((off, used, len(out), why))
    claimed = []
    for off, used, _, _ in sorted(rows):
        if claimed and off < claimed[-1][1]:
            claimed[-1][1] = max(claimed[-1][1], off + used)
        else:
            claimed.append([off, off + used])
    p = 0
    for lo, hi in claimed + [[len(data), len(data)]]:
        rows.extend(scan_gap(data, p, lo))
        p = hi
    return sorted(rows)


def popcount(b):
    return bin(b).count("1")


def plane_overlap(data):
    """For 4bpp tiles: mean over rows of |(p0|p1) & (p2|p3)| / |(p0|p1)|(p2|p3)|.
    Real 4bpp art scores high (the upper planes paint the same pixels); 2bpp
    data read as 4bpp scores low because the halves are unrelated tiles."""
    num = den = 0
    for t in range(0, len(data) - 31, 32):
        for y in range(8):
            lo = data[t + 2 * y] | data[t + 2 * y + 1]
            hi = data[t + 16 + 2 * y] | data[t + 16 + 2 * y + 1]
            num += popcount(lo & hi)
            den += popcount(lo | hi)
    return num / den if den else 0.0


def tilemap_score(out):
    """Fraction of 16-bit words whose high 6 bits (vhoppp) take one of a small
    number of values. A real SNES tilemap uses only a handful of
    palette/priority/flip combinations across thousands of entries; tile
    pixel data spreads that field uniformly."""
    if len(out) < 64 or len(out) % 2:
        return 0.0
    from collections import Counter
    c = Counter(int.from_bytes(out[i:i + 2], "little") >> 10 for i in range(0, len(out), 2))
    n = sum(c.values())
    return sum(v for _, v in c.most_common(8)) / n


def classify(out):
    n = len(out)
    if n % 32 == 0 and n <= 1024:
        ws = [int.from_bytes(out[i:i + 2], "little") for i in range(0, n, 2)]
        if all(w & 0x8000 == 0 for w in ws) and looks_like_palette(ws[:16]):
            return "palette", 0.0
    # Tilemaps first: they are frequently a multiple of 32 too, so testing
    # them after the tile tests mislabels every course background.
    tm = tilemap_score(out)
    if n >= 256 and tm >= 0.98:
        return "tilemap", tm
    if n % 32 == 0:
        s = plane_overlap(out)
        return ("tiles4" if s >= 0.35 else "tiles2"), s
    if n % 16 == 0:
        return "tiles2", plane_overlap(out)
    return "data", 0.0


def load_cache(path):
    """Cached rows, or None when there is no cache or it predates the
    reference-first scan (three columns instead of four)."""
    rows = []
    if not os.path.exists(path):
        return None
    with open(path) as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 4:
                return None
            rows.append((int(cols[0], 16), int(cols[1]), int(cols[2]), cols[3]))
    return rows


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--rescan", action="store_true")
    ap.add_argument("--only", help="process just this stream address")
    ap.add_argument("--no-png", action="store_true")
    ap.add_argument("--scale", type=int, default=2)
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    for sub in ("bin", "png"):
        p = os.path.join(args.out, sub)
        if not os.path.isdir(p):
            os.makedirs(p)

    cache = os.path.join(args.out, "streams.tsv")
    if args.only:
        try:
            kind, value = parse_addr(args.only)
            off = snes_to_file(*value) if kind == "snes" else value
            out, used = decompress(data, off)
        except (AddressError, CompressionError) as e:
            print("error: {}".format(e), file=sys.stderr)
            return 1
        rows = [(off, used, len(out), "-")]
    else:
        rows = None if args.rescan else load_cache(cache)
        if rows is None:
            print("scanning ROM for streams (this takes a minute)...")
            rows = scan_all(data)
            with open(cache, "w") as f:
                f.write("# offset\tpacked\tunpacked\treferenced_by\n")
                for off, used, size, why in rows:
                    f.write("{}\t{}\t{}\t{}\n".format(fmt_file(off), used, size, why))

    index = []
    for off, used, size, why in rows:
        out, _ = decompress(data, off)
        b, a = file_to_snes(off)
        name = "{:06X}_{:02X}{:04X}".format(off, b, a)
        kind, score = classify(out)
        with open(os.path.join(args.out, "bin", name + ".bin"), "wb") as f:
            f.write(out)
        pngs = []
        if not args.no_png:
            if kind == "palette":
                p = os.path.join(args.out, "png", name + "_pal.png")
                render_palette(out, 0, len(out), path=p)
                pngs.append(p)
            elif kind in ("tiles4", "tiles2") or (kind == "tilemap" and len(out) % 32 == 0):
                if len(out) % 32 == 0:
                    p = os.path.join(args.out, "png", name + "_4bpp.png")
                    render_sheet(decode_tiles(out, 4), 4, 16, args.scale).save(p)
                    pngs.append(p)
                if kind == "tiles2" or score < 0.5:
                    p = os.path.join(args.out, "png", name + "_2bpp.png")
                    render_sheet(decode_tiles(out, 2), 2, 16, args.scale).save(p)
                    pngs.append(p)
        index.append((off, b, a, used, size, kind, score, pngs, why))
        print("{} {}  {:6d} -> {:6d}  {:<8} {:.2f}".format(
            fmt_file(off), fmt_snes(b, a), used, size, kind, score))

    if not args.only:
        with open(os.path.join(args.out, "index.tsv"), "w") as f:
            f.write("file_offset\tsnes_addr\tpacked\tunpacked\tratio\tkind\tscore"
                    "\tpng\treferenced_by\n")
            for off, b, a, used, size, kind, score, pngs, why in index:
                f.write("{}\t{}\t{}\t{}\t{:.2f}\t{}\t{:.2f}\t{}\t{}\n".format(
                    fmt_file(off), fmt_snes(b, a), used, size, size / used, kind, score,
                    ";".join(os.path.basename(p) for p in pngs), why))
        from collections import Counter
        c = Counter(k for _, _, _, _, _, k, _, _, _ in index)
        print("{} of them referenced by the ROM, the rest found by scanning "
              "the gaps".format(sum(1 for r in index if r[8] != "-")))
        print("\n{} streams: {}".format(len(index), dict(c)))
        print("index: {}".format(os.path.join(args.out, "index.tsv")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
