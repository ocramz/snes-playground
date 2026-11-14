#!/usr/bin/env python3
"""Decode a hole's playfield: terrain shape, elevation, gaps.

Course grid layer 1 is a terrain *shape* id and layer 3 is elevation. Both
are read by `sub_terrain_probe` at $81:9479, which turns a world position
into a cell and evaluates the surface height there. This script implements
the same function from the same ROM tables, so what it prints is what the
engine computes rather than a re-derivation.

    $81:9310  tbl_terrain_edge_h    28*4 bytes, surface at each cell edge
    $81:9D81  tbl_terrain_quad      28*4 words, shape code per quadrant
    $81:9569  tbl_terrain_quad_diag 28*4 words, quadrant table for $10-$1B
    $81:9629  tbl_terrain_diag_bias 28 words, Z bias for $10-$1B
    $88:8000  tbl_height_z_lo       Z(h) = h * $5A82, low words
    $88:80C8  tbl_height_z_hi       ... high words
    $88:8190  tbl_slope_ramp        1024-entry linear ramp, 0 .. 2*$5A82

Usage:

Grid layer 2 is the special-tile layer -- hazards, friction changes, boost
panels, enemies. Its byte is a jump-table index into $81:8136; `--tiles`
dumps that mapping. See docs/tiles.md.

    python3 tools/terrain.py --index 0            # terrain + height grids
    python3 tools/terrain.py --index 56 --legend  # ... with a shape legend
    python3 tools/terrain.py --tables             # the ROM shape tables
    python3 tools/terrain.py --tiles              # the special-tile dispatch
    python3 tools/terrain.py --stats              # cross-check code vs data
    python3 tools/terrain.py --probe 0 5 3        # surface Z at a cell
    python3 tools/terrain.py --index 0 --png -o build/courses/000.png
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from courses import ENTRIES, entry, default_entries, header  # noqa: E402
from halcomp import CompressionError, decompress  # noqa: E402
from lorom import snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

TERRAIN_COUNT = 28
Z_UNIT = 0x5A82          # one height step in the engine's 16.16 world Z

# Edge order in tbl_terrain_edge_h and quadrant order in tbl_terrain_quad are
# the same and are N, E, S, W. Established from the quadrant split at
# $81:9479 (x+y<1 and x>=y -> 0, x+y>=1 and x>=y -> 1, ...) and confirmed by
# the movement code's `EOR #$0002` for "opposite direction".
DIRS = {"N": (0, -1), "E": (1, 0), "S": (0, 1), "W": (-1, 0),
        "NE": (1, -1), "SE": (1, 1), "SW": (-1, 1), "NW": (-1, -1)}
EDGE_NAMES = ("N", "E", "S", "W")

# Shape codes stored in tbl_terrain_quad, and what $81:952A / $81:9583 do
# with each. `x` and `y` are the sub-cell fractions, 0.0 .. 1.0.
SHAPE_SURFACE = {
    0: "flat, top of cell",
    1: "ramp, rises with +y",
    2: "ramp, rises with -x",
    3: "ramp, rises with -y",
    4: "ramp, rises with +x",
    5: "diagonal ramp, rises with (1-x)+y",
    6: "diagonal ramp, rises with (1-x)+(1-y)",
    7: "diagonal ramp, rises with x+(1-y)",
    8: "diagonal ramp, rises with x+y",
}

# Family names. The geometry below is read from ROM; only these labels are
# editorial. $04-$0F build their surface from axis-aligned ramp triangles;
# $10-$1B use the true-diagonal handlers at $81:9583.
FAMILIES = [
    (0x00, 0x00, "gap"),
    (0x01, 0x01, "flat"),
    (0x02, 0x02, "mound"),
    (0x03, 0x03, "dimple"),
    (0x04, 0x07, "ramp"),
    (0x08, 0x0B, "faceted diagonal, upper half"),
    (0x0C, 0x0F, "faceted diagonal, lower half"),
    (0x10, 0x13, "diagonal, upper half"),
    (0x14, 0x17, "diagonal, lower half"),
    (0x18, 0x1B, "diagonal ramp, full cell"),
]


def family(t):
    for lo, hi, name in FAMILIES:
        if lo <= t <= hi:
            return name
    return "?"


# Grid layer 2 is the special-tile layer. $81:811B dispatches on the byte
# through a 256-entry table of 3-byte long pointers at $81:8136 when the ball
# lands on the cell; $81:8436 does the same through $81:8451 when it hits the
# cell from the side. Both tables group the values identically.
TILE_DISPATCH_LAND = (0x81, 0x8136)
TILE_DISPATCH_HIT = (0x81, 0x8451)

# What each land handler does. The grouping is read from ROM, so only these
# descriptions are editorial; "?" marks a group whose purpose is not
# established. Written as (description, confidence).
TILE_HANDLERS = {
    (0x81, 0x8905): ("no tile behaviour (default)", "solid"),
    (0x81, 0x88F9): ("empty cell", "solid"),
    (0x82, 0x8967): ("spawns actor $0049 via tbl_tile_actor", "solid"),
    (0x82, 0x98F8): ("hazard: calls $83:ABC5, the out-of-bounds routine", "solid"),
    (0x82, 0x9653): ("hazard: calls $83:ABC5", "solid"),
    (0x82, 0x9858): ("hazard: calls $83:ABC5", "solid"),
    (0x82, 0xA55E): ("hazard: calls $83:ABC5, snaps Z, zeroes vz", "solid"),
    (0x82, 0x86B9): ("hazard: calls $83:ABC5 after restoring the last position",
                     "solid"),
    (0x82, 0x8F77): ("friction override: rewrites $DA3A/$DA3C/$DA3E", "solid"),
    (0x82, 0x8EFB): ("friction override, second variant", "solid"),
    (0x82, 0x9DB3): ("boost panel: vy += $82:9CB7 (-512), toward N", "solid"),
    (0x82, 0x9DD7): ("boost panel: vx += $82:9CB5 (+512), toward E", "solid"),
    (0x82, 0x9DFB): ("boost panel: vy += $82:9CB5 (+512), toward S", "solid"),
    (0x82, 0x9E1F): ("boost panel: vx += $82:9CB7 (-512), toward W", "solid"),
    (0x82, 0xA7DD): ("kicker: turns landing vz into a directional impulse",
                     "solid"),
    (0x82, 0xA5B1): ("snaps Z to the surface and zeroes vz", "solid"),
    (0x82, 0xA6C7): ("arrow panel N/S ($14 N, $16 S): turns the velocity to the arrow, same speed",
                     "solid"),
    (0x82, 0xA70B): ("arrow panel E/W ($15 E, $17 W): turns the velocity to the arrow, same speed",
                     "solid"),
    (0x82, 0x8FF1): ("edge: falls through to $81:899F, keep applying gravity",
                     "likely"),
    (0x82, 0x80F6): ("surface overlay; tracks entering and leaving in $69CA+",
                     "mechanics only"),
    (0x82, 0x94D3): ("solid object standing 3 height steps tall", "solid"),
    (0x82, 0xAD8E): ("the cup: holes the ball (docs/physics.md); placed at run time, so in no course data",
                     "solid"),
}
for _a in (0x9FE3, 0x9FD1, 0x9FDA):
    TILE_HANDLERS[(0x82, _a)] = ("toggled impulse ($6A2A), magnitude $80:DDEF",
                                 "mechanics only")
for _a in (0x9FFF, 0x9FED, 0x9FF6):
    TILE_HANDLERS[(0x82, _a)] = ("toggled impulse ($6A2A), magnitude $80:DDF3",
                                 "mechanics only")
for _a in (0xA01A, 0xA008, 0xA011, 0xA035, 0xA023, 0xA02C):
    TILE_HANDLERS[(0x82, _a)] = ("toggled impulse ($6A2A)", "mechanics only")
for _a in (0xA980, 0xA25D, 0xA1B1, 0xA3EB, 0x9342, 0x938E):
    TILE_HANDLERS.setdefault((0x82, _a), ("?", "unknown"))

# Values the engine finds by scanning the whole grid at load rather than by
# dispatch. $82:ACBF looks for the first $0C or $C3 and records its column,
# row and elevation+1 -- the one marked cell every hole has.
TILE_SCANNED = {0x0C: "the single marked cell per hole, found by $82:ACBF",
                0xC3: "alternate marker accepted by the same scan (unused)"}


def tile_table(d, which):
    """The 256 long pointers of one tile dispatch table."""
    bank, addr = which
    o = snes_to_file(bank, addr)
    return [(d[o + 3 * i + 2], int.from_bytes(d[o + 3 * i:o + 3 * i + 2],
                                              "little")) for i in range(256)]


def runs(ids):
    out, s, p = [], ids[0], ids[0]
    for x in ids[1:]:
        if x == p + 1:
            p = x
            continue
        out.append((s, p))
        s = p = x
    out.append((s, p))
    return " ".join("${:02X}".format(a) if a == b else "${:02X}-${:02X}".format(a, b)
                    for a, b in out)


class Tables(object):
    """The engine's terrain tables, read straight out of the ROM."""

    def __init__(self, d):
        def words(bank, addr, n):
            o = snes_to_file(bank, addr)
            return [int.from_bytes(d[o + 2 * i:o + 2 * i + 2], "little")
                    for i in range(n)]
        o = snes_to_file(0x81, 0x9310)
        self.edge = list(d[o:o + TERRAIN_COUNT * 4])
        self.quad = words(0x81, 0x9D81, TERRAIN_COUNT * 4)
        self.quad_diag = words(0x81, 0x9569, TERRAIN_COUNT * 4)
        self.diag_bias = words(0x81, 0x9629, TERRAIN_COUNT)
        self.z_lo = words(0x88, 0x8000, 100)
        self.z_hi = words(0x88, 0x80C8, 100)
        self.ramp = words(0x88, 0x8190, 1024)

    def edges(self, t):
        """Surface level at the four edge midpoints, in half height units."""
        return self.edge[t * 4:t * 4 + 4]

    def shapes(self, t):
        return self.quad[t * 4:t * 4 + 4]

    def fall(self, t):
        """Downhill direction, derived from the edge levels.

        A single lowest edge is an axis-aligned fall line; two adjacent edges
        tied at the minimum is a diagonal one; all four equal means the cell
        has no fall line (flat, or a mound/dimple whose slope is interior).
        """
        e = self.edges(t)
        if t == 0:
            return None
        lo = min(e)
        low = [EDGE_NAMES[i] for i in range(4) if e[i] == lo]
        if len(low) == 1:
            return low[0]
        if len(low) == 2:
            for a, b in (("N", "E"), ("E", "S"), ("S", "W"), ("W", "N")):
                if set(low) == set((a, b)):
                    return a + b if a + b in DIRS else b + a
        return None

    def base_z(self, h):
        return (self.z_hi[h] << 16) | self.z_lo[h]

    def surface_z(self, t, h, xfrac, yfrac):
        """Surface Z at a sub-cell position, as $81:9479 computes it.

        `xfrac` and `yfrac` are the 16-bit fractions the engine keeps in
        $7E:D9F0 / $7E:D9F4. Returns the 32-bit world Z of the ground.
        """
        if t == 0:
            return 0                                     # $81:94DA
        q = quadrant(xfrac, yfrac)
        base = self.base_z(h)
        if t & 0x10:                                     # $81:9573
            v = self.quad_diag[t * 4 + q]
            if v != 0xFFFF:
                return base + v
            code = self.quad[t * 4 + q]
            acc = {5: (0xFFFF - xfrac) + yfrac,
                   6: (0xFFFF - xfrac) + (0xFFFF - yfrac),
                   7: xfrac + (0xFFFF - yfrac),
                   8: xfrac + yfrac}[code]
            return base + self.ramp[(acc >> 7) & 0x3FF] - self.diag_bias[t]
        code = self.quad[t * 4 + q]                      # $81:951B
        if code == 0:
            return base + Z_UNIT                         # $81:9534
        acc = {1: yfrac, 2: 0xFFFF - xfrac,
               3: 0xFFFF - yfrac, 4: xfrac}[code]
        return base + self.ramp[acc >> 7]


