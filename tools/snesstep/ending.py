#!/usr/bin/env python3
"""Snapshot the end of a whole-game autoplay run: medal award, King Dedede,
the ending and the credits.

tools/snesstep/autoplay.py, played to the end, leaves `pokes.txt` and
`input.txt` in its output directory. Replaying them is deterministic, so
this script replays the run twice:

1. once to find where the screens are: the frames of the scene requests at
   `$80:CABC` for scene 15 (the medal award after the last course, when
   every course has a medal), 18 (the ending, `$87:F028`) and 19 (the
   credits, `$84:FB26`), and where the fight with King Dedede begins
   (the first "boss hp" event in the run's log.json);
2. once more taking snapshots there. The run presses A every 20 frames,
   which dismisses the medal award within a frame or two, so a third
   replay, stopped at the award, leaves A out after scene 15 (holding the
   award up shifts everything after it, and the recorded pokes are by
   frame).

Every snapshot is rendered (tools/ppu_render.py). The credits are kept
whole in `build/screens/ending/`, and a few named screens are copied to
`build/screens/`.

    python3 tools/snesstep/autoplay.py --frames 135000 --out build/emu/autoplay/game
    python3 tools/snesstep/ending.py build/emu/autoplay/game
    python3 tools/snesstep/ending.py build/emu/autoplay/extra --prefix extra_
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
RENDER = os.path.join(ROOT, "tools", "ppu_render.py")
CREDITS = 7600          # frames from the credits' scene request to END
STEP = 45               # credits snapshot spacing


def replay(run, out, frames, extra, inp=None):
    shutil.rmtree(out, ignore_errors=True)
    # A run that booted from a save (autoplay.py --extra) replays from it.
    sram = []
    cfg = os.path.join(run, "run.json")
    if os.path.exists(cfg):
        with open(cfg) as f:
            path = json.load(f).get("sram")
        if path:
            sram = ["--sram", path]
    subprocess.run([BIN, "--frames", str(frames)] + sram + [
                    "--input", inp or os.path.join(run, "input.txt"),
                    "--pokes", os.path.join(run, "pokes.txt"),
                    "--no-dsp", "--quiet", "--out", out] + extra, check=True)


def scene_calls(pclog):
    """[(frame, scene)] from a pclog.tsv of $80:CABC."""
    out = []
    with open(pclog) as f:
        next(f)
        for line in f:
            r = line.rstrip("\n").split("\t")
            if r[3] == "$80:CABC":
                out.append((int(r[0]), int(r[4], 16)))
    return out


def render(snap, png, layers=False):
    cmd = [sys.executable, RENDER, snap, "-o", png]
    if layers:
        cmd += ["--layers", png[:-4] + "_layers"]
    subprocess.run(cmd, check=False, stdout=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run", help="an autoplay.py output directory played past the ending")
    ap.add_argument("--prefix", default="",
                    help="prefix for the screen names, e.g. extra_ for the extra game")
    a = ap.parse_args()
    run = os.path.abspath(a.run)
    work = os.path.join(run, "ending")
    os.makedirs(work, exist_ok=True)

    # Pass 1: where things are.
    with open(os.path.join(run, "log.json")) as f:
        log = json.load(f)
    boss = [e["frame"] for e in log["events"] if e["event"] == "boss hp"]
    with open(os.path.join(run, "pokes.txt")) as f:
        last = max(int(l.split(":")[0]) for l in f if l.strip()) + 2000
    find = os.path.join(work, "find")
    replay(run, find, last, ["--log-pc", "$80:CABC"])
    calls = scene_calls(os.path.join(find, "pclog.tsv"))
    first = {}
    for fr, sc in calls:
        first.setdefault(sc, fr)
    missing = [s for s in (18, 19) if s not in first]
    if missing:
        sys.exit("the run does not reach scene(s) {}".format(missing))
    print("scene requests: " + ", ".join(
        "{} at {}".format(s, first[s]) for s in (15, 18, 19) if s in first))

    # Pass 2: snapshots. Name -> frame.
    named = {}
    if boss:
        named["dedede_fight"] = boss[0] - 200     # lined up for the first shot
    named["dedede_defeated"] = first[18] - 150
    named["ending"] = first[18] + 60
    credits = list(range(first[19] + 60, first[19] + CREDITS, STEP))
    named["credits"] = credits[20]          # PROGRAMMERS, with names
    named["end_screen"] = credits[-1]
    frames = sorted(set(named.values()) | set(credits))
    shots = os.path.join(work, "snaps")
    replay(run, shots, frames[-1] + 1,
           ["--snap-at", ",".join(str(f) for f in frames)])
    where = dict((n, shots) for n in named)
    # The medal award separately: without the A presses that dismiss it.
    # Holding it up shifts everything after it, and the recorded pokes are
    # by frame, so this replay stops there.
    if 15 in first:
        inp = os.path.join(work, "input_medal.txt")
        with open(os.path.join(run, "input.txt")) as src, open(inp, "w") as dst:
            for line in src:
                f = line.split()
                if f and f[0].isdigit() and first[15] - 40 <= int(f[0]) < first[15] + 500:
                    continue
                dst.write(line)
        medal = os.path.join(work, "medal")
        named["medal_award"] = first[15] + 300
        replay(run, medal, named["medal_award"] + 1,
               ["--snap-at", str(named["medal_award"])], inp=inp)
        where["medal_award"] = medal

    dest = os.path.join(ROOT, "build", "screens")
    seq = os.path.join(dest, a.prefix + "ending")
    shutil.rmtree(seq, ignore_errors=True)
    os.makedirs(seq)
    for i, fr in enumerate(credits):
        render(os.path.join(shots, "f{:06d}".format(fr)),
               os.path.join(seq, "credits_{:03d}.png".format(i)))
    for name, fr in named.items():
        render(os.path.join(where[name], "f{:06d}".format(fr)),
               os.path.join(dest, a.prefix + name + ".png"), layers=True)
    print("{} named screens and {} credits frames -> {}".format(
        len(named), len(credits), os.path.relpath(dest, ROOT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
