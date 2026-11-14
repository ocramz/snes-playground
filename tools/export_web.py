#!/usr/bin/env python3
"""Export one hole as web-ready assets for the Phaser demo in web/.

Everything is derived from the ROM (and from other tools' output under
build/), and everything is written under build/web/ -- gitignored, like every
other derived artifact. web/vite.config.ts serves that directory as its
public dir, so `/course.json` in the browser is build/web/course.json.

    python3 tools/export_web.py                  # hole 0 = course 1, hole 1
    python3 tools/export_web.py --hole 0 --only course,tables,layers
    python3 tools/export_web.py --golden         # + build/web-test fixtures

Steps (--only takes a comma list; default is all that do not need the
emulator or other build/ output):

    manifest  ROM hash, exporter version
    font      the 8x8 font as a glyph sheet
    sprites   the atlas (tools/export_web_sprites.py; needs the stepper)
    ui        the shot panel sprites (tools/export_web_ui.py; needs the stepper)
    audio     music (cut at its loop end), jingle and effects via ffmpeg
    course    grid layers, tee, enemies, objects, projection origin
    tables    every ROM constant the TypeScript physics needs, each with its
              $bank:addr so a number in the browser can be traced to the ROM
    layers    the isometric course bitmap as RGBA, split by tile priority,
              and the BG3 scenery
    golden    terrain.py's surface_z sampled over every cell (a test fixture)

Facts used here, and where they come from:
    projection  px = 32 (x + y);  py = word7 + 16 (x - y) - 16 Z / $5A82
                word7 is header word 7 (docs/courses.md); checked against the
                first populated BG row in 230 of 232 holes.
    priority    mode 1 with the BG3 priority bit draws, back to front,
                BG2.0, BG1.0, [OBJ priority 2], BG2.1, BG1.1 (coursemap.render).
                Sprites go between the two layer images.
"""

import argparse
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from courses import ENTRIES, default_entries, header  # noqa: E402
from coursemap import (  # noqa: E402
    EMPTY, backdrop, course_page, course_palette, unpack, BG3_MAP_TILES)
from lorom import snes_to_file  # noqa: E402
from romcheck import EXPECTED_SHA1, RomError, load_rom  # noqa: E402
from terrain import Tables, Z_UNIT, load_hole, tile_table  # noqa: E402
from tiles import decode_tiles  # noqa: E402

VERSION = 1
OUT_DEFAULT = os.path.join(ROOT, "build", "web")
TEST_DEFAULT = os.path.join(ROOT, "build", "web-test")

# Layer 2 values the engine treats specially (docs/tiles.md).
TEE_TILE = 0x0C
ACTOR_ENEMY = 0x49      # object type 73, tiles $40-$52 and $57
ACTOR_PILLAR = 0x48     # object type 72, tile $02


# --------------------------------------------------------------------------
# ROM readers
# --------------------------------------------------------------------------

def rom_words(d, bank, addr, n, signed=False):
    o = snes_to_file(bank, addr)
    out = []
    for i in range(n):
        v = int.from_bytes(d[o + 2 * i:o + 2 * i + 2], "little", signed=signed)
        out.append(v)
    return out


def rom_bytes(d, bank, addr, n, signed=False):
    o = snes_to_file(bank, addr)
    return [int.from_bytes(d[o + i:o + i + 1], "little", signed=signed)
            for i in range(n)]


def src(bank, addr):
    return "${:02X}:{:04X}".format(bank, addr)


# --------------------------------------------------------------------------
# tables.json
# --------------------------------------------------------------------------