def quadrant(xfrac, yfrac):
    """Which of the cell's four triangles a point is in. $81:9479."""
    if xfrac + yfrac >= 0x10000:
        return 1 if xfrac >= yfrac else 2
    return 0 if xfrac >= yfrac else 3


def load_hole(d, defaults, index):
    """Header fields, name, and grid layers 1-4 for one hole."""
    _, fields, name, _ = header(d, index)
    layers = {}
    for t in (1, 2, 3, 4):
        bank, addr = entry(d, t, index)
        try:
            layers[t], _ = decompress(d, snes_to_file(bank, addr))
        except CompressionError:
            return None
    w, h = fields[1], fields[2]
    if not w or not h or len(layers[1]) < w * h or len(layers[3]) < w * h:
        return None
    return fields, name, w, h, layers


def populated(d, defaults):
    return [i for i in range(ENTRIES) if entry(d, 0, i) != defaults[0]]


def print_grid(title, cells, w, h):
    print("-- {}".format(title))
    for y in range(h):
        row = []
        for x in range(w):
            v = cells[y * w + x]
            row.append("{:02X}".format(v) if v else " .")
        print("   " + " ".join(row))


def cmd_index(d, defaults, args):
    got = load_hole(d, defaults, args.index)
    if got is None:
        print("error: hole {} has no usable grids".format(args.index),
              file=sys.stderr)
        return 1
    fields, name, w, h, layers = got
    tab = Tables(d)
    print("hole {} {!r}  {}x{}  header {}".format(
        args.index, name, w, h, " ".join("{:04X}".format(f) for f in fields)))
    print_grid("layer 1: terrain shape ($7E:6B90)", layers[1], w, h)
    print_grid("layer 3: elevation ($7E:7390)", layers[3], w, h)
    if args.all_layers:
        print_grid("layer 2: content ($7E:8390)", layers[2], w, h)
        print_grid("layer 4: edge walls, low nibble ($7E:7B90)", layers[4], w, h)
    if args.legend:
        used = sorted(set(layers[1][:w * h]) - set([0]))
        print("-- shapes used")
        for t in used:
            if t >= TERRAIN_COUNT:
                print("   ${:02X}  out of range, not a known shape".format(t))
                continue
            f = tab.fall(t)
            print("   ${:02X}  {:<32} edges {}  falls {}".format(
                t, family(t),
                " ".join(str(x) for x in tab.edges(t)), f or "-"))
        land = tile_table(d, TILE_DISPATCH_LAND)
        used2 = sorted(set(layers[2][:w * h]) - set([0]))
        if used2:
            print("-- special tiles used (layer 2)")
            for v in used2:
                if v in TILE_SCANNED:
                    print("   ${:02X}  {}".format(v, TILE_SCANNED[v]))
                    continue
                desc, conf = TILE_HANDLERS.get(land[v], ("?", "unknown"))
                print("   ${:02X}  ${:02X}:{:04X}  {} [{}]".format(
                    v, land[v][0], land[v][1], desc, conf))
    if args.png:
        render_png(layers, w, h, tab, args.out or
                   "build/courses/{:03d}_terrain.png".format(args.index))
    return 0


