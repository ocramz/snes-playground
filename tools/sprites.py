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

Control records are 3 bytes, not 5. Byte 0 is the marker and bytes 1-2 a
pointer:
    $7E  **priority override**, not a continuation. `$80:8D90` reads the byte
         at `$7E:<ptr>`, keeps bits 0-1, shifts them to bits 12-13 and stores
         that in `$3F`; the walk continues inline at +3 in the alternate
         walker `$80:8E39`, which ORs `$3F` into every later attribute word
         (`$80:8E67 ORA $3F`). Bits 12-13 of the attribute are the OAM
         priority. The value comes from WRAM and is not known statically, but
         the parts after it are perfectly ordinary and must still be walked.
    $80  a real continuation: `$80:8DAC` does `LDA $0001,Y / TAY`, an absolute
         jump to another list in the same bank. Followed by default;
         `--no-follow` stops there.

Treating `$7E` as a terminator loses the whole frame: most lists in the
`$89:9295`, `$92F3`, `$9351`, `$9365` and `$CCDB` tables *open* with one.

`$80:8E39` is the same walker with the `$3F` priority OR applied; the record
layout is identical.

Frame lists live in bank `$89` and are always read with `DBR=$89`, set by the
`PEA $7E89 / PLB` at `$80:8C1A`. `$89:8000 (0x048000)` is one word pointer
table into them, not the index; see docs/animation.md. An object holds the
address and bank of such a table (`$7E:0B9E,X`, `$7E:0BBE,X`) plus an index
into it (`$7E:0B7E,X`).

Rendering needs a composed OBJ page, not a tile sheet: frame lists use tile
numbers relative to the OBSEL name base ($6000 here), and the page is built
from several VRAM loads. Use `tools/vram.py objpage` to make one. Sprite
palettes are CGRAM $80-$FF, so **OBJ palette n is sub-palette n+8** of a
512-byte CGRAM image.

OBSEL is pinned, not guessed. The course screen-setup block at
`$80:CB91 (0x004B91)` -- 16 bytes, reached from `tbl_scene_screen_blocks
$80:CAC7` through `sub_scene_screen_setup $80:CABC` -- opens `09 03 ...`:
BGMODE `$09`, **OBSEL `$03`**. OBSEL bits 0-2 are the OBJ name base in 8K-word
units, so the base is `3 << 13` = VRAM word `$6000`; OBSEL bits 5-7 are 0,
which selects the **8x8 / 16x16** sprite size pair. That is where `OBJ_SIZE`
comes from.

    python3 tools/sprites.py --list '$89:831B'
    python3 tools/sprites.py --table                # dump the $89:8000 table
    python3 tools/sprites.py --render '$89:8550' --objpage build/vram/obj/course.bin \\
        --palette build/vram/cgram/98C000.bin -o build/f.png
    python3 tools/sprites.py --all                  # every table in tables.tsv
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
FRAME_TABLE_ADDR = 0x8000
FRAME_TABLE_COUNT = 105
RECORD = 5
# OBSEL $03 at $80:CB91 -> bits 5-7 = 0 = the 8x8 / 16x16 size pair, and
# bits 0-2 = 3 = OBJ name base VRAM word $6000. See the module docstring.
OBJ_SIZE = (8, 16)
OBJ_PAGE_TILES = 512     # a name base addresses two 256-tile pages
NULL_ENTRIES = (0x0000, 0xFFFF)
MISSING_COLOR = (255, 0, 255, 255)
TABLES_TSV = "build/sprites/tables.tsv"


def signed(b):
    return b - 0x100 if b & 0x80 else b


