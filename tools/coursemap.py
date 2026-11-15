#!/usr/bin/env python3
"""Unpack and render a hole's isometric background from course tables 5-9.

Tables 8 and 9 are the two background layers, but they are not rectangular
tilemaps: empty space around the diamond is not stored. Tables 5, 6 and 7
are the row directory that makes them rectangular again. Each holds exactly
`header word 5` 16-bit entries, one per map row:

    table 5   first column of the row      ($FFFF = the row is empty)
    table 6   last column of the row
    table 7   word offset of the row inside tables 8 and 9

so, for a row r and a column c,

    tile(r, c) = table8[ table7[r] + c - table5[r] ]   if t5[r] <= c <= t6[r]

and nothing is stored otherwise. Read off the column-strip copy at
`$80:BE17 (0x003E17)`, which uploads one column at a time while the course
scrolls:

    LDA $93B0,X / CMP $9BB0,X / BEQ skip     ; t5[r], t6[r]; equal = no row
    ... reject c outside [t5, t6] ...
    SEC / SBC $0A / CLC / ADC $8BB0,X        ; (c - t5[r]) + t7[r]
    ASL A / TAX
    LDA $7F:3000,X / STA $0000,Y             ; table 8 -> BG1 row buffer
    LDA $7F:9800,X / STA $0040,Y             ; table 9 -> BG2 row buffer

`$7E:93B0`, `$9BB0` and `$8BB0` are where `sub_course_load_bg` puts tables
5, 6 and 7, and `$7F:3000` / `$7F:9800` are tables 8 and 9. The two buffers
go to VRAM `$5000` and `$5800` (`$80:BE65`, `$80:BE9A`), which screen block
0 at `$80:CB91` assigns to BG1 and BG2, so **table 8 is BG1 and table 9 is
BG2**.

Header words 4 and 5 are therefore the map size in 8-pixel *tiles*, not in
pixels: a grid cell is 8 tiles wide, `word4 = 4 * (width + height)`, and
`word3 = word4 * word5` is the full rectangular tile count.

The tile page and palette come from the course scene's own loaders:

    $80:CC9D  $8B:DAB1 -> $7F:2000   isometric terrain tiles
              $90:9E9E -> $7F:0000   then 27,136 bytes to VRAM word $0000
    $80:D369  512 bytes from $98:C000 by MVN into the CGRAM staging buffer

so VRAM tiles 0-255 come from `$90:9E9E` and 256-847 from `$8B:DAB1`.

That is the page every hole starts from. A hole with water (`$60-$6F` in
layer 2, and no boost panel `$30-$3B`) then gets its own tiles `$180-$1AB`
from `$91:ED29` at the load (`$82:BCD7` -> `$80:CCEF`), and object 113 cycles
palette 4's colours 1-7 through three sets every 8 frames (`$84:8533`), so the
course CGRAM image's colours there -- the boost panels' red cycle -- are not
what a water hole shows. `hole_page` and `hole_palette` apply both; the
render uses the first ripple set.

BG3 carries the scenery behind the course, and all of it is per-course
rather than per-hole. `sub_load_course_backdrop $80:D6A8` selects tiles and
tilemap with `course & 7` from the tables at `$80:D748` and `$80:D768`, and
`$80:D4F7` selects a matching palette from `$80:D517` and hands it to
`sub_cgram_partial` with A = `$28` bytes: CGRAM colours 0-19. That palette is
what makes the layer readable: the course CGRAM image at `$98:C000` leaves
BG3 sub-palettes 1-7 entirely black, so drawing the scenery against it
produces holes.

The CGRAM in play (`hole_cgram`; measured on snapshots of 18 holes over the
eight courses, notes/port-v2-phase1-courses.md) is `$98:C000`, then the
scenery's 20 colours at 0, the HUD's 12 at 20 (`$83:AA24`: `$98:CE48`), then
the course's list `$80:D869`[course] (`$80:D82B`, run by `$80:90E7`): five
runs into BG palettes 2, 3, 5, 6 and 7, which is all that tells one course's
colours from another's.

The BG3 character page is shared three ways -- font at tiles 0-191, window
furniture at 208-303, and the scenery at 320-511 -- which is why the stored
tilemap references indices below 320: the same buffer also holds the text
window. Text is written into it at run time by `$83:B406`, which ORs `$3C00`
(palette 7, priority) into each glyph.

BG3's map is 32x32, so it wraps. Rendering a whole course at once therefore
tiles the scenery, where the hardware would only ever show one screen of it.
Pass `--no-backdrop` for the course geometry alone.

    python3 tools/coursemap.py                  # every hole -> build/courses
    python3 tools/coursemap.py --index 0
    python3 tools/coursemap.py --check          # assertions only, no output
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from courses import ENTRIES, default_entries, entry, header  # noqa: E402
from halcomp import CompressionError, decompress  # noqa: E402
from lorom import fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import decode_tiles, snes_color  # noqa: E402

# Course scene graphics, from the loader disassembly above.
GFX_LOW = (0x90, 0x9E9E)       # VRAM tiles $000-$0FF
GFX_HIGH = (0x8B, 0xDAB1)      # VRAM tiles $100-$34F
PALETTE = (0x98, 0xC000)
CGRAM_BANK = 0x98      # sub_cgram_partial's MVN hardwires this
PAGE_BYTES = 27136             # the size field of the record at $80:CCB7
TILE_BYTES4 = 32

# The scenery behind the course is BG3, and it is per-course rather than
# per-hole: `sub_load_course_backdrop $80:D6A8` takes the course number at
# $7E:6A5A, masks it with 7, and indexes two 8-entry tables of (bank16,
# addr16). Tiles land at VRAM word $4A00 and the tilemap at $3C00, while
# screen block 0 puts BG3's character base at $4000 -- so a tilemap index
# counts 2bpp tiles from $4000 and the backdrop starts at tile
# ($4A00 - $4000) / 8 = 320. The font occupies tiles 0-191 of the same page.
BACKDROP_TILES = (0x80, 0xD748)
BACKDROP_MAP = (0x80, 0xD768)
# The BG3 character page is built from three loads, all in the course
# bundle (`tools/scenes.py bundles`). Tile indices count 2bpp tiles from the
# character base $4000, so a load at VRAM word W starts at (W - $4000) / 8.
BG3_SOURCES = [
    ((0x90, 0xFBBC), 0x4000, 3072),    # font, tiles 0-191   (gfx_b entry 1)
    ((0x92, 0x9505), 0x4680, 1792),    # window furniture, tiles 208-303
]
BG3_CHAR_BASE = 0x4000
BG3_BACKDROP_VRAM = 0x4A00     # tiles 320-511
BG3_MAP_TILES = 32             # block 0 gives BG3 a 32x32 map, so it repeats
TILE_BYTES2 = 16

# The scenery has its own palette, also per-course. `$80:D4F7` indexes this
# table with `course & 7` and hands 40 colours to `sub_cgram_partial`, which
# writes them to CGRAM colours 0-39 from bank $98. Without this the course
# image's own BG3 sub-palettes 1-7 are all black, which is what gives the
# clouds their holes.
BG3_PALETTE_TABLE = (0x80, 0xD517)
BG3_PALETTE_ALT = (0x80, 0xD527)      # taken instead when $7E:6A2E is set
BG3_PALETTE_COLOURS = 20              # A = $28 bytes (sub_cgram_partial counts bytes)
# Then `$83:AA24` loads the score panel's 12 colours over BG3 palettes 5-7.
HUD_PALETTE = (0x98, 0xCE48)
HUD_CGRAM, HUD_COLOURS = 20, 12
# `$82:BC9C` -> `$80:D82B`[`$6A2E`]: entry 0 (`$80:D839`) takes the list
# `$80:D869`[`$7E:6A5A`] (or `$80:DA0D` while `$ED5B` is set; not modelled),
# and `$80:90E7` runs it: words (bytes, source in bank $98, CGRAM index)
# until `$FF`. Entry 1, the `$6A2E` alternate, is not modelled either.
COURSE_LISTS = (0x80, 0xD869)
COURSE_LIST_END = 0xFF

# Per-hole surface graphics (docs/courses.md "Per-hole surface graphics").
# At the hole's load `$82:BCD7` reads the per-value counts of the layer-2 grid
# at `$7E:B3B8`: any boost panel `$30-$3B` sets `$B6FA` = 1 and spawns object
# 112 (`$84:876C`, the panels' colour cycle) and nothing else; otherwise any
# water `$60-$6F` sets `$B6FA` = 2, spawns object 113 (`$84:8293`, the water's
# ripple) and calls graphics set A entry 2 (`$80:CCDF`), whose record
# `$80:CCEF` copies 1408 uncompressed bytes from `$91:ED29` to VRAM word
# `$1800` -- tiles `$180-$1AB`, which the course page otherwise fills from
# `$8B:DAB1`. (`$80:CCF8`, a zero fill, is taken instead while `$69CA` is set.)
BOOST_VALUES = range(0x30, 0x3C)
WATER_VALUES = range(0x60, 0x70)
WATER_GFX = (0x91, 0xED29)
WATER_GFX_BYTES = 1408
WATER_FIRST_TILE = 0x180
# Object 113's per-frame hook `$84:8533` steps a phase (phase + 1) & 3 every
# `$84:8576`[phase] frames and writes 7 colours from bank `$98` at
# base + `$84:857E`[phase] to CGRAM colour `$41` (palette 4, colours 1-7)
# through `sub_cgram_partial`. The base is `$84:84AF`[`$6A5C`], and `$6A5C` is
# 2 * course in every snapshot recorded for courses 0-15. `$84:84F1` is the
# table taken while `$7E:6A2E` is set, and `$7E:ED5B` picks `$98:EA50`/`$EA7A`;
# neither is modelled here.
WATER_BASES = (0x84, 0x84AF)
WATER_PHASE_FRAMES = (0x84, 0x8576)
WATER_PHASE_OFFSET = (0x84, 0x857E)
WATER_PHASES = 4
WATER_CGRAM = 0x41
WATER_COLOURS = 7
# Object 112 (`$84:876C`, spawned for the boost panels) writes palette 4
# colours 1-4 from these four sets in turn, `JSL $80:E445` with A = 3 between
# them (`$84:8781`-`$84:87D1`); a wait of N resumes N + 1 frames on, and the
# writes are 4 frames apart in play (hole 17, --watch-write $0482-$0489).
# The operands of the four `LDX #$C2xx` and of the first `LDA #3`:
BOOST_SETS = ((0x84, 0x8785), (0x84, 0x8799), (0x84, 0x87AD), (0x84, 0x87C1))
BOOST_WAIT = (0x84, 0x878F)
BOOST_CGRAM = 0x41
BOOST_COLOURS = 4
# Objects 114 (`$84:8258`, the warp panels `$B0-$B9`) and 115 (`$84:8253`,
# the snap tiles `$18-$1B`, tested first) share one loop: the phase steps
# (phase + 1) & 3 and writes 5 colours from `$84:828B`[phase] to CGRAM `$6B`
# (palette 6 colours 11-15), waiting `$539C` = 7 or 3 (spawned by `$82:BD29`).
# Measured: 8 and 4 frames a set (holes 3 and 29).
PANEL_TABLE = (0x84, 0x828B)
PANEL_WAITS = {114: (0x84, 0x8259), 115: (0x84, 0x8254)}   # the LDA #n operands
PANEL_SNAP_VALUES = range(0x18, 0x1C)
PANEL_WARP_VALUES = range(0xB0, 0xBA)
PANEL_CGRAM = 0x6B
PANEL_COLOURS = 5

W_CELLS, W_WIDTH, W_HEIGHT, W_AREA, W_MAPW, W_MAPH = 0, 1, 2, 3, 4, 5
EMPTY = 0xFFFF

T_LEFT, T_RIGHT, T_OFFSET, T_BG1, T_BG2 = 5, 6, 7, 8, 9


def words(b):
    return [int.from_bytes(b[i:i + 2], "little") for i in range(0, len(b) - 1, 2)]


def table(d, index, n):
    """Decompress course table `n` for a hole."""
    bank, addr = entry(d, n, index)
    out, _ = decompress(d, snes_to_file(bank, addr))
    return out


def course_page(d):
    """The 848-tile VRAM page the course scene builds at word $0000."""
    low, _ = decompress(d, snes_to_file(*GFX_LOW))
    high, _ = decompress(d, snes_to_file(*GFX_HIGH))
    page = low + high
    if len(page) != PAGE_BYTES:
        raise ValueError("page is {} bytes, expected {}".format(len(page), PAGE_BYTES))
    return page


def course_palette(d):
    """16 sub-palettes of 16 colours from the CGRAM image at $98:C000."""
    off = snes_to_file(*PALETTE)
    raw = d[off:off + 512]
    cols = [snes_color(w) for w in words(raw)]
    return [cols[i * 16:(i + 1) * 16] for i in range(16)]


def surface_kind(d, index):
    """"boost", "water" or None: which branch `$82:BCD7` takes for this hole.

    The boost panels are tested first, so a hole with both gets no water
    graphics, as in the game.
    """
    _, fields, _, _ = header(d, index)
    n = fields[W_WIDTH] * fields[W_HEIGHT]
    try:
        values = set(table(d, index, 2)[:n])
    except CompressionError:
        return None
    if values & set(BOOST_VALUES):
        return "boost"
    if values & set(WATER_VALUES):
        return "water"
    return None


def hole_page(d, index):
    """The course page as it is while this hole is in play: `course_page`,
    with the water tiles at `$180-$1AB` on a water hole."""
    page = course_page(d)
    if surface_kind(d, index) != "water":
        return page
    src = snes_to_file(*WATER_GFX)
    at = WATER_FIRST_TILE * TILE_BYTES4
    return page[:at] + d[src:src + WATER_GFX_BYTES] + page[at + WATER_GFX_BYTES:]


def _word(d, bank, addr):
    o = snes_to_file(bank, addr)
    return int.from_bytes(d[o:o + 2], "little")


def _layer2_values(d, index):
    _, fields, _, _ = header(d, index)
    n = fields[W_WIDTH] * fields[W_HEIGHT]
    try:
        return set(table(d, index, 2)[:n])
    except CompressionError:
        return set()


def _cgram_set(d, addr, count):
    o = snes_to_file(CGRAM_BANK, addr)
    return [snes_color(w) for w in words(d[o:o + 2 * count])]


def water_ripple(d, index):
    """Object 113's ripple for a water hole, or None.

    `sets` are the distinct 7-colour sets in first-use order and `order` the
    set of each phase, so course 1 gives order [0, 1, 0, 2]; each phase lasts
    `stepFrames`. The phase starts at 0 when the object spawns, at the load.
    The base is `$84:84AF`[`$6A5C`], `$6A5C` = 2 * course (measured for
    courses 0-16), so `index // 8` picks it.
    """
    if surface_kind(d, index) != "water":
        return None
    course = index // 8
    base = _word(d, WATER_BASES[0], WATER_BASES[1] + 2 * course)
    frames = [_word(d, WATER_PHASE_FRAMES[0], WATER_PHASE_FRAMES[1] + 2 * p)
              for p in range(WATER_PHASES)]
    if len(set(frames)) != 1:
        raise ValueError("water phases of unequal length: {}".format(frames))
    offsets = [_word(d, WATER_PHASE_OFFSET[0], WATER_PHASE_OFFSET[1] + 2 * p)
               for p in range(WATER_PHASES)]
    distinct = list(dict.fromkeys(offsets))
    return {
        "name": "ripple", "object": 113,
        "source": fmt_snes(0x84, 0x8533),
        "colours": [fmt_snes(CGRAM_BANK, base + off) for off in distinct],
        "stepFrames": frames[0],
        "order": [distinct.index(off) for off in offsets],
        "sets": [_cgram_set(d, base + off, WATER_COLOURS) for off in distinct],
        "cgram": WATER_CGRAM, "count": WATER_COLOURS,
    }


def boost_cycle(d, index):
    """Object 112's colour cycle on a hole with boost panels, or None.

    Its first set is `$98:C000`'s own colours there, so the layers drawn with
    `hole_cgram` already show set 0.
    """
    if surface_kind(d, index) != "boost":
        return None
    addrs = [_word(d, *op) for op in BOOST_SETS]
    wait = _word(d, *BOOST_WAIT)
    return {
        "name": "boost", "object": 112,
        "source": fmt_snes(0x84, 0x876C),
        "colours": [fmt_snes(CGRAM_BANK, a) for a in addrs],
        "stepFrames": wait + 1,
        "order": list(range(len(addrs))),
        "sets": [_cgram_set(d, a, BOOST_COLOURS) for a in addrs],
        "cgram": BOOST_CGRAM, "count": BOOST_COLOURS,
    }


def panel_cycle(d, index):
    """Object 115's (any snap tile) or 114's (any warp panel) colour cycle,
    or None (`$82:BD29`). The phase is incremented before its first write,
    so the sets run from `$84:828B`[1]; the layers are drawn with set 0."""
    values = _layer2_values(d, index)
    if values & set(PANEL_SNAP_VALUES):
        obj = 115
    elif values & set(PANEL_WARP_VALUES):
        obj = 114
    else:
        return None
    table = [_word(d, PANEL_TABLE[0], PANEL_TABLE[1] + 2 * p) for p in range(4)]
    addrs = [table[(p + 1) & 3] for p in range(4)]
    wait = _word(d, *PANEL_WAITS[obj])
    return {
        "name": "panels", "object": obj,
        "source": fmt_snes(0x84, 0x8253 if obj == 115 else 0x8258),
        "colours": [fmt_snes(CGRAM_BANK, a) for a in addrs],
        "stepFrames": wait + 1,
        "order": list(range(len(addrs))),
        "sets": [_cgram_set(d, a, PANEL_COLOURS) for a in addrs],
        "cgram": PANEL_CGRAM, "count": PANEL_COLOURS,
    }


def palette_cycles(d, index):
    """The BG colour cycles an object runs while the hole is in play (the
    ripple or the boost panels' cycle, and the warp or snap panels'). The
    outline's two colours, object 111's, are on every hole and are drawn as
    masks instead (export_web.py). Not modelled: objects 116-118 of the
    `$58-$5D` tiles, and the scenery's own cycles (`$84:CF31`, `$84:D072`)."""
    return [c for c in (water_ripple(d, index), boost_cycle(d, index), panel_cycle(d, index)) if c]


