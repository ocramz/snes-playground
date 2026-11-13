#!/usr/bin/env python3
"""Replay a recorded autoplay.py run and render chosen frames as named
screens in build/screens/.

    python3 tools/snesstep/capture.py build/emu/autoplay/two_player \\
        two_player_scorecard=12440 two_player_result=12860

The run directory holds input.txt, pokes.txt and run.json (its save file,
if it booted from one); the replay is deterministic, so a frame number
picked from one replay shows the same screen in the next.
"""

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ending import ROOT, render, replay  # noqa: E402


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run")
    ap.add_argument("shots", nargs="+", metavar="NAME=FRAME")
    a = ap.parse_args()
    run = os.path.abspath(a.run)
    named = dict((n, int(f)) for n, f in (s.split("=") for s in a.shots))
    work = os.path.join(run, "capture")
    frames = sorted(set(named.values()))
    replay(run, work, frames[-1] + 1,
           ["--snap-at", ",".join(str(f) for f in frames)])
    dest = os.path.join(ROOT, "build", "screens")
    os.makedirs(dest, exist_ok=True)
    for name, fr in named.items():
        render(os.path.join(work, "f{:06d}".format(fr)),
               os.path.join(dest, name + ".png"), layers=True)
        print("{} <- frame {}".format(name, fr))
    return 0


if __name__ == "__main__":
    sys.exit(main())