def parse_frame(data, off, max_parts=64, follow=True, bank=FRAME_TABLE_BANK,
                max_depth=8, _seen=None):
    """Return (parts, next_offset). Each part is a dict.

    A `$7E` record is a priority override; the walk continues past it. A `$80`
    record is a real continuation, followed when `follow` is set, so the
    returned parts are the whole frame.
    """
    parts = []
    p = off
    seen = set() if _seen is None else _seen
    seen.add(off)
    while len(parts) < max_parts:
        r = data[p:p + RECORD]
        if len(r) < 3:
            break
        if r[0] == 0x7E:
            # Priority override read from WRAM; the list continues at +3 and
            # every later part's priority is OR'd with it.
            parts.append({"control": 0x7E,
                          "target": int.from_bytes(r[1:3], "little"),
                          "raw": bytes(r[:3])})
            p += 3
            continue
        if r[0] == 0x80:
            target = int.from_bytes(r[1:3], "little")
            part = {"control": 0x80, "target": target, "raw": bytes(r[:3]),
                    "followed": False}
            parts.append(part)
            if not follow or max_depth <= 0:
                return parts, p + 3
            try:
                nxt = snes_to_file(bank, target)
            except AddressError:
                part["error"] = "target below $8000"
                return parts, p + 3
            if nxt in seen:
                part["error"] = "cycle"
                return parts, p + 3
            part["followed"] = True
            more, end = parse_frame(data, nxt, max_parts - len(parts), follow,
                                    bank, max_depth - 1, seen)
            parts.extend(more)
            return parts, end
        if len(r) < RECORD:
            break
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


def frame_table(data, bank=FRAME_TABLE_BANK, addr=FRAME_TABLE_ADDR,
                count=FRAME_TABLE_COUNT):
    """The word entries of one frame-pointer table.

    Defaults to `tbl_sprite_frames $89:8000`, but every table found by
    tools/frametabs.py has the same shape, so pass its base and entry count.
    """
    base = snes_to_file(bank, addr)
    return [int.from_bytes(data[base + 2 * i:base + 2 * i + 2], "little")
            for i in range(count)]


def frame_tiles(parts, obj_size=OBJ_SIZE):
    """(tile numbers, palettes) a frame's drawable parts touch.

    A 16x16 part occupies t, t+1, t+16, t+17 of the OBJ page, so the numbers
    it reaches are not just the one in the record.
    """
    tiles, pals = set(), set()
    for p in parts:
        if "control" in p:
            continue
        n = (obj_size[1] if p["large"] else obj_size[0]) // 8
        for ty in range(n):
            for tx in range(n):
                tiles.add(p["tile"] + ty * 16 + tx)
        pals.add(p["palette"])
    return tiles, pals


def tile_ranges(tiles, cap=6):
    """'$1C0-$1C8' style summary of a tile set, runs merged."""
    if not tiles:
        return "-"
    out, ordered = [], sorted(tiles)
    lo = prev = ordered[0]
    for t in ordered[1:] + [None]:
        if t == prev + 1:
            prev = t
            continue
        out.append("${:03X}".format(lo) if lo == prev
                   else "${:03X}-${:03X}".format(lo, prev))
        lo = prev = t
    if len(out) > cap:
        return ",".join(out[:cap]) + ",+{}".format(len(out) - cap)
    return ",".join(out)


def part_sizes(parts, obj_size=OBJ_SIZE):
    """Pixel size of each drawable part, from the record's size bit."""
    return [obj_size[1] if p["large"] else obj_size[0] for p in parts]


def frame_bbox(parts, obj_size=OBJ_SIZE):
    """(minx, miny, maxx, maxy) over the drawable parts of one frame.

    Stage an animation on the union of its frames' boxes, otherwise each
    frame is cropped to its own content and the sprite jitters.
    """
    real = [p for p in parts if "control" not in p]
    if not real:
        return None
    size = part_sizes(real, obj_size)
    return (min(p["dx"] for p in real),
            min(p["dy"] for p in real),
            max(p["dx"] + s for p, s in zip(real, size)),
            max(p["dy"] + s for p, s in zip(real, size)))


