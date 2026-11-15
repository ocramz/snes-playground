#!/usr/bin/env python3
"""Sprite atlas for the web demo (called by tools/export_web.py --only sprites).

Everything is cut from pictures the game itself drew:

* Kirby: the clips of build/sprites/kirby/clips (tools/kirbyanim.py), which
  carry per-frame offsets and 60 Hz durations.
* Enemies, stars, the cup and the tee pad: sheets built from a *replay of
  hole 1 played by the game's own rules* (tools/snesstep/autoplay.py's
  build/emu/autoplay/c1n), so they show hole 1's palette and every state an
  enemy goes through. `capture()` makes the snapshots and the sheets.
* The tree, the shot-guide dot and cone: the thread object that draws the
  tree has no frame list emusheets can read, so these are cropped from the
  OBJ layer of a rendered snapshot (tools/ppu_render.py).

Convention in the atlas JSON: every frame has `ox, oy`, the position of the
object *within the frame*. A sprite is drawn with its top-left at
`object_position - (ox, oy)`, which is the origin convention of
build/sprites/emu/obj_*.json and of the Kirby clips.

Object positions in hole-1 WRAM (measured, f002302): enemies and trees sit at
the corner of their cell, `(32 (x+y), word7 + 16 (x-y) - 16 Z/$5A82)` with Z
the ground height, in course-bitmap pixels; the tee pad at the cell centre.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

STEPPER = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
# `python3 tools/snesstep/autoplay.py --course 0` writes build/emu/autoplay/course1
# (a replay of course 1 played by the game's own rules); c1n is an older run of it.
REPLAY_DIR = next((d for d in (os.path.join(ROOT, "build", "emu", "autoplay", n)
                               for n in ("c1n", "course1"))
                   if os.path.exists(os.path.join(d, "pokes.txt"))),
                  os.path.join(ROOT, "build", "emu", "autoplay", "course1"))
SNAP_DIR = os.path.join(ROOT, "build", "emu", "web_hole0")
# Every enemy species' idle clip, recorded by tools/snesstep/trace_enemies.py
# (optional: without it only the hole-1 sheet's $4C clip is exported).
SPECIES_DIR = os.path.join(ROOT, "build", "sprites", "enemies")
SHEET_DIR = os.path.join(ROOT, "build", "web-sprites")
KIRBY_CLIPS = os.path.join(ROOT, "build", "sprites", "kirby", "clips")

SNAP_FIRST, SNAP_LAST, SNAP_EVERY = 2110, 3960, 3
TREE_SNAP = "f002350"      # camera clear of the tree: whole sprite on screen
TREE_REF = "f002302"       # camera (192, 152): tree frame top-left at (168, 168)

KIRBY_CLIP_NAMES = (
    "aim_facing", "aim_turn_facing", "curl_into_ball_angle", "unroll_angle",
    "wait_turn_facing", "ball_squash_squash", "hop_", "ball_roll", "ball_sink",
    "tired_health",
    # the engine's asleep (pose 3, object $BE stands in) and hazard poses
    # (49 dizzy after a bumper, 40 the volcano's throw), engine/ phase 7
    "fall_asleep", "dizzy", "hit_burn_")


# --------------------------------------------------------------------------

def capture(force=False):
    """Replay hole 1 with snapshots and turn them into sprite sheets."""
    if os.path.isdir(SHEET_DIR) and os.path.exists(
            os.path.join(SHEET_DIR, "obj_073.png")) and not force:
        return
    if not os.path.exists(STEPPER):
        raise SystemExit("build the stepper first (docs/tooling.md): "
                         "CARGO_TARGET_DIR=build/snesstep cargo build --release "
                         "--offline --manifest-path tools/snesstep/Cargo.toml")
    if not os.path.exists(os.path.join(REPLAY_DIR, "pokes.txt")):
        raise SystemExit("run `python3 tools/snesstep/autoplay.py --course 0` first "
                         "(expected {})".format(REPLAY_DIR))
    snaps = ",".join(str(f) for f in range(SNAP_FIRST, SNAP_LAST, SNAP_EVERY))
    if not os.path.isdir(SNAP_DIR):
        subprocess.run([STEPPER, "--frames", str(SNAP_LAST),
                        "--input", os.path.join(REPLAY_DIR, "input.txt"),
                        "--pokes", os.path.join(REPLAY_DIR, "pokes.txt"),
                        "--snap-at", snaps, "--no-dsp", "--quiet",
                        "--out", SNAP_DIR], check=True)
    os.makedirs(SHEET_DIR, exist_ok=True)
    dirs = sorted(os.path.join(SNAP_DIR, d) for d in os.listdir(SNAP_DIR)
                  if d.startswith("f"))
    subprocess.run([sys.executable, os.path.join(HERE, "emusheets.py"),
                    "--out", SHEET_DIR,
                    "--cache", os.path.join(SHEET_DIR, "cache.pickle")] + dirs,
                   check=True)


# --------------------------------------------------------------------------

class Atlas(object):
    def __init__(self):
        self.items = []         # (name, image, ox, oy)
        self.names = set()

    def add(self, name, img, ox, oy, trim=True):
        if name in self.names:
            return name
        if trim:
            box = img.getbbox()
            if box is None:
                box = (0, 0, 1, 1)
            img = img.crop(box)
            ox, oy = ox - box[0], oy - box[1]
        self.names.add(name)
        self.items.append((name, img, ox, oy))
        return name

    def pack(self, width=1024):
        from PIL import Image
        order = sorted(self.items, key=lambda it: -it[1].height)
        x = y = shelf = 0
        placed = {}
        for name, img, ox, oy in order:
            w, h = img.size
            if x + w + 1 > width:
                x, y, shelf = 0, y + shelf + 1, 0
            placed[name] = (x, y, w, h, ox, oy)
            x += w + 1
            shelf = max(shelf, h)
        height = y + shelf + 1
        sheet = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for name, img, ox, oy in self.items:
            px, py = placed[name][:2]
            sheet.paste(img, (px, py))
        frames = {n: {"x": p[0], "y": p[1], "w": p[2], "h": p[3],
                      "ox": p[4], "oy": p[5]} for n, p in placed.items()}
        return sheet, frames


def sheet_frames(stem):
    """Cells of a build/sprites/emu-style sheet as (image, ox, oy) tuples."""
    from PIL import Image
    img = Image.open(stem + ".png").convert("RGBA")
    meta = json.load(open(stem + ".json"))
    cw, ch = meta["cell"]
    ox, oy = meta["origin"]
    out = []
    for f in meta["frames"]:
        out.append((img.crop((f["x"], f["y"], f["x"] + cw, f["y"] + ch)), ox, oy))
    return out


def render_obj_layer(snap):
    """OBJ layer of a snapshot as RGBA, via tools/ppu_render.py."""
    from PIL import Image
    tmp = os.path.join(SHEET_DIR, "render_" + snap)
    if not os.path.exists(os.path.join(tmp, "obj.png")):
        subprocess.run([sys.executable, os.path.join(HERE, "ppu_render.py"),
                        os.path.join(SNAP_DIR, snap),
                        "-o", tmp + ".png", "--layers", tmp],
                       check=True, capture_output=True)
    return Image.open(os.path.join(tmp, "obj.png")).convert("RGBA")


def alpha_bbox(img, rect):
    box = img.crop(rect).getbbox()
    if box is None:
        raise SystemExit("nothing in {} of the OBJ layer".format(rect))
    return (rect[0] + box[0], rect[1] + box[1], rect[0] + box[2], rect[1] + box[3])


def build(outdir):
    from PIL import Image
    capture()
    atlas = Atlas()
    clips = {}

    # ---- Kirby --------------------------------------------------------
    kc = json.load(open(os.path.join(KIRBY_CLIPS, "clips.json")))
    for clip in kc["clips"]:
        name = clip["name"]
        if not name.startswith(KIRBY_CLIP_NAMES):
            continue
        seq = []
        for fr in clip["frames"]:
            img = Image.open(os.path.join(KIRBY_CLIPS, fr["png"])).convert("RGBA")
            key = "k_" + os.path.splitext(os.path.basename(fr["png"]))[0]
            atlas.add(key, img, -fr["x"], -fr["y"], trim=False)
            seq.append({"f": key, "d": max(1, int(fr["duration"]))})
        clips[name] = {"frames": seq, "loop": bool(clip["loop"]),
                       "loopStart": clip["loop_start"] or 0,
                       "next": clip["next_state"]}

    # ---- hole-1 sheets ---------------------------------------------------
    enemy = sheet_frames(os.path.join(SHEET_DIR, "obj_073"))
    # Sheet order is time order (checked against the live frame indices of the
    # three enemy slots): 0-7 the idle turn (about 8 frames each, a 63 frame
    # cycle), 8-15 the star left behind (1 frame each), 16-20 the cup opening.
    idle_d = [8, 8, 8, 8, 8, 8, 8, 7]
    seq = []
    for i in range(8):
        img, ox, oy = enemy[i]
        seq.append({"f": atlas.add("enemy_%d" % i, img, ox, oy), "d": idle_d[i]})
    clips["enemy_idle"] = {"frames": seq, "loop": True, "loopStart": 0, "next": None}
    seq = []
    for i in range(8):
        img, ox, oy = enemy[8 + i]
        seq.append({"f": atlas.add("star_%d" % i, img, ox, oy), "d": 1})
    clips["star"] = {"frames": seq, "loop": True, "loopStart": 0, "next": None}
    seq = []
    for i, d in enumerate((22, 3, 3, 3, 60)):
        img, ox, oy = enemy[16 + i]
        seq.append({"f": atlas.add("cuphole_%d" % i, img, ox, oy), "d": d})
    clips["cup_open"] = {"frames": seq, "loop": False, "loopStart": 0, "next": None}

    # ---- every species' idle clip -----------------------------------------
    # enemy_XX_idle and its frames enemy_XX_i, XX the species' tile ($40-$4F,
    # $57; $50-$52 draw as $4D-$4F). The star and the cup's opening above are
    # the same for every species (one picture per list over all 232 holes).
    species = os.path.join(SPECIES_DIR, "species.json")
    if os.path.exists(species):
        with open(species) as f:
            for tile, e in sorted(json.load(f)["species"].items()):
                names = []
                for i, p in enumerate(e["pictures"]):
                    img = Image.open(os.path.join(SPECIES_DIR, p["png"])).convert("RGBA")
                    names.append(atlas.add("enemy_{}_{}".format(tile, i), img, p["ox"], p["oy"]))
                clips["enemy_{}_idle".format(tile)] = {
                    "frames": [{"f": names[k], "d": d} for k, d in e["frames"]],
                    "loop": True, "loopStart": 0, "next": None}

    ring = sheet_frames(os.path.join(SHEET_DIR, "obj_074"))
    atlas.add("cupring", *ring[0])
    # Object 75, spawned at the hole-out ($82:AD13): four 16x16 sprites at OAM
    # priority 0 and a lower OAM index than Kirby (web_hole0 f003124), so
    # where it is opaque the course shows through and Kirby is hidden: the
    # cup's near rim. Only its alpha is used (the engine's cup-mask.ts); the
    # notch in rows 0-1 is the ring's opening.
    mask = sheet_frames(os.path.join(SHEET_DIR, "obj_075"))
    atlas.add("cupmask", *mask[0])
    tee = sheet_frames(os.path.join(SHEET_DIR, "obj_108"))
    atlas.add("tee", *tee[3])
    shadow = sheet_frames(os.path.join(SHEET_DIR, "obj_121"))
    atlas.add("shadow", *shadow[0])

    # ---- cropped from the OBJ layer ---------------------------------------
    ref = render_obj_layer(TREE_REF)
    snap = render_obj_layer(TREE_SNAP)
    # The frame is 48 x 64 with its top-left at (168, 168) in TREE_REF; the
    # visible bbox there gives the offset of the art inside the frame.
    rb = alpha_bbox(ref, (160, 160, 224, 224))
    dx, dy = rb[0] - 168, rb[1] - 168
    sb = alpha_bbox(snap, (88, 122, 150, 200))   # clear of the guide cone above
    tl = (sb[0] - dx, sb[1] - dy)
    tree = snap.crop((tl[0], tl[1], tl[0] + 48, tl[1] + 64))
    atlas.add("tree", tree, -8, 56, trim=False)
    # The shot guide: dots along the predicted path and a cone where it lands
    # (f002350 is an aiming frame; both are cropped clear of the other sprites).
    dot = snap.crop((93, 88, 98, 95))
    atlas.add("guide_dot", dot, 2, 6, trim=False)
    cone = snap.crop((137, 107, 144, 118))
    atlas.add("guide_cone", cone, 3, 10, trim=False)

    cutscenes = build_cutscenes(atlas)
    if cutscenes:
        with open(os.path.join(outdir, "cutscenes.json"), "w") as f:
            json.dump(cutscenes, f, separators=(",", ":"))

    sheet, frames = atlas.pack()
    sheet.save(os.path.join(outdir, "sprites.png"))
    with open(os.path.join(outdir, "sprites.json"), "w") as f:
        json.dump({"image": "sprites.png", "size": list(sheet.size),
                   "frames": frames, "clips": clips}, f, separators=(",", ":"))
    return {"frames": len(frames), "clips": len(clips), "size": list(sheet.size),
            "cutscenes": sorted(cutscenes["windows"]) if cutscenes else None}


# --------------------------------------------------------------------------
# The hazard actors' pictures, for the engine (tools/export_web.py --only objects)

OBJECT_SHEETS = os.path.join(ROOT, "build", "sprites", "emu")
# The bumpers 76 (rides its track) and 77 (bobs), the volcanoes 81-83
# (docs/tiles.md; engine/src/core/sim/actors.ts). actors.tsv rates all five
# actor ids a "match" for these types. 63 and 64 are the warp's: Kirby curls
# up and bursts into stars at the warp he went into, stars and a flash where
# he comes out ($82:AAE5, $82:AB6E; engine/src/core/systems/warp.ts).
OBJECT_TYPES = (63, 64, 76, 77, 81, 82, 83)


def build_objects(outdir):
    """objects.png + objects.json: the emulated sheets of OBJECT_TYPES
    (build/sprites/emu/obj_NNN, tools/emusheets.py over every hole), packed like
    sprites.json. A sheet lists its pictures by frame table ($89:xxxx, one per
    look: the courses dress the same object differently) and index within it;
    frame `oTTT_K_II` is type TTT, the K-th table in the sheet's order, index
    II. `objects[type].tables[K]` names the table and `.frames[K][II]` the
    frame, so a view picks a picture from the thread's frame number. Which
    table a course uses is not traced (the first is the one seen on course 1:
    h003 for 76)."""
    atlas = Atlas()
    objects = {}
    for t in OBJECT_TYPES:
        stem = os.path.join(OBJECT_SHEETS, "obj_%03d" % t)
        if not os.path.exists(stem + ".json"):
            print("objects: {}.json missing (tools/emusheets.py); type {} skipped".format(stem, t))
            continue
        meta = json.load(open(stem + ".json"))
        cells = sheet_frames(stem)
        tables, frames = [], []
        for f, (img, ox, oy) in zip(meta["frames"], cells):
            if f["table"] not in tables:
                tables.append(f["table"])
                frames.append([])
            k = tables.index(f["table"])
            row = frames[k]
            while len(row) <= f["index"]:
                row.append(None)
            row[f["index"]] = atlas.add("o%03d_%d_%02d" % (t, k, f["index"]), img, ox, oy)
        objects[str(t)] = {"tables": tables, "frames": frames,
                           "source": os.path.relpath(stem + ".json", ROOT)}
    if not objects:
        return None
    sheet, packed = atlas.pack()
    sheet.save(os.path.join(outdir, "objects.png"))
    with open(os.path.join(outdir, "objects.json"), "w") as f:
        json.dump({"image": "objects.png", "size": list(sheet.size), "frames": packed,
                   "clips": {}, "objects": objects}, f, separators=(",", ":"))
    return {"types": sorted(int(k) for k in objects), "frames": len(packed),
            "size": list(sheet.size)}


# --------------------------------------------------------------------------
# The intro and the hole-out, replayed from tools/snesstep/trace_cutscene.py

CUTSCENE_TRACE = os.path.join(ROOT, "build", "web-test", "cutscene_hole0.json")
CUTSCENE_PICS = os.path.join(ROOT, "build", "web-test", "cutscene_pics")
# Thread-object types that take part (docs/web-demo.md). 74 (the cup's ring)
# and 108 (the tee pad) keep world coordinates; every other type keeps screen
# coordinates, so its world position is screen + scroll.
CUTSCENE_TYPES = {
    "intro": {104, 105, 106, 107, 108, 109},
    "outro": {74, 108, 128, 129, 132},
    "outroHio": {74, 108, 128, 129, 132, 17, 99, 100, 103, 130, 131},
}
WORLD_TYPES = {74, 108}
ANCHOR_TYPE = {"tee": 108, "cup": 74}
# Where each window starts: the intro at the request of the hole's song (the
# screen is still black; it fades in from 2183), the hole-outs on the frame
# the ball is holed (`$DA4A` = 1; the holed effect $21 follows two frames later).
CUTSCENE_START = {"intro": 2169, "outro": 3121, "outroHio": 3121}


def night_cgram():
    """(day, night) BG CGRAM as 128 RGB colours each, from the HOLE IN ONE
    window of the trace (the frame before the swap and the frame of it), or
    None without a trace."""
    if not os.path.exists(CUTSCENE_TRACE):
        return None
    from tiles import snes_color
    tr = json.load(open(CUTSCENE_TRACE))
    w = tr["windows"].get("outroHio")
    if not w:
        return None
    pals = [bytes.fromhex(p) for p in tr["palettes"]]
    frames = [fr for fr in w["frames"] if fr["f"] >= CUTSCENE_START["outroHio"]]
    day = pals[frames[0]["pal"]]
    swap = next((fr for fr in frames if pals[fr["pal"]][:2] != day[:2]), None)
    if swap is None:
        return None
    night = pals[swap["pal"]]

    def cols(b):
        return [snes_color(b[2 * i] | (b[2 * i + 1] << 8)) for i in range(128)]
    return cols(day), cols(night)


def build_cutscenes(atlas):
    """cutscenes.json: per window and frame, the sprites relative to an anchor
    (the tee pad or the cup ring, where the recorded run had them), the camera
    relative to the same anchor, the brightness and the sound requests."""
    if not os.path.exists(CUTSCENE_TRACE):
        print("cutscenes: {} missing (tools/snesstep/trace_cutscene.py); skipped".format(
            CUTSCENE_TRACE))
        return None
    from PIL import Image
    tr = json.load(open(CUTSCENE_TRACE))
    pics = tr["pictures"]

    def pos_of(win, typ):
        for fr in win["frames"]:
            for o in fr["objs"]:
                if o[0] == typ:
                    return o[2], o[3]
        raise SystemExit("cutscenes: no type {} in the trace".format(typ))

    anchors = {"tee": pos_of(tr["windows"]["intro"], ANCHOR_TYPE["tee"]),
               "cup": pos_of(tr["windows"]["outro"], ANCHOR_TYPE["cup"])}
    names = ["tee", "cup"]
    palettes = [bytes.fromhex(p) for p in tr["palettes"]]
    out = {"about": "tools/export_web_sprites.py build_cutscenes from {}".format(
               os.path.relpath(CUTSCENE_TRACE, ROOT)),
           "anchors": {k: list(v) for k, v in anchors.items()}, "windows": {}}
    for name, win in tr["windows"].items():
        types = CUTSCENE_TYPES[name]
        start = CUTSCENE_START[name]
        main = "tee" if name == "intro" else "cup"
        ax, ay = anchors[main]
        frames = [fr for fr in win["frames"] if fr["f"] >= start]
        if name == "intro":
            # until the aim stage (Kirby's state 4) takes over
            end = next(fr["f"] for fr in frames if fr["state"] == 4)
        else:
            # until the screen is blanked after the fade-out
            lit = False
            end = None
            for fr in frames:
                if fr["inidisp"] & 0x80 == 0 and fr["inidisp"] & 15:
                    lit = True
                elif lit and fr["inidisp"] & 0x80:
                    end = fr["f"]
                    break
        frames = [fr for fr in frames if fr["f"] < end]
        day = palettes[frames[0]["pal"]]
        night = None
        sprites_ = []
        for i, fr in enumerate(frames):
            if night is None and palettes[fr["pal"]][:2] != day[:2]:
                night = i
            sx, sy = fr["scroll"]
            row = []
            for typ, slot, x, y, pic in fr["objs"]:
                if typ not in types:
                    continue
                key = "cs_" + pic
                if key not in atlas.names:
                    m = pics[pic]
                    img = Image.open(os.path.join(CUTSCENE_PICS, m["file"])).convert("RGBA")
                    atlas.add(key, img, m["ox"], m["oy"], trim=False)
                if typ in WORLD_TYPES:
                    a = "tee" if typ == 108 else "cup"
                    bx, by = anchors[a]
                    row.append([key, x - bx, y - by, names.index(a), -1])
                else:
                    # screen space: lower slots are drawn on top
                    row.append([key, x + sx - ax, y + sy - ay, names.index(main), 64 - slot])
            sprites_.append(row)
        camera = [[fr["scroll"][0] - ax, fr["scroll"][1] - ay] for fr in frames]
        brightness = [0 if fr["inidisp"] & 0x80 else fr["inidisp"] & 15 for fr in frames]
        # the scroll is set up under the blanked screen: show the first lit one
        lit = next(i for i, b in enumerate(brightness) if b)
        camera[:lit] = [camera[lit]] * lit
        out["windows"][name] = {
            "recorded": [frames[0]["f"], end],
            "length": len(frames),
            "anchor": main,
            "camera": camera,
            "brightness": brightness,
            "hideKirby": next((i for i, fr in enumerate(frames) if fr["state"] == 1), None),
            "night": night,
            "cues": [[f - start, kind, i] for f, kind, i in win["cues"] if start <= f < end],
            "sprites": sprites_,
        }
    out["nightPalette"] = None
    if "outroHio" in out["windows"] and out["windows"]["outroHio"]["night"] is not None:
        w = tr["windows"]["outroHio"]
        i = out["windows"]["outroHio"]["night"]
        f0 = [fr for fr in w["frames"] if fr["f"] >= CUTSCENE_START["outroHio"]]
        out["nightPalette"] = {"day": tr["palettes"][f0[0]["pal"]],
                               "night": tr["palettes"][f0[i]["pal"]],
                               "frame": f0[i]["f"]}
    return out


if __name__ == "__main__":
    out = os.path.join(ROOT, "build", "web")
    os.makedirs(out, exist_ok=True)
    print(build(out))
