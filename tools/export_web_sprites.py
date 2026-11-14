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
SHEET_DIR = os.path.join(ROOT, "build", "web-sprites")
KIRBY_CLIPS = os.path.join(ROOT, "build", "sprites", "kirby", "clips")

SNAP_FIRST, SNAP_LAST, SNAP_EVERY = 2110, 3960, 3
TREE_SNAP = "f002350"      # camera clear of the tree: whole sprite on screen
TREE_REF = "f002302"       # camera (192, 152): tree frame top-left at (168, 168)

KIRBY_CLIP_NAMES = (
    "aim_facing", "aim_turn_facing", "curl_into_ball_angle", "unroll_angle",
    "wait_turn_facing", "ball_squash_squash", "hop_", "ball_roll", "ball_sink",
    "tired_health")


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

    ring = sheet_frames(os.path.join(SHEET_DIR, "obj_074"))
    atlas.add("cupring", *ring[0])
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

    sheet, frames = atlas.pack()
    sheet.save(os.path.join(outdir, "sprites.png"))
    with open(os.path.join(outdir, "sprites.json"), "w") as f:
        json.dump({"image": "sprites.png", "size": list(sheet.size),
                   "frames": frames, "clips": clips}, f, separators=(",", ":"))
    return {"frames": len(frames), "clips": len(clips), "size": list(sheet.size)}


if __name__ == "__main__":
    out = os.path.join(ROOT, "build", "web")
    os.makedirs(out, exist_ok=True)
    print(build(out))
