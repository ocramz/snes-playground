#!/usr/bin/env python3
"""Render an SNES tilemap over a decoded tile sheet.

A tilemap entry is one 16-bit little-endian word:

    bits 0-9    tile index
    bits 10-12  palette (sub-palette number)
    bit  13     priority
    bit  14     horizontal flip
    bit  15     vertical flip

Both the map and the tiles normally come from decompressed streams under
build/gfx/bin. The map's width is not stored with it, so pass --width (in
tiles); --guess prints the factorisations that produce a plausible screen.

    python3 tools/tilemap.py MAP.bin TILES.bin --width 46 -o build/out.png
    python3 tools/tilemap.py MAP.bin TILES.bin --width 32 \
        --palette build/pal/98C000.bin -o out.png
    python3 tools/tilemap.py MAP.bin --guess

Tiles missing from the sheet are drawn as a flat mid-grey so a wrong
pairing is obvious rather than silently blank.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tiles import decode_tiles, grey_palette, read_palette  # noqa: E402


def entries(data):
    return [int.from_bytes(data[i:i + 2], "little") for i in range(0, len(data) - 1, 2)]


def render(map_data, tile_data, width, bpp=4, palettes=None, scale=1):
    from PIL import Image
    ents = entries(map_data)
    tiles = decode_tiles(tile_data, bpp) if tile_data else []
    height = (len(ents) + width - 1) // width
    img = Image.new("RGB", (width * 8, height * 8), (128, 128, 128))
    px = img.load()
    default = grey_palette(bpp)
    for i, w in enumerate(ents):
        idx = w & 0x3FF
        pal = (w >> 10) & 7
        hflip = bool(w & 0x4000)
        vflip = bool(w & 0x8000)
        ox, oy = (i % width) * 8, (i // width) * 8
        if idx >= len(tiles):
            continue
        rows = tiles[idx]
        colors = palettes[pal] if palettes and pal < len(palettes) else default
        for y in range(8):
            sy = 7 - y if vflip else y
            for x in range(8):
                sx = 7 - x if hflip else x
                px[ox + x, oy + y] = colors[rows[sy][sx]]
    if scale != 1:
        resample = getattr(Image, "Resampling", Image).NEAREST
        img = img.resize((img.width * scale, img.height * scale), resample)
    return img


def guess_widths(n):
    """Plausible tilemap widths for n entries: divisors giving a screen-ish
    aspect ratio, plus the SNES standard 32 and 64."""
    out = []
    for w in range(8, 129):
        if n % w == 0:
            h = n // w
            if 0.2 <= h / w <= 5:
                out.append((w, h))
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map", help="tilemap bin")
    ap.add_argument("tiles", nargs="?", help="tile sheet bin")
    ap.add_argument("--width", type=int, help="map width in tiles")
    ap.add_argument("--bpp", type=int, choices=(2, 4, 8), default=4)
    ap.add_argument("--palette", help="CGRAM file; all 8 sub-palettes are used")
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument("--guess", action="store_true", help="print candidate widths and exit")
    ap.add_argument("-o", "--output")
    args = ap.parse_args()

    with open(args.map, "rb") as f:
        map_data = f.read()
    n = len(map_data) // 2
    if args.guess:
        print("{} entries; candidate width x height:".format(n))
        for w, h in guess_widths(n):
            print("  {:3d} x {:3d}".format(w, h))
        return 0
    if not args.width or not args.output:
        ap.error("need --width and -o (or --guess)")

    tile_data = b""
    if args.tiles:
        with open(args.tiles, "rb") as f:
            tile_data = f.read()
    palettes = None
    if args.palette:
        palettes = [read_palette("{}:{}".format(args.palette, i), args.bpp)
                    for i in range(8)]
    img = render(map_data, tile_data, args.width, args.bpp, palettes, args.scale)
    parent = os.path.dirname(os.path.abspath(args.output))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    img.save(args.output)
    print("wrote {} ({} entries, {}x{})".format(args.output, n, img.width, img.height))
    return 0


if __name__ == "__main__":
    sys.exit(main())
