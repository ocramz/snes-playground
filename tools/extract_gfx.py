#!/usr/bin/env python3
"""Catalogue every HAL-compressed stream in the ROM, decompress it, guess
what it is, and render tile sheets.

Uses halcomp.scan over the whole ROM (cached in build/gfx/streams.tsv so the
minute-long scan runs once), then for each stream writes

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

from halcomp import CompressionError, decompress, scan  # noqa: E402
from lorom import AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file  # noqa: E402
from palettes import looks_like_palette, render as render_palette  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import decode_tiles, render_sheet  # noqa: E402

OUT = "build/gfx"
MIN_OUT = 128
MIN_RATIO = 1.2


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
    rows = []
    if not os.path.exists(path):
        return None
    with open(path) as f:
        for line in f:
            if line.startswith("#") or not line.strip():
                continue
            off, used, size = line.split("\t")[:3]
            rows.append((int(off, 16), int(used), int(size)))
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
        rows = [(off, used, len(out))]
    else:
        rows = None if args.rescan else load_cache(cache)
        if rows is None:
            print("scanning ROM for streams (this takes a minute)...")
            rows = list(scan(data, 0, len(data), MIN_OUT, MIN_RATIO))
            with open(cache, "w") as f:
                f.write("# offset\tpacked\tunpacked\n")
                for off, used, size in rows:
                    f.write("{}\t{}\t{}\n".format(fmt_file(off), used, size))

    index = []
    for off, used, size in rows:
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
        index.append((off, b, a, used, size, kind, score, pngs))
        print("{} {}  {:6d} -> {:6d}  {:<8} {:.2f}".format(
            fmt_file(off), fmt_snes(b, a), used, size, kind, score))

    if not args.only:
        with open(os.path.join(args.out, "index.tsv"), "w") as f:
            f.write("file_offset\tsnes_addr\tpacked\tunpacked\tratio\tkind\tscore\tpng\n")
            for off, b, a, used, size, kind, score, pngs in index:
                f.write("{}\t{}\t{}\t{}\t{:.2f}\t{}\t{:.2f}\t{}\n".format(
                    fmt_file(off), fmt_snes(b, a), used, size, size / used, kind, score,
                    ";".join(os.path.basename(p) for p in pngs)))
        from collections import Counter
        c = Counter(k for _, _, _, _, _, k, _, _ in index)
        print("\n{} streams: {}".format(len(index), dict(c)))
        print("index: {}".format(os.path.join(args.out, "index.tsv")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
