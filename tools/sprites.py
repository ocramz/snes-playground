#!/usr/bin/env python3
"""Decode and render metasprite (OAM part list) frames.

The OAM builder at `$80:8D89 (0x000D89)` walks a list of 5-byte records and
emits one hardware sprite per record. Field mapping is taken from the store
sequence at `$80:8DE4`, which writes OAM bytes 0-3 for one sprite:

    byte 0   Y offset, signed, sign-extended and added to the object's
             Y ($38); the result goes to OAM byte 1.
             Values $7E and $80 are control codes, see below.
    byte 1   OAM byte 2 (tile number, low 8 bits)
    byte 2   OAM byte 3 (attribute): vhoopppN
             bit 0    tile number bit 8
             bits 1-3 palette
             bits 4-5 priority
             bit 6    horizontal flip
             bit 7    vertical flip
             (bytes 1-2 are fetched as one 16-bit load and stored together)
    byte 3   X offset, signed, added to the object's X ($36); low 8 bits go
             to OAM byte 0 and the 9th bit is shifted into the OAM high
             table through the bit pair accumulated in $31.
    byte 4   bit 7  set on the LAST record of the frame
             bit 6  the sprite's size bit, shifted into the OAM high table
                    alongside the X sign bit

An off-screen part is skipped by the Y range check at `$80:8DD1`
(`$00E0..$FFE0`) and the X check that follows, so a skipped part still
consumes its record.

Control values in byte 0:
    $7E  end this list and continue in the list pointed to by bytes 1-2,
         read from bank $7E (`$80:8D90`)
    $80  follow the 16-bit pointer in bytes 1-2 and continue there
         (`$80:8DAC`)

`$80:8E39` is a second copy of the same walker used for the other OAM
priority queue; the record layout is identical.

Frame lists live in bank `$89`, indexed through a word pointer table at
`$89:8000 (0x048000)`. An object's current list pointer is stored per-object
at `$7E:0B9E,X` (low word) and `$7E:0BBE,X` (bank), set by `$80:9B98`.

    python3 tools/sprites.py --list '$89:831B'
    python3 tools/sprites.py --table                # dump the $89:8000 table
    python3 tools/sprites.py --render '$89:831B' TILES.bin -o build/f.png
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import AddressError, fmt_file, fmt_snes, parse_addr, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import decode_tiles, grey_palette, read_palette  # noqa: E402

FRAME_TABLE = 0x048000   # $89:8000
FRAME_TABLE_BANK = 0x89
RECORD = 5


def signed(b):
    return b - 0x100 if b & 0x80 else b


def parse_frame(data, off, max_parts=64):
    """Return (parts, next_offset). Each part is a dict."""
    parts = []
    p = off
    while len(parts) < max_parts:
        r = data[p:p + RECORD]
        if len(r) < RECORD:
            break
        if r[0] == 0x7E or r[0] == 0x80:
            # Control record: byte 0 is a marker, bytes 1-2 a pointer.
            parts.append({"control": r[0],
                          "target": int.from_bytes(r[1:3], "little"),
                          "raw": bytes(r)})
            return parts, p + 3
        parts.append({
            "dy": signed(r[0]),
            "tile": r[1] | ((r[2] & 1) << 8),
            "palette": (r[2] >> 1) & 7,
            "priority": (r[2] >> 4) & 3,
            "hflip": bool(r[2] & 0x40),
            "vflip": bool(r[2] & 0x80),
            "dx": signed(r[3]),
            "large": bool(r[4] & 0x40),
            "last": bool(r[4] & 0x80),
            "raw": bytes(r),
        })
        # OAM tile numbers index the sprite tile page; a 16x16 sprite uses
        # tiles t, t+1, t+16, t+17 there.
        p += RECORD
        if r[4] & 0x80:
            break
    return parts, p


def frame_table(data, count=105):
    out = []
    for i in range(count):
        w = int.from_bytes(data[FRAME_TABLE + 2 * i:FRAME_TABLE + 2 * i + 2], "little")
        out.append(w)
    return out


def render_frame(parts, tile_data, bpp=4, palettes=None, scale=4, pad=32):
    from PIL import Image
    tiles = decode_tiles(tile_data, bpp) if tile_data else []
    real = [p for p in parts if "control" not in p]
    if not real:
        raise ValueError("frame has no drawable parts")
    size = [16 if p["large"] else 8 for p in real]
    minx = min(p["dx"] for p in real)
    miny = min(p["dy"] for p in real)
    maxx = max(p["dx"] + s for p, s in zip(real, size))
    maxy = max(p["dy"] + s for p, s in zip(real, size))
    w, h = maxx - minx + 2 * pad, maxy - miny + 2 * pad
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    default = grey_palette(bpp)
    for part, s in zip(real, size):
        colors = palettes[part["palette"]] if palettes else default
        n = s // 8
        for ty in range(n):
            for tx in range(n):
                # A 16x16 sprite is tiles t, t+1 / t+16, t+17 in VRAM.
                idx = part["tile"] + ty * 16 + tx
                if idx >= len(tiles):
                    continue
                rows = tiles[idx]
                bx = part["dx"] - minx + pad + (n - 1 - tx if part["hflip"] else tx) * 8
                by = part["dy"] - miny + pad + (n - 1 - ty if part["vflip"] else ty) * 8
                for y in range(8):
                    sy = 7 - y if part["vflip"] else y
                    for x in range(8):
                        sx = 7 - x if part["hflip"] else x
                        c = rows[sy][sx]
                        if c == 0:
                            continue
                        px[bx + x, by + y] = colors[c] + (255,)
    if scale != 1:
        resample = getattr(Image, "Resampling", Image).NEAREST
        img = img.resize((img.width * scale, img.height * scale), resample)
    return img


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", dest="list_addr", help="decode the frame list at this address")
    ap.add_argument("--table", action="store_true", help="dump the $89:8000 pointer table")
    ap.add_argument("--render", help="frame list address to render")
    ap.add_argument("tiles", nargs="?", help="tile sheet bin (for --render)")
    ap.add_argument("--bpp", type=int, choices=(2, 4, 8), default=4)
    ap.add_argument("--palette", help="CGRAM file")
    ap.add_argument("--scale", type=int, default=4)
    ap.add_argument("-o", "--output")
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    def to_off(text):
        kind, value = parse_addr(text)
        return snes_to_file(*value) if kind == "snes" else value

    if args.table:
        for i, w in enumerate(frame_table(data)):
            if w == 0xFFFF:
                print("{:3d}: unused".format(i))
                continue
            off = snes_to_file(FRAME_TABLE_BANK, w)
            parts, _ = parse_frame(data, off)
            print("{:3d}: {} ({})  {} parts".format(
                i, fmt_snes(FRAME_TABLE_BANK, w), fmt_file(off), len(parts)))
        return 0

    addr = args.list_addr or args.render
    if not addr:
        ap.print_help()
        return 2
    try:
        off = to_off(addr)
    except AddressError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    parts, end = parse_frame(data, off)

    if args.render:
        if not args.output:
            ap.error("--render needs -o")
        tile_data = b""
        if args.tiles:
            with open(args.tiles, "rb") as f:
                tile_data = f.read()
        palettes = None
        if args.palette:
            palettes = [read_palette("{}:{}".format(args.palette, i), args.bpp)
                        for i in range(8)]
        img = render_frame(parts, tile_data, args.bpp, palettes, args.scale)
        parent = os.path.dirname(os.path.abspath(args.output))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent)
        img.save(args.output)
        print("wrote {} ({} parts)".format(args.output, len(parts)))
        return 0

    print("frame list at {} ({}), ends {}".format(addr, fmt_file(off), fmt_file(end)))
    for i, p in enumerate(parts):
        if "control" in p:
            print("  {:2d}: control ${:02X} -> ${:04X}".format(
                i, p["control"], p["target"]))
            continue
        print("  {:2d}: dx={:+4d} dy={:+4d} tile=${:03X} pal={} pri={} {}{}{}{}".format(
            i, p["dx"], p["dy"], p["tile"], p["palette"], p["priority"],
            "H" if p["hflip"] else "-", "V" if p["vflip"] else "-",
            " large" if p["large"] else " small", " LAST" if p["last"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