def render_png(layers, w, h, tab, path):
    from PIL import Image, ImageDraw
    scale = 24
    img = Image.new("RGB", (w * scale, h * scale), (12, 12, 16))
    dr = ImageDraw.Draw(img)
    for i in range(w * h):
        t, z = layers[1][i], layers[3][i]
        x, y = (i % w) * scale, (i // w) * scale
        if not t:
            continue
        # Colour by elevation so the shape of the terrain reads at a glance.
        g = 40 + min(z, 15) * 13
        dr.rectangle([x, y, x + scale - 1, y + scale - 1],
                     fill=(g, g // 2 + 30, 150 - g // 3), outline=(0, 0, 0))
        f = tab.fall(t) if t < TERRAIN_COUNT else None
        dr.text((x + 2, y + 2), "{:X}".format(z), fill=(255, 255, 255))
        if f:
            dr.text((x + 2, y + 12), f, fill=(255, 220, 120))
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    img.save(path)
    print("wrote {}".format(path))


def cmd_tables(d, args):
    tab = Tables(d)
    print("Terrain shapes, read from $81:9310 and $81:9D81.")
    print("Edge levels are half height units at the N/E/S/W edge midpoints;")
    print("quadrant codes index the surface handlers at $81:952A / $81:9583.")
    print()
    print("   t   edges NESW   quadrants   falls   family")
    for t in range(TERRAIN_COUNT):
        f = tab.fall(t)
        print("  ${:02X}   {}      {}     {:<5}   {}".format(
            t, " ".join(str(x) for x in tab.edges(t)),
            " ".join(str(x) for x in tab.shapes(t)), f or "-", family(t)))
    print()
    print("Surface handlers (quadrant code -> what the engine evaluates):")
    for code in sorted(SHAPE_SURFACE):
        print("  {}  {}".format(code, SHAPE_SURFACE[code]))
    print()
    print("Elevation scale: one height step = $%04X (%d) in 16.16 world Z."
          % (Z_UNIT, Z_UNIT))
    print("  $88:8000/$88:80C8: Z(h) = h * $%04X, checked h=0..99: %s"
          % (Z_UNIT, all(tab.base_z(h) == h * Z_UNIT for h in range(100))))
    print("  $88:8190: %d entries, %d .. %d; 511 -> %d (~1 step), "
          "1023 -> %d (~2 steps)"
          % (len(tab.ramp), tab.ramp[0], tab.ramp[-1],
             tab.ramp[511], tab.ramp[1023]))
    print("  A flat cell of height h has its top surface at (h+1) steps.")
    return 0


def cmd_tiles(d, defaults, args):
    import collections
    land = tile_table(d, TILE_DISPATCH_LAND)
    hit = tile_table(d, TILE_DISPATCH_HIT)

    # How often each value actually occurs.
    slots = tile_slots(d, defaults)
    used = collections.Counter()
    incourse = collections.defaultdict(set)
    for i, name, w, h, layers in slots:
        for v in layers[2][:w * h]:
            if v:
                used[v] += 1
                incourse[v].add(i)

    groups = collections.OrderedDict()
    for v, t in enumerate(land):
        groups.setdefault(t, []).append(v)
    print("Grid layer 2 is the special-tile layer. On landing, $81:811B")
    print("dispatches the cell's byte through {} long pointers at $81:8136;".format(
        len(land)))
    print("on a side hit, $81:8436 uses the matching table at $81:8451.")
    print("Both group the 256 values identically.")
    print()
    print("Counted over {} hole slots with a full-size layer 2 "
          "({} non-zero cells).".format(
              len(slots), sum(used.values())))
    print()
    print("  on-land   on-hit    cells  holes  what it does")
    for t in sorted(groups, key=lambda k: -len(groups[k])):
        vals = groups[t]
        n = sum(used[v] for v in vals)
        cs = set()
        for v in vals:
            cs |= incourse[v]
        desc, conf = TILE_HANDLERS.get(t, ("?", "unknown"))
        hts = sorted(set(hit[v] for v in vals))
        ht = "/".join("{:04X}".format(a) for b, a in hts)
        print("  {:02X}:{:04X}  {:<9} {:5d} {:5d}   {} [{}]".format(
            t[0], t[1], ht, n, len(cs), desc, conf))
        print("            values {}".format(runs(vals)))
    print()
    print("Found by scanning rather than dispatch:")
    for v in sorted(TILE_SCANNED):
        print("  ${:02X}  {:5d} cells in {:3d} courses   {}".format(
            v, used[v], len(incourse[v]), TILE_SCANNED[v]))
    return 0


def tile_slots(d, defaults):
    """Every hole slot with a full-size layer 2.

    The 232 populated slots are 116 terrain geometries, each stored twice at
    `i` and `i+64`. Layers 1, 3 and 4 are byte-identical between the pair;
    only layer 2 differs, so both slots are distinct tile layouts and both
    count here. The 20 `MAPC0`-`MAPE3` second copies carry a 16-byte stub
    layer 2 instead of a grid and are skipped, leaving 212.
    """
    out = []
    for i in populated(d, defaults):
        got = load_hole(d, defaults, i)
        if got is None:
            continue
        fields, name, w, h, layers = got
        if len(layers[2]) < w * h:
            continue
        out.append((i, name, w, h, layers))
    return out


def cmd_probe(d, defaults, args):
    got = load_hole(d, defaults, args.probe[0])
    if got is None:
        print("error: hole has no usable grids", file=sys.stderr)
        return 1
    _, name, w, h, layers = got
    tab = Tables(d)
    cx, cy = args.probe[1], args.probe[2]
    if not (0 <= cx < w and 0 <= cy < h):
        print("cell ({}, {}) is outside the {}x{} grid -> off the course"
              .format(cx, cy, w, h))
        return 0
    i = cy * w + cx
    t, z = layers[1][i], layers[3][i]
    print("hole {} {!r} cell ({}, {}) index {}".format(
        args.probe[0], name, cx, cy, i))
    print("  terrain ${:02X} ({}), elevation ${:02X}".format(t, family(t), z))
    if not t:
        print("  gap: the probe reports ground Z = 0 and nothing stops a ball")
        return 0
    print("  surface Z across the cell (fraction of a cell -> Z, in steps):")
    for yf in (0x0000, 0x8000, 0xFFFF):
        row = []
        for xf in (0x0000, 0x8000, 0xFFFF):
            row.append("%6.3f" % (tab.surface_z(t, z, xf, yf) / float(Z_UNIT)))
        print("    y={:.1f}  {}".format(yf / 65535.0, "  ".join(row)))
    print("    (columns x=0.0, 0.5, 1.0)")
    return 0


def components(l1, w, h):
    """Connected components of the solid region, 4-connected."""
    seen = set()
    sizes = []
    for i in range(w * h):
        if not l1[i] or i in seen:
            continue
        stack, size = [i], 0
        seen.add(i)
        while stack:
            c = stack.pop()
            size += 1
            cx, cy = c % w, c // w
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = cx + dx, cy + dy
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if l1[j] and j not in seen:
                        seen.add(j)
                        stack.append(j)
        sizes.append(size)
    return sorted(sizes, reverse=True)


def tile_meaning(d, byte, land_table):
    """What the engine does when a ball lands on this layer-2 value."""
    if byte in TILE_SCANNED:
        return TILE_SCANNED[byte], "solid"
    target = land_table[byte]
    return TILE_HANDLERS.get(target, ("?", "unknown"))


def cmd_export(d, defaults, args):
    """Per-hole machine-readable geometry: shape, elevation, walls, tiles.

    Everything here is computed from the engine's own tables, so the surface
    corners are the values `sub_terrain_probe` would return, not a model of
    them. Cells where layer 1 is $00 are gaps: the probe returns ground
    Z = 0 there and nothing stops a ball, which is why they are flagged
    rather than given a height.
    """
    import json

    tab = Tables(d)
    land = tile_table(d, TILE_DISPATCH_LAND)
    actor_off = snes_to_file(0x82, 0xBDBC)
    actors = [int.from_bytes(d[actor_off + 2 * i:actor_off + 2 * i + 2], "little")
              for i in range(256)]

    indices = [args.index] if args.index is not None else populated(d, defaults)
    if not os.path.isdir(args.out_dir):
        os.makedirs(args.out_dir)

    rows = []
    corners = ((0x0000, 0x0000), (0xFFFF, 0x0000), (0xFFFF, 0xFFFF), (0x0000, 0xFFFF))
    for i in indices:
        got = load_hole(d, defaults, i)
        if got is None:
            print("hole {}: no usable grids, skipped".format(i), file=sys.stderr)
            continue
        fields, name, w, h, layers = got
        l1, l2, l3, l4 = layers[1], layers[2], layers[3], layers[4]
        has_tiles = len(l2) >= w * h

        # Island ids, so a cell can name the component it belongs to.
        comp_id = {}
        for cid, start in enumerate(sorted(
                (j for j in range(w * h) if l1[j]), key=lambda j: j)):
            if start in comp_id:
                continue
            stack = [start]
            comp_id[start] = cid
            while stack:
                c = stack.pop()
                cx, cy = c % w, c // w
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if l1[j] and j not in comp_id:
                            comp_id[j] = cid
                            stack.append(j)
        # Renumber the components densely in first-appearance order.
        order, remap = [], {}
        for j in range(w * h):
            if j in comp_id and comp_id[j] not in remap:
                remap[comp_id[j]] = len(order)
                order.append(comp_id[j])

        cells, marked = [], None
        for j in range(w * h):
            shape, elev, flags = l1[j], l3[j], l4[j]
            tile = l2[j] if has_tiles else 0
            cell = {
                "x": j % w, "y": j // w,
                "shape": shape, "family": family(shape),
                "fall": tab.fall(shape) if shape else None,
                "elevation": elev,
                "gap": shape == 0,
                "walls": {EDGE_NAMES[b]: bool(flags & (1 << b)) for b in range(4)},
                "wall_high_nibble": flags >> 4,
                "island": remap[comp_id[j]] if j in comp_id else None,
            }
            if shape:
                cell["surface_corners"] = [
                    tab.surface_z(shape, elev, xf, yf) for xf, yf in corners]
                cell["surface_steps"] = [
                    round(z / float(Z_UNIT), 4) for z in cell["surface_corners"]]
            if has_tiles:
                meaning, conf = tile_meaning(d, tile, land)
                cell["tile"] = tile
                cell["tile_meaning"] = meaning
                cell["tile_confidence"] = conf
                cell["actor"] = actors[tile] if actors[tile] != 0xFFFF else None
                if tile in TILE_SCANNED:
                    marked = {"x": j % w, "y": j // w, "value": tile,
                              "elevation": elev}
            cells.append(cell)

        solid = sum(1 for c in cells if not c["gap"])
        sizes = components(l1, w, h)
        hole = {
            "index": i, "name": name, "header": list(fields),
            "width": w, "height": h,
            "cell_count": w * h, "solid_cells": solid, "gap_cells": w * h - solid,
            "max_elevation": max((c["elevation"] for c in cells if not c["gap"]),
                                 default=0),
            "islands": sizes,
            "marked_cell": marked,
            "has_tile_layer": has_tiles,
            "z_unit": Z_UNIT,
            "cells": cells,
        }
        hole_dir = os.path.join(args.out_dir, "{:03d}_{}".format(i, name or "noname"))
        if not os.path.isdir(hole_dir):
            os.makedirs(hole_dir)
        with open(os.path.join(hole_dir, "geometry.json"), "w") as f:
            json.dump(hole, f, indent=1)
        if not args.no_heightmap:
            write_heightmap(hole, os.path.join(hole_dir, "heightmap.png"))
        rows.append((i, name, w, h, solid, hole["max_elevation"], len(sizes),
                     has_tiles, sum(1 for c in cells if c.get("tile"))))

    with open(os.path.join(args.out_dir, "holes.tsv"), "w") as f:
        f.write("index\tname\twidth\theight\tsolid_cells\tmax_elevation"
                "\tislands\thas_tile_layer\tnonzero_tiles\n")
        for r in rows:
            f.write("\t".join(str(x) for x in r) + "\n")
    print("exported {} holes to {}".format(len(rows), args.out_dir))
    return 0


def write_heightmap(hole, path):
    """Sub-cell surface height as a greyscale image, 8 samples per cell.

    Sampling the same surface function the physics uses means ramps appear
    as gradients rather than as flat cells, which is the point: the cell's
    elevation byte is only its base.
    """
    from PIL import Image
    w, h, n = hole["width"], hole["height"], 8
    img = Image.new("L", (w * n, h * n))
    px = img.load()
    tallest = max((max(c["surface_corners"]) for c in hole["cells"]
                   if not c["gap"]), default=1) or 1
    for c in hole["cells"]:
        if c["gap"]:
            continue
        z = c["surface_corners"]
        for sy in range(n):
            for sx in range(n):
                u, v = sx / float(n - 1), sy / float(n - 1)
                # Bilinear over the four corner heights, in corner order
                # NW, NE, SE, SW.
                top = z[0] + (z[1] - z[0]) * u
                bot = z[3] + (z[2] - z[3]) * u
                val = top + (bot - top) * v
                px[c["x"] * n + sx, c["y"] * n + sy] = int(
                    max(0, min(255, 255.0 * val / tallest)))
    img.save(path)


def cmd_stats(d, defaults, args):
    import collections
    tab = Tables(d)
    holes = []
    for i in populated(d, defaults):
        got = load_hole(d, defaults, i)
        if got is not None:
            holes.append((i,) + got)

    # Every hole is stored twice (indices i and i+64). Deduplicate on the
    # grids themselves so the counts below describe distinct courses.
    seen, uniq = set(), []
    for rec in holes:
        n = rec[3] * rec[4]
        key = (bytes(rec[5][1][:n]), bytes(rec[5][3][:n]))
        if key not in seen:
            seen.add(key)
            uniq.append(rec)

    h1 = collections.Counter()
    h3 = collections.Counter()
    cells = 0
    for _, _, _, w, h, layers in uniq:
        h1.update(layers[1][:w * h])
        h3.update(layers[3][:w * h])
        cells += w * h
    # Layers 1, 3 and 4 are duplicated between hole i and i+64; only layer 2
    # differs. Terrain statistics therefore go over distinct geometries.
    print("hole slots populated: {}   distinct geometries: {}   cells: {}".format(
        len(holes), len(uniq), cells))
    print()
    print("layer 1 (terrain shape): {} distinct values, {} .. {}".format(
        len(h1), "${:02X}".format(min(h1)), "${:02X}".format(max(h1))))
    missing = [t for t in range(TERRAIN_COUNT) if t not in h1]
    print("  in range $00-${:02X}: {}    unused by any course: {}".format(
        TERRAIN_COUNT - 1, all(v < TERRAIN_COUNT for v in h1),
        ", ".join("${:02X}".format(t) for t in missing) or "none"))
    print("layer 3 (elevation): {} distinct values, {} .. {}".format(
        len(h3), "${:02X}".format(min(h3)), "${:02X}".format(max(h3))))
    print()

    # The cross-check that matters: the ROM's edge table says which way each
    # shape falls; the course data should show exactly that height step.
    print("fall direction from $81:9310 vs measured height step in the data")
    print("  shape  falls  neighbour delta -1   n      family")
    delta = collections.defaultdict(collections.Counter)
    for _, _, _, w, h, layers in uniq:
        l1, l3 = layers[1], layers[3]
        for y in range(h):
            for x in range(w):
                t = l1[y * w + x]
                if not t or t >= TERRAIN_COUNT:
                    continue
                f = tab.fall(t)
                if f is None:
                    continue
                dx, dy = DIRS[f]
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and l1[ny * w + nx]:
                    delta[t][l3[ny * w + nx] - l3[y * w + x]] += 1
    for t in sorted(delta):
        c = delta[t]
        n = sum(c.values())
        print("   ${:02X}    {:<5}      {:5.1f}%        {:5d}  {}".format(
            t, tab.fall(t), 100.0 * c[-1] / n, n, family(t)))
    print()
    print("$02 (mound) is level with no edge, so it has no fall line; the")
    print("check below is that every neighbour is exactly one step lower.")
    mound = collections.Counter()
    for _, _, _, w, h, layers in uniq:
        l1, l3 = layers[1], layers[3]
        for y in range(h):
            for x in range(w):
                if l1[y * w + x] != 0x02:
                    continue
                for dx, dy in DIRS.values():
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and l1[ny * w + nx]:
                        mound[l3[ny * w + nx] - l3[y * w + x]] += 1
    tot = sum(mound.values())
    print("  $02 neighbours one step lower: {:.1f}% of {}".format(
        100.0 * mound[-1] / tot if tot else 0, tot))
    print()
    print("gaps and islands (layer 1 == $00 is 'no cell here')")
    zero = h1[0]
    print("  empty cells: {} ({:.1f}%)".format(zero, 100.0 * zero / cells))
    comp = collections.Counter()
    multi = []
    for i, _, name, w, h, layers in uniq:
        sizes = components(layers[1], w, h)
        comp[len(sizes)] += 1
        if len(sizes) > 1:
            multi.append((name, sizes))
    print("  islands per course: {}".format(
        ", ".join("{} course(s) with {}".format(n, k)
                  for k, n in sorted(comp.items()))))
    for name, sizes in sorted(multi):
        print("    {:<12} {}".format(name, " + ".join(str(s) for s in sizes)))
    return 0


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--index", type=int, help="show one hole")
    ap.add_argument("--all-layers", action="store_true",
                    help="also print layers 2 and 4")
    ap.add_argument("--legend", action="store_true",
                    help="describe each shape the hole uses")
    ap.add_argument("--tables", action="store_true",
                    help="dump the engine's terrain tables")
    ap.add_argument("--tiles", action="store_true",
                    help="dump the layer-2 special-tile dispatch tables")
    ap.add_argument("--stats", action="store_true",
                    help="cross-check the ROM tables against every course")
    ap.add_argument("--probe", type=int, nargs=3, metavar=("HOLE", "X", "Y"),
                    help="evaluate the surface height over one cell")
    ap.add_argument("--png", action="store_true", help="render to PNG")
    ap.add_argument("-o", "--out", help="PNG path (must be under build/)")
    ap.add_argument("--export", action="store_true",
                    help="write per-hole geometry.json and heightmap.png")
    ap.add_argument("--out-dir", default="build/courses",
                    help="destination for --export")
    ap.add_argument("--no-heightmap", action="store_true",
                    help="skip the heightmap PNGs when exporting")
    args = ap.parse_args()

    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    if args.tables:
        return cmd_tables(d, args)
    defaults = default_entries(d)
    if args.export:
        return cmd_export(d, defaults, args)
    if args.tiles:
        return cmd_tiles(d, defaults, args)
    if args.probe:
        return cmd_probe(d, defaults, args)
    if args.stats:
        return cmd_stats(d, defaults, args)
    if args.index is not None:
        return cmd_index(d, defaults, args)
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
