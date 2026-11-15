#!/usr/bin/env python3
"""Exemplar patches of the course art, for drawing terrain the ROM never drew.

The engine's random holes (engine/src/core/gen, plans/random_holes.md) have
no BG tilemaps of their own. The ROM's course art is regular enough to stand
in for one cell at a time: cells sit exactly on the 8x8 tile grid, every
clean interior flat cell of the 116 geometries is the same block of tiles
$020/$021, all holes share one tile page and palette, and floor markings are
BG2 overlays on a plain BG1 ground (docs/courses.md, measured 2026-11-15).
So this tool composes each hole's BG layers (BG2.0, BG1.0, BG2.1, BG1.1, as
mode 1 stacks them; coursemap.py) and takes, per pixel, the most common
colour over many instances of:

  top   a cell's surface, per terrain shape $01-$1B, from cells whose four
        neighbours are solid and join flush, with no special tile drawn on
        the cell (actors are sprites) and no outline next to it; only the
        cell's own quadrant triangles (and two pixels round them) are kept;
        64 x 64 px, the cell's left
        vertex (at its flat top, elevation + 1) at (0, 32)
  mark  the same per (special tile, shape), for the floor markings, from
        cells with any neighbours (there are fewer of them); no cell with a
        wall is used (the ROM draws a wall as a line on the cell)
  face  the side of a step one height step tall, for the two faces the
        camera sees, E (+x) and N (-y), from flat cells over a drop or a gap:
        the first step under the edge, a middle one and the last one;
        32 x 32 px, the edge's left end at (0, 16) for E and (0, 0) for N

Water holes (their own tiles at $180-$1AB) are left out; boost holes are
kept with the palette's first boost colours. Only the first copy of each
geometry is read (layers 1, 3, 4 and tables 8, 9 repeat at i + 64).

    python3 tools/terrain_style.py                       # build/engine/assets
    python3 tools/terrain_style.py --out build/style --sheet

Writes terrain_style.png (an atlas of the patches) and terrain_style.json:
for each patch its rectangle, the instances it was taken from, and the share
of instances that agree with the chosen colour, averaged over its pixels.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from coursemap import EMPTY, blit, hole_page, hole_palette, surface_kind, unpack  # noqa: E402
from courses import default_entries  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from terrain import Z_UNIT, Tables, load_hole, populated  # noqa: E402
from tiles import decode_tiles  # noqa: E402

SENTINEL = np.array([1, 2, 3], dtype=np.uint8)  # SNES colours are multiples of 8
TOP = 64
FACE = 32
STEP = 16  # one height step on screen
DXY = ((0, -1), (1, 0), (0, 1), (-1, 0))  # N E S W
MARK_TILES = (
    [0x04] + list(range(0x10, 0x1C)) + list(range(0x20, 0x25)) + list(range(0x30, 0x3C))
    + list(range(0xB0, 0xB4))
)
PER_KEY = 400  # instances kept per patch (every k-th, so the sample spans the holes)


def compose(d, index):
    """The hole's BG1 + BG2 as RGB, SENTINEL where nothing is drawn."""
    map_w, map_h, g1, g2, _ = unpack(d, index)
    tiles = decode_tiles(hole_page(d, index), 4)
    pal = np.array(hole_palette(d, index), dtype=np.uint8)
    img = np.empty((map_h * 8, map_w * 8, 3), dtype=np.uint8)
    img[:, :] = SENTINEL
    for grid, want in ((g2, 0), (g1, 0), (g2, 1), (g1, 1)):
        for i, w in enumerate(grid):
            if w == EMPTY or ((w >> 13) & 1) != want:
                continue
            y, x = divmod(i, map_w)
            blit(img, pal, tiles, w, y * 8, x * 8)
    return img


class Hole(object):
    def __init__(self, d, tab, index):
        fields, name, w, h, layers = load_hole(d, None, index)
        self.index, self.name, self.w, self.h = index, name, w, h
        self.word7 = fields[7]
        self.shape = list(layers[1][:w * h])
        self.tile = list(layers[2][:w * h]) if len(layers[2]) >= w * h else [0] * (w * h)
        self.elev = list(layers[3][:w * h])
        self.walls = [v & 0x0F for v in layers[4][:w * h]] if len(layers[4]) >= w * h else [0] * (w * h)
        self.tab = tab
        self.img = compose(d, index)

    def at(self, x, y):
        return y * self.w + x if 0 <= x < self.w and 0 <= y < self.h else -1

    def solid(self, x, y):
        i = self.at(x, y)
        return i >= 0 and self.shape[i] != 0

    def level(self, x, y, side):
        i = self.at(x, y)
        return 2 * self.elev[i] + self.tab.edges(self.shape[i])[side]

    def flush_all_round(self, x, y):
        for side, (dx, dy) in enumerate(DXY):
            if not self.solid(x + dx, y + dy):
                return False
            if self.level(x, y, side) != self.level(x + dx, y + dy, (side + 2) % 4):
                return False
        return True

    def anchor(self, x, y):
        """The cell's left vertex at its flat top (elevation + 1), bitmap pixels."""
        e = self.elev[self.at(x, y)]
        return 32 * (x + y), self.word7 + 16 * (x - y) - 16 * (e + 1)

    def cut(self, x0, y0, w, h):
        if x0 < 0 or y0 < 0 or x0 + w > self.img.shape[1] or y0 + h > self.img.shape[0]:
            return None
        return self.img[y0:y0 + h, x0:x0 + w]


