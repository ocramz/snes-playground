#!/usr/bin/env python3
"""Per-frame state of chosen thread objects, for the engine's hazard tests.

Runs tools/snesstep on an input script (and its .pokes, when there is one)
with `--watch-write` over the thread-object slot arrays (docs/animation.md
"Thread objects": 64 slots, two bytes each) and, for every frame in which a
slot of one of the requested object types changes, records that slot:

    $4E1C type      $5D9C frame index     $5F1C / $5F9C position (draw space)
    $531C-$5A9C     the per-type fields: the hazard cube test reads x at
                    $581C/$589C, y at $591C/$599C, z at $5A1C/$5A9C

    python3 tools/snesstep/trace_actors.py web_haz76 --types 76,77,81,82,83

Output: build/web-test/actors_<name>.json
  {"name", "types", "fields": [...], "records": [[frame, line, slot, type, v...], ...]}
  (a record is the slot's state at the end of that frame's writes; `line`
  the scanline of its first write, as in trace_ball.py).
"""

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")

SLOTS = 64
TYPE = 0x4E1C
FIELDS = [0x531C + 0x80 * i for i in range(16)] + [0x5D9C, 0x5F1C, 0x5F9C]
NAMES = ["f{:04X}".format(a) for a in FIELDS]


def trace(name, frames, types, out_dir):
    inp = os.path.join(HERE, "inputs", name + ".txt")
    run = os.path.join(ROOT, "build", "emu", "actors_" + name)
    os.makedirs(run, exist_ok=True)
    cmd = [BIN, "--frames", str(frames), "--input", inp,
           "--watch-write", "$7E:{:04X}-$7E:{:04X}".format(TYPE, TYPE + 2 * SLOTS - 1),
           "--watch-write", "$7E:{:04X}-$7E:{:04X}".format(0x531C, 0x5B1B),
           "--watch-write", "$7E:{:04X}-$7E:{:04X}".format(0x5D9C, 0x5E1B),
           "--watch-write", "$7E:{:04X}-$7E:{:04X}".format(0x5F1C, 0x601B)]
    pokes = os.path.join(HERE, "inputs", name + ".pokes")
    if os.path.exists(pokes):
        cmd += ["--pokes", pokes]
    subprocess.run(cmd + ["--no-dsp", "--quiet", "--out", run], check=True)

    mem = {}

    def word(a):
        return mem.get(a, 0) | (mem.get(a + 1, 0) << 8)

    def slot_of(a):
        for base in [TYPE] + FIELDS:
            if base <= a < base + 2 * SLOTS:
                return (a - base) // 2
        return None

    records = []
    touched = {}  # slot -> first line in this frame
    cur = None

    def flush(frame):
        for slot, line in sorted(touched.items()):
            t = word(TYPE + 2 * slot)
            if t in types:
                records.append([frame, line, slot, t] + [word(b + 2 * slot) for b in FIELDS])
        touched.clear()

    with open(os.path.join(run, "watch.tsv")) as f:
        next(f)
        for line in f:
            fr, ln, _pc, addr, _old, new = line.rstrip("\n").split("\t")
            fr = int(fr)
            if cur is not None and fr != cur:
                flush(cur)
            cur = fr
            a = int(addr.split(":")[1], 16)
            mem[a] = int(new, 16)
            s = slot_of(a)
            if s is not None and s not in touched:
                touched[s] = int(ln)
    if cur is not None:
        flush(cur)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "actors_{}.json".format(name))
    with open(path, "w") as f:
        json.dump({"name": name, "types": sorted(types),
                   "fields": ["frame", "line", "slot", "type"] + NAMES,
                   "records": records}, f, separators=(",", ":"))
    print("{}: {} records -> {}".format(name, len(records), path))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", help="input script in tools/snesstep/inputs/ (without .txt)")
    ap.add_argument("--frames", type=int, default=3600)
    ap.add_argument("--types", default="76,77,81,82,83",
                    help="object types to record, comma-separated")
    ap.add_argument("--out", default=os.path.join(ROOT, "build", "web-test"))
    args = ap.parse_args()
    if not os.path.exists(BIN):
        print("build the stepper first (docs/tooling.md)", file=sys.stderr)
        return 1
    trace(args.name, args.frames, {int(t) for t in args.types.split(",")}, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