def build_tables(d):
    tab = Tables(d)
    t = {"about": "ROM tables for web/src/sim. Every entry has a 'source' "
                  "($bank:addr). Words are raw 16-bit values; 'signed' ones "
                  "are already sign-extended.",
         "zUnit": Z_UNIT}

    def put(key, bank, addr, values, width):
        t[key] = {"source": src(bank, addr), "width": width, "values": values}

    put("terrainEdge", 0x81, 0x9310, list(tab.edge), 1)
    put("terrainQuad", 0x81, 0x9D81, list(tab.quad), 2)
    put("terrainQuadDiag", 0x81, 0x9569, list(tab.quad_diag), 2)
    put("terrainDiagBias", 0x81, 0x9629, list(tab.diag_bias), 2)
    put("heightZLo", 0x88, 0x8000, list(tab.z_lo), 2)
    put("heightZHi", 0x88, 0x80C8, list(tab.z_hi), 2)
    put("ramp", 0x88, 0x8190, list(tab.ramp), 2)

    put("sinDeg", 0x80, 0xA5A2, rom_words(d, 0x80, 0xA5A2, 450, True), 2)
    # arctan in degrees by ratio index 0-255 (sub_atan2_deg $80:A4C1)
    put("atanDeg", 0x80, 0xA928, rom_bytes(d, 0x80, 0xA928, 256), 1)
    # per-shape flag: a surface-code change inside the cell throws the ball
    # ($81:980B, the no-edge-crossing case)
    put("crestShape", 0x81, 0x9B45, rom_bytes(d, 0x81, 0x9B45, 28), 1)
    put("degToDir32", 0x81, 0x8E98, rom_bytes(d, 0x81, 0x8E98, 361), 1)

    put("frictionClass", 0x81, 0x8C12, rom_words(d, 0x81, 0x8C12, 13), 2)
    put("rollFriction", 0x80, 0xDC49, rom_words(d, 0x80, 0xDC49, 22 * 4), 2)
    put("ballGravity", 0x80, 0xDB6D, rom_words(d, 0x80, 0xDB6D, 22 * 4, True), 2)
    put("slopeAccelX", 0x81, 0x9E85, rom_words(d, 0x81, 0x9E85, 9, True), 2)
    put("slopeAccelY", 0x81, 0x9E97, rom_words(d, 0x81, 0x9E97, 9, True), 2)
    put("launchX", 0x81, 0x9E61, rom_words(d, 0x81, 0x9E61, 9, True), 2)
    put("launchY", 0x81, 0x9E73, rom_words(d, 0x81, 0x9E73, 9, True), 2)
    put("stepDampMaskX", 0x81, 0x9EA9, rom_words(d, 0x81, 0x9EA9, 4), 2)
    put("stepDampMaskY", 0x81, 0x9EB1, rom_words(d, 0x81, 0x9EB1, 4), 2)
    put("reflectIndex", 0x81, 0x9EB9, rom_words(d, 0x81, 0x9EB9, 16), 2)
    # 13 matrices of 3x3 signed Q15 words, row-major, 18 bytes each.
    put("reflectMatrix", 0x81, 0x9ED9, rom_words(d, 0x81, 0x9ED9, 13 * 9, True), 2)

    put("powerGround", 0x88, 0xA670, rom_words(d, 0x88, 0xA670, 64), 2)
    put("powerFly", 0x88, 0xA6F0, rom_words(d, 0x88, 0xA6F0, 64), 2)
    put("spinGroundTB", 0x80, 0xDD17, rom_bytes(d, 0x80, 0xDD17, 13, True), 1)
    put("curve", 0x80, 0xDD24, rom_bytes(d, 0x80, 0xDD24, 13, True), 1)
    put("spinFlyTB", 0x80, 0xDD33, rom_words(d, 0x80, 0xDD33, 13, True), 2)
    put("spinFlySide", 0x80, 0xDD4D, rom_bytes(d, 0x80, 0xDD4D, 13, True), 1)
    put("buttonModifier", 0x82, 0xDB75, rom_words(d, 0x82, 0xDB75, 2, True), 2)

    # The cup's dish: 32 x 32 words, row = folded y fraction >> 10, column =
    # folded x fraction >> 10 (sub_cup_depth $82:AFE9). $5000 = flat centre.
    put("cupDepth", 0x88, 0x8990, rom_words(d, 0x88, 0x8990, 32 * 32), 2)

    def scalar(key, bank, addr, signed=False):
        t.setdefault("consts", {})[key] = {
            "source": src(bank, addr),
            "value": rom_words(d, bank, addr, 1, signed)[0]}

    scalar("bounceMinFrames", 0x80, 0xDCFD)
    scalar("restSpeed", 0x80, 0xDD01)
    scalar("powerScale", 0x80, 0xDD03)
    scalar("flySpinBase", 0x80, 0xDD05)
    scalar("rollFrictionDefault", 0x80, 0xDD0D)
    scalar("bounceDampXY", 0x80, 0xDD0F)
    scalar("bounceDampZ", 0x80, 0xDD11)
    scalar("stepDamp", 0x80, 0xDD13)
    scalar("stepDampZ", 0x80, 0xDD15)
    return t


