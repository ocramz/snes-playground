#!/usr/bin/env python3
"""Decode SNES planar tile data (2/4/8 bpp) and render it to PNG.

Input is a raw file (normally a decompressed stream under build/) or a ROM
address. Output is a tile sheet, `--width` tiles across, scaled `--scale`x.
Without a palette the sheet is greyscale; `--palette FILE[:index]` uses SNES
15-bit BGR colours from a raw CGRAM-format file (16 colours per row for
4bpp, 4 for 2bpp, 256 for 8bpp).

    python3 tools/tiles.py build/gfx/x.bin --bpp 4 -o build/gfx/x.png
    python3 tools/tiles.py '$8D:9400' --rom --length 0x1000 --bpp 4 -o build/t.png
    python3 tools/tiles.py x.bin --bpp 4 --palette build/pal/title.bin:3 -o x.png

Also importable: decode_tiles(data, bpp) -> list of 8x8 index arrays;
snes_color(word) -> (r, g, b).

SNES planar format (fullsnes "Video Memory / Tile format"): each tile is 8
rows; for 2bpp each row is 2 bytes (plane 0, plane 1), 16 bytes per tile.
4bpp adds a second 16-byte block with planes 2 and 3; 8bpp adds two more
blocks for planes 4-7. Bit 7 of a plane byte is the leftmost pixel.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import AddressError, parse_addr, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

TILE_BYTES = {2: 16, 4: 32, 8: 64}


def decode_tile(chunk, bpp):
    """Return 8 rows of 8 palette indices for one tile."""
    if bpp == 7:
        # Mode 7 / "linear 8bpp": one byte per pixel, row-major, 64 bytes.
        # (bpp=7 is a tag for this layout, not a bit depth.)
        return [list(chunk[y * 8:y * 8 + 8]) for y in range(8)]
    rows = []
    for y in range(8):
        row = [0] * 8
        for plane in range(bpp):
            # Planes are stored in pairs: pair p holds planes 2p and 2p+1,
            # 16 bytes per pair, 2 bytes per row.
            pair, sub = divmod(plane, 2)
            b = chunk[pair * 16 + y * 2 + sub]
            for x in range(8):
                if b & (0x80 >> x):
                    row[x] |= 1 << plane
        rows.append(row)
    return rows


def decode_tiles(data, bpp):
    n = 64 if bpp == 7 else TILE_BYTES[bpp]
    count = len(data) // n
    return [decode_tile(data[i * n:(i + 1) * n], bpp) for i in range(count)]


def snes_color(word):
    """15-bit 0BBBBBGGGGGRRRRR -> 8-bit (r, g, b)."""
    r = word & 0x1F
    g = (word >> 5) & 0x1F
    b = (word >> 10) & 0x1F
    return (r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2)


def read_palette(path_spec, bpp):
    """'file.bin' or 'file.bin:N' -> list of (r,g,b) for one sub-palette."""
    colors_per = 256 if bpp == 7 else 1 << bpp
    path, _, idx = path_spec.partition(":")
    idx = int(idx, 0) if idx else 0
    with open(path, "rb") as f:
        raw = f.read()
    words = [int.from_bytes(raw[i:i + 2], "little") for i in range(0, len(raw) - 1, 2)]
    sub = words[idx * colors_per:(idx + 1) * colors_per]
    if len(sub) < colors_per:
        raise ValueError("palette {} has no sub-palette {}".format(path, idx))
    return [snes_color(w) for w in sub]


def grey_palette(bpp):
    n = 256 if bpp == 7 else 1 << bpp
    return [(i * 255 // (n - 1),) * 3 for i in range(n)]


def render_sheet(tiles, bpp, width=16, scale=2, palette=None, transparent0=False):
    from PIL import Image
    palette = palette or grey_palette(bpp)
    if not tiles:
        raise ValueError("no tiles")
    height = (len(tiles) + width - 1) // width
    img = Image.new("RGBA" if transparent0 else "RGB", (width * 8, height * 8))
    px = img.load()
    for t, rows in enumerate(tiles):
        ox, oy = (t % width) * 8, (t // width) * 8
        for y in range(8):
            for x in range(8):
                c = rows[y][x]
                rgb = palette[c]
                if transparent0:
                    px[ox + x, oy + y] = rgb + (0 if c == 0 else 255,)
                else:
                    px[ox + x, oy + y] = rgb
    if scale != 1:
        img = img.resize((img.width * scale, img.height * scale), Image.Resampling.NEAREST if hasattr(Image, "Resampling") else Image.NEAREST)
    return img


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="raw file, or a ROM address with --rom")
    ap.add_argument("--rom", action="store_true", help="source is a ROM address")
    ap.add_argument("--offset", default="0", help="byte offset into the file")
    ap.add_argument("--length", help="bytes to decode (default: all)")
    ap.add_argument("--bpp", type=int, choices=(2, 4, 7, 8), default=4,
                    help="2/4/8 planar; 7 = Mode 7 linear 8bpp (64 bytes/tile)")
    ap.add_argument("--width", type=int, default=16, help="tiles per row")
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--palette", help="CGRAM-format file[:subpalette]")
    ap.add_argument("--transparent", action="store_true", help="colour 0 transparent")
    ap.add_argument("-o", "--output", required=True, help="PNG path (under build/)")
    args = ap.parse_args()

    try:
        if args.rom:
            data = load_rom()
            kind, value = parse_addr(args.source)
            start = snes_to_file(*value) if kind == "snes" else value
        else:
            with open(args.source, "rb") as f:
                data = f.read()
            start = int(args.offset, 0)
    except (RomError, AddressError, OSError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    end = len(data) if args.length is None else start + int(args.length, 0)
    chunk = data[start:end]
    tiles = decode_tiles(chunk, args.bpp)
    if not tiles:
        print("error: {} bytes is less than one {}bpp tile".format(len(chunk), args.bpp),
              file=sys.stderr)
        return 1
    palette = read_palette(args.palette, args.bpp) if args.palette else None
    img = render_sheet(tiles, args.bpp, args.width, args.scale, palette, args.transparent)
    parent = os.path.dirname(os.path.abspath(args.output))
    if not os.path.isdir(parent):
        os.makedirs(parent)
    img.save(args.output)
    print("wrote {} ({} tiles, {}x{})".format(args.output, len(tiles), img.width, img.height))
    return 0


if __name__ == "__main__":
    sys.exit(main())
