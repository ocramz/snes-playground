#!/usr/bin/env python3
"""Frame-level timeline of the game's UI-side state, for the web demo.

Runs tools/snesstep on an input script with `--watch-write` on a set of WRAM
words (Kirby's animation state, facing, shot angle, aim, the spin selectors,
the power meter, the camera, the ball's cell and the airborne / shot-over
flags) and writes the frames at which each one changes.

    $7E:D7D4  Kirby's animation state (docs/animation.md: 4 aim, 5 aim turning,
              6 curl, 7 unroll, 12 squash, 13 hop, 14/15/16 roll)
    $7E:D7C4  facing (8)         $7E:D7CC  shot angle (16)
    $7E:D9B4  aim phi, degrees   $7E:D9B6  elevation
    $7E:6B50  side selector      $7E:6B52  top/back selector
    $7E:6B3A  power meter
    $7E:0086 / $7E:0088  camera x / y (scroll of the course)
    $7E:38AC / $7E:38AE  the world camera behind it; $6AAA / $6AAC its aim-stage target;
    $7E:DA58 / $7E:DA5C  Kirby's projected position
    $7E:D8AE / $7E:D8B6  ball cell x / y    $7E:D8A6  airborne
    $7E:D9BE  shot over

    python3 tools/snesstep/trace_flow.py web_flow --frames 4600

Output: build/web-test/flow_<name>.json   {"events": [[frame, name, value], ...]}
        (and the raw stepper run in build/emu/flow_<name>).
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")

WATCH = {
    "state": 0xD7D4, "facing": 0xD7C4, "angle": 0xD7CC,
    "aim": 0xD9B4, "elev": 0xD9B6,
    "side": 0x6B50, "tb": 0x6B52, "meter": 0x6B3A,
    "camx": 0x0086, "camy": 0x0088,
    "cx38": 0x38AC, "cy38": 0x38AE,     # the world camera (the scroll is camx = $38AC, camy = 456 - $38AE)
    "tgtx": 0x6AAA, "tgty": 0x6AAC,     # the aim camera's focus: where the guide's path ends
    "kx": 0xDA58, "ky": 0xDA5C,         # Kirby's projected position (x, 456 - y)
    "kxf": 0xDA56, "kyf": 0xDA5A,       # ... and their fractions
    "px": 0xDA60, "py": 0xDA64, "pxf": 0xDA5E, "pyf": 0xDA62,   # last frame's
    "c2": 0x38C2, "c4": 0x38C4, "c6": 0x38C6, "c8": 0x38C8,    # the follow camera's lag: wanted, reached
    "st": 0x39D6,                       # the follow camera's state
    "bx": 0xD8AE, "by": 0xD8B6, "air": 0xD8A6, "over": 0xD9BE,
}


def s16(v):
    return v - 65536 if v >= 32768 else v


def trace(name, frames, out_dir, extra=()):
    inp = os.path.join(HERE, "inputs", name + ".txt")
    run = os.path.join(ROOT, "build", "emu", "flow_" + name)
    os.makedirs(run, exist_ok=True)
    cmd = [BIN, "--frames", str(frames), "--input", inp]
    for a in sorted(set(WATCH.values())):
        cmd += ["--watch-write", "$7E:{:04X}-$7E:{:04X}".format(a, a + 1)]
    cmd += list(extra) + ["--no-dsp", "--quiet", "--out", run]
    subprocess.run(cmd, check=True)

    mem = {}
    last = {}
    events = []
    by_addr = {}
    for n, a in WATCH.items():
        by_addr[a] = n
        by_addr[a + 1] = n
    cur_frame = None

    def flush(frame):
        for n, a in WATCH.items():
            v = mem.get(a, 0) | (mem.get(a + 1, 0) << 8)
            if n in ("aim", "elev", "camx", "camy", "bx", "by", "cx38", "cy38", "tgtx", "tgty", "kx", "ky",
                     "px", "py", "c2", "c4", "c6", "c8"):
                v = s16(v)
            if last.get(n) != v:
                last[n] = v
                events.append([frame, n, v])

    with open(os.path.join(run, "watch.tsv")) as f:
        next(f)
        for line in f:
            fr, _, _pc, addr, _, new = line.rstrip("\n").split("\t")
            fr = int(fr)
            if cur_frame is not None and fr != cur_frame:
                flush(cur_frame)
            cur_frame = fr
            mem[int(addr.split(":")[1], 16)] = int(new, 16)
    if cur_frame is not None:
        flush(cur_frame)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "flow_{}.json".format(name))
    with open(path, "w") as f:
        json.dump({"name": name, "events": events}, f, separators=(",", ":"))
    print("{}: {} events -> {}".format(name, len(events), path))
    return events


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", help="input script in tools/snesstep/inputs/ (without .txt)")
    ap.add_argument("--frames", type=int, default=4600)
    ap.add_argument("--out", default=os.path.join(ROOT, "build", "web-test"))
    args = ap.parse_args()
    if not os.path.exists(BIN):
        print("build the stepper first (docs/tooling.md)", file=sys.stderr)
        return 1
    trace(args.name, args.frames, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