def render_frame(parts, tile_data, bpp=4, palettes=None, scale=4, pad=32,
                 bbox=None, obj_size=OBJ_SIZE):
    """Render one frame. Returns (image, stats).

    `tile_data` is a composed OBJ page (see tools/vram.py objpage), indexed by
    the frame's tile numbers directly. Tiles past its end are drawn as magenta
    blocks and counted in `stats["missing"]` -- a silent blank is exactly how
    a wrong page composition imitates a working render.

    Pass `bbox` from `frame_bbox` (unioned across an animation) to keep a
    fixed canvas and a fixed origin between frames.
    """
    from PIL import Image
    tiles = decode_tiles(tile_data, bpp) if tile_data else []
    real = [p for p in parts if "control" not in p]
    if not real:
        raise ValueError("frame has no drawable parts")
    size = part_sizes(real, obj_size)
    minx, miny, maxx, maxy = bbox if bbox else frame_bbox(parts, obj_size)
    w, h = maxx - minx + 2 * pad, maxy - miny + 2 * pad
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    default = grey_palette(bpp)
    stats = {"parts": len(real), "missing": 0, "tile_max": 0}
    for part, s in zip(real, size):
        colors = palettes[part["palette"]] if palettes else default
        n = s // 8
        for ty in range(n):
            for tx in range(n):
                # A 16x16 sprite is tiles t, t+1 / t+16, t+17 in VRAM.
                idx = part["tile"] + ty * 16 + tx
                stats["tile_max"] = max(stats["tile_max"], idx)
                rows = tiles[idx] if idx < len(tiles) else None
                if rows is None:
                    stats["missing"] += 1
                bx = part["dx"] - minx + pad + (n - 1 - tx if part["hflip"] else tx) * 8
                by = part["dy"] - miny + pad + (n - 1 - ty if part["vflip"] else ty) * 8
                for y in range(8):
                    sy = 7 - y if part["vflip"] else y
                    for x in range(8):
                        sx = 7 - x if part["hflip"] else x
                        if rows is None:
                            px[bx + x, by + y] = MISSING_COLOR
                            continue
                        c = rows[sy][sx]
                        if c == 0:
                            continue
                        px[bx + x, by + y] = colors[c] + (255,)
    if scale != 1:
        resample = getattr(Image, "Resampling", Image).NEAREST
        img = img.resize((img.width * scale, img.height * scale), resample)
    return img, stats


def load_palettes(path, bpp=4, obj=True):
    """The 8 sprite palettes of a CGRAM image.

    OBJ palettes are CGRAM $80-$FF, so sub-palette n+8 of a 512-byte image.
    """
    base = 8 if obj else 0
    return [read_palette("{}:{}".format(path, base + i), bpp) for i in range(8)]


def read_tables(path):
    """Parse tools/frametabs.py's tables.tsv into dicts."""
    out = []
    with open(path) as f:
        header = f.readline().rstrip("\n").split("\t")
        for line in f:
            row = dict(zip(header, line.rstrip("\n").split("\t")))
            kind, value = parse_addr(row["table_addr"])
            if kind != "snes":
                continue
            bank, addr = value
            out.append({"bank": bank, "addr": addr,
                        "entries": int(row["entries"]),
                        "confidence": row.get("confidence", "-"),
                        "source": row.get("source", "-"),
                        "name": "{:02X}_{:04X}".format(bank, addr)})
    return out


def walk_table(data, table, follow=True):
    """[(index, word, parts)] for every live entry of one table."""
    out = []
    for i, w in enumerate(frame_table(data, table["bank"], table["addr"],
                                      table["entries"])):
        if w in NULL_ENTRIES:
            continue
        try:
            off = snes_to_file(FRAME_TABLE_BANK, w)
        except AddressError:
            continue
        parts, _ = parse_frame(data, off, follow=follow)
        out.append((i, w, parts))
    return out