# --------------------------------------------------------------------------
# course.json
# --------------------------------------------------------------------------

def build_course(d, defaults, index):
    got = load_hole(d, defaults, index)
    if got is None:
        raise SystemExit("hole {} has no usable grids".format(index))
    fields, name, w, h, layers = got
    l1, l2, l3, l4 = layers[1], layers[2], layers[3], layers[4]
    has_tiles = len(l2) >= w * h
    n = w * h

    actor_off = snes_to_file(0x82, 0xBDBC)
    actors = [int.from_bytes(d[actor_off + 2 * i:actor_off + 2 * i + 2], "little")
              for i in range(256)]

    tee, enemies, objects, edges = None, [], [], []
    tiles = list(l2[:n]) if has_tiles else [0] * n
    for j, tile in enumerate(tiles):
        if not tile:
            continue
        x, y = j % w, j // w
        if tile == TEE_TILE:
            tee = {"x": x, "y": y, "elevation": l3[j]}
        actor = actors[tile]
        if actor == ACTOR_ENEMY:
            enemies.append({"x": x, "y": y, "tile": tile, "actor": actor})
        elif actor != 0xFFFF:
            objects.append({"x": x, "y": y, "tile": tile, "actor": actor,
                            "type": actor})        # an actor id is the object type
        if 0x28 <= tile <= 0x2D:
            edges.append({"x": x, "y": y, "tile": tile})

    map_w, map_h = fields[4], fields[5]
    return {
        "index": index, "name": name, "header": list(fields),
        "w": w, "h": h,
        "bitmap": {"w": map_w * 8, "h": map_h * 8},
        "word7": fields[7],
        "zUnit": Z_UNIT,
        "projection": {"sx": 32, "sy": 16, "syPerStep": 16, "originY": fields[7]},
        "shape": list(l1[:n]), "elev": list(l3[:n]), "walls": list(l4[:n]),
        "tile": tiles,
        "tee": tee, "enemies": enemies, "objects": objects, "edgeTiles": edges,
    }


# --------------------------------------------------------------------------
# layers
# --------------------------------------------------------------------------

# The play-area outline is BG2 palette 7, colour 15, and the game animates
# that one CGRAM entry (an object at $84:81A3 steps it through a table every
# 3 frames; measured with snesstep --watch-write '$7E:04FE-$7E:04FF'). So
# those pixels are written to a separate white mask that the browser tints.
OUTLINE_PAL, OUTLINE_COLOUR = 7, 15
OUTLINE_TABLE = (0x98, 0xD3E6)      # 15 colours; the cycle walks it ping-pong
OUTLINE_WALK = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 13, 14, 13,
                12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]   # emulated, 3 frames each


def blit_rgba(img, pal, tiles, word, y, x, outline=None):
    """Draw one tilemap cell into an (H, W, 4) array; colour 0 is transparent.

    With `outline` (an (H, W, 4) array), the outline colour goes there as
    white instead of into `img`.
    """
    import numpy as np
    idx = word & 0x3FF
    if idx >= len(tiles):
        return
    rows = tiles[idx]
    if (word >> 14) & 1:
        rows = [row[::-1] for row in rows]
    if (word >> 15) & 1:
        rows = rows[::-1]
    cell = np.array(rows, dtype=np.uint8)
    view = img[y:y + 8, x:x + 8]
    if view.shape[0] != 8 or view.shape[1] != 8:
        return
    mask = cell != 0
    colours = np.array(pal[(word >> 10) & 7], dtype=np.uint8)
    if outline is not None and ((word >> 10) & 7) == OUTLINE_PAL:
        ol = cell == OUTLINE_COLOUR
        oview = outline[y:y + 8, x:x + 8]
        oview[ol] = 255
        mask = mask & ~ol
    view[mask, :3] = colours[cell[mask]]
    view[mask, 3] = 255


