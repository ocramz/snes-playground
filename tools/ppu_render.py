#!/usr/bin/env python3
"""Render a PPU snapshot taken by tools/snesstep: what the screen showed.

A snapshot directory (see docs/emulation.md) holds `vram.bin`, `cgram.bin`,
`oam.bin` and `regs.json`. This draws, from those alone:

    <out>.png               the 256x224 screen: BG layers by mode, sprites,
                            priority, the main/sub screen colour maths,
                            per-line HDMA scroll and mode-7 parameters
    --layers DIR            every enabled BG's whole tilemap at its own size,
                            unscrolled (`bgN.png`), the sprites alone
                            (`obj.png`), and the OBJ tile page with the OBJ
                            palettes (`objpage.png`) -- the reusable art,
                            not just the visible window

Windows are modelled: the two windows per line (per-line positions when
HDMA moved them), per-layer enable/invert and the OR/AND/XOR/XNOR logic,
TMW/TSW masking, and the colour window that gates colour maths and "force
main screen black". The course screens depend on this: they set colour
maths to "inside the colour window only" with COLDATA white, and without
the window every pixel would be added to white.

What is not modelled: mosaic, hi-res modes 5/6 at full width (drawn at 256
pixels), interlace, EXTBG, per-line CGRAM changes made by HDMA (the
snapshot holds one palette), direct colour, and offset-per-tile in modes
2/4/6. Force blank (INIDISP bit 7) draws a black screen, as the hardware
does; `--ignore-blank` draws the PPU contents anyway, which is useful for a
snapshot taken while a screen is being loaded. `--brightness` applies
INIDISP brightness.

    python3 tools/ppu_render.py build/emu/screens/f000600 -o build/x.png
    python3 tools/ppu_render.py SNAP -o x.png --layers build/x_layers --scale 2
"""

import argparse
import json
import os
import sys

import numpy as np

W, H = 256, 224

# Bits per pixel of BG1..BG4 for each mode; 0 = layer absent.
MODE_BPP = {0: (2, 2, 2, 2), 1: (4, 4, 2, 0), 2: (4, 4, 0, 0), 3: (8, 4, 0, 0),
            4: (8, 2, 0, 0), 5: (4, 2, 0, 0), 6: (4, 0, 0, 0), 7: (8, 0, 0, 0)}

# Front-to-back drawing order: ("bg", n, prio) or ("obj", prio).
def layer_order(mode, bg3_prio):
    if mode == 0:
        return [("obj", 3), ("bg", 0, 1), ("bg", 1, 1), ("obj", 2), ("bg", 0, 0),
                ("bg", 1, 0), ("obj", 1), ("bg", 2, 1), ("bg", 3, 1), ("obj", 0),
                ("bg", 2, 0), ("bg", 3, 0)]
    if mode == 1:
        if bg3_prio:
            return [("bg", 2, 1), ("obj", 3), ("bg", 0, 1), ("bg", 1, 1),
                    ("obj", 2), ("bg", 0, 0), ("bg", 1, 0), ("obj", 1),
                    ("bg", 2, 0), ("obj", 0)]
        return [("obj", 3), ("bg", 0, 1), ("bg", 1, 1), ("obj", 2), ("bg", 0, 0),
                ("bg", 1, 0), ("obj", 1), ("bg", 2, 1), ("obj", 0), ("bg", 2, 0)]
    if mode == 7:
        return [("obj", 3), ("obj", 2), ("obj", 1), ("bg", 0, 0), ("obj", 0)]
    return [("obj", 3), ("bg", 0, 1), ("obj", 2), ("bg", 1, 1), ("obj", 1),
            ("bg", 0, 0), ("obj", 0), ("bg", 1, 0)]


OBJ_SIZES = {0: ((8, 8), (16, 16)), 1: ((8, 8), (32, 32)), 2: ((8, 8), (64, 64)),
             3: ((16, 16), (32, 32)), 4: ((16, 16), (64, 64)),
             5: ((32, 32), (64, 64)), 6: ((16, 32), (32, 64)),
             7: ((16, 32), (32, 32))}


