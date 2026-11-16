#!/usr/bin/env python3
"""Play every hole for a while and collect what its sprites look like.

For each hole index (course * 8 + hole, the index into every bank `$88`
course table), run tools/snesstep through `inputs/play_hole1.txt` -- a new
member, course 1 -- but poke the course number `$7E:6A5A` and the hole
`$7E:6A5E` just before the hole is started, so the game loads that hole
instead. The script then takes two shots, which gets Kirby moving and the
enemies reacting. Snapshots every few frames go to tools/emusheets.py's
cache and are deleted, so the batch needs little disk.

Also renders the first in-play frame of every hole to
`<out>/screens/holeNNN.png`, writes `<out>/holes.tsv`, and merges every
run's executed instructions into build/emu/cov/holes.tsv for
tools/coverage.py.

    python3 tools/snesstep/holes.py                  # holes 0-231
    python3 tools/snesstep/holes.py --holes 0-63
    python3 tools/snesstep/holes.py --holes 19 --keep

`--script NAME:FROM-TO` (repeatable) adds the snapshots of one of the
input scripts (with its .pokes) to the same cache instead, one every frame
from FROM to TO, and rewrites the sheets: the water's splashes 56-58 are on
screen in no hole's two shots (port_v2 phase 4):

    python3 tools/snesstep/holes.py --holes none \
        --script web_water_drop:2478-2520 --script web_water_shallow:2466-2500
"""

import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
POKE_FRAME = 2050          # after the course intro is up, before A at 2100
START, END = 2150, 3400    # hole in play: idle, two shots, rolling
SHOT_FRAME = 2300          # the screen to keep per hole


def holes_arg(text):
    if text == "none":
        return []
    out = []
    for part in text.split(","):
        if "-" in part:
            lo, hi = part.split("-")
            out.extend(range(int(lo), int(hi) + 1))
        else:
            out.append(int(part))
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--holes", type=holes_arg, default=list(range(232)))
    ap.add_argument("--out", default=os.path.join(ROOT, "build", "emu", "holes"))
    ap.add_argument("--every", type=int, default=4, help="snapshot interval")
    ap.add_argument("--keep", action="store_true", help="keep the snapshots")
    ap.add_argument("--script", action="append", default=[],
                    help="NAME:FROM-TO, an input script's frames into the cache")
    args = ap.parse_args()
    if not os.path.exists(BIN):
        subprocess.run(["cargo", "build", "--release", "--offline", "--manifest-path",
                        os.path.join(HERE, "Cargo.toml")], check=True,
                       env=dict(os.environ, CARGO_TARGET_DIR=os.path.join(
                           ROOT, "build", "snesstep")))
    cache = os.path.join(args.out, "emusheets.pickle")
    os.makedirs(os.path.join(args.out, "screens"), exist_ok=True)
    rows = []
    executed = set()
    for idx in args.holes:
        course, hole = divmod(idx, 8)
        run = os.path.join(args.out, "h{:03d}".format(idx))
        snaps = ",".join(str(f) for f in range(START, END, args.every))
        proc = subprocess.run(
            [BIN, "--frames", str(END), "--input",
             os.path.join(HERE, "inputs", "play_hole1.txt"),
             "--poke", "{}:$7E:6A5A={:04X}".format(POKE_FRAME, course),
             "--poke", "{}:$7E:6A5E={:04X}".format(POKE_FRAME, hole),
             "--snap-at", snaps + ",{}".format(SHOT_FRAME),
             "--coverage", os.path.join(run, "coverage.tsv"),
             "--no-dsp", "--quiet", "--out", run],
            capture_output=True, text=True)
        ok = proc.returncode == 0
        loaded = "-"
        if ok:
            shot = os.path.join(run, "f{:06d}".format(SHOT_FRAME))
            with open(os.path.join(shot, "wram.bin"), "rb") as f:
                w = f.read()
            loaded = (w[0xABB6] | w[0xABB7] << 8) // 3
            subprocess.run([sys.executable, os.path.join(ROOT, "tools", "ppu_render.py"),
                            shot, "-o", os.path.join(args.out, "screens",
                                                     "hole{:03d}.png".format(idx))],
                           capture_output=True)
            with open(os.path.join(run, "coverage.tsv")) as f:
                next(f)
                executed.update(line.rstrip("\n") for line in f)
            dirs = sorted(os.path.join(run, d) for d in os.listdir(run)
                          if d.startswith("f"))
            subprocess.run([sys.executable, os.path.join(ROOT, "tools", "emusheets.py"),
                            "--cache", cache, "--no-write"] + dirs,
                           capture_output=True)
        rows.append((idx, course, hole, "ok" if ok else "failed", loaded))
        print("hole {:3d} (course {:2d} hole {}): {}, loaded index {}".format(
            idx, course, hole, rows[-1][3], loaded), flush=True)
        if not args.keep:
            shutil.rmtree(run, ignore_errors=True)
    for spec in args.script:
        name, window = spec.split(":")
        lo, hi = (int(v) for v in window.split("-"))
        run = os.path.join(args.out, "s_" + name)
        cmd = [BIN, "--frames", str(hi + 1), "--input",
               os.path.join(HERE, "inputs", name + ".txt"),
               "--snap-at", ",".join(str(f) for f in range(lo, hi + 1)),
               "--no-dsp", "--quiet", "--out", run]
        pokes = os.path.join(HERE, "inputs", name + ".pokes")
        if os.path.exists(pokes):
            cmd += ["--pokes", pokes]
        subprocess.run(cmd, check=True)
        dirs = sorted(os.path.join(run, d) for d in os.listdir(run) if d.startswith("f"))
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "emusheets.py"),
                        "--cache", cache, "--no-write"] + dirs, capture_output=True, check=True)
        print("script {} {}-{}: {} snapshots".format(name, lo, hi, len(dirs)), flush=True)
        if not args.keep:
            shutil.rmtree(run, ignore_errors=True)
    if not args.holes:
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "emusheets.py"),
                        "--cache", cache, "--out", os.path.join(ROOT, "build", "sprites", "emu")])
        return 0
    cov = os.path.join(ROOT, "build", "emu", "cov", "holes.tsv")
    os.makedirs(os.path.dirname(cov), exist_ok=True)
    with open(cov, "w") as f:
        f.write("snes_addr\tfile_offset\tm\tx\tlen\n")
        for line in sorted(executed, key=lambda l: l.split("\t")[1]):
            f.write(line + "\n")
    with open(os.path.join(args.out, "holes.tsv"), "w") as f:
        f.write("hole_index\tcourse\thole\trun\tloaded_index\n")
        for r in rows:
            f.write("\t".join(str(c) for c in r) + "\n")
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "emusheets.py"),
                    "--cache", cache, "--out",
                    os.path.join(ROOT, "build", "sprites", "emu")])
    return 0


if __name__ == "__main__":
    sys.exit(main())
