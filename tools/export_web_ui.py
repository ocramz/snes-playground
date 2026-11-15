#!/usr/bin/env python3
"""The shot panel of the real game, for the web demo (step `ui` of export_web.py).

While you choose the spin and the power the game draws, as OBJ sprites
anchored to Kirby's screen position (identical offsets with the camera in two
different places, checked): a "1" above him that bobs, a 48 x 48 face with a
vertical ruler and a marker, a gauge, and a row of four tomatoes. This script
reads them from the game itself.

It runs the stepper on tools/snesstep/inputs/web_ui.txt (hole 1: a fly shot,
the aim confirmed at frame 2800, the side selector swept 6 -> 0 -> 12 with
Left / Right, one power meter cycle) with snapshots at chosen frames, decodes
OAM and VRAM with tools/ppu_render.py, and writes build/web/ui.png + ui.json.

What the snapshots showed (frames of that script; A = the aim confirm, 2800):

    A + 46        the "1" appears at (-4, -38) .. (-4, -30) from Kirby's ball point,
                  bobbing -40 -39 -38 -39, one step per 8 frames
    A + 66        the panel appears; its gauge frame slides in over 4 frames (x 12, 16,
                  20, 23); the tomatoes appear with it
    A + 70        top/back starts to move (a fly shot), side answers Left / Right
    marker        vertical ruler and marker at x = -4 + 2 (side - 6); the marker dot at
                  y = 24 + 2 (topBack - 6); the horizontal bar at y = 24
    gauge         four 8 x 8 tiles stacked at x = 25, y = 13 .. 37; the tile per slot
                  depends on the meter (0-63): full tiles from the bottom, one partial

Tile numbers below are this hole's OBJ tile slots (found by comparing the OAM of
an aim frame with a spin frame): they are data of hole 1, not of the game.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

STEPPER = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
INPUT = os.path.join(HERE, "snesstep", "inputs", "web_ui.txt")
SNAP_DIR = os.path.join(ROOT, "build", "emu", "web_ui")
# the guide of a rolling shot (web_ui is a fly shot, whose guide uses other tiles)
GUIDE_INPUT = os.path.join(HERE, "snesstep", "inputs", "web_flow.txt")
GUIDE_DIR = os.path.join(ROOT, "build", "emu", "web_ui_guide")

# frames: the panel opening, then the side / top-back sweep, then the meter
OPEN_FRAMES = list(range(2836, 2876))
SWEEP_FRAMES = list(range(2876, 3126, 4))
METER_FRAMES = list(range(3126, 3256))
LAST = 3260
BASE_FRAME = 2870            # the panel fully open, all four tomatoes (the one about to be spent blinks later)
WORD7 = 232                  # hole 1, header word 7
Z_STEP = 23170.0

RULER = (55, 56)
MARKER = (57, 58)
GAUGE = tuple(range(70, 78))
# the 3 x 3 tiles of the face: the ball fills with red from the bottom as the meter rises
FACE = (16, 18, 20, 22, 24, 26, 28, 30, 48)
BASE = FACE + (50, 52, 54, 66, 67)
ONE = (128, 144)
TOMATO = (352,)
# the aim stage's guide: a dot (115), and the cone at the end of the path (142 on top of 158)
DOT, CONE_TOP, CONE_BOTTOM = 115, 142, 158
GUIDE_FRAME = 2702           # web_flow, aim stage held at 328 degrees: four dots and the cone
UI_TILES = set(RULER + MARKER + GAUGE + BASE + ONE + TOMATO + (DOT, CONE_TOP, CONE_BOTTOM))


def capture(force=False):
    if os.path.isdir(SNAP_DIR) and os.listdir(SNAP_DIR) and os.path.isdir(GUIDE_DIR) and not force:
        return
    if not os.path.exists(STEPPER):
        raise SystemExit("build the stepper first (docs/tooling.md)")
    os.makedirs(SNAP_DIR, exist_ok=True)
    frames = OPEN_FRAMES + SWEEP_FRAMES + METER_FRAMES
    os.makedirs(GUIDE_DIR, exist_ok=True)
    subprocess.run([STEPPER, "--frames", str(GUIDE_FRAME + 4), "--input", GUIDE_INPUT,
                    "--snap-at", str(GUIDE_FRAME), "--no-dsp", "--quiet", "--out", GUIDE_DIR], check=True)
    subprocess.run([STEPPER, "--frames", str(LAST), "--input", INPUT,
                    "--snap-at", ",".join(str(f) for f in frames),
                    "--no-dsp", "--quiet", "--out", SNAP_DIR], check=True)


def w16(m, a):
    return m[a] | (m[a + 1] << 8)


def read(frame, base=None):
    """One snapshot: Kirby's screen anchor, side, top/back, meter and the UI sprites."""
    import numpy as np
    import ppu_render as P
    path = os.path.join(base or SNAP_DIR, "f%06d" % frame)
    snap = P.Snapshot(path)
    m = open(os.path.join(path, "wram.bin"), "rb").read()
    x = w16(m, 0xD8AE) + w16(m, 0xD8AA) / 65536.0
    y = w16(m, 0xD8B6) + w16(m, 0xD8B2) / 65536.0
    z = (w16(m, 0xD8BE) << 16) | w16(m, 0xD8BA)
    if z >= 1 << 31:
        z -= 1 << 32
    cam = (snap.ppu["bg_hofs"][0], snap.ppu["bg_vofs"][0])
    ax = 32 * (x + y) - cam[0]
    ay = WORD7 + 16 * (x - y) - 16 * z / Z_STEP - cam[1]
    small, large = P.OBJ_SIZES[(snap.ppu["obsel"] >> 5) & 7]
    ents = []
    for i in range(128):
        ox, oy, tile, attr = (int(v) for v in snap.oam[4 * i:4 * i + 4])
        hi = (int(snap.oam[512 + i // 4]) >> (2 * (i % 4))) & 3
        if hi & 1:
            ox -= 256
        tile |= (attr & 1) << 8
        if tile not in UI_TILES:
            continue
        wd, _ = large if hi & 2 else small
        pal = (attr >> 1) & 7
        hf, vf = bool(attr & 0x40), bool(attr & 0x80)
        n = wd // 8
        img = np.zeros((wd, wd), dtype=np.uint8)
        for ty in range(n):
            for tx in range(n):
                img[ty * 8:ty * 8 + 8, tx * 8:tx * 8 + 8] = P.tile_at(
                    snap, 4, P.obj_tile_word(snap, tile, tx, ty))
        if hf:
            img = img[:, ::-1]
        if vf:
            img = img[::-1, :]
        idx = np.where(img > 0, 128 + pal * 16 + img, 0)
        rgb = (snap.cgram5[idx] * 255 // 31).astype(np.uint8)
        a = np.where(img > 0, 255, 0).astype(np.uint8)
        ents.append({"i": i, "tile": tile, "x": int(round(ox - ax)), "y": int(round(oy + 1 - ay)),
                     "w": wd, "rgba": np.dstack([rgb, a]),
                     "hf": hf, "vf": vf})
    return {"f": frame, "side": w16(m, 0x6B50), "tb": w16(m, 0x6B52), "meter": w16(m, 0x6B3A),
            "ents": ents}


def build(outdir):
    import hashlib
    from PIL import Image
    from export_web_sprites import Atlas
    capture()
    atlas = Atlas()
    names = {}

    def pic(e):
        """Atlas name of a decoded sprite (same pixels share one picture)."""
        key = hashlib.md5(e["rgba"].tobytes()).hexdigest()[:8]
        name = "u_" + key
        if name not in names:
            names[name] = True
            atlas.add(name, Image.fromarray(e["rgba"], "RGBA"), 0, 0, trim=False)
        return name

    base = read(BASE_FRAME)
    out = {}
    assert sum(1 for e in base["ents"] if e["tile"] in TOMATO) == 4, "BASE_FRAME shows fewer than four tomatoes"
    assert sum(1 for e in base["ents"] if e["tile"] == 50 and e["x"] == 23) == 1, "gauge frame not in place"

    # --- static parts, back to front (OAM: a lower index is drawn in front) ----
    static = [e for e in base["ents"] if e["tile"] in BASE or e["tile"] in ONE or e["tile"] in TOMATO]
    static.sort(key=lambda e: -e["i"])
    out["base"] = [{"f": pic(e), "x": e["x"], "y": e["y"], "t": e["tile"]} for e in static
                   if e["tile"] not in ONE and e["tile"] not in TOMATO and e["tile"] not in FACE]
    out["face"] = [{"f": pic(e), "x": e["x"], "y": e["y"]} for e in static if e["tile"] in FACE]
    # the two 8 x 8 tiles of the "1": the top one (128) at the bob height, the other 8 below
    out["one"] = [{"f": pic(e), "x": e["x"], "dy": 0 if e["tile"] == 128 else 8}
                  for e in static if e["tile"] in ONE]
    out["tomato"] = [{"f": pic(e), "x": e["x"], "y": e["y"]} for e in sorted(
        (e for e in static if e["tile"] in TOMATO), key=lambda e: e["x"])]

    # --- the ruler and the marker: x follows `side`, the dot's y follows top/back ----
    sx = lambda side: -4 + 2 * (side - 6)
    ruler = sorted((e for e in base["ents"] if e["tile"] in RULER), key=lambda e: -e["i"])
    out["ruler"] = [{"f": pic(e), "dx": e["x"] - sx(base["side"]), "y": e["y"]} for e in ruler]
    for e in sorted((e for e in base["ents"] if e["tile"] in MARKER), key=lambda e: -e["i"]):
        out["bar" if e["tile"] == 58 else "dot"] = {"f": pic(e), "dx": e["x"] - sx(base["side"])}
    # a check against every sweep frame: the ruler x and the bar must follow side (the
    # sprites lag the variable by a frame or two while it moves, so only count frames at rest)
    sweep = [read(f) for f in SWEEP_FRAMES]
    ok = bad = 0
    for s in sweep:
        for e in s["ents"]:
            if e["tile"] == 58:
                if abs(e["x"] - (sx(s["side"]) + out["bar"]["dx"])) <= 2:
                    ok += 1
                else:
                    bad += 1
    out["markerCheck"] = {"ok": ok, "bad": bad}

    # --- the meter: the gauge tiles and the face tiles per meter value ---------------
    # What a snapshot shows is older than the WRAM it was taken with: the gauge sprites
    # are built from the meter one frame earlier, the face picture reaches VRAM one frame
    # after that (found by trying lags 0-8: only lag 1 for the gauge and lag 2 for the face
    # make the picture a pure function of the meter).
    series = [(f, read(f)) for f in METER_FRAMES]
    meters = {f: s["meter"] for f, s in series}
    gauge, face = {}, {}
    conflicts = 0
    for f, s in series:
        for lag, table, tiles, key in ((1, gauge, GAUGE, lambda e: e["y"]),
                                       (2, face, FACE, lambda e: (e["y"], e["x"]))):
            if f - lag not in meters:
                continue
            ents = sorted((e for e in s["ents"] if e["tile"] in tiles), key=key)
            item = [{"f": pic(e), "x": e["x"], "y": e["y"]} for e in ents]
            level = meters[f - lag]
            if level in table and table[level] != item:
                conflicts += 1
            table.setdefault(level, item)
    out["gauge"] = {str(k): v for k, v in sorted(gauge.items())}
    out["faces"] = {str(k): v for k, v in sorted(face.items())}
    out["levelCheck"] = {"gauge": len(gauge), "face": len(face), "conflicts": conflicts}

    # --- the guide of the aim stage: a dot and the cone (two tiles stacked) ----------
    gs = read(GUIDE_FRAME, GUIDE_DIR)
    dot = next(e for e in gs["ents"] if e["tile"] == DOT)
    top = next(e for e in gs["ents"] if e["tile"] == CONE_TOP)
    bottom = next(e for e in gs["ents"] if e["tile"] == CONE_BOTTOM)
    cone = Image.new("RGBA", (8, 16), (0, 0, 0, 0))
    cone.paste(Image.fromarray(top["rgba"], "RGBA"), (0, 0))
    cone.paste(Image.fromarray(bottom["rgba"], "RGBA"), (0, 8))
    atlas.add("u_cone", cone, 0, 0, trim=False)
    out["guide"] = {"dot": pic(dot), "cone": "u_cone",
                    "note": "the dot's 8x8 centre sits at the path point + (-3, 0); the cone's top-left at the "
                            "path end + (-6, -15) (measured: 31 aim angles, tools/snesstep/trace_flow.py)"}
    # ... and from the water: with $D9EE set the guide draws palette 0's own
    # pictures ($81:ACF6: $89:8F52 for a rolling dot, $81:ADF6: $89:8F6B for the
    # end; same offsets as the dry lists), in the wet palette: drawn from the
    # aim in the pond of web_water_shot (export_web_sprites.py's snapshot)
    from export_web_sprites import WATER_REF_AIM, draw_list, water_ref_snapshot
    wet = water_ref_snapshot(WATER_REF_AIM)
    atlas.add("u_dot_wet", draw_list(wet, 0x8F52)[0], 0, 0, trim=False)
    atlas.add("u_cone_wet", draw_list(wet, 0x8F6B)[0], 0, 0, trim=False)
    out["guide"]["dotWet"] = "u_dot_wet"
    out["guide"]["coneWet"] = "u_cone_wet"

    # --- timings, from the frames of web_ui (A = 2800) -----------------------------
    # the "1" bobs: -40 from +46, -39 from +54, then from +70 a 32 frame cycle
    # (-38 -39 -40 -39, 8 frames each; changes at frames 2870, 3134, 3142, ... in every frame
    # snapshot, checked at 3134 = 2870 + 33 * 8)
    out["timing"] = {"one": 46, "panel": 66, "ready": 70, "slide": [-11, -7, -3, 0],
                     "oneIntro": [[46, -40], [54, -39]],
                     "oneCycle": {"from": 70, "frames": 8, "values": [-38, -39, -40, -39]},
                     "meterStart": 5}
    out["anchorNote"] = "x, y are relative to the ball's projected point (Kirby's object position)"

    sheet, frames = atlas.pack(width=256)
    sheet.save(os.path.join(outdir, "ui.png"))
    out["image"] = "ui.png"
    out["size"] = list(sheet.size)
    out["frames"] = {n: {"x": f["x"], "y": f["y"], "w": f["w"], "h": f["h"]} for n, f in frames.items()}
    with open(os.path.join(outdir, "ui.json"), "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    return {"pictures": len(frames), "marker": out["markerCheck"], "levels": out["levelCheck"]}


if __name__ == "__main__":
    o = os.path.join(ROOT, "build", "web")
    os.makedirs(o, exist_ok=True)
    print(build(o))
