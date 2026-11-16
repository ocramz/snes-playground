#!/usr/bin/env python3
"""Per-frame ball state from the real game, for the web demo's physics tests.

Runs tools/snesstep on an input script with `--watch-write` over player 1's
ball block (docs/physics.md, "The ball's state") and rebuilds, for every frame,
the position, velocity and airborne flag the game left there. The TypeScript
port (web/src/sim/ball.ts) replays the shot from its first moving frame and
must reproduce the rest.

    player 1 block    x  $7E:D8AE (cell) : $D8AA (fraction)
                      y  $7E:D8B6 : $D8B2
                      z  $7E:D8BE : $D8BA   (16.16)
                      vx $D87A  vy $D87E  vz $D882   airborne $D8A6
                      spin x $D866, y $D86A, pending $D86E
                      in the water $D872 (the work copy's $D9EE)
                      the copy ability: stock $D852, worn $D856, mode $D85A,
                      the shot's use latch $D85E (the work copy's $D9C4-$D9CA)
    aim, elevation    $7E:D9B4, $7E:D9B6

    python3 tools/snesstep/trace_ball.py web_fly --frames 3700
    python3 tools/snesstep/trace_ball.py all          # every inputs/web_*.txt
    python3 tools/snesstep/trace_ball.py web_demo10   # DEMOPLAY demo 10, from frame 850

A script may come with inputs/<name>.pokes (the stepper's --pokes format); it
is passed along when it exists. FRAMES below lengthens the run of the scripts
that need it, and START moves the first kept frame of those that play earlier
than a hole picked at 2050 (the DEMOPLAY demos, web_demoNN: their hole is set
up at about frame 1030).

The ability words ($D852-$D85E) sit below the block: the trigger ($82:C8C2)
and the take ($82:8A70) write them from lower pcs than the block store, so
they are watched apart and never cut a burst; a record carries their value at
its burst's last block write (the store writes them first, `$82:F17A`-`F18F`),
so a record is the block as its store left it: the trigger's writes after the
store show in the next one (web_ab_c1 3050: the latch the transformation's
48 frames later).

Each record also carries `ln`, the scanline of its burst's first store: the
game's main loop often runs past the vblank, so a burst in the first lines of
frame F belongs to the loop iteration of F - 1 (the engine tests convert).

Output: build/web-test/trace_<name>.json (gitignored with the rest of build/).
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")

BLOCK = (0xD866, 0xD8C0)
SIDE = (0xD852, 0xD861)
FIELDS = {
    "xf": 0xD8AA, "xc": 0xD8AE, "yf": 0xD8B2, "yc": 0xD8B6,
    "zlo": 0xD8BA, "zhi": 0xD8BE, "vx": 0xD87A, "vy": 0xD87E, "vz": 0xD882,
    "air": 0xD8A6, "spinx": 0xD866, "spiny": 0xD86A, "spinp": 0xD86E,
    "aim": 0xD9B4, "elev": 0xD9B6,
    "wet": 0xD872,
    "stock": 0xD852, "worn": 0xD856, "mode": 0xD85A, "latch": 0xD85E,
}
SIDE_FIELDS = {k: a for k, a in FIELDS.items() if SIDE[0] <= a < SIDE[1]}


def s16(v):
    return v - 65536 if v >= 32768 else v


# Scripts that run longer than the default --frames (a second shot, a hole-out).
FRAMES = {"web_hole": 4700, "web_tomatoes": 5200, "web_water_shot": 3800,
          # the demos run until their hole-out (the stream ends with it)
          "web_demo10": 3910, "web_demo11": 3400, "web_demo12": 2680, "web_demo13": 3690,
          "web_demo14": 2780, "web_demo15": 3740, "web_demo16": 2420, "web_demo17": 3960,
          "web_demo18": 3490, "web_demo19": 4400, "web_ab_c1": 4300}
# The first frame kept, by name prefix, when it is not --from.
START = {"web_demo": 850}


def trace(args):
    inp = os.path.join(HERE, "inputs", args.name + ".txt")
    run = os.path.join(ROOT, "build", "emu", "trace_" + args.name)
    os.makedirs(run, exist_ok=True)
    frames = max(args.frames, FRAMES.get(args.name, 0))
    cmd = [BIN, "--frames", str(frames), "--input", inp,
           "--watch-write", "$7E:{:04X}-$7E:{:04X}".format(*BLOCK),
           "--watch-write", "$7E:D9B4-$7E:D9B7",
           "--watch-write", "$7E:{:04X}-$7E:{:04X}".format(*SIDE)]
    pokes = os.path.join(HERE, "inputs", args.name + ".pokes")
    if os.path.exists(pokes):
        cmd += ["--pokes", pokes]
    subprocess.run(cmd + ["--no-dsp", "--quiet", "--out", run], check=True)
    mem = {}
    out = []
    # The stepper writes a poke at the start of a frame's vblank, not through
    # the CPU, so the watch never sees it: apply them to the model at their
    # frame, before that frame's writes ({frame: [(addr, value)]}).
    poked = {}
    if os.path.exists(pokes):
        for line in open(pokes):
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            fr, rest = line.split(":", 1)
            addr, val = rest.split("=")
            a = int(addr.split(":")[1], 16)
            poked.setdefault(int(fr), []).append((a, int(val, 16)))
    applied = set()

    def apply_pokes(upto):
        for pf in sorted(poked):
            if pf <= upto and pf not in applied:
                for a, v in poked[pf]:
                    mem[a] = v & 0xFF
                    mem[a + 1] = (v >> 8) & 0xFF
                applied.add(pf)
    # The game copies the work copy back to the player block in a short burst
    # of stores (pcs $82:F1BF, F1C5, F1CB, ... in increasing order). A burst
    # can straddle a frame boundary, so a snapshot per *frame* is sometimes
    # torn. Cut on bursts instead: a new one starts when a store comes from a
    # lower pc than the previous store, hits a byte this burst already wrote,
    # or comes 100 or more scanlines after the burst began.
    def w(a):
        return mem.get(a, 0) | (mem.get(a + 1, 0) << 8)

    side = {}  # the ability words at the open burst's last block write

    def snap(frame, line, pc):
        s = {k: w(a) for k, a in FIELDS.items()}
        for k, a in SIDE_FIELDS.items():
            s[k] = side.get(k, w(a))
        s["f"] = frame
        s["ln"] = line
        s["pc"] = pc  # the burst's first writer: the store ($82:F1xx), or another (a reaction, an object)
        s["z"] = s["zhi"] * 65536 + s["zlo"]
        if s["zhi"] >= 32768:
            s["z"] -= 2 ** 32
        for k in ("vx", "vy", "vz", "xc", "yc", "spinx", "spiny", "latch"):
            s[k] = s16(s[k])
        return s

    start = next((v for p, v in START.items() if args.name.startswith(p)), args.start)
    burst_frame, burst_line, burst_pc, last_pc, seen = None, 0, "", -1, set()
    with open(os.path.join(run, "watch.tsv")) as f:
        next(f)
        for line in f:
            fr, ln, pc, addr, _, new = line.rstrip("\n").split("\t")
            fr = int(fr)
            apply_pokes(fr)
            a = int(addr.split(":")[1], 16)
            pcv = int(pc.split(":")[1], 16)
            in_block = BLOCK[0] <= a < BLOCK[1]
            if in_block:
                # a burst spans a few scanlines; a write 100 or more lines on
                # starts another (a store that changed only one byte of a
                # word, then the next store's other byte at the same pc,
                # would otherwise merge: web_ab_wheel_step 2534/2535)
                late = burst_frame is not None and (fr * 262 + int(ln)) - (burst_frame * 262 + burst_line) >= 100
                if (pcv < last_pc or a in seen or late) and burst_frame is not None:
                    if burst_frame >= start:
                        out.append(snap(burst_frame, burst_line, burst_pc))
                    burst_frame, seen = None, set()
                if burst_frame is None:
                    burst_frame, burst_line, burst_pc = fr, int(ln), pc
                last_pc = pcv
                seen.add(a)
            mem[a] = int(new, 16)
            if in_block:
                side = {k: w(sa) for k, sa in SIDE_FIELDS.items()}
    if burst_frame is not None and burst_frame >= start:
        out.append(snap(burst_frame, burst_line, burst_pc))
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "trace_{}.json".format(args.name))
    with open(path, "w") as f:
        json.dump({"name": args.name, "frames": out}, f, separators=(",", ":"))
    moving = sum(1 for s in out if s["vx"] or s["vy"] or s["vz"])
    print("{}: {} frames, {} with motion -> {}".format(args.name, len(out), moving, path))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", help="input script in tools/snesstep/inputs/ (without .txt), or 'all'")
    ap.add_argument("--frames", type=int, default=3700)
    ap.add_argument("--from", dest="start", type=int, default=2100,
                    help="first frame kept")
    ap.add_argument("--out", default=os.path.join(ROOT, "build", "web-test"))
    args = ap.parse_args()
    if not os.path.exists(BIN):
        print("build the stepper first (docs/tooling.md)", file=sys.stderr)
        return 1
    if args.name == "all":
        names = sorted(f[:-4] for f in os.listdir(os.path.join(HERE, "inputs"))
                       if f.startswith("web_") and f.endswith(".txt"))
    else:
        names = [args.name]
    for n in names:
        args.name = n
        trace(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