def hole_cgram(d, index, course=None):
    """The 256 CGRAM words while the hole is in play, before any cycle runs:
    `$98:C000`, the scenery's 20 colours at 0, the HUD's 12 at 20 and the
    course's list (the module docstring). `course` defaults to the hole's
    (`index // 8`, the `$6A5A` the hole loader uses)."""
    if course is None:
        course = index // 8
    cg = words(d[snes_to_file(*PALETTE):snes_to_file(*PALETTE) + 512])
    sc = _word(d, BG3_PALETTE_TABLE[0], BG3_PALETTE_TABLE[1] + 2 * (course & 7))
    o = snes_to_file(CGRAM_BANK, sc)
    cg[0:BG3_PALETTE_COLOURS] = words(d[o:o + 2 * BG3_PALETTE_COLOURS])
    o = snes_to_file(*HUD_PALETTE)
    cg[HUD_CGRAM:HUD_CGRAM + HUD_COLOURS] = words(d[o:o + 2 * HUD_COLOURS])
    lst = snes_to_file(COURSE_LISTS[0], _word(d, COURSE_LISTS[0], COURSE_LISTS[1] + 2 * course))
    while True:
        n = int.from_bytes(d[lst:lst + 2], "little")
        if n == COURSE_LIST_END:
            break
        srca = int.from_bytes(d[lst + 2:lst + 4], "little")
        dst = int.from_bytes(d[lst + 4:lst + 6], "little")
        o = snes_to_file(CGRAM_BANK, srca)
        cg[dst:dst + n // 2] = words(d[o:o + n])
        lst += 6
    return cg


def hole_palette(d, index, sets=None, course=None):
    """The hole's 16 sub-palettes of 16 colours in play (`hole_cgram`), with
    each palette cycle at set 0, or at `sets[name]` for the cycles named
    there (a water hole's ripple set k: `{"ripple": k}`)."""
    cg = [snes_color(w) for w in hole_cgram(d, index, course)]
    pal = [cg[i * 16:(i + 1) * 16] for i in range(16)]
    for cyc in palette_cycles(d, index):
        k = (sets or {}).get(cyc["name"], 0)
        sub, first = divmod(cyc["cgram"], 16)
        row = list(pal[sub])
        row[first:first + cyc["count"]] = cyc["sets"][k]
        pal[sub] = row
    return pal


def backdrop(d, index):
    """The BG3 scenery for a hole: (tile page, 32x32 tilemap words, its 32 colours).

    Selected by course rather than hole. The hole index is `course * 8 +
    hole` (`sub_set_hole_index $82:B0A4`), so the backdrop slot is
    `(index // 8) & 7`.
    """
    slot = (index // 8) & 7

    def pair(table):
        off = snes_to_file(*table) + 4 * slot
        bank = int.from_bytes(d[off:off + 2], "little") & 0xFF
        addr = int.from_bytes(d[off + 2:off + 4], "little")
        return bank, addr

    tiles, _ = decompress(d, snes_to_file(*pair(BACKDROP_TILES)))
    tmap, _ = decompress(d, snes_to_file(*pair(BACKDROP_MAP)))

    page = bytearray(512 * TILE_BYTES2)

    def place(blob, vram_word, size):
        start = (vram_word - BG3_CHAR_BASE) // 8 * TILE_BYTES2
        n = min(size, len(blob), len(page) - start)
        page[start:start + n] = blob[:n]

    for src, vram_word, size in BG3_SOURCES:
        blob, _ = decompress(d, snes_to_file(*src))
        place(blob, vram_word, size)
    place(tiles, BG3_BACKDROP_VRAM, len(tiles))

    # BG3's eight 4-colour palettes are CGRAM 0-31: the scenery's 20 colours
    # and the HUD's 12 (hole_cgram).
    colours = [snes_color(w) for w in hole_cgram(d, index)[:32]]
    return bytes(page), words(tmap), colours


def unpack(d, index, fields=None):
    """Return (map_w, map_h, bg1, bg2, rows).

    bg1/bg2 are row-major lists of map_w*map_h tilemap words, EMPTY where the
    hole stores nothing. `rows` is the (left, right, offset) directory.
    """
    if fields is None:
        _, fields, _, _ = header(d, index)
    map_w, map_h = fields[W_MAPW], fields[W_MAPH]
    left = words(table(d, index, T_LEFT))
    right = words(table(d, index, T_RIGHT))
    offset = words(table(d, index, T_OFFSET))
    bg1 = words(table(d, index, T_BG1))
    bg2 = words(table(d, index, T_BG2))

    grid1 = [EMPTY] * (map_w * map_h)
    grid2 = [EMPTY] * (map_w * map_h)
    rows = []
    for r in range(map_h):
        l, rt, o = left[r], right[r], offset[r]
        rows.append((l, rt, o))
        # The engine's own guard: a row whose ends are equal is not drawn.
        if l == rt or l == EMPTY:
            continue
        base = r * map_w
        for c in range(l, rt + 1):
            src = o + c - l
            if src < len(bg1):
                grid1[base + c] = bg1[src]
            if src < len(bg2):
                grid2[base + c] = bg2[src]
    return map_w, map_h, grid1, grid2, rows


def check(d, index, fields, name):
    """Assertions that the row directory really describes tables 8 and 9."""
    map_w, map_h = fields[W_MAPW], fields[W_MAPH]
    left = words(table(d, index, T_LEFT))
    right = words(table(d, index, T_RIGHT))
    offset = words(table(d, index, T_OFFSET))
    n1 = len(table(d, index, T_BG1)) // 2
    n2 = len(table(d, index, T_BG2)) // 2
    problems = []
    if not (len(left) == len(right) == len(offset) == map_h):
        problems.append("directory lengths {}/{}/{} != word5 {}".format(
            len(left), len(right), len(offset), map_h))
    if fields[W_AREA] != map_w * map_h:
        problems.append("word3 {} != word4*word5 {}".format(
            fields[W_AREA], map_w * map_h))
    acc = 0
    widest = 0
    for l, r, o in zip(left, right, offset):
        if l == EMPTY:
            continue
        if o != acc:
            problems.append("row offset {} != running total {}".format(o, acc))
            break
        acc += r - l + 1
        widest = max(widest, r + 1)
    if acc != n1 or acc != n2:
        problems.append("span total {} != table8 {} / table9 {}".format(acc, n1, n2))
    if widest > map_w:
        problems.append("rightmost column {} exceeds word4 {}".format(widest, map_w))
    return problems


def blit(img, pal, tiles, word_, y, x, bpp_pal_shift=0):
    """Draw one tilemap cell, treating colour 0 as transparent."""
    import numpy as np
    idx = word_ & 0x3FF
    if idx >= len(tiles):
        return
    rows = tiles[idx]
    if (word_ >> 14) & 1:
        rows = [row[::-1] for row in rows]
    if (word_ >> 15) & 1:
        rows = rows[::-1]
    cell = np.array(rows, dtype=np.uint8)
    view = img[y:y + 8, x:x + 8]
    if view.shape[0] != 8 or view.shape[1] != 8:
        return
    mask = cell != 0
    view[mask] = pal[((word_ >> 10) & 7) + bpp_pal_shift][cell[mask]]


def render(map_w, map_h, grid1, grid2, tiles, palettes, back_colour,
           bg3=None):
    """Compose the layers the way mode 1 stacks them, back to front.

    BGMODE is `$09`: mode 1 with the BG3 priority bit set. So the order is
    BG3 (no priority), BG2, BG1, then any BG3 tile whose priority bit is set
    in front of everything. BG3 is 2bpp with a 32x32 map, so it repeats.
    """
    import numpy as np
    from PIL import Image

    img = np.zeros((map_h * 8, map_w * 8, 3), dtype=np.uint8)
    img[:, :] = back_colour
    pal = np.array(palettes, dtype=np.uint8)          # (16, 16, 3)
    if bg3 is not None and len(bg3) > 2:
        cols = bg3[2]
        pal2 = np.array([[cols[g * 4 + c] for c in range(4)]
                         for g in range(8)], dtype=np.uint8)
    else:
        pal2 = np.array([[palettes[i // 4][(i % 4) * 4 + c] for c in range(4)]
                         for i in range(8)], dtype=np.uint8)

    def draw_bg3(want):
        if bg3 is None:
            return
        page, tmap = bg3[0], bg3[1]
        cells = decode_tiles(page, 2)
        for ty in range(0, map_h, BG3_MAP_TILES):
            for tx in range(0, map_w, BG3_MAP_TILES):
                for i, w in enumerate(tmap[:BG3_MAP_TILES * BG3_MAP_TILES]):
                    if ((w >> 13) & 1) != want:
                        continue
                    cy, cx = divmod(i, BG3_MAP_TILES)
                    blit(img, pal2, cells, w, (ty + cy) * 8, (tx + cx) * 8)

    draw_bg3(0)
    # Mode 1 order: BG2 priority 0, BG1 priority 0, BG2 priority 1, BG1 pri 1.
    for grid, want in ((grid2, 0), (grid1, 0), (grid2, 1), (grid1, 1)):
        for i, w in enumerate(grid):
            if w == EMPTY or ((w >> 13) & 1) != want:
                continue
            y, x = divmod(i, map_w)
            blit(img, pal, tiles, w, y * 8, x * 8)
    draw_bg3(1)
    return Image.fromarray(img)


def write_grid(path, grid):
    with open(path, "wb") as f:
        f.write(b"".join(w.to_bytes(2, "little") for w in grid))


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/courses")
    ap.add_argument("--index", type=int, help="only this hole index")
    ap.add_argument("--check", action="store_true",
                    help="verify the row directory against tables 8/9, write nothing")
    ap.add_argument("--no-layers", action="store_true",
                    help="skip the separate bg1/bg2 PNGs")
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument("--no-backdrop", action="store_true",
                    help="omit the BG3 per-course scenery")
    args = ap.parse_args()

    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    defaults = default_entries(d)
    indices = [args.index] if args.index is not None else [
        i for i in range(ENTRIES) if entry(d, 0, i) != defaults[0]]

    if args.check:
        bad = 0
        for i in indices:
            _, fields, name, _ = header(d, i)
            try:
                problems = check(d, i, fields, name)
            except CompressionError as e:
                problems = ["decompression failed: {}".format(e)]
            if problems:
                bad += 1
                print("hole {:3d} {}: {}".format(i, name, "; ".join(problems)))
        print("{}/{} holes consistent".format(len(indices) - bad, len(indices)))
        return 1 if bad else 0

    try:
        page = course_page(d)
    except (CompressionError, ValueError) as e:
        print("error: course tile page: {}".format(e), file=sys.stderr)
        return 1
    print("tile page {} tiles from {} + {}; palette {}".format(
        len(page) // TILE_BYTES4, fmt_snes(*GFX_LOW), fmt_snes(*GFX_HIGH), fmt_snes(*PALETTE)))

    worst = 0
    for i in indices:
        _, fields, name, _ = header(d, i)
        hole_dir = os.path.join(args.out, "{:03d}_{}".format(i, name or "noname"))
        if not os.path.isdir(hole_dir):
            os.makedirs(hole_dir)
        map_w, map_h, g1, g2, rows = unpack(d, i, fields)
        bg3 = None if args.no_backdrop else backdrop(d, i)
        # The water holes replace tiles $180-$1AB and palette 4's colours 1-7.
        tiles = decode_tiles(hole_page(d, i), 4)
        palettes = hole_palette(d, i)
        back_colour = palettes[0][0]
        used = [w & 0x3FF for w in g1 + g2 if w != EMPTY]
        top = max(used) if used else 0
        worst = max(worst, top)
        missing = sum(1 for t in used if t >= len(tiles))

        write_grid(os.path.join(hole_dir, "bg1.bin"), g1)
        write_grid(os.path.join(hole_dir, "bg2.bin"), g2)
        with open(os.path.join(hole_dir, "map.json"), "w") as f:
            json.dump({
                "index": i, "name": name, "header": fields,
                "grid_width": fields[W_WIDTH], "grid_height": fields[W_HEIGHT],
                "map_width_tiles": map_w, "map_height_tiles": map_h,
                "rows": [{"left": l, "right": r, "offset": o}
                         for l, r, o in rows],
                "stored_tiles": len(used) // 2, "max_tile": top,
            }, f, indent=1)

        img = render(map_w, map_h, g1, g2, tiles, palettes, back_colour, bg3)
        if args.scale != 1:
            from PIL import Image
            resample = getattr(Image, "Resampling", Image).NEAREST
            img = img.resize((img.width * args.scale, img.height * args.scale), resample)
        img.save(os.path.join(hole_dir, "render.png"))
        if not args.no_layers:
            blank = [EMPTY] * (map_w * map_h)
            render(map_w, map_h, g1, blank, tiles, palettes, back_colour).save(
                os.path.join(hole_dir, "bg1.png"))
            render(map_w, map_h, blank, g2, tiles, palettes, back_colour).save(
                os.path.join(hole_dir, "bg2.png"))
        print("{:3d} {:12s} {:3d}x{:3d} tiles, {:5d} stored, max tile ${:03X}{}{}".format(
            i, name, map_w, map_h, len(used) // 2, top,
            ", {} MISSING".format(missing) if missing else "",
            ", water" if surface_kind(d, i) == "water" else ""))

    print("{} holes rendered; highest tile index ${:03X} of {} in the page".format(
        len(indices), worst, len(page) // TILE_BYTES4))
    return 0


if __name__ == "__main__":
    sys.exit(main())