class Snapshot(object):
    def __init__(self, path):
        def raw(name, size):
            with open(os.path.join(path, name), "rb") as f:
                b = f.read()
            if len(b) != size:
                raise ValueError("{}: {} bytes, expected {}".format(name, len(b), size))
            return np.frombuffer(b, dtype=np.uint8)
        self.path = path
        self.vram = raw("vram.bin", 0x10000)
        self.cgram_raw = raw("cgram.bin", 512)
        self.oam = raw("oam.bin", 544)
        with open(os.path.join(path, "regs.json")) as f:
            self.regs = json.load(f)
        self.ppu = self.regs["ppu"]
        self.hdma = {k.lower(): v for k, v in self.regs.get("hdma", {}).items()}
        words = self.cgram_raw[0::2].astype(np.uint16) | \
            (self.cgram_raw[1::2].astype(np.uint16) << 8)
        r, g, b = words & 31, (words >> 5) & 31, (words >> 10) & 31
        self.cgram5 = np.stack([r, g, b], axis=1).astype(np.int16)   # 256 x 3
        self._tiles = {}

    def line_value(self, reg, default):
        """Per-line values of a register: HDMA's if it touched it, else flat."""
        vals = self.hdma.get(reg)
        if vals and len(vals) >= H:
            return np.array(vals[:H], dtype=np.int64)
        return np.full(H, default, dtype=np.int64)

    def tiles(self, bpp):
        """All tiles of a depth decoded at every possible VRAM word offset
        that is a multiple of the tile size: array (count, 8, 8)."""
        if bpp in self._tiles:
            return self._tiles[bpp]
        size = bpp * 8
        v = self.vram.reshape(-1, size)
        out = np.zeros((v.shape[0], 8, 8), dtype=np.uint8)
        shifts = 7 - np.arange(8)
        for plane in range(bpp):
            base = (plane // 2) * 16 + (plane & 1)
            rows = v[:, base:base + 16:2]                       # (n, 8)
            bits = (rows[:, :, None] >> shifts[None, None, :]) & 1
            out |= (bits << plane).astype(np.uint8)
        self._tiles[bpp] = out
        return out


def tile_at(snap, bpp, word_addr):
    """8x8 pixel indices of the tile whose data starts at a VRAM word."""
    t = snap.tiles(bpp)
    idx = ((word_addr * 2) & 0xFFFF) // (bpp * 8)
    return t[idx % len(t)]


def bg_full(snap, n, bpp, mode):
    """(pix, pal, prio) arrays for a BG's whole tilemap, unscrolled.

    `pix` is the colour index within its palette (0 = transparent), `pal`
    the CGRAM base for each pixel.
    """
    sc = snap.ppu["bg_sc"][n]
    nba = snap.ppu["bg_nba"][n // 2]
    char_base = ((nba >> (4 * (n & 1))) & 0xF) << 12          # words
    map_base = (sc & 0xFC) << 8                                 # words
    big = bool(snap.ppu["bgmode"] & (0x10 << n))
    tsz = 16 if big else 8
    mw = 64 if sc & 1 else 32
    mh = 64 if sc & 2 else 32
    pw, ph = mw * tsz, mh * tsz
    pix = np.zeros((ph, pw), dtype=np.uint8)
    pal = np.zeros((ph, pw), dtype=np.int16)
    prio = np.zeros((ph, pw), dtype=np.uint8)
    words_per_tile = bpp * 4
    ncol = 1 << bpp
    for my in range(mh):
        for mx in range(mw):
            # 32x32 screens laid out left-right then top-bottom.
            screen = (mx // 32) + (my // 32) * (2 if mw == 64 else 1)
            addr = (map_base + screen * 0x400 + (my % 32) * 32 + (mx % 32)) & 0x7FFF
            e = int(snap.vram[2 * addr]) | (int(snap.vram[2 * addr + 1]) << 8)
            t, p, pr = e & 0x3FF, (e >> 10) & 7, (e >> 13) & 1
            hf, vf = bool(e & 0x4000), bool(e & 0x8000)
            if bpp == 8:
                base_col = 0
            else:
                base_col = p * ncol + (n * 32 if mode == 0 else 0)
            for sy in range(tsz // 8):
                for sx in range(tsz // 8):
                    sub = t + (sy * 16) + sx
                    px = tile_at(snap, bpp, char_base + sub * words_per_tile)
                    if hf:
                        px = px[:, ::-1]
                    if vf:
                        px = px[::-1, :]
                    ox = (tsz // 8 - 1 - sx if hf else sx) * 8
                    oy = (tsz // 8 - 1 - sy if vf else sy) * 8
                    y0, x0 = my * tsz + oy, mx * tsz + ox
                    pix[y0:y0 + 8, x0:x0 + 8] = px
                    pal[y0:y0 + 8, x0:x0 + 8] = base_col
                    prio[y0:y0 + 8, x0:x0 + 8] = pr
    return pix, pal, prio


def bg_screen(snap, n, bpp, mode, full=None):
    """(colour index into CGRAM or -1, prio) for the visible 256x224."""
    pix, pal, prio = full if full is not None else bg_full(snap, n, bpp, mode)
    ph, pw = pix.shape
    hreg, vreg = "{:04x}".format(0x210D + 2 * n), "{:04x}".format(0x210E + 2 * n)
    hofs = snap.line_value(hreg, snap.ppu["bg_hofs"][n])
    vofs = snap.line_value(vreg, snap.ppu["bg_vofs"][n])
    ys = (np.arange(H)[:, None] + vofs[:, None]) % ph
    xs = (np.arange(W)[None, :] + hofs[:, None]) % pw
    p = pix[ys, xs]
    col = np.where(p > 0, pal[ys, xs] + p, -1)
    return col.astype(np.int16), prio[ys, xs]


def signed(v, bits):
    v &= (1 << bits) - 1
    return v - (1 << bits) if v & (1 << (bits - 1)) else v


def mode7_screen(snap):
    m7 = snap.ppu["m7"]
    a = snap.line_value("211b", m7["a"])
    b = snap.line_value("211c", m7["b"])
    c = snap.line_value("211d", m7["c"])
    d = snap.line_value("211e", m7["d"])
    cx = snap.line_value("211f", m7["x"])
    cy = snap.line_value("2120", m7["y"])
    ho = snap.line_value("210d", snap.ppu.get("m7hofs", 0))
    vo = snap.line_value("210e", snap.ppu.get("m7vofs", 0))
    sgn = np.vectorize(lambda v, bits: signed(int(v), bits))
    a, b, c, d = sgn(a, 16), sgn(b, 16), sgn(c, 16), sgn(d, 16)
    cx, cy, ho, vo = sgn(cx, 13), sgn(cy, 13), sgn(ho, 13), sgn(vo, 13)
    sel = snap.ppu.get("m7sel", 0)
    sx = np.arange(W)[None, :]
    if sel & 1:
        sx = 255 - sx
    sy = np.arange(H)[:, None]
    if sel & 2:
        sy = 255 - sy
    dx = (ho[:, None] - cx[:, None]) + sx
    dy = (vo[:, None] - cy[:, None]) + sy
    X = (a[:, None] * dx + b[:, None] * dy + (cx[:, None] << 8)) >> 8
    Y = (c[:, None] * dx + d[:, None] * dy + (cy[:, None] << 8)) >> 8
    outside = (X < 0) | (X > 1023) | (Y < 0) | (Y > 1023)
    Xw, Yw = X & 1023, Y & 1023
    tmap = snap.vram[0::2]                  # low bytes: 128x128 tile map
    tdat = snap.vram[1::2]                  # high bytes: 8bpp linear tiles
    tile = tmap[(Yw >> 3) * 128 + (Xw >> 3)].astype(np.int64)
    over = (sel >> 6) & 3
    if over == 3:
        tile = np.where(outside, 0, tile)
    p = tdat[(tile * 64 + (Yw & 7) * 8 + (Xw & 7)) & 0x7FFF].astype(np.int16)
    if over == 2:
        p = np.where(outside, 0, p)
    col = np.where(p > 0, p, -1)
    return col.astype(np.int16), np.zeros((H, W), dtype=np.uint8)


def obj_tile_word(snap, tile, tx, ty):
    obsel = snap.ppu["obsel"]
    base = (obsel & 7) << 13
    gap = ((obsel >> 3) & 3) << 12
    t = (tile & 0x100) | ((((tile >> 4) + ty) & 0xF) << 4) | ((tile + tx) & 0xF)
    word = base + (t & 0xFF) * 16
    if t & 0x100:
        word += 0x1000 + gap
    return word & 0x7FFF


def sprites(snap):
    """(colour index or -1, prio) for the visible screen, plus per-sprite info."""
    col = np.full((H, W), -1, dtype=np.int16)
    prio = np.zeros((H, W), dtype=np.uint8)
    small, large = OBJ_SIZES[(snap.ppu["obsel"] >> 5) & 7]
    oam = snap.oam
    listing = []
    for i in range(127, -1, -1):          # lower index drawn last = in front
        x, y, tile, attr = (int(v) for v in oam[4 * i:4 * i + 4])
        hi = (int(oam[512 + i // 4]) >> (2 * (i % 4))) & 3
        if hi & 1:
            x -= 256
        w, h = large if hi & 2 else small
        tile |= (attr & 1) << 8
        pal = 128 + ((attr >> 1) & 7) * 16
        pr = (attr >> 4) & 3
        hf, vf = bool(attr & 0x40), bool(attr & 0x80)
        img = np.zeros((h, w), dtype=np.uint8)
        for ty in range(h // 8):
            for tx in range(w // 8):
                px = tile_at(snap, 4, obj_tile_word(snap, tile, tx, ty))
                img[ty * 8:ty * 8 + 8, tx * 8:tx * 8 + 8] = px
        if hf:
            img = img[:, ::-1]
        if vf:
            img = img[::-1, :]
        for row in range(h):
            sy = (y + row + 1) & 0xFF   # sprites appear one line below Y
            if sy >= H:
                continue
            line = img[row]
            for colx in range(w):
                sx = x + colx
                if 0 <= sx < W and line[colx]:
                    col[sy, sx] = pal + line[colx]
                    prio[sy, sx] = pr
        if not (x <= -w or x >= W):
            listing.append(i)
    return col, prio


def window_areas(snap):
    """(win1, win2) boolean HxW arrays: pixels inside each window."""
    x = np.arange(W)[None, :]
    wh = snap.ppu.get("wh", [1, 0, 1, 0])
    out = []
    for i in (0, 2):
        left = snap.line_value("{:04x}".format(0x2126 + i), wh[i])[:, None]
        right = snap.line_value("{:04x}".format(0x2127 + i), wh[i + 1])[:, None]
        out.append((x >= left) & (x <= right))
    return out


def window_mask(snap, areas, nibble, logic):
    """Pixels a layer's window settings select.

    `nibble` is the layer's 4 bits of W12SEL/W34SEL/WOBJSEL: bit 0 invert
    window 1, bit 1 enable window 1, bit 2 invert window 2, bit 3 enable
    window 2. `logic` is its 2 bits of WBGLOG/WOBJLOG: OR, AND, XOR, XNOR.
    With neither window enabled nothing is selected.
    """
    w1 = areas[0] ^ bool(nibble & 1)
    w2 = areas[1] ^ bool(nibble & 4)
    e1, e2 = bool(nibble & 2), bool(nibble & 8)
    if e1 and e2:
        if logic == 0:
            return w1 | w2
        if logic == 1:
            return w1 & w2
        if logic == 2:
            return w1 ^ w2
        return ~(w1 ^ w2)
    if e1:
        return w1
    if e2:
        return w2
    return np.zeros((H, W), dtype=bool)


def layer_windows(snap):
    """{layer id 0-3, 4 = OBJ, 5 = colour: HxW mask}."""
    areas = window_areas(snap)
    p = snap.ppu
    w12, w34, wobj = p.get("w12sel", 0), p.get("w34sel", 0), p.get("wobjsel", 0)
    bglog, objlog = p.get("wbglog", 0), p.get("wobjlog", 0)
    nibbles = {0: w12 & 15, 1: w12 >> 4, 2: w34 & 15, 3: w34 >> 4,
               4: wobj & 15, 5: wobj >> 4}
    logics = {0: bglog & 3, 1: (bglog >> 2) & 3, 2: (bglog >> 4) & 3,
              3: (bglog >> 6) & 3, 4: objlog & 3, 5: (objlog >> 2) & 3}
    return {k: window_mask(snap, areas, nibbles[k], logics[k]) for k in nibbles}


def compose(snap, layers, order, mask, wmask=0, windows=None):
    """Front-to-back pick of the first opaque pixel among enabled layers.

    `wmask` is TMW or TSW: a layer whose bit is set is hidden wherever its
    window selects. Returns (colour index, layer id): layer id 0-3 BG,
    4 OBJ, 5 backdrop.
    """
    out = np.full((H, W), -1, dtype=np.int16)
    who = np.full((H, W), 5, dtype=np.int8)
    for item in order:
        if item[0] == "obj":
            if not mask & 0x10 or "obj" not in layers:
                continue
            col, prio = layers["obj"]
            hit = (out < 0) & (col >= 0) & (prio == item[1])
            lid = 4
        else:
            n = item[1]
            if not mask & (1 << n) or n not in layers:
                continue
            col, prio = layers[n]
            hit = (out < 0) & (col >= 0) & (prio == item[2])
            lid = n
        if windows is not None and wmask & (1 << lid):
            hit &= ~windows[lid]
        out[hit] = col[hit]
        who[hit] = lid
    return out, who


def to_rgb(snap, idx):
    rgb = snap.cgram5[np.where(idx < 0, 0, idx)]
    return rgb


def render(snap, brightness=False, ignore_blank=False):
    mode = snap.ppu["bgmode"] & 7
    bpps = MODE_BPP[mode]
    layers = {}
    fulls = {}
    if mode == 7:
        layers[0] = mode7_screen(snap)
    else:
        for n, bpp in enumerate(bpps):
            if bpp:
                fulls[n] = bg_full(snap, n, bpp, mode)
                layers[n] = bg_screen(snap, n, bpp, mode, fulls[n])
    layers["obj"] = sprites(snap)
    if snap.ppu.get("inidisp", 0) & 0x80 and not ignore_blank:
        return np.zeros((H, W, 3), dtype=np.uint8), fulls
    windows = layer_windows(snap)
    order = layer_order(mode, bool(snap.ppu["bgmode"] & 8))
    main_idx, main_who = compose(snap, layers, order, snap.ppu["tm"],
                                 snap.ppu.get("tmw", 0), windows)
    main = to_rgb(snap, main_idx)

    cgwsel, cgadsub = snap.ppu.get("cgwsel", 0), snap.ppu.get("cgadsub", 0)
    colour_win = windows[5]

    def region(sel):
        """0 everywhere, 1 inside the colour window, 2 outside, 3 nowhere."""
        if sel == 0:
            return np.ones((H, W), dtype=bool)
        if sel == 1:
            return colour_win
        if sel == 2:
            return ~colour_win
        return np.zeros((H, W), dtype=bool)

    # Force-black counts the other way: 0 never, 1 outside, 2 inside, 3 always.
    black = region(3 - ((cgwsel >> 6) & 3))
    main = np.where(black[:, :, None], 0, main)
    math_on = region((cgwsel >> 4) & 3)
    if math_on.any() and cgadsub & 0x3F:
        fixed = np.array(snap.ppu.get("coldata", [0, 0, 0]), dtype=np.int16)
        if cgwsel & 2:
            sub_idx, _ = compose(snap, layers, order, snap.ppu["ts"],
                                 snap.ppu.get("tsw", 0), windows)
            sub_present = sub_idx >= 0
            sub = np.where(sub_present[:, :, None], to_rgb(snap, sub_idx),
                           fixed[None, None, :])
        else:
            sub = np.broadcast_to(fixed, main.shape)
            sub_present = np.ones((H, W), dtype=bool)
        enabled = np.zeros((H, W), dtype=bool)
        for lid in range(4):
            if cgadsub & (1 << lid):
                enabled |= main_who == lid
        if cgadsub & 0x10:
            # Only OBJ palettes 4-7 take part.
            enabled |= (main_who == 4) & (main_idx >= 192)
        if cgadsub & 0x20:
            enabled |= main_who == 5
        enabled &= math_on
        # Halving is skipped where the main pixel was forced black, and
        # against a fixed colour standing in for a transparent sub screen.
        half = bool(cgadsub & 0x40) & sub_present & ~black
        res = main - sub if cgadsub & 0x80 else main + sub
        res = np.where(half[:, :, None], res // 2, res)
        res = np.clip(res, 0, 31)
        main = np.where(enabled[:, :, None], res, main)

    rgb = (main * 255 // 31).astype(np.uint8)
    if brightness:
        b = snap.ppu.get("inidisp", 15) & 15
        rgb = (rgb.astype(np.int32) * b // 15).astype(np.uint8)
    return rgb, fulls


def save(arr, path, scale=1):
    from PIL import Image
    img = Image.fromarray(arr, "RGB" if arr.ndim == 3 and arr.shape[2] == 3 else "RGBA")
    if scale != 1:
        resample = getattr(Image, "Resampling", Image).NEAREST
        img = img.resize((img.width * scale, img.height * scale), resample)
    parent = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(parent):
        os.makedirs(parent)
    img.save(path)


def rgba_of(snap, pix, pal):
    idx = np.where(pix > 0, pal + pix, 0)
    rgb = (snap.cgram5[idx] * 255 // 31).astype(np.uint8)
    a = np.where(pix > 0, 255, 0).astype(np.uint8)
    return np.dstack([rgb, a])


def write_layers(snap, fulls, outdir, scale):
    for n, (pix, pal, _) in fulls.items():
        save(rgba_of(snap, pix, pal), os.path.join(outdir, "bg{}.png".format(n + 1)),
             scale)
    col, _ = sprites(snap)
    rgb = (snap.cgram5[np.where(col < 0, 0, col)] * 255 // 31).astype(np.uint8)
    a = np.where(col >= 0, 255, 0).astype(np.uint8)
    save(np.dstack([rgb, a]), os.path.join(outdir, "obj.png"), scale)
    # The OBJ page: 512 tiles, 16 per row, each drawn with the palette the
    # visible sprites use most for it, else palette 0.
    page = np.zeros((32 * 8, 16 * 8, 4), dtype=np.uint8)
    for t in range(512):
        px = tile_at(snap, 4, obj_tile_word(snap, t, 0, 0))
        pal = 128
        rgb = (snap.cgram5[pal + px] * 255 // 31).astype(np.uint8)
        a = np.where(px > 0, 255, 0).astype(np.uint8)
        y, x = (t // 16) * 8, (t % 16) * 8
        page[y:y + 8, x:x + 8] = np.dstack([rgb, a])
    save(page, os.path.join(outdir, "objpage.png"), scale)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("snapshot", nargs="+", help="snapshot directory (one or more)")
    ap.add_argument("-o", "--output", help="PNG path (single snapshot)")
    ap.add_argument("--layers", help="also write whole-tilemap layers here")
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument("--brightness", action="store_true",
                    help="apply INIDISP brightness")
    ap.add_argument("--ignore-blank", action="store_true",
                    help="draw the PPU contents even under force blank")
    args = ap.parse_args()
    if len(args.snapshot) > 1 and (args.output or args.layers):
        ap.error("-o/--layers take one snapshot; omit them to write "
                 "screen.png into each snapshot directory")
    for path in args.snapshot:
        try:
            snap = Snapshot(path)
        except (OSError, ValueError, KeyError) as e:
            print("error: {}: {}".format(path, e), file=sys.stderr)
            return 1
        rgb, fulls = render(snap, args.brightness, args.ignore_blank)
        out = args.output or os.path.join(path, "screen.png")
        save(rgb, out, args.scale)
        if args.layers:
            write_layers(snap, fulls, args.layers, args.scale)
        print("wrote {} (mode {}, TM ${:02X})".format(
            out, snap.ppu["bgmode"] & 7, snap.ppu["tm"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
