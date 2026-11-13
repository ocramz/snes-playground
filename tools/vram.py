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

The OBJ page. Sprite tile numbers are relative to the OBSEL name base,
`$6000` on the course screen. The course loads `$8D:CA0A` to tiles
`$000-$19F` up front and nothing else: 155 of those tiles are one repeated
filler, parked in slots that are filled per hole, and `$1A0-$1FF` is left
blank for the objects' own uploads (see `queue` below). `objpage` composes
loader sites, in order, into one 512-tile image; it is the starting state,
not what a given sprite is drawn from -- tools/objsheets.py replays the
uploads on top of it.

The queue. `sub_load_asset_vram` is only one caller of `sub_vram_queue
$80:8696`; 890 call sites reach it directly, and most sprite tiles arrive
that way, uncompressed, straight from ROM. A is the block address, and the
block's **bank comes from the caller**: `$80:86AB` tests the address and
takes the caller's program bank (`$07,S`, the `JSL` return address) for a
block at `$8000` or above, the caller's data bank (`$01,S`) otherwise. So
`LDA #$C388 / JSL $80:8696` in bank `$86` names a block at `$86:C388`.

Byte 0 of a record is not a DMA channel but an offset into the mode table
at `$80:FF0A`, three bytes per mode (`DMAP`, B-bus address, `VMAIN`):

    $00  01 18 80   plain word copy to $2118/19
    $03  09 18 80   fill: the "source" is one fixed word
    $1B  01 18 81   word copy stepping 32 words, i.e. a tilemap column

`queue` lists every record of every block every site can pass; `direct`
writes out the ROM chunks those records copy.

CGRAM. A full palette image is block-moved into the staging buffer at
`$7E:0400` (as `$00:0400`, a WRAM mirror) by

    LDA #len-1 / LDX #src / LDY #$0400 / PHB / MVN $00,bank / PLB

Sprite palettes are CGRAM `$80-$FF`, i.e. the image's second half. Because
`tiles.read_palette` slices sub-palette n at n*32 bytes, **OBJ palette n is
sub-palette n+8** of the full image --- no offset flag needed.

    python3 tools/vram.py loaders
    python3 tools/vram.py queue                      # -> build/vram/queue.tsv
    python3 tools/vram.py direct                     # -> build/gfx/direct/
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
QUEUE = (0x80, 0x8696)       # sub_vram_queue
DMA_MODE_TABLE = (0x80, 0xFF0A)
MODE_COPY, MODE_FILL = 0x00, 0x03
CODE_END = 0x040000          # banks $80-$87 hold the code
MAX_TABLE_BLOCKS = 64
BLOB_BANK = 0x7F             # src24 of $7Fxxxx means "the decompressed blob"
NAME_BASE = 0x6000           # OBJ tile page base, in VRAM words
OBJ_PAGE_TILES = 512         # a name base addresses two 256-tile pages
TILE_BYTES4 = 32
CGRAM_BYTES = 512
CGRAM_OBJ = 0x100            # sprite palettes are the second half

