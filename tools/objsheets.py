#!/usr/bin/env python3
"""Render sprite sheets: every frame with the tiles it is actually shown with.

A metasprite frame is tile *numbers*; the picture depends on what is in VRAM
when it is drawn, and most sprite tiles are uploaded by the object itself,
moments before, from uncompressed ROM (`tools/vram.py queue`). Rendering a
frame table against one fixed tile page therefore shows scraps: the right
layout over the wrong tiles. This tool replays what each object does instead.

For each of the 234 thread object types (`tools/objanim.py`):

1. start from the course OBJ page and the course CGRAM image. The page is
   what the screen loads up front (`$8D:CA0A`, tiles `$000-$19F`) plus
   whatever object type 13 loads: that is the thread every hole starts, and
   it calls the tileset loader for entries 23, 4, 25, 1 and 2;
2. walk the object's events in order: uploads patch the page, partial
   palette loads patch CGRAM, table / index stores pick the frame;
3. at every `JSR $1030` and every `JSL $80:E445` the object yields, so the
   frame current at that point is one the player sees, for that many frames.

That gives each object an **animation** (frames in order, with durations).
Every frame is also remembered against its (table, index), so that a
**table sheet** can show each entry with the tiles it was seen with rather
than whatever the page happens to hold. An entry no object was seen to show
falls back to the object's final page, then to the course page, and is
flagged; if that fallback is known to be wrong or incomplete the entry is
left off the picture and listed under "omitted" in the atlas instead.

A `LDA table,X / JSL $80:8696` upload picks one of several blocks at run
time. Each is applied in turn and shown: those are the frames of a tile-swap
animation, the layout staying put while its tiles change.

A layout index is not a picture. Kirby's frames point at the same few tile
slots and the art is swapped underneath them, so one table entry is shown
with dozens of different uploads and a sheet with one cell per entry would
show one of them. The object sheets therefore hold every distinct (layout,
tiles) pair seen, and a third output, the **block sheets**, draws every
upload block that writes OBJ tiles as the grid it occupies in VRAM -- so
each piece of uploaded art exists as one assembled image even when no
traced object was seen to show it.

An object spawned by another starts from its spawner's page at the moment of
the spawn: a parent commonly uploads its children's tiles and then creates
them.

Every tile a frame uses has a provenance, and a frame is only as good as
its worst tile. The index reports it rather than guessing:

* `placeholder` -- the tile still holds the course page's filler: an upload
  the trace did not reach, or a frame meant for another screen;
* `unknown` -- the tile was uploaded from WRAM or the decompression buffer
  and nothing was seen being unpacked there;
* `empty` -- the tile is in the page's dynamic region (`$1A0` up, which the
  course load leaves blank) and nothing was uploaded there, so part of the
  frame is simply missing;
* `swapped` -- on a table sheet only: the entry was never seen being shown,
  and it uses a tile slot that is re-uploaded during the animation, so the
  art under it is whichever upload came last;
* `context` -- the tile was loaded by the hole-start object, not by this
  object or its spawner. Right for whatever every hole shows, and wrong for
  an enemy whose tiles are swapped in per hole; these frames can look
  convincing and be composed of the wrong tiles, so treat them as unproven;
* no flag -- every tile came from the object's own uploads (or its
  spawner's) or from the fixed course tiles.

Which screen an object belongs to is not known either. Everything is drawn
over the course page and palette; an object from the title screen or a menu
will have the right shapes and may have the wrong colours.

    python3 tools/objsheets.py                 # -> build/sprites/{objects,tables,anim}
    python3 tools/objsheets.py --type 197      # one object type
    python3 tools/objsheets.py --scale 3       # enlarge the sheets
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import frametabs  # noqa: E402
import objanim  # noqa: E402
import scenes  # noqa: E402
import sprites  # noqa: E402
import vram  # noqa: E402
from halcomp import CompressionError, decompress  # noqa: E402
from lorom import AddressError, file_to_snes, fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import decode_tile, snes_color  # noqa: E402

COURSE_OBJ_SITE = 0xCE92      # $80:CE92 loads $8D:CA0A to tiles $000-$19F
HOLE_START_TYPE = 13          # $81:BE91, spawned at the start of every hole
DYNAMIC_FROM = 0x1A0          # $8D:CA0A fills $000-$19F; the rest is uploads
DOUBT = ("placeholder", "unknown", "context", "empty", "swapped")
TILESET_TABLE = (0x80, 0xCE45, 28)
COURSE_CGRAM = (0x98, 0xC000)
PALETTE_BANK = 0x98           # sub_cgram_partial $80:90C8 hardwires it
TILE = 32
PAGE_TILES = 512
FRAME_BANK = 0x89
UNKNOWN_WAIT = 4              # frames shown for a wait whose count is computed
MAX_ANIM_FRAMES = 400         # per object; the long demo scripts loop anyway
SHEET_COLUMNS = 12

# Per-tile provenance, kept alongside the page.
BASE, OWN, UNKNOWN, CONTEXT = 0, 1, 2, 3
PASSES = 3                    # spawner -> child inheritance is iterated

_tile_rows = {}


def tile_rows(raw):
    rows = _tile_rows.get(raw)
    if rows is None:
        rows = decode_tile(raw, 4)
        _tile_rows[raw] = rows
    return rows


def obj_palettes(cgram):
    """The eight OBJ palettes (CGRAM `$80-$FF`) of a 512-byte image."""
    out = []
    for p in range(8):
        base = 0x100 + p * 32
        out.append([snes_color(int.from_bytes(cgram[base + 2 * i:base + 2 * i + 2],
                                              "little")) for i in range(16)])
    return out


def course_page(data):
    """The OBJ page the course screen loads before any object runs."""
    for off, bank, src, block in vram.find_loader_sites(data):
        if file_to_snes(off)[1] == COURSE_OBJ_SITE and bank is not None:
            page, _ = vram.compose_objpage(data, [(bank, src, block)])
            return page
    raise RomError("course OBJ loader site not found")


def placeholder_tile(page):
    """The tile the course page parks in slots meant for later uploads.

    Recognised by repetition: it is by far the commonest non-blank tile.
    """
    counts = {}
    for i in range(PAGE_TILES):
        raw = bytes(page[i * TILE:(i + 1) * TILE])
        if any(raw):
            counts[raw] = counts.get(raw, 0) + 1
    raw, n = max(counts.items(), key=lambda kv: kv[1])
    return raw if n >= 32 else None


class Frame(object):
    """One picture: a part list plus the tiles and colours it was shown with."""

    __slots__ = ("addr", "parts", "tiles", "palettes", "duration", "table",
                 "index", "site", "flags")

    def key(self):
        return (self.addr, tuple(sorted(self.tiles.items())),
                tuple(tuple(p) for p in self.palettes))


def frame_parts(data, addr):
    """Drawable parts of the frame list at `$89:addr`, or None."""
    if not frametabs.frame_ok(data, FRAME_BANK, addr):
        return None
    parts, _ = sprites.parse_frame(data, snes_to_file(FRAME_BANK, addr))
    return [p for p in parts if "control" not in p]


def tiles_of(parts):
    return sorted(sprites.frame_tiles(parts)[0])


def draw(parts, tiles, palettes, box):
    """RGBA image of one frame, cropped to `box`, back to front."""
    from PIL import Image
    minx, miny, maxx, maxy = box
    img = Image.new("RGBA", (maxx - minx, maxy - miny), (0, 0, 0, 0))
    px = img.load()
    for part in reversed(parts):
        n = 2 if part["large"] else 1
        colors = palettes[part["palette"]]
        for ty in range(n):
            for tx in range(n):
                rows = tile_rows(tiles[sprites.obj_tile(part["tile"], tx, ty)])
                bx = part["dx"] - minx + (n - 1 - tx if part["hflip"] else tx) * 8
                by = part["dy"] - miny + (n - 1 - ty if part["vflip"] else ty) * 8
                for y in range(8):
                    row = rows[7 - y if part["vflip"] else y]
                    for x in range(8):
                        c = row[7 - x if part["hflip"] else x]
                        if c:
                            px[bx + x, by + y] = colors[c] + (255,)
    return img


class Sim(object):
    """Replays one object's events against a tile page and a palette."""

    def __init__(self, data, base_page, cgram, placeholder, tables, ram=None,
                 origin=None):
        self.data = data
        self.page = bytearray(base_page)
        self.origin = bytearray(origin) if origin else bytearray(PAGE_TILES)
        self.cgram = bytearray(cgram)
        self.spawned = {}             # child type -> state at its first spawn
        self.writes = bytearray(PAGE_TILES)   # uploads per tile, saturating
        self.blocks = []              # (bank, addr) of every block applied
        # Staging buffers whose contents are known: {(bank, addr): bytes}.
        # A VRAM record that reads WRAM or the decompression buffer can be
        # honoured when a stream was seen being unpacked there.
        self.ram = dict(ram or {})
        self.placeholder = placeholder
        self.tables = tables          # {addr: entries} for bank-$89 tables
        self.table = None
        self.index = None
        self.list = None
        self.frames = []
        self.seen = {}                # (table, index) -> Frame, first sighting
        self.uploads = 0

    # -- state changes ------------------------------------------------------

    def apply_block(self, bank, addr):
        for rec in vram.parse_block(self.data, bank, addr):
            first, last = vram.tile_range(rec["vram_word"], rec["size"])
            if first is None:
                continue
            kind, kb, ka = vram.source_of(rec)
            start = (rec["vram_word"] - vram.NAME_BASE) * 2
            n = min(rec["size"], len(self.page) - start)
            staged = self.staged(kb, ka, n) if kind in ("wram", "blob") else None
            if kind == "rom" and rec["slot"] == vram.MODE_COPY:
                off = snes_to_file(kb, ka)
                self.page[start:start + n] = self.data[off:off + n]
                mark = OWN
            elif staged is not None:
                self.page[start:start + len(staged)] = staged
                mark = OWN
            elif kind == "fill" and (ka >= 0x8000 and kb not in (0x7E, 0x7F)):
                off = snes_to_file(kb | 0x80, ka)
                self.page[start:start + n] = (self.data[off:off + 2] * (n // 2 + 1))[:n]
                mark = OWN
            else:
                mark = UNKNOWN
            for t in range(first, last + 1):
                self.origin[t] = mark
                self.writes[t] = min(255, self.writes[t] + 1)
            self.uploads += 1
        self.blocks.append((bank, addr))

    def stage(self, bank, addr, blob):
        self.ram[(bank, addr)] = bytes(blob)

    def staged(self, bank, addr, n):
        """Bytes a record would read from a staging buffer, if known."""
        for (b, base), blob in self.ram.items():
            if b == bank and base <= addr < base + len(blob):
                return blob[addr - base:addr - base + n]
        return None

    def apply_tileset(self, entry):
        """Do what tileset loader `entry` does (`sub_load_tileset $80:CE45`).

        A loader that picks its block from a table at run time is skipped:
        which entry runs depends on game state.
        """
        bank, addr, count = TILESET_TABLE
        targets = dict(scenes.jump_entries(self.data, bank, addr, count))
        if entry not in targets:
            return
        for act in scenes.walk_loader(self.data, bank, targets[entry]):
            kind = act["kind"]
            if kind in ("vram", "stage", "wram"):
                try:
                    blob, _ = decompress(self.data,
                                         snes_to_file(act["src_bank"], act["src"]))
                except (CompressionError, AddressError):
                    continue
                if kind == "wram":
                    self.stage(0x7E, act["dest"], blob)
                else:
                    self.stage(vram.BLOB_BANK, act.get("dest", 0), blob)
                if kind == "vram":
                    self.apply_block(0x80, act["block"])
            elif kind == "queue":
                self.apply_block(0x80, act["block"])

    def apply_palette(self, count, src, index):
        if None in (count, src, index) or src < 0x8000:
            return
        off = snes_to_file(PALETTE_BANK, src)
        start = index * 2
        n = max(0, min(count, len(self.cgram) - start))
        self.cgram[start:start + n] = self.data[off:off + n]

    def state(self):
        """What a child spawned now would inherit."""
        return {"page": bytes(self.page), "origin": bytes(self.origin),
                "cgram": bytes(self.cgram), "ram": dict(self.ram)}

    # -- frames -------------------------------------------------------------

    def current(self):
        """(list address, table, index) of the frame the slot now names."""
        if self.list is not None:
            return self.list, None, None
        if self.table is None or self.index is None or self.index >= 0x8000:
            return None
        if self.table not in self.tables:
            # Not a table: the slot holds a list for a custom draw routine.
            if frametabs.frame_ok(self.data, FRAME_BANK, self.table):
                return self.table, None, None
            return None
        if self.index >= self.tables[self.table]:
            return None
        off = snes_to_file(FRAME_BANK, self.table + 2 * self.index)
        word = int.from_bytes(self.data[off:off + 2], "little")
        if word in (0, 0xFFFF):
            return None
        return word, self.table, self.index

    def snapshot(self, addr, table, index, duration, site, seen=True):
        """A Frame of the list at `addr` over the current page.

        `seen` is False when nothing showed this frame and the page is just
        the state the object ended in.
        """
        parts = frame_parts(self.data, addr)
        if not parts:
            return None
        f = Frame()
        f.addr, f.parts, f.table, f.index = addr, parts, table, index
        f.duration, f.site = duration, site
        f.tiles = {}
        flags = set()
        for t in tiles_of(parts):
            raw = bytes(self.page[t * TILE:(t + 1) * TILE])
            f.tiles[t] = raw
            if self.origin[t] == UNKNOWN:
                flags.add("unknown")
            elif self.origin[t] == CONTEXT:
                flags.add("context")
            elif self.origin[t] == BASE and raw == self.placeholder:
                flags.add("placeholder")
            elif self.origin[t] == BASE and t >= DYNAMIC_FROM and not any(raw):
                flags.add("empty")
            if not seen and self.writes[t] > 1:
                flags.add("swapped")
        f.flags = sorted(flags)
        f.palettes = obj_palettes(self.cgram)
        return f

    def emit(self, duration, site):
        cur = self.current()
        if not cur:
            return
        f = self.snapshot(cur[0], cur[1], cur[2], duration, site)
        if not f:
            return
        if cur[1] is not None:
            self.seen.setdefault((cur[1], cur[2]), f)
        if self.frames and self.frames[-1].key() == f.key():
            self.frames[-1].duration += duration
        elif len(self.frames) < MAX_ANIM_FRAMES:
            self.frames.append(f)

    # -- the walk -----------------------------------------------------------

    def run(self, events, inherited=None):
        if inherited:
            self.table = inherited
        child = False                # stores after a spawn configure the child
        for ev in events:
            kind, v = ev["kind"], ev["value"]
            site = (ev["bank"], ev["addr"])
            if kind == "spawn":
                child = True
                if v and v[0] == "imm":
                    self.spawned.setdefault(v[1], self.state())
            elif kind == "self":
                child = False
            elif kind in ("table", "index", "index_step", "list") and child:
                continue
            elif kind == "table":
                self.list = None
                self.table = v[1] if v and v[0] == "imm" else None
            elif kind == "index":
                self.index = v[1] if v and v[0] == "imm" else None
            elif kind == "index_step":
                if self.index is not None:
                    self.index = (self.index + v) & 0xFFFF
            elif kind == "list":
                if v and v[0] == "imm":
                    self.list = v[1]
                elif v and v[0] == "word":
                    off = snes_to_file(v[1], v[2])
                    self.list = int.from_bytes(self.data[off:off + 2], "little")
                else:
                    self.list = None
            elif kind == "frame":
                self.list = None
                self.index = 0xFFFF if v[1] == 0xFF else v[1]
                self.emit(max(1, ev["wait"]), site)
            elif kind == "wait":
                n = v[1] if v and v[0] == "imm" else UNKNOWN_WAIT
                self.emit(max(1, n), site)
            elif kind == "upload":
                if v and v[0] == "imm" and v[1] >= 0x8000 and \
                        vram.clean_block(self.data, ev["bank"], v[1]):
                    self.apply_block(ev["bank"], v[1])
                elif v and v[0] == "table":
                    base = snes_to_file(v[1], v[2])
                    for n in range(vram.MAX_TABLE_BLOCKS):
                        w = int.from_bytes(self.data[base + 2 * n:base + 2 * n + 2],
                                           "little")
                        if not vram.clean_block(self.data, ev["bank"], w):
                            break
                        self.apply_block(ev["bank"], w)
                        self.emit(UNKNOWN_WAIT, site)
            elif kind == "palette":
                self.apply_palette(*v)
            elif kind == "tileset":
                if v and v[0] == "imm":
                    self.apply_tileset(v[1])


def child_tables(objs):
    """{object type: [table addresses its spawners store into the new slot]}.

    A spawner configures its child right after the spawn call, with the new
    slot still in Y, and only then reloads its own slot with `LDY $D2`. So
    table stores between a spawn and the next `self` event are the child's.
    """
    out = {}
    for obj in objs:
        child = None
        for ev in obj["events"]:
            v = ev["value"]
            if ev["kind"] == "spawn":
                child = v[1] if v and v[0] == "imm" else -1
            elif ev["kind"] == "self":
                child = None
            elif ev["kind"] == "table" and child is not None and child >= 0 \
                    and v and v[0] == "imm":
                out.setdefault(child, [])
                if v[1] not in out[child]:
                    out[child].append(v[1])
    return out


def union_box(frames):
    boxes = [sprites.frame_bbox(f.parts) for f in frames]
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def sheet(frames, columns=SHEET_COLUMNS, scale=1):
    """(image, atlas) for a list of Frames laid out on a uniform grid.

    Every cell is the union box of the frames, so the object's origin is at
    the same place in each -- an animation cut from the sheet does not
    jitter. The atlas gives that origin and each cell's rectangle.
    """
    from PIL import Image
    box = union_box(frames)
    cw, ch = box[2] - box[0], box[3] - box[1]
    cols = min(columns, len(frames))
    rows = (len(frames) + cols - 1) // cols
    img = Image.new("RGBA", (cols * cw, rows * ch), (0, 0, 0, 0))
    cells = []
    for n, f in enumerate(frames):
        x, y = (n % cols) * cw, (n // cols) * ch
        img.paste(draw(f.parts, f.tiles, f.palettes, box), (x, y))
        cells.append({"x": x * scale, "y": y * scale,
                      "list": fmt_snes(FRAME_BANK, f.addr),
                      "table": fmt_snes(FRAME_BANK, f.table)
                      if f.table is not None else None,
                      "index": f.index, "duration": f.duration,
                      "flags": f.flags})
    if scale != 1:
        resample = getattr(Image, "Resampling", Image).NEAREST
        img = img.resize((img.width * scale, img.height * scale), resample)
    atlas = {"cell": [cw * scale, ch * scale],
             "origin": [-box[0] * scale, -box[1] * scale],
             "scale": scale, "frames": cells}
    return img, atlas


def gif(frames, path, scale=3):
    """An animated preview; durations are in 60 Hz frames."""
    from PIL import Image
    box = union_box(frames)
    resample = getattr(Image, "Resampling", Image).NEAREST
    adaptive = getattr(Image, "Palette", Image).ADAPTIVE
    images = []
    for f in frames:
        im = draw(f.parts, f.tiles, f.palettes, box)
        bg = Image.new("RGBA", im.size, (48, 48, 64, 255))
        bg.alpha_composite(im)
        images.append(bg.resize((im.width * scale, im.height * scale), resample)
                      .convert("RGB").convert("P", palette=adaptive))
    images[0].save(path, save_all=True, append_images=images[1:], loop=0,
                   duration=[max(20, int(f.duration * 1000 / 60)) for f in frames],
                   disposal=2)


def distinct(frames):
    out, seen = [], set()
    for f in frames:
        k = f.key()
        if k not in seen:
            seen.add(k)
            out.append(f)
    return out


OMIT = ("swapped", "empty", "placeholder", "unknown")


def write_sheet(frames, stem, scale, omit_unseen=False):
    """Write a sheet and its atlas.

    With `omit_unseen`, an entry nothing was seen to show **and** whose
    tiles are known to be wrong or missing is left off the picture and
    listed under "omitted" instead. Drawing it would put a real layout over
    another frame's art, which reads as a broken sprite rather than as a
    gap in what is known.
    """
    omitted = []
    if omit_unseen:
        keep = []
        for f in frames:
            if "unpaired" in f.flags and set(f.flags) & set(OMIT):
                omitted.append({"list": fmt_snes(FRAME_BANK, f.addr),
                                "index": f.index, "flags": f.flags})
            else:
                keep.append(f)
        frames = keep
    atlas = {"frames": []}
    if frames:
        img, atlas = sheet(frames, scale=scale)
        img.save(stem + ".png")
    elif os.path.exists(stem + ".png"):
        os.remove(stem + ".png")
    atlas["omitted"] = omitted
    with open(stem + ".json", "w") as f:
        json.dump(atlas, f, indent=1)
    return len(frames)


def block_sheets(data, out, palettes, tile_pal, shown, scale):
    """Draw every upload block that copies ROM into the OBJ page.

    The image is the block's tiles where they sit in the 16-wide tile grid,
    which for these uploads is also how the sprite is assembled: a pose is
    stored as a top row and a bottom row and sent to two consecutive rows
    of VRAM. The palette is the one frames were most often seen using on
    those tiles, `tile_pal`; palette 0 when none was, which is a guess and
    is recorded as such.
    """
    from PIL import Image
    outdir = os.path.join(out, "blocks")
    if not os.path.isdir(outdir):
        os.makedirs(outdir)
    done = {}
    for site in vram.queue_sites(data):
        for bank, addr in site["blocks"]:
            if (bank, addr) in done:
                done[(bank, addr)]["sites"] += 1
                continue
            cells = {}
            sources = []
            for rec in vram.parse_block(data, bank, addr):
                first, last = vram.tile_range(rec["vram_word"], rec["size"])
                kind, kb, ka = vram.source_of(rec)
                if first is None or kind != "rom" or rec["slot"] != vram.MODE_COPY:
                    continue
                off = snes_to_file(kb, ka)
                sources.append(fmt_snes(kb, ka))
                for t in range(first, last + 1):
                    cells[t] = bytes(data[off + (t - first) * TILE:
                                          off + (t - first + 1) * TILE])
            if not cells:
                continue
            votes = {}
            for t in cells:
                for pal, n in tile_pal.get(t, {}).items():
                    votes[pal] = votes.get(pal, 0) + n
            pal = max(votes, key=votes.get) if votes else 0
            cols = [t & 0xF for t in cells]
            rows = [t >> 4 for t in cells]
            x0, y0 = min(cols), min(rows)
            img = Image.new("RGBA", ((max(cols) - x0 + 1) * 8,
                                     (max(rows) - y0 + 1) * 8), (0, 0, 0, 0))
            px = img.load()
            for t, raw in cells.items():
                tr = tile_rows(raw)
                bx, by = ((t & 0xF) - x0) * 8, ((t >> 4) - y0) * 8
                for y in range(8):
                    for x in range(8):
                        c = tr[y][x]
                        if c:
                            px[bx + x, by + y] = palettes[pal][c] + (255,)
            if scale != 1:
                resample = getattr(Image, "Resampling", Image).NEAREST
                img = img.resize((img.width * scale, img.height * scale), resample)
            name = "{:02X}_{:04X}".format(bank, addr)
            img.save(os.path.join(outdir, name + ".png"))
            done[(bank, addr)] = {
                "tiles": sprites.tile_ranges(set(cells)), "sources": sources,
                "palette": pal, "guess": not votes, "sites": 1,
                "seen": (bank, addr) in shown}
    path = os.path.join(outdir, "index.tsv")
    with open(path, "w") as f:
        f.write("block\ttiles\tsources\tpalette\tpalette_guessed\tsites"
                "\tseen_under_frame\n")
        for (bank, addr), b in sorted(done.items()):
            f.write("\t".join([
                fmt_snes(bank, addr), b["tiles"], " ".join(b["sources"]),
                str(b["palette"]), "yes" if b["guess"] else "-",
                str(b["sites"]), "yes" if b["seen"] else "-"]) + "\n")
    return len(done), sum(1 for b in done.values() if b["seen"]), path


def read_tables(path):
    """{addr: entries} for the bank-$89 tables, and the table-less lists."""
    tables = {}
    for t in sprites.read_tables(path):
        if t["bank"] == FRAME_BANK:
            tables[t["addr"]] = t["entries"]
    return tables


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/sprites")
    ap.add_argument("--tables", default=sprites.TABLES_TSV)
    ap.add_argument("--type", type=lambda s: int(s, 0), action="append",
                    help="only this object type (repeatable)")
    ap.add_argument("--scale", type=int, default=1, help="sheet pixel scale")
    ap.add_argument("--no-gif", action="store_true")
    args = ap.parse_args()

    try:
        data = load_rom()
        base = course_page(data)
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    if not os.path.isfile(args.tables):
        print("error: {} not found; run tools/frametabs.py first".format(
            args.tables), file=sys.stderr)
        return 1

    off = snes_to_file(*COURSE_CGRAM)
    cgram = data[off:off + 512]
    placeholder = placeholder_tile(base)
    tables = read_tables(args.tables)
    objs = objanim.trace(data)
    inherited = child_tables(objs)

    # The hole-start object's loads are part of every course object's world,
    # but they are context, not the object's own doing.
    ram = {}
    origin = bytes(PAGE_TILES)
    for obj in objs:
        if obj["type"] == HOLE_START_TYPE:
            start = Sim(data, base, cgram, placeholder, tables)
            start.run(obj["events"])
            base, ram = bytes(start.page), start.ram
            origin = bytes(CONTEXT if o == OWN else o for o in start.origin)
    world = {"page": base, "origin": origin, "cgram": cgram, "ram": ram}

    def simulate(obj, state):
        out = []
        for first in (inherited.get(obj["type"]) or [None]):
            sim = Sim(data, state["page"], state["cgram"], placeholder, tables,
                      state["ram"], state["origin"])
            sim.run(obj["events"], first)
            out.append(sim)
        return out

    # A child starts from its spawner's state, so run to a fixed point: each
    # pass hands the states captured at spawn calls to the next.
    states = {}
    results = {}
    for _ in range(PASSES):
        captured = {}
        for obj in objs:
            sims = simulate(obj, states.get(obj["type"], world))
            results[obj["type"]] = sims
            for sim in sims:
                for child, st in sim.spawned.items():
                    if child != obj["type"] and sim.uploads:
                        captured.setdefault(child, st)
        if captured == states:
            break
        states = captured

    rows = []
    paired = {}                       # (table, index) -> Frame, any object
    finals = {}                       # table -> Sim that last used it
    for obj in objs:
        tid = obj["type"]
        sims = results[tid]
        frames = [f for sim in sims for f in sim.frames]
        used = []
        for sim in sims:
            for key, f in sim.seen.items():
                best = paired.get(key)
                if best is None or len(f.flags) < len(best.flags):
                    paired[key] = f
                if key[0] not in used:
                    used.append(key[0])
            for ev in obj["events"]:
                v = ev["value"]
                if ev["kind"] == "table" and v and v[0] == "imm" and \
                        v[1] in tables:
                    if v[1] not in finals or sim.uploads > finals[v[1]].uploads:
                        finals[v[1]] = sim
                    if v[1] not in used:
                        used.append(v[1])
        for t in inherited.get(tid, []):
            if t in tables and t not in used:
                used.append(t)
                finals.setdefault(t, sims[0])
        shown = distinct(frames)
        flags = sorted(set(fl for f in shown for fl in f.flags))
        rows.append([tid, fmt_snes(obj["bank"], obj["addr"]), len(obj["events"]),
                     sum(s.uploads for s in sims), len(frames), len(shown),
                     sum(f.duration for f in frames),
                     ",".join("${:04X}".format(t) for t in used) or "-",
                     ",".join(flags) or "-",
                     "yes" if tid in states else "-"])
        if args.type and tid not in args.type:
            continue
        if shown:
            stem = os.path.join(args.out, "objects", "obj_{:03d}".format(tid))
            write_sheet(shown, stem, args.scale)
            if not args.no_gif and len(frames) > 1:
                gif(frames, os.path.join(args.out, "anim",
                                         "obj_{:03d}.gif".format(tid)))

    # Table sheets: each entry with the tiles some object showed it with.
    trows = []
    blank = Sim(data, base, cgram, placeholder, tables, ram, origin)

    def table_row(name, out, entries):
        counts = {}
        for f in out:
            for fl in f.flags:
                counts[fl] = counts.get(fl, 0) + 1
        trows.append([name, entries, len(out),
                      sum(1 for f in out if not set(f.flags) & set(DOUBT)),
                      counts.get("context", 0), counts.get("placeholder", 0),
                      counts.get("empty", 0), counts.get("swapped", 0),
                      counts.get("unknown", 0), counts.get("unpaired", 0)])

    for t in sprites.read_tables(args.tables):
        bank, addr, entries = t["bank"], t["addr"], t["entries"]
        in_frame_bank = bank == FRAME_BANK
        sim = finals.get(addr, blank) if in_frame_bank else blank
        out = []
        for i in range(entries):
            f = paired.get((addr, i)) if in_frame_bank else None
            if f is None:
                o = snes_to_file(bank, addr + 2 * i)
                word = int.from_bytes(data[o:o + 2], "little")
                if word in (0, 0xFFFF):
                    continue
                f = sim.snapshot(word, addr, i, 1, None, seen=False)
                if f is None:
                    continue
                f.flags = sorted(set(f.flags) | {"unpaired"})
            out.append(f)
        if not out:
            continue
        table_row(fmt_snes(bank, addr), out, entries)
        if not args.type:
            write_sheet(out, os.path.join(args.out, "tables", t["name"]),
                        args.scale, omit_unseen=True)

    # Frame lists no table names: drawn over the course world, in address
    # order, so that nothing in the bank is left out.
    lpath = os.path.join(os.path.dirname(args.tables), "lists.tsv")
    loose = []
    if os.path.isfile(lpath):
        with open(lpath) as f:
            next(f)
            for line in f:
                addr = int(line.split("\t")[0][4:], 16)
                fr = blank.snapshot(addr, None, None, 1, None)
                if fr:
                    fr.flags = sorted(set(fr.flags) | {"unpaired"})
                    loose.append(fr)
    if loose:
        table_row("lists", loose, len(loose))
        if not args.type:
            write_sheet(loose, os.path.join(args.out, "tables", "lists"),
                        args.scale, omit_unseen=True)

    path = os.path.join(args.out, "objects", "index.tsv")
    with open(path, "w") as f:
        f.write("type\tentry\tevents\tuploads\tanim_frames\tdistinct_frames"
                "\tanim_ticks\ttables\tflags\tinherits_spawner\n")
        for r in rows:
            f.write("\t".join(str(c) for c in r) + "\n")
    tpath = os.path.join(args.out, "tables", "index.tsv")
    with open(tpath, "w") as f:
        f.write("table\tentries\tframes\tproven\tcontext\tplaceholder\tempty"
                "\tswapped\tunknown\tunpaired\n")
        for r in trows:
            f.write("\t".join(str(c) for c in r) + "\n")

    animated = sum(1 for r in rows if r[5])
    clean = sum(1 for r in rows if r[5] and r[8] == "-")
    print("{} object types: {} show at least one frame, {} of those with "
          "every tile proven".format(len(rows), animated, clean))
    print("{} table sheets, {} frames: {} proven; with a doubtful tile: "
          "{} context, {} placeholder, {} empty, {} swapped, {} unknown "
          "source".format(
              len(trows), sum(r[2] for r in trows), sum(r[3] for r in trows),
              sum(r[4] for r in trows), sum(r[5] for r in trows),
              sum(r[6] for r in trows), sum(r[7] for r in trows),
              sum(r[8] for r in trows)))
    if not args.type:
        shown_blocks = set(b for sims in results.values() for sim in sims
                           for b in sim.blocks)
        tile_pal = {}
        for sims in results.values():
            for sim in sims:
                for f in sim.frames:
                    for p in f.parts:
                        n = 2 if p["large"] else 1
                        for ty in range(n):
                            for tx in range(n):
                                t = sprites.obj_tile(p["tile"], tx, ty)
                                c = tile_pal.setdefault(t, {})
                                c[p["palette"]] = c.get(p["palette"], 0) + 1
        n, seen_n, bpath = block_sheets(data, args.out, obj_palettes(cgram),
                                        tile_pal, shown_blocks, args.scale)
        print("{} upload blocks drawn as tile grids, {} of them also seen "
              "under a frame; wrote {}".format(n, seen_n, bpath))
    print("wrote {} and {}".format(path, tpath))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AddressError as e:
        print("error: {}".format(e), file=sys.stderr)
        sys.exit(1)