def build_layers(d, index, outdir):
    import numpy as np
    from PIL import Image

    _, fields, name, _ = header(d, index)
    map_w, map_h, g1, g2, _rows = unpack(d, index, fields)
    tiles = decode_tiles(course_page(d), 4)
    pal = course_palette(d)
    W, H = map_w * 8, map_h * 8

    def compose(want):
        img = np.zeros((H, W, 4), dtype=np.uint8)
        ol = np.zeros((H, W, 4), dtype=np.uint8)
        # BG2 is behind BG1 at the same priority.
        for grid in (g2, g1):
            for i, wd in enumerate(grid):
                if wd == EMPTY or ((wd >> 13) & 1) != want:
                    continue
                y, x = divmod(i, map_w)
                blit_rgba(img, pal, tiles, wd, y * 8, x * 8, outline=ol)
        return img, ol

    (back, ol_back), (front, ol_front) = compose(0), compose(1)
    wrote = {}
    for name_, arr in (("layer_back.png", back), ("layer_front.png", front),
                       ("layer_outline_back.png", ol_back),
                       ("layer_outline_front.png", ol_front)):
        path = os.path.join(outdir, name_)
        if arr[:, :, 3].any():
            Image.fromarray(arr, "RGBA").save(path)
            wrote[name_] = [W, H]
        elif os.path.exists(path):
            os.remove(path)

    # BG3 scenery: one 32x32-tile screen with the per-course palette. Groups
    # of four colours, as coursemap.render builds them.
    page, tmap, cols = backdrop(d, index)
    cells = decode_tiles(page, 2)
    pal2 = [[cols[g * 4 + c] for c in range(4)] for g in range(8)]
    sky = np.zeros((BG3_MAP_TILES * 8, BG3_MAP_TILES * 8, 4), dtype=np.uint8)
    for want in (0, 1):
        for i, wd in enumerate(tmap[:BG3_MAP_TILES * BG3_MAP_TILES]):
            if ((wd >> 13) & 1) != want:
                continue
            cy, cx = divmod(i, BG3_MAP_TILES)
            blit_rgba(sky, pal2, cells, wd, cy * 8, cx * 8)
    Image.fromarray(sky, "RGBA").save(os.path.join(outdir, "layer_bg3.png"))
    wrote["layer_bg3.png"] = [256, 256]
    # The backdrop colour behind everything is the course palette's colour 0.
    from tiles import snes_color
    table = [snes_color(w) for w in rom_words(d, OUTLINE_TABLE[0], OUTLINE_TABLE[1], 15)]
    return {"files": wrote, "backColour": list(cols[0]), "name": name,
            "outline": {"source": src(*OUTLINE_TABLE), "stepFrames": 3,
                        "cycle": [list(table[i]) for i in OUTLINE_WALK]}}


# --------------------------------------------------------------------------
# font

def build_font(d, outdir):
    """The game's 8x8 font (docs/text.md) as one 16-glyph-wide RGBA sheet,
    glyph index = tile index = the game's character code."""
    import numpy as np
    from PIL import Image
    import text as text_mod
    tiles = text_mod.font_tiles(d)
    cols = 16
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.zeros((rows * 8, cols * 8, 4), dtype=np.uint8)
    # glyph pixels are value 3; value 1 is the cell background, 2 is rare
    shades = [None, None, (200, 200, 230, 255), (255, 255, 255, 255)]
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        for y in range(8):
            for x in range(8):
                v = t[y][x]
                if shades[v]:
                    sheet[r * 8 + y, c * 8 + x] = shades[v]
    Image.fromarray(sheet, "RGBA").save(os.path.join(outdir, "font.png"))
    return {"glyphs": len(tiles), "cols": cols}