# Named compositions of loader sites, applied in order. Later loads overwrite
# earlier ones, exactly as the hardware sees them.
# The course screen makes exactly one OBJ load up front, `$8D:CA0A` to tiles
# `$000-$19F`. `$80:D2E7` (`$8E:DD91` to `$100-$1FF`) used to be composed on
# top of it; that is tileset entry 24, whose only caller is `$83:96E0` in
# scene 5, and it overwrote 160 course tiles with another screen's.
SCENES = {
    "course": [0xCE92],
    "scene5": [0xD2E7],
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


def dma_mode(data, mode):
    """(DMAP, B-bus address, VMAIN) for a record's mode byte."""
    off = snes_to_file(*DMA_MODE_TABLE) + mode
    return data[off], data[off + 1], data[off + 2]


def clean_block(data, bank, addr):
    """Records of a block that is well formed, else None.

    Well formed: at least one record, a `$FF` terminator right after the
    last, every mode a multiple of 3 inside the table, and no empty or
    over-long transfer. That is what lets a table of block pointers be
    walked to its end without a length.
    """
    if addr < 0x8000:
        return None
    recs = parse_block(data, bank, addr)
    if not recs:
        return None
    end = snes_to_file(bank, addr) + 8 * len(recs)
    if end >= len(data) or data[end] != 0xFF:
        return None
    for r in recs:
        if r["slot"] % 3 or r["slot"] > 0x2D or not 0 < r["size"] <= 0x8000:
            return None
    return recs


def queue_sites(data):
    """Every `sub_vram_queue` call site, with the blocks it can pass.

    Yields {"site", "form", "table", "blocks"}; `blocks` is a list of
    (bank, addr). Forms:

      imm         `LDA #block / JSL` -- one block, in the caller's bank.
      table       `LDA $bb:aaaa,X / JSL` -- a table of block pointers; the
                  blocks are still in the caller's bank. Walked until a word
                  is not a clean block.
      ram         the immediate is below `$8000`: a block built in WRAM.
      unresolved  A comes from somewhere a byte pattern cannot see.
    """
    tail = bytes([QUEUE[1] & 0xFF, QUEUE[1] >> 8, QUEUE[0]])
    for i in range(4, CODE_END - 4):
        if data[i] not in (0x22, 0x5C) or data[i + 1:i + 4] != tail:
            continue
        caller = file_to_snes(i)[0]
        site = {"site": i, "form": "unresolved", "table": None, "blocks": []}
        if data[i - 3] == 0xA9:
            addr = int.from_bytes(data[i - 2:i], "little")
            if addr < 0x8000:
                site["form"] = "ram"
            elif clean_block(data, caller, addr):
                site["form"] = "imm"
                site["blocks"] = [(caller, addr)]
        elif data[i - 4] == 0xBF:
            tbank = 0x80 | (data[i - 1] & 0x7F)
            taddr = int.from_bytes(data[i - 3:i - 1], "little")
            if taddr >= 0x8000:
                base = snes_to_file(tbank, taddr)
                for n in range(MAX_TABLE_BLOCKS):
                    w = int.from_bytes(data[base + 2 * n:base + 2 * n + 2], "little")
                    if not clean_block(data, caller, w):
                        break
                    site["blocks"].append((caller, w))
                if site["blocks"]:
                    site["form"] = "table"
                    site["table"] = (tbank, taddr)
        yield site


def source_of(rec):
    """Where a record's bytes come from: (kind, bank, addr).

    `rom` is a ROM address in canonical `$80+` form, `blob` the stream last
    decompressed to `$7F:0000`, `wram` anything else in `$7E`/`$7F` or below
    `$8000` -- built at run time, not recoverable statically. A fill has no
    source at all; its "address" is where the fill word lives.
    """
    bank, addr = rec["src"] >> 16, rec["src"] & 0xFFFF
    if rec["slot"] == MODE_FILL:
        return "fill", bank, addr
    if bank == BLOB_BANK:
        return "blob", bank, addr
    if bank == 0x7E or addr < 0x8000:
        return "wram", bank, addr
    return "rom", bank | 0x80, addr


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


CGRAM_PARTIAL = (0x80, 0x90C8)     # sub_cgram_partial
CGRAM_PARTIAL_BANK = 0x98           # hardwired by the MVN at $80:90D4


def find_cgram_partial_sites(data):
    """Yield (file_offset, count, src, index) for partial palette loads.

    `LDA #count / LDX #src / LDY #index / JSL $80:90C8`: `count` bytes from
    `$98:src` to CGRAM starting at colour `index`. Sites whose operands are
    not three immediates are yielded with None in their place.
    """
    tail = bytes((CGRAM_PARTIAL[1] & 0xFF, CGRAM_PARTIAL[1] >> 8, CGRAM_PARTIAL[0]))
    for i in range(9, CODE_END - 4):
        if data[i] not in (0x22, 0x5C) or data[i + 1:i + 4] != tail:
            continue
        pre = data[i - 9:i]
        if pre[0] == 0xA9 and pre[3] == 0xA2 and pre[6] == 0xA0:
            yield (i, int.from_bytes(pre[1:3], "little"),
                   int.from_bytes(pre[4:6], "little"),
                   int.from_bytes(pre[7:9], "little"))
        else:
            yield (i, None, None, None)


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


def queue_rows(data):
    """One row per (site, block, record), plus the distinct ROM sources."""
    rows = []
    sources = {}                 # (bank, addr) -> {"size", "vram", "sites"}
    for site in queue_sites(data):
        sb, sa = file_to_snes(site["site"])
        if not site["blocks"]:
            rows.append([fmt_snes(sb, sa), fmt_file(site["site"]), site["form"],
                         "-", "-", "-", "-", "-", "-", "-", "-", "-", "-"])
            continue
        for n, (bank, addr) in enumerate(site["blocks"]):
            for r, rec in enumerate(parse_block(data, bank, addr)):
                kind, kb, ka = source_of(rec)
                first, last = tile_range(rec["vram_word"], rec["size"])
                src_file = "-"
                if kind == "rom":
                    src_file = fmt_file(snes_to_file(kb, ka))
                    if rec["slot"] == MODE_COPY:
                        src = sources.setdefault(
                            (kb, ka), {"size": 0, "vram": set(), "sites": set()})
                        src["size"] = max(src["size"], rec["size"])
                        src["vram"].add(rec["vram_word"])
                        src["sites"].add(site["site"])
                rows.append([
                    fmt_snes(sb, sa), fmt_file(site["site"]), site["form"],
                    fmt_snes(*site["table"]) if site["table"] else "-",
                    fmt_snes(bank, addr), r, "{:02X}".format(rec["slot"]),
                    rec["size"], kind, fmt_snes(kb, ka), src_file,
                    "${:04X}".format(rec["vram_word"]),
                    "${:03X}-${:03X}".format(first, last)
                    if first is not None else "-"])
    return rows, sources


def cmd_queue(data, args):
    rows, sources = queue_rows(data)
    path = os.path.join(args.out, "queue.tsv")
    _ensure(path)
    with open(path, "w") as f:
        f.write("site_addr\tsite_file\tform\ttable\tblock\trecord\tmode\tsize"
                "\tsrc_kind\tsrc_addr\tsrc_file\tvram_word\tobj_tiles\n")
        for r in rows:
            f.write("\t".join(str(c) for c in r) + "\n")
    forms = {}
    for site in queue_sites(data):
        forms[site["form"]] = forms.get(site["form"], 0) + 1
    kinds = {}
    for r in rows:
        kinds[r[8]] = kinds.get(r[8], 0) + 1
    kinds.pop("-", None)
    print("{} call sites: {}".format(
        sum(forms.values()),
        ", ".join("{} {}".format(v, k) for k, v in sorted(forms.items()))))
    print("{} records: {}".format(
        sum(kinds.values()),
        ", ".join("{} {}".format(v, k) for k, v in sorted(kinds.items()))))
    print("{} distinct ROM sources, {} bytes".format(
        len(sources), sum(s["size"] for s in sources.values())))
    print("wrote {}".format(path))
    return 0


def cmd_direct(data, args):
    """Write every uncompressed ROM chunk the queue copies to VRAM."""
    _, sources = queue_rows(data)
    outdir = args.direct_out
    _ensure(os.path.join(outdir, "bin", "x"))
    _ensure(os.path.join(outdir, "png", "x"))
    path = os.path.join(outdir, "index.tsv")
    obj = total = 0
    with open(path, "w") as f:
        f.write("src_addr\tsrc_file\tsize\tvram_words\tkind\tsites\tfirst_site\n")
        for (bank, addr), src in sorted(sources.items()):
            off = snes_to_file(bank, addr)
            blob = data[off:off + src["size"]]
            name = "{:02X}_{:04X}".format(bank, addr)
            with open(os.path.join(outdir, "bin", name + ".bin"), "wb") as g:
                g.write(blob)
            # OBJ tiles are 4bpp, and under the common OBSEL they live at
            # VRAM $6000 up. Anything lower is BG data whose depth depends
            # on the screen, so it gets no picture here rather than a wrong
            # one.
            is_obj = all(w >= NAME_BASE for w in src["vram"])
            if is_obj and len(blob) >= TILE_BYTES4:
                render_sheet(decode_tiles(blob, 4), 4, width=16,
                             scale=args.scale).save(
                    os.path.join(outdir, "png", name + ".png"))
                obj += 1
            total += len(blob)
            first = min(src["sites"])
            f.write("\t".join([
                fmt_snes(bank, addr), fmt_file(off), str(src["size"]),
                ",".join("${:04X}".format(w) for w in sorted(src["vram"])),
                "obj" if is_obj else "bg", str(len(src["sites"])),
                fmt_snes(*file_to_snes(first))]) + "\n")
    print("wrote {} ({} chunks, {} bytes; {} drawn as OBJ tiles)".format(
        path, len(sources), total, obj))
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

    # Partial loads: not images, but they are where most palettes live.
    path = os.path.join(args.out, "cgram_partial.tsv")
    known = sources = total = 0
    seen = {}
    with open(path, "w") as f:
        f.write("site_addr\tsite_file\tbytes\tsrc_addr\tsrc_file"
                "\tfirst_colour\tlayer\n")
        for off, count, src, index in find_cgram_partial_sites(data):
            total += 1
            sb, sa = file_to_snes(off)
            if count is None or src < 0x8000:
                f.write("{}\t{}\t-\t-\t-\t-\t-\n".format(
                    fmt_snes(sb, sa), fmt_file(off)))
                continue
            known += 1
            so = snes_to_file(CGRAM_PARTIAL_BANK, src)
            seen[so] = max(seen.get(so, 0), count)
            f.write("{}\t{}\t{}\t{}\t{}\t{}\t{}\n".format(
                fmt_snes(sb, sa), fmt_file(off), count,
                fmt_snes(CGRAM_PARTIAL_BANK, src), fmt_file(so), index,
                "obj" if index >= 128 else "bg"))
    print("wrote {} ({} partial palette loads, {} with immediate operands "
          "naming {} sources, {} bytes)".format(
              path, total, known, len(seen), sum(seen.values())))
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
    sub.add_parser("queue")
    d = sub.add_parser("direct")
    d.add_argument("--direct-out", default="build/gfx/direct")
    d.add_argument("--scale", type=int, default=3)
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
        if args.cmd == "queue":
            return cmd_queue(data, args)
        if args.cmd == "direct":
            return cmd_direct(data, args)
        if args.cmd == "cgram":
            return cmd_cgram(data, args)
        return cmd_objpage(data, args)
    except (AddressError, CompressionError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
