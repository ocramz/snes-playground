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
    $7E:D7F0  tomatoes   $7E:D7F4  lives   $7E:D82A  strokes + 1   $7E:6A10  stars
    $7E:DA4A  holed      $7E:69FE  the cup's slot   $7E:D80A  the card's hole 1
    $7E:68F6 / $7E:68F8  the tomato queue's read / write index
    $7E:D872  in the water   $7E:0504  OBJ palette 0 colour 2 (the wet swap)
    $7E:69DC  the water's skip count   $7E:0079 / $7E:007B  the random state

A script may come with tools/snesstep/inputs/<name>.pokes (one F:ADDR=VAL per
line, the stepper's --pokes format): it is passed along when it exists.

    python3 tools/snesstep/trace_flow.py web_flow --frames 4600

Output: build/web-test/flow_<name>.json   {"events": [[frame, name, value], ...]}
        build/web-test/sounds_<name>.json the sound requests ($80:B542 / $80:B4AC)
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
    "prio": 0xD96A,                     # Kirby's OAM priority ($82:F4FD; 1/2 behind the course)
    # the hole's counters (engine phase 6, read 2026-11-14)
    "tom": 0xD7F0,                      # tomatoes (Kirby's health), 0-4
    "lives": 0xD7F4,                    # spare lives
    "strokes": 0xD82A,                  # shots + 1 ($80:C1DC = 1, +1 per set-up)
    "stars": 0x6A10,                    # enemies taken by player 1
    "holed": 0xDA4A,                    # 1 holed, 2 sunk
    "cupslot": 0x69FE,                  # the last enemy's slot once it is the cup, else $FFFF
    "card0": 0xD80A,                    # the score card's first hole ($83:D4F6)
    "tqr": 0x68F6,                      # the tomato queue's read index ($83:ABDD)
    "tqw": 0x68F8,                      # ... and its write index ($83:ABC5)
    # the water (port_v2 phase 4)
    "wet": 0xD872,                      # in the water: the block's $D9EE ($82:F1B0)
    "pal": 0x0504,                      # OBJ palette 0 colour 2 in the CGRAM shadow ($80:90C8):
                                        # $2C9C dry ($98:C77A), $312F wet ($98:C796)
    "skips": 0x69DC,                    # the water's skip count ($82:8228)
    "rnga": 0x0079, "rngb": 0x007B,     # the random state ($80:87DD): the engine's tests seed from it
}


# Every sound request: sub_spc_play_sfx $80:B542 (A = the effect) and
# sub_spc_play_song $80:B4AC (A = the song's request byte, song + $7E).
SFX_PC, SONG_PC = "$80:B542", "$80:B4AC"
# A request in the first lines of a frame belongs to the main loop's
# iteration of the frame before (the loop runs past the vblank).
ITERATION_LINE = 112


def write_sounds(name, run, out_dir):
    """build/engine/rom-test/sounds_<name>.json: [frame, line, iteration,
    'sfx' | 'song', id, caller] per request, from the stepper's pclog.tsv."""
    rows = []
    with open(os.path.join(run, "pclog.tsv")) as f:
        head = next(f).rstrip("\n").split("\t")
        col = {k: i for i, k in enumerate(head)}
        for line in f:
            r = line.rstrip("\n").split("\t")
            fr, ln = int(r[col["frame"]]), int(r[col["line"]])
            kind = "sfx" if r[col["pc"]] == SFX_PC else "song"
            rows.append([fr, ln, fr - 1 if ln < ITERATION_LINE else fr, kind,
                         int(r[col["a"]], 16) & 0xFF, r[col["ret_long"]]])
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "sounds_{}.json".format(name))
    with open(path, "w") as f:
        json.dump({"name": name, "about": "[frame, line, iteration, kind, id, caller]",
                   "requests": rows}, f, separators=(",", ":"))


def s16(v):
    return v - 65536 if v >= 32768 else v


def trace(name, frames, out_dir, extra=()):
    inp = os.path.join(HERE, "inputs", name + ".txt")
    run = os.path.join(ROOT, "build", "emu", "flow_" + name)
    os.makedirs(run, exist_ok=True)
    cmd = [BIN, "--frames", str(frames), "--input", inp]
    pokes = os.path.join(HERE, "inputs", name + ".pokes")
    if os.path.exists(pokes):
        cmd += ["--pokes", pokes]
    for a in sorted(set(WATCH.values())):
        cmd += ["--watch-write", "$7E:{:04X}-$7E:{:04X}".format(a, a + 1)]
    cmd += ["--log-pc", SFX_PC, "--log-pc", SONG_PC]
    cmd += list(extra) + ["--no-dsp", "--quiet", "--out", run]
    subprocess.run(cmd, check=True)
    write_sounds(name, run, out_dir)

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
