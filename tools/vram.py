#!/usr/bin/env python3
"""Reconstruct what the PPU sees: VRAM tile pages and CGRAM palettes.

A frame list gives tile *numbers*, not tiles. Turning one into a picture needs
to know which blobs were loaded where in VRAM, and which CGRAM image was live.
Both are recoverable from the loader call sites.

VRAM loaders. `sub_load_asset_vram` at `$80:CAA9 (0x004AA9)` decompresses a
stream to `$7F:0000` and hands a parameter block to `sub_vram_queue`. Call
sites use

    LDA #bank / LDX #src / LDY #block / JML $80:CAA9

and the block is a list of 8-byte records terminated by a single `$FF`:

    byte 0     DMA slot
    bytes 1-2  size in bytes
    bytes 3-5  24-bit source; `$7F:xxxx` means "offset xxxx into the blob
               just decompressed", so one stream can fill two VRAM regions
    bytes 6-7  destination VRAM *word* address

Layout confirmed against `sub_vram_enqueue_one $80:86E6` and against the
`gfx_course_obj` row in symbols.tsv: block `$80:CE96` reads
`00 | 00 34 | 00 00 7F | 00 60` = 13312 bytes to VRAM word `$6000`.

The OBJ page. Sprite tile numbers are relative to the OBSEL name base. Two
loads land on exact tile-page boundaries at base `$6000` --- `$8D:CA0A` fills
tiles `$000-$19F` and `$8E:DD91` fills `$100-$1FF` --- and together they span
exactly the `$000-$1F3` range the frame lists reference. That is two
independent witnesses for base `$6000`, which is worth having because the
routines that actually write `$2101` are dispatched and have no direct
callers. `objpage` composes those loads, in order, into one 512-tile image.

CGRAM. A full palette image is block-moved into the staging buffer at
`$7E:0400` (as `$00:0400`, a WRAM mirror) by

    LDA #len-1 / LDX #src / LDY #$0400 / PHB / MVN $00,bank / PLB

Sprite palettes are CGRAM `$80-$FF`, i.e. the image's second half. Because
`tiles.read_palette` slices sub-palette n at n*32 bytes, **OBJ palette n is
sub-palette n+8** of the full image --- no offset flag needed.

    python3 tools/vram.py loaders
    python3 tools/vram.py cgram
    python3 tools/vram.py objpage --scene course -o build/vram/obj/course.bin
    python3 tools/vram.py objpage --site '$80:D2E7' --site '$80:CE92' -o x.bin
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from halcomp import CompressionError, decompress  # noqa: E402
from lorom import AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file  # noqa: E402
from palettes import looks_like_palette, render, words  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import decode_tiles, render_sheet  # noqa: E402

LOADER = (0x80, 0xCAA9)      # sub_load_asset_vram
BLOB_BANK = 0x7F             # src24 of $7Fxxxx means "the decompressed blob"
NAME_BASE = 0x6000           # OBJ tile page base, in VRAM words
OBJ_PAGE_TILES = 512         # a name base addresses two 256-tile pages
TILE_BYTES4 = 32
CGRAM_BYTES = 512
CGRAM_OBJ = 0x100            # sprite palettes are the second half

# Named compositions of loader sites, applied in order. Later loads overwrite
# earlier ones, exactly as the hardware sees them.
SCENES = {
    "course": [0xCE92, 0xD2E7],
}


def find_loader_sites(data):
    """Yield (file_offset, bank, src, block) for every sub_load_asset_vram call.

    `bank`/`src` are None for the table-driven sites, which pick their source
    from a table with `LDA long,X` instead of an immediate.
    """
    tail = bytes([LOADER[1] & 0xFF, LOADER[1] >> 8, LOADER[0]])
    for i in range(len(data) - 4):
        if data[i + 1:i + 4] != tail or data[i] not in (0x5C, 0x22):
            continue
        pre = data[i - 9:i]
        if len(pre) < 9:
            continue
        if pre[0] == 0xA9 and pre[3] == 0xA2 and pre[6] == 0xA0:
            yield (i, pre[1],
                   int.from_bytes(pre[4:6], "little"),
                   int.from_bytes(pre[7:9], "little"))
        elif pre[6] == 0xA0:
            # Table-driven: the source comes from an LDA long,X earlier on.
            yield (i, None, None, int.from_bytes(pre[7:9], "little"))


def parse_block(data, bank, addr, max_records=32):
    """Decode a VRAM parameter block into a list of records."""
    off = snes_to_file(bank, addr)
    out = []
    for _ in range(max_records):
        if off >= len(data) or data[off] == 0xFF:
            break
        rec = data[off:off + 8]
        if len(rec) < 8:
            break
        out.append({
            "slot": rec[0],
            "size": int.from_bytes(rec[1:3], "little"),
            "src": int.from_bytes(rec[3:6], "little"),
            "vram_word": int.from_bytes(rec[6:8], "little"),
        })
        off += 8
    return out


def tile_range(vram_word, size, name_base=NAME_BASE):
    """OBJ tile numbers a load covers, or (None, None) if outside the page."""
    if vram_word < name_base:
        return None, None
    first = (vram_word - name_base) // 16
    last = first + size // TILE_BYTES4 - 1
    if first >= OBJ_PAGE_TILES:
        return None, None
    return first, min(last, OBJ_PAGE_TILES - 1)


def site_blob(data, bank, src):
    """Decompress a loader's source stream. Returns (blob, packed_len)."""
    return decompress(data, snes_to_file(bank, src))