def mode_patch(stack, mask):
    """Per pixel, the commonest colour of the stack (N, H, W, 3) and its share.

    Pixels outside `mask` (H, W) and SENTINEL pixels are transparent.
    """
    n, h, w, _ = stack.shape
    code = (stack[..., 0].astype(np.int32) << 16) | (stack[..., 1].astype(np.int32) << 8) | stack[..., 2]
    colours, inv = np.unique(code, return_inverse=True)
    inv = inv.reshape(n, h, w)
    counts = np.zeros((len(colours), h, w), dtype=np.int32)
    for k in range(len(colours)):
        counts[k] = (inv == k).sum(axis=0)
    best = counts.argmax(axis=0)
    share = counts.max(axis=0) / float(n)
    rgb = colours[best]
    out = np.zeros((h, w, 4), dtype=np.uint8)
    out[..., 0] = (rgb >> 16) & 0xFF
    out[..., 1] = (rgb >> 8) & 0xFF
    out[..., 2] = rgb & 0xFF
    sentinel = (int(SENTINEL[0]) << 16) | (int(SENTINEL[1]) << 8) | int(SENTINEL[2])
    opaque = (rgb != sentinel) & mask
    out[..., 3] = np.where(opaque, 255, 0)
    out[~opaque] = 0
    agree = float(share[opaque].mean()) if opaque.any() else 0.0
    return out, agree


def top_mask(tab, shape):
    """The pixels of a cell's own surface in its patch: its four quadrant
    triangles, projected from the surface Z at their corners (the same
    triangles the engine's renderer fills), anchor (0, 32)."""
    from PIL import ImageDraw
    img = Image.new("L", (TOP, TOP), 0)
    draw = ImageDraw.Draw(img)

    def point(fx, fy, toward=(0.5, 0.5)):
        # sample the plane a hair inside the triangle (the corners belong to two)
        sx = fx + (toward[0] - fx) * 0.02
        sy = fy + (toward[1] - fy) * 0.02
        xf = max(0, min(0xFFFF, int(round(sx * 0x10000))))
        yf = max(0, min(0xFFFF, int(round(sy * 0x10000))))
        z = tab.surface_z(shape, 0, xf, yf) / float(Z_UNIT) - 1
        return (32 * (fx + fy), 32 + 16 * (fx - fy) - 16 * z)

    quads = (((0, 0), (1, 0)), ((1, 0), (1, 1)), ((1, 1), (0, 1)), ((0, 1), (0, 0)))
    for a, b in quads:
        mid = ((a[0] + b[0] + 0.5) / 3, (a[1] + b[1] + 0.5) / 3)
        draw.polygon([point(*a, toward=mid), point(*b, toward=mid), point(0.5, 0.5, toward=mid)], fill=255)
    m = np.array(img) > 0
    # two pixels more all round: the renderer's pixel-centre fill and PIL's
    # polygon disagree on the rim, and the art runs on across flush edges
    for _ in range(2):
        g = m.copy()
        g[1:, :] |= m[:-1, :]
        g[:-1, :] |= m[1:, :]
        g[:, 1:] |= m[:, :-1]
        g[:, :-1] |= m[:, 1:]
        m = g
    return m