# --------------------------------------------------------------------------
# HUD

HUD_SRC = os.path.join(ROOT, "build", "screens", "hole_in_play_layers", "bg3.png")


def build_hud(outdir):
    """The in-play panel (BG3 of an emulated frame), with the numbers and the
    tomatoes blanked so the browser can draw its own. Coordinates are screen
    pixels of that 256x224 frame (measured on build/screens/hole_in_play)."""
    from PIL import Image
    if not os.path.exists(HUD_SRC):
        print("hud: {} missing (tools/snesstep/screens.py makes it); skipped".format(HUD_SRC))
        return None
    im = Image.open(HUD_SRC).convert("RGBA")
    panel = im.crop((16, 176, 240, 208))
    px = panel.load()

    def fill(box, colour):
        x0, y0, x1, y1 = box
        for y in range(y0 - 176, y1 - 176):
            for x in range(x0 - 16, x1 - 16):
                px[x, y] = colour

    # Where BG3 draws nothing the game shows the course through a darkening
    # window; a flat dark colour stands in for it.
    dark = (24, 24, 24, 255)
    orange = (255, 189, 107, 255)        # the SHOT / HOLE box
    back = (40, 40, 48, 255)
    strip = (214, 148, 247, 255)         # the lilac star-count strip
    for y in range(panel.height):
        for x in range(panel.width):
            if px[x, y][3] == 0:
                px[x, y] = back
    tom = im.crop((164, 183, 182, 199))  # one tomato with its leaf, 18 x 16
    fill((24, 184, 48, 208), back)       # the portrait window shows scenery: blank it
    fill((111, 194, 127, 207), dark)
    fill((136, 193, 153, 207), orange)
    fill((163, 182, 231, 199), back)
    fill((197, 199, 219, 208), strip)
    panel.save(os.path.join(outdir, "hud_panel.png"))
    tom.save(os.path.join(outdir, "hud_tomato.png"))
    return {"panel": [224, 32], "at": [16, 176], "tomato": list(tom.size),
            "slots": {"hole": [111, 194], "shot": [136, 193], "tomato": [164, 183],
                      "tomatoStep": 16, "stars": [200, 200]}}


# --------------------------------------------------------------------------
# audio

WAV_DIR = os.path.join(ROOT, "build", "spc", "wav")


def encode(src_wav, dst_base, seconds=None):
    """ogg vorbis, plus an mp3 for browsers that cannot decode it."""
    import subprocess
    base = ["ffmpeg", "-y", "-loglevel", "error", "-i", src_wav]
    if seconds:
        base += ["-t", str(seconds)]
    subprocess.run(base + ["-c:a", "libvorbis", "-q:a", "4", dst_base + ".ogg"], check=True)
    subprocess.run(base + ["-c:a", "libmp3lame", "-q:a", "4", dst_base + ".mp3"], check=True)


def build_audio(outdir):
    """music (cut at its loop end), the hole-in jingle and the effects the
    demo plays, with the loop points the browser needs."""
    import csv
    amap = json.load(open(os.path.join(HERE, "web_audio_map.json")))
    index = os.path.join(WAV_DIR, "index.tsv")
    if not os.path.exists(index):
        print("audio: {} missing (tools/render_audio.py makes it); skipped".format(index))
        return None
    rows = {}
    with open(index) as f:
        for r in csv.DictReader(f, delimiter="\t"):
            rows[(r["kind"], r["id"])] = r
    out = {}
    n = amap["music"]["song"]
    row = rows[("song", "{:02d}".format(n))]
    start, length = float(row["loop_start_s"]), float(row["loop_length_s"])
    end = start + length
    encode(os.path.join(WAV_DIR, "songs", "song_{:02d}.wav".format(n)),
           os.path.join(outdir, "music"), seconds=round(end + 0.05, 3))
    out["music"] = {"file": "music.ogg", "loopStart": round(start, 4), "loopEnd": round(end, 4)}
    j = amap["jingle"]["song"]
    encode(os.path.join(WAV_DIR, "songs", "song_{:02d}.wav".format(j)), os.path.join(outdir, "jingle"))
    out["jingle"] = "jingle.ogg"
    out["sfx"] = {}
    for sid in amap["sfx"]:
        name = "sfx_{:02X}".format(int(sid))
        encode(os.path.join(WAV_DIR, "sfx", name + ".wav"), os.path.join(outdir, name))
        out["sfx"][sid] = name + ".ogg"
    write_json(os.path.join(outdir, "audio.json"), out, compact=False)
    return {"music": out["music"], "sfx": len(out["sfx"])}