def compose_objpage(data, sites, name_base=NAME_BASE, verbose=False):
    """Build a 512-tile OBJ page from loader sites, applied in order."""
    page = bytearray(OBJ_PAGE_TILES * TILE_BYTES4)
    covered = bytearray(len(page))
    for bank, src, block in sites:
        blob, _ = site_blob(data, bank, src)
        for rec in parse_block(data, 0x80, block):
            if rec["vram_word"] < name_base:
                continue
            start = (rec["vram_word"] - name_base) * 2
            if start >= len(page):
                continue
            src_off = rec["src"] - (BLOB_BANK << 16)
            chunk = blob[src_off:src_off + rec["size"]]
            n = min(len(chunk), len(page) - start)
            page[start:start + n] = chunk[:n]
            covered[start:start + n] = b"\x01" * n
            if verbose:
                first, last = tile_range(rec["vram_word"], n, name_base)
                print("  {} -> tiles ${:03X}..${:03X} ({} bytes)".format(
                    fmt_snes(bank, src), first, last, n))
    return bytes(page), sum(covered)


def find_cgram_sites(data):
    """Yield (file_offset, src_bank, src_addr, length) for CGRAM block moves."""
    for i in range(len(data) - 3):
        if data[i:i + 3] != b"\xa0\x00\x04":       # LDY #$0400
            continue
        mvn = data.find(b"\x54", i + 3, i + 15)
        if mvn < 0:
            continue
        pre = data[i - 6:i]
        if len(pre) < 6 or pre[0] != 0xA9 or pre[3] != 0xA2:
            continue
        yield (i, data[mvn + 2],
               int.from_bytes(pre[4:6], "little"),
               int.from_bytes(pre[1:3], "little") + 1)


def _ensure(path):
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)


def cmd_loaders(data, args):
    _ensure(os.path.join(args.out, "index.tsv"))
    rows = []
    for off, bank, src, block in find_loader_sites(data):
        sb, sa = file_to_snes(off)
        packed = unpacked = "-"
        if bank is not None:
            try:
                blob, packed = site_blob(data, bank, src)
                unpacked = len(blob)
            except CompressionError as e:
                packed, unpacked = "-", "error: {}".format(e)
        for rec in parse_block(data, 0x80, block):
            first, last = tile_range(rec["vram_word"], rec["size"])
            rows.append([
                fmt_snes(sb, sa), fmt_file(off),
                fmt_snes(bank, src) if bank is not None else "indirect",
                fmt_file(snes_to_file(bank, src)) if bank is not None else "-",
                packed, unpacked,
                "{:02X}".format(rec["slot"]), rec["size"],
                "${:04X}".format(rec["vram_word"]),
                "${:03X}".format(first) if first is not None else "-",
                "${:03X}".format(last) if last is not None else "-",
                "obj" if first is not None else "bg",
            ])
    path = os.path.join(args.out, "index.tsv")
    with open(path, "w") as f:
        f.write("site_addr\tsite_file\tsrc_addr\tsrc_file\tpacked\tunpacked"
                "\tslot\tsize\tvram_word\ttile_first\ttile_last\tkind\n")
        for r in rows:
            f.write("\t".join(str(c) for c in r) + "\n")
    obj = [r for r in rows if r[-1] == "obj"]
    print("wrote {} ({} records from {} sites, {} in the OBJ page)".format(
        path, len(rows), len(set(r[0] for r in rows)), len(obj)))
    for r in obj:
        print("  {}  {}  {:>6} bytes  VRAM {}  tiles {}..{}".format(
            r[0], r[2], r[7], r[8], r[9], r[10]))
    return 0


