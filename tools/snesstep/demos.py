#!/usr/bin/env python3
"""Play the 20 demos of DEMOPLAY SELECT and collect their sprites.

The demos (title -> DEMO PLAY, scene 13) each show one copy ability or
hazard in a short scripted hole, so they show Kirby forms and effects that
two shots on an ordinary hole rarely reach. For entry K (0-19, five per row)
this moves the cursor K % 5 right and K // 5 down and presses A at frame
800; the demo runs from about frame 817 until it returns to the select
screen. Snapshots every few frames go to tools/emusheets.py's cache
(`<out>/emusheets.pickle`) and are deleted; the first in-play frame is kept
as `<out>/screens/demoKK.png`.

    python3 tools/snesstep/demos.py
    python3 tools/snesstep/demos.py --demos 0,7 --keep
"""

import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
START, END, SHOT = 820, 3600, 1200


def script(k):
    lines = ["400 START 2", "450 DOWN 2", "480 DOWN 2", "520 START 2"]
    f = 700
    for _ in range(k % 5):
        lines.append("{} RIGHT 2".format(f))
        f += 12
    for _ in range(k // 5):
        lines.append("{} DOWN 2".format(f))
        f += 12
    lines.append("800 A 2")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demos", default=",".join(str(k) for k in range(20)))
    ap.add_argument("--out", default=os.path.join(ROOT, "build", "emu", "demos"))
    ap.add_argument("--every", type=int, default=3)
    ap.add_argument("--keep", action="store_true")
    args = ap.parse_args()
    os.makedirs(os.path.join(args.out, "screens"), exist_ok=True)
    cache = os.path.join(args.out, "emusheets.pickle")
    executed = set()
    for k in (int(x) for x in args.demos.split(",")):
        run = os.path.join(args.out, "d{:02d}".format(k))
        os.makedirs(run, exist_ok=True)
        inp = os.path.join(run, "input.txt")
        with open(inp, "w") as f:
            f.write(script(k))
        snaps = ",".join(str(f) for f in range(START, END, args.every))
        proc = subprocess.run(
            [BIN, "--frames", str(END), "--input", inp, "--snap-at",
             snaps + ",{}".format(SHOT), "--coverage", os.path.join(run, "cov.tsv"),
             "--no-dsp", "--quiet", "--out", run], capture_output=True, text=True)
        if proc.returncode != 0:
            print("demo {:2d}: failed: {}".format(k, proc.stderr.strip()[:200]))
            continue
        with open(os.path.join(run, "cov.tsv")) as f:
            next(f)
            executed.update(line.rstrip("\n") for line in f)
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "ppu_render.py"),
                        os.path.join(run, "f{:06d}".format(SHOT)), "-o",
                        os.path.join(args.out, "screens", "demo{:02d}.png".format(k))],
                       capture_output=True)
        dirs = sorted(os.path.join(run, d) for d in os.listdir(run) if d.startswith("f"))
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "emusheets.py"),
                        "--cache", cache, "--no-write"] + dirs, capture_output=True)
        print("demo {:2d}: ok".format(k), flush=True)
        if not args.keep:
            shutil.rmtree(run, ignore_errors=True)
    cov = os.path.join(ROOT, "build", "emu", "cov", "demos.tsv")
    os.makedirs(os.path.dirname(cov), exist_ok=True)
    with open(cov, "w") as f:
        f.write("snes_addr\tfile_offset\tm\tx\tlen\n")
        for line in sorted(executed, key=lambda l: l.split("\t")[1]):
            f.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