def contact_sheet(images, columns=8, pad=2):
    """One image per table so a whole animation can be eyeballed at once."""
    from PIL import Image
    if not images:
        return None
    cw = max(im.width for im in images) + pad
    ch = max(im.height for im in images) + pad
    rows = (len(images) + columns - 1) // columns
    sheet = Image.new("RGBA", (cw * min(columns, len(images)), ch * rows),
                      (0, 0, 0, 0))
    for n, im in enumerate(images):
        sheet.paste(im, ((n % columns) * cw, (n // columns) * ch))
    return sheet


def cmd_all(data, args, obj_size):
    """Render every live entry of every table in tables.tsv."""
    tables = read_tables(args.tables)
    tile_data = b""
    if args.objpage:
        with open(args.objpage, "rb") as f:
            tile_data = f.read()
    palettes = None
    if args.palette:
        palettes = load_palettes(args.palette, args.bpp, obj=not args.bg_palette)
    page_tiles = len(tile_data) // 32 if tile_data else 0

    rows = []
    rendered = skipped = 0
    for table in tables:
        live = walk_table(data, table, follow=not args.no_follow)
        # Union bbox across the whole table: frames of one table have to share
        # an origin or the animation jitters as each frame crops to itself.
        boxes = [b for b in (frame_bbox(p, obj_size) for _, _, p in live) if b]
        union = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                 max(b[2] for b in boxes), max(b[3] for b in boxes)) if boxes else None
        # A table whose tiles run past the composed page belongs to another
        # scene. Rendering it against this page produces confident-looking
        # garbage, so flag it instead.
        all_tiles = set()
        for _, _, parts in live:
            all_tiles |= frame_tiles(parts, obj_size)[0]
        outside = sorted(t for t in all_tiles if t >= page_tiles)
        scene = "course" if not outside else "other"
        if outside:
            skipped += 1

        images = []
        for index, wrd, parts in live:
            tiles, pals = frame_tiles(parts, obj_size)
            box = frame_bbox(parts, obj_size)
            missing = sum(1 for t in tiles if t >= page_tiles)
            rows.append([
                fmt_snes(table["bank"], table["addr"]), index,
                fmt_snes(FRAME_TABLE_BANK, wrd),
                fmt_file(snes_to_file(FRAME_TABLE_BANK, wrd)),
                len([p for p in parts if "control" not in p]),
                box[0] if box else "-", box[1] if box else "-",
                box[2] - box[0] if box else "-", box[3] - box[1] if box else "-",
                tile_ranges(tiles), ",".join(str(p) for p in sorted(pals)) or "-",
                missing, scene, table["confidence"]])
            if scene != "course" or not box or not tile_data:
                continue
            img, _ = render_frame(parts, tile_data, args.bpp, palettes,
                                  args.scale, bbox=union, obj_size=obj_size)
            images.append(img)
            path = os.path.join(args.out, "frames", table["name"],
                                "{:03d}.png".format(index))
            ensure(path)
            img.save(path)
            rendered += 1
        if images:
            path = os.path.join(args.out, "sheets", table["name"] + ".png")
            ensure(path)
            contact_sheet(images, args.columns).save(path)

    path = os.path.join(args.out, "frames.tsv")
    ensure(path)
    with open(path, "w") as f:
        f.write("table\tindex\tlist_addr\tlist_file\tparts\tbbox_x\tbbox_y"
                "\tbbox_w\tbbox_h\ttiles\tpalettes\tmissing\tscene"
                "\tconfidence\n")
        for r in rows:
            f.write("\t".join(str(c) for c in r) + "\n")
    print("{} tables, {} live entries, {} frames rendered".format(
        len(tables), len(rows), rendered))
    print("{} tables flagged scene=other (tiles past the {}-tile page); "
          "not rendered".format(skipped, page_tiles))
    print("wrote {}, {}/frames/, {}/sheets/".format(path, args.out, args.out))
    bad = sum(1 for r in rows if r[12] == "course" and r[11])
    if bad:
        print("warning: {} course-scene frames still reference missing "
              "tiles".format(bad), file=sys.stderr)
    return 0


def ensure(path):
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", dest="list_addr", help="decode the frame list at this address")
    ap.add_argument("--table", action="store_true", help="dump the $89:8000 pointer table")
    ap.add_argument("--render", help="frame list address to render")
    ap.add_argument("tiles", nargs="?", help="composed OBJ page (for --render)")
    ap.add_argument("--objpage", help="composed OBJ page; same as the positional")
    ap.add_argument("--bpp", type=int, choices=(2, 4, 8), default=4)
    ap.add_argument("--palette", help="512-byte CGRAM image; OBJ palettes are taken from it")
    ap.add_argument("--bg-palette", action="store_true",
                    help="use the BG half of --palette instead of the OBJ half")
    ap.add_argument("--obj-size", default="8,16",
                    help="small,large sprite pixel sizes; the default is what "
                         "OBSEL $03 at $80:CB91 selects")
    ap.add_argument("--no-follow", action="store_true",
                    help="stop at a $80 control record instead of following it")
    ap.add_argument("--scale", type=int, default=4)
    ap.add_argument("-o", "--output")
    ap.add_argument("--all", action="store_true",
                    help="render every live entry of every table in tables.tsv")
    ap.add_argument("--tables", default=TABLES_TSV,
                    help="frametabs.py output to drive --all")
    ap.add_argument("--out", default="build/sprites", help="--all output root")
    ap.add_argument("--columns", type=int, default=8,
                    help="contact sheet width, in frames")
    args = ap.parse_args()

    follow = not args.no_follow
    try:
        obj_size = tuple(int(v, 0) for v in args.obj_size.split(","))
        if len(obj_size) != 2:
            raise ValueError
    except ValueError:
        ap.error("--obj-size wants two numbers, e.g. 8,16")

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    def to_off(text):
        kind, value = parse_addr(text)
        return snes_to_file(*value) if kind == "snes" else value

    if args.all:
        if not args.objpage:
            print("note: no --objpage, writing frames.tsv only "
                  "(build it with tools/vram.py objpage)", file=sys.stderr)
        try:
            return cmd_all(data, args, obj_size)
        except OSError as e:
            print("error: {}".format(e), file=sys.stderr)
            return 1

    if args.table:
        for i, w in enumerate(frame_table(data)):
            if w == 0xFFFF:
                print("{:3d}: unused".format(i))
                continue
            off = snes_to_file(FRAME_TABLE_BANK, w)
            parts, _ = parse_frame(data, off, follow=follow)
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
    parts, end = parse_frame(data, off, follow=follow)

    if args.render:
        if not args.output:
            ap.error("--render needs -o")
        page = args.objpage or args.tiles
        tile_data = b""
        if page:
            with open(page, "rb") as f:
                tile_data = f.read()
        palettes = None
        if args.palette:
            palettes = load_palettes(args.palette, args.bpp, obj=not args.bg_palette)
        # Pass the box explicitly: render_frame would otherwise recompute it,
        # and a caller that wants a fixed origin across frames has no way in.
        img, stats = render_frame(parts, tile_data, args.bpp, palettes,
                                  args.scale, bbox=frame_bbox(parts, obj_size),
                                  obj_size=obj_size)
        ensure(args.output)
        img.save(args.output)
        print("wrote {} ({} parts, max tile ${:03X})".format(
            args.output, stats["parts"], stats["tile_max"]))
        if stats["missing"]:
            print("warning: {} tiles past the end of the page, drawn magenta; "
                  "the page is probably composed wrong".format(stats["missing"]),
                  file=sys.stderr)
        return 0

    print("frame list at {} ({}), ends {}".format(addr, fmt_file(off), fmt_file(end)))
    for i, p in enumerate(parts):
        if "control" in p:
            if p["control"] == 0x7E:
                print("  {:2d}: priority override from $7E:{:04X} "
                      "(runtime value; list continues)".format(i, p["target"]))
                continue
            note = p.get("error") or ("followed" if p["followed"] else "not followed")
            print("  {:2d}: continue -> ${:04X}  ({})".format(i, p["target"], note))
            continue
        print("  {:2d}: dx={:+4d} dy={:+4d} tile=${:03X} pal={} pri={} {}{}{}{}".format(
            i, p["dx"], p["dy"], p["tile"], p["palette"], p["priority"],
            "H" if p["hflip"] else "-", "V" if p["vflip"] else "-",
            " large" if p["large"] else " small", " LAST" if p["last"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