def cmd_cgram(data, args):
    outdir = os.path.join(args.out, "cgram")
    _ensure(os.path.join(outdir, "x"))
    print("{:12} {:12} {:>6}  {}".format("site", "source", "bytes", "OBJ sub-palettes passing"))
    for off, bank, src, length in find_cgram_sites(data):
        sb, sa = file_to_snes(off)
        so = snes_to_file(bank, src)
        image = data[so:so + min(length, CGRAM_BYTES)]
        name = "{:02X}{:04X}".format(bank, src)
        with open(os.path.join(outdir, name + ".bin"), "wb") as f:
            f.write(image)
        render(data, so, min(length, CGRAM_BYTES),
               path=os.path.join(outdir, name + ".png"))
        # OBJ palettes are the second half. Only count the sub-palettes that
        # the copy actually reaches -- three of these sites copy less than a
        # full image, so "n/8" would understate them.
        avail = max(0, min(8, (length - CGRAM_OBJ) // 32))
        ok = sum(1 for i in range(avail)
                 if looks_like_palette(words(data, so + CGRAM_OBJ + i * 32, 16)))
        print("{:12} {:12} {:>6}  {}".format(
            fmt_snes(sb, sa), fmt_snes(bank, src), length,
            "{}/{}".format(ok, avail) if avail else "- (BG half only)"))
    print("wrote {}/".format(outdir))
    return 0


def cmd_objpage(data, args):
    sites = []
    if args.scene:
        if args.scene not in SCENES:
            print("error: unknown scene {!r}; known: {}".format(
                args.scene, ", ".join(sorted(SCENES))), file=sys.stderr)
            return 1
        want = SCENES[args.scene]
    else:
        want = []
        for text in args.site or []:
            kind, value = parse_addr(text)
            off = snes_to_file(*value) if kind == "snes" else value
            want.append(file_to_snes(off)[1])
    if not want:
        print("error: give --scene or at least one --site", file=sys.stderr)
        return 1

    by_site = {}
    for off, bank, src, block in find_loader_sites(data):
        by_site[file_to_snes(off)[1]] = (bank, src, block)
    for addr in want:
        if addr not in by_site:
            print("error: no loader call site at $80:{:04X}".format(addr), file=sys.stderr)
            return 1
        bank, src, block = by_site[addr]
        if bank is None:
            print("error: $80:{:04X} is table-driven; its source is not "
                  "a constant".format(addr), file=sys.stderr)
            return 1
        sites.append((bank, src, block))

    print("composing OBJ page at name base ${:04X}:".format(args.name_base))
    page, covered = compose_objpage(data, sites, args.name_base, verbose=True)
    _ensure(args.output)
    with open(args.output, "wb") as f:
        f.write(page)
    print("wrote {} ({} tiles, {}/{} bytes covered)".format(
        args.output, len(page) // TILE_BYTES4, covered, len(page)))
    if args.png:
        img = render_sheet(decode_tiles(page, 4), 4, width=16, scale=args.scale)
        _ensure(args.png)
        img.save(args.png)
        print("wrote {}".format(args.png))
    return 0


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/vram", help="output directory")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("loaders")
    sub.add_parser("cgram")
    o = sub.add_parser("objpage")
    o.add_argument("--scene", help="named composition: " + ", ".join(sorted(SCENES)))
    o.add_argument("--site", action="append", help="loader call site address (repeatable)")
    o.add_argument("--name-base", type=lambda s: int(s, 0), default=NAME_BASE)
    o.add_argument("--png", help="also render the composed page here")
    o.add_argument("--scale", type=int, default=3)
    o.add_argument("-o", "--output", required=True)
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    try:
        if args.cmd == "loaders":
            return cmd_loaders(data, args)
        if args.cmd == "cgram":
            return cmd_cgram(data, args)
        return cmd_objpage(data, args)
    except (AddressError, CompressionError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