# --------------------------------------------------------------------------
# golden terrain fixture
# --------------------------------------------------------------------------

def build_golden(d, defaults, index):
    tab = Tables(d)
    _, _, w, h, layers = load_hole(d, defaults, index)
    l1, l3 = layers[1], layers[3]
    fracs = sorted(set([k * 0x1000 for k in range(16)] + [0x7FFF, 0x8000, 0xFFFF]))
    z = []
    for j in range(w * h):
        for yf in fracs:
            for xf in fracs:
                z.append(tab.surface_z(l1[j], l3[j], xf, yf))
    return {"about": "Tables.surface_z (tools/terrain.py) for every cell, "
                     "row-major, then yf, then xf.",
            "w": w, "h": h, "fracs": fracs, "z": z}


# --------------------------------------------------------------------------

def write_json(path, obj, compact=True):
    with open(path, "w") as f:
        if compact:
            json.dump(obj, f, separators=(",", ":"))
        else:
            json.dump(obj, f, indent=1)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hole", type=int, default=0, help="hole index (course*8+hole)")
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--test-out", default=TEST_DEFAULT)
    ap.add_argument("--only", default="manifest,course,tables,layers,font,hud,sprites,ui,audio",
                    help="comma list of steps")
    ap.add_argument("--golden", action="store_true",
                    help="also write the terrain golden fixture")
    args = ap.parse_args()
    steps = set(args.only.split(","))
    if args.golden:
        steps.add("golden")

    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    defaults = default_entries(d)
    os.makedirs(args.out, exist_ok=True)

    if "course" in steps:
        course = build_course(d, defaults, args.hole)
        write_json(os.path.join(args.out, "course.json"), course)
        print("course.json: hole {} {} {}x{}, {} enemies, {} objects, tee {}".format(
            args.hole, course["name"], course["w"], course["h"],
            len(course["enemies"]), len(course["objects"]), course["tee"]))
    if "tables" in steps:
        write_json(os.path.join(args.out, "tables.json"), build_tables(d))
        print("tables.json written")
    if "layers" in steps:
        info = build_layers(d, args.hole, args.out)
        write_json(os.path.join(args.out, "layers.json"), info, compact=False)
        print("layers: {}".format(info["files"]))
    if "font" in steps:
        info = build_font(d, args.out)
        print("font.png: {}".format(info))
    if "audio" in steps:
        print("audio: {}".format(build_audio(args.out)))
    if "hud" in steps:
        print("hud: {}".format(build_hud(args.out)))
    if "sprites" in steps:
        import export_web_sprites
        print("sprites: {}".format(export_web_sprites.build(args.out)))
    if "ui" in steps:
        import export_web_ui
        print("ui: {}".format(export_web_ui.build(args.out)))
    if "golden" in steps:
        os.makedirs(args.test_out, exist_ok=True)
        write_json(os.path.join(args.test_out, "terrain_golden.json"),
                   build_golden(d, defaults, args.hole))
        print("terrain_golden.json written to {}".format(args.test_out))
    if "manifest" in steps:
        files = sorted(f for f in os.listdir(args.out) if f != "manifest.json")
        write_json(os.path.join(args.out, "manifest.json"), {
            "exporter": VERSION, "hole": args.hole, "romSha1": EXPECTED_SHA1,
            "files": files}, compact=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