def face_mask(face):
    """The band of one step under the edge, in a FACE x FACE box."""
    m = np.zeros((FACE, FACE), dtype=bool)
    for u in range(FACE):
        edge = (16 - u // 2) if face == "E" else u // 2
        m[edge:edge + STEP, u] = True
    return m


def sample(d, holes):
    tops, marks = {}, {}
    faces = {(f, part): [] for f in ("E", "N") for part in ("top", "mid", "bottom")}
    for h in holes:
        for y in range(h.h):
            for x in range(h.w):
                i = h.at(x, y)
                s = h.shape[i]
                if s == 0:
                    continue
                ax, ay = h.anchor(x, y)
                t = h.tile[i]
                around = [h.tile[j] for j in (h.at(x + dx, y + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                                              if (dx or dy)) if j >= 0]
                # the cell's own pixels are all that is kept, so only its own
                # tile matters, its walls (drawn as lines on it) and no
                # outline through a neighbour
                outline = any(0x28 <= a <= 0x2D for a in around)
                patch = h.cut(ax, ay - 32, TOP, TOP)
                if patch is not None and not outline and h.walls[i] == 0:
                    if (t == 0 or 0x40 <= t <= 0x57 or t == 0x0C) and h.flush_all_round(x, y):
                        tops.setdefault(s, []).append(patch)
                    elif t in MARK_TILES:
                        # markings are rarer: any neighbours will do
                        marks.setdefault((t, s), []).append(patch)
                if s != 1 or t != 0:
                    continue
                e = h.elev[i]
                # the E face (+x) and the N face (-y): drops of a whole number of steps, or a gap
                for face, (dx, dy), side in (("E", (1, 0), 1), ("N", (0, -1), 0)):
                    if h.solid(x + dx, y + dy):
                        drop = h.level(x, y, side) - h.level(x + dx, y + dy, (side + 2) % 4)
                        if drop < 2 or drop % 2:
                            continue
                        steps = drop // 2
                    else:
                        steps = e + 1
                    # the box's top-left: E's edge runs from (x+1, y), 16 px below the box's
                    # top, up to (x+1, y+1); N's from (x, y), the box's top, down to (x+1, y)
                    ex, ey = (ax + 32, ay) if face == "E" else (ax, ay)
                    parts = [("top", 0)]
                    if steps >= 3:
                        parts.append(("mid", 1))
                    if steps >= 2:
                        parts.append(("bottom", steps - 1))
                    for part, j in parts:
                        patch = h.cut(ex, ey + STEP * j, FACE, FACE)
                        if patch is not None:
                            faces[(face, part)].append(patch)
    return tops, marks, faces


def thin(items):
    if len(items) <= PER_KEY:
        return items
    k = len(items) / float(PER_KEY)
    return [items[int(i * k)] for i in range(PER_KEY)]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/engine/assets")
    ap.add_argument("--min", type=int, default=3, help="fewest instances a patch is taken from")
    ap.add_argument("--sheet", action="store_true", help="also write terrain_style_sheet.png, 4x, labelled")
    args = ap.parse_args()
    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    tab = Tables(d)
    defaults = default_entries(d)
    indices = [i for i in populated(d, defaults) if i < 64 or 128 <= i < 192]
    holes = []
    for i in indices:
        if surface_kind(d, i) == "water" or load_hole(d, defaults, i) is None:
            continue
        holes.append(Hole(d, tab, i))
    tops, marks, faces = sample(d, holes)

    entries = []  # (group, key, rgba, n, agree)
    for s in sorted(tops):
        if len(tops[s]) >= args.min:
            rgba, agree = mode_patch(np.stack(thin(tops[s])), top_mask(tab, s))
            entries.append(("top", "{:02X}".format(s), rgba, len(tops[s]), agree))
    for (t, s) in sorted(marks):
        # a marking seen once is still the ROM's own picture of it
        if len(marks[(t, s)]) >= 1:
            rgba, agree = mode_patch(np.stack(thin(marks[(t, s)])), top_mask(tab, s))
            entries.append(("mark", "{:02X}_{:02X}".format(t, s), rgba, len(marks[(t, s)]), agree))
    for (face, part) in sorted(faces):
        if len(faces[(face, part)]) >= args.min:
            rgba, agree = mode_patch(np.stack(thin(faces[(face, part)])), face_mask(face))
            entries.append(("face", "{}_{}".format(face, part), rgba, len(faces[(face, part)]), agree))

    # one row of 64 px per entry slot, 16 slots to a row
    cols = 16
    rows = (len(entries) + cols - 1) // cols
    atlas = np.zeros((rows * TOP, cols * TOP, 4), dtype=np.uint8)
    meta = {"top": {}, "mark": {}, "face": {}}
    for k, (group, key, rgba, n, agree) in enumerate(entries):
        r, c = divmod(k, cols)
        h, w = rgba.shape[:2]
        atlas[r * TOP:r * TOP + h, c * TOP:c * TOP + w] = rgba
        meta[group][key] = {"x": c * TOP, "y": r * TOP, "w": w, "h": h, "n": n, "agree": round(agree, 3)}
    os.makedirs(args.out, exist_ok=True)
    Image.fromarray(atlas, "RGBA").save(os.path.join(args.out, "terrain_style.png"))
    doc = {
        "about": "tools/terrain_style.py: per-pixel commonest colours of the course art (BG1 + BG2, "
                 "tile page $90:9E9E + $8B:DAB1, palette $98:C000) over {} geometries".format(len(holes)),
        "anchors": {
            "top": "a cell's left vertex at elevation + 1 is the patch's (0, 32)",
            "face": "E: the edge's left end (x+1, y) at the cell's top is (0, 16); N: (x, y) is (0, 0); "
                    "one step down is +16",
        },
        "holes": [h.index for h in holes],
        **meta,
    }
    with open(os.path.join(args.out, "terrain_style.json"), "w") as f:
        json.dump(doc, f, indent=1)
    if args.sheet:
        big = Image.fromarray(atlas, "RGBA").resize((atlas.shape[1] * 4, atlas.shape[0] * 4), getattr(Image, 'Resampling', Image).NEAREST)
        big.save(os.path.join(args.out, "terrain_style_sheet.png"))
    print("{} patches from {} holes: {} tops, {} marks, {} faces -> {}".format(
        len(entries), len(holes), len(meta["top"]), len(meta["mark"]), len(meta["face"]), args.out))
    for group in ("top", "face"):
        for key, m in sorted(meta[group].items()):
            print("  {} {:10s} n={:5d} agree={:.2f}".format(group, key, m["n"], m["agree"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
