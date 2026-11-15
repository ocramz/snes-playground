#!/usr/bin/env python3
"""Pixel check of the web demo's shot panel against the real game's sprites.

    python3 tools/check_web_ui.py            # writes the states, runs the browser, compares
    python3 tools/check_web_ui.py --target engine   # the same for engine/ (its dev server, port 5174)

Needs `npm run dev` running in web/ (or engine/), the snapshots of tools/export_web_ui.py and
Playwright's cached Chromium. For a set of frames of tools/snesstep/inputs/web_ui.txt
it draws the UI sprites of the real snapshot (anchored at (128, 100)) and the panel as
the browser draws it for the same side / top-back / meter / age, on black, and counts
the differing pixels above the tomato row (the tomato about to be spent blinks).
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

FRAMES = [2870, 2871, 2872, 2900, 2960, 3000, 3040, 3092, 3128, 3129, 3134, 3135, 3137, 3140, 3160, 3180, 3189, 3200, 3220, 3250]
A_FRAME = 2800
# where each target's ui.json is, which directory runs its browser half, and the output
TARGETS = {
    "web": {"ui": os.path.join(ROOT, "build", "web", "ui.json"), "cwd": os.path.join(ROOT, "web"),
            "out": os.path.join(ROOT, "build", "web-test", "panel")},
    "engine": {"ui": os.path.join(ROOT, "build", "engine", "assets", "ui.json"), "cwd": os.path.join(ROOT, "engine"),
               "out": os.path.join(ROOT, "build", "engine", "test-panel")},
}


def real_state(frame, ui):
    import export_web_ui as E
    s = E.read(frame)
    side = tb = None
    for e in s["ents"]:
        if e["tile"] == 58:
            side = (e["x"] + 4) // 2 + 6
        if e["tile"] == 57:
            tb = (e["y"] - 24) // 2 + 6
    # the meter the sprites show: the level whose tiles equal the gauge sprites
    shown = sorted((e["x"], e["y"], e["tile"]) for e in s["ents"] if e["tile"] in E.GAUGE)
    return s, side, tb, shown


def wram_meter(frame):
    import export_web_ui as E
    m = open(os.path.join(E.SNAP_DIR, "f%06d" % frame, "wram.bin"), "rb").read()
    return m[0x6B3A] | (m[0x6B3B] << 8)


def canvas(ents, only=None):
    import numpy as np
    img = np.zeros((224, 256, 4), dtype=np.uint8)
    img[:, :, 3] = 255
    for e in sorted(ents, key=lambda e: -e["i"]):
        if only is not None and not only(e):
            continue
        h, w = e["rgba"].shape[:2]
        x0, y0 = 128 + e["x"], 100 + e["y"]
        for yy in range(h):
            for xx in range(w):
                if e["rgba"][yy, xx, 3] and 0 <= y0 + yy < 224 and 0 <= x0 + xx < 256:
                    img[y0 + yy, x0 + xx] = e["rgba"][yy, xx]
    return img


def main():
    import numpy as np
    from PIL import Image
    import export_web_ui as E
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", choices=sorted(TARGETS), default="web")
    target = TARGETS[ap.parse_args().target]
    OUT = target["out"]
    ui = json.load(open(target["ui"]))
    os.makedirs(OUT, exist_ok=True)
    states, reals = [], {}
    for f in FRAMES:
        s, side, tb, shown = real_state(f, ui)
        m1 = m2 = -1
        if f >= E.METER_FRAMES[0] + 2:
            m1, m2 = wram_meter(f - 1), wram_meter(f - 2)
        states.append({"name": "f%d" % f, "age": f - A_FRAME, "side": side, "tb": tb, "meter1": m1, "meter2": m2})
        reals[f] = s
    sp = os.path.join(OUT, "states.json")
    json.dump(states, open(sp, "w"))
    subprocess.run(["node", "test/e2e/panel.mjs", sp, OUT], cwd=target["cwd"], check=True)
    bad = 0
    for f, st in zip(FRAMES, states):
        mine = np.array(Image.open(os.path.join(OUT, "panel_f%d.png" % f)).convert("RGBA"))
        real = canvas(reals[f]["ents"], only=lambda e: e["tile"] not in E.TOMATO)
        # the region above the tomato row; the bob of the "1" and everything else must agree
        a, b = mine[:150], real[:150]
        diff = int((np.abs(a[:, :, :3].astype(int) - b[:, :, :3].astype(int)).sum(axis=2) > 0).sum())
        print("%s f%d side %s tb %s meter %s/%s age %d: %d pixels differ" % (
            "ok  " if diff == 0 else "FAIL", f, st["side"], st["tb"], st["meter1"], st["meter2"], st["age"], diff))
        bad += diff != 0
        if diff:
            Image.fromarray(np.hstack([a, b])).save(os.path.join(OUT, "diff_f%d.png" % f))
    print("all identical" if not bad else "%d frames differ (see %s)" % (bad, os.path.relpath(OUT, ROOT)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
