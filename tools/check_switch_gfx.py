#!/usr/bin/env python3
"""Check the switches' and the swirls' VRAM model against the game's.

port_v2 phase 6 (notes/port-v2-phase6-switches.md). The exporter draws the
switch holes from `coursemap.hole_page` with the switches' uploads and
object 127's frames, and the engine dissolves the water by the order
`$80:9271` (export_web.py `dissolve_map`). This runs the scenarios of
engine/test/switch-scenarios.ts in tools/snesstep with snapshots and
compares `vram_post.bin` (after the NMI's uploads) with the model:

- the toggles' switch's 8 tiles at VRAM word $3280 by `$6A2A`, before and
  after its flip (`$80:D7B5` 1);
- object 127's 14 tiles at $3000 against the record its last upload named
  (iters' `uploads`, trace_flow.py);
- the water's 44 tiles at $1800 through the water switch's block: k steps
  done since the flip are the source tiles with the pixels `$80:9271`[0..k-1]
  set (coming) or cleared (going) in every tile, all four planes; zero at
  the load of a water-off hole (`$80:CCF8`).

    python3 tools/check_switch_gfx.py            # needs build/engine/rom-test's flow fixtures

Exit status 1 on any difference.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import coursemap as cm  # noqa: E402
from lorom import snes_to_file  # noqa: E402
from romcheck import load_rom  # noqa: E402

BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
INPUTS = os.path.join(HERE, "snesstep", "inputs")
FIXTURES = os.path.join(ROOT, "build", "engine", "rom-test")
OUT = os.path.join(ROOT, "build", "emu", "switch_gfx")
SWIRL_FIRST = 0xDC80
SWIRL_RECORD = 9
ORDER = (0x80, 0x9271)


def snap(name, frames):
    run = os.path.join(OUT, name)
    os.makedirs(run, exist_ok=True)
    cmd = [BIN, "--frames", str(max(frames) + 1), "--input", os.path.join(INPUTS, name + ".txt"),
           "--pokes", os.path.join(INPUTS, name + ".pokes"),
           "--snap-at", ",".join(str(f) for f in frames), "--no-dsp", "--quiet", "--out", run]
    subprocess.run(cmd, check=True)
    return {f: open(os.path.join(run, "f{:06d}".format(f), "vram_post.bin"), "rb").read() for f in frames}


def flow(name, key):
    ev = json.load(open(os.path.join(FIXTURES, "flow_{}.json".format(name))))["events"]
    return [(e[0], e[3], e[2]) for e in ev if e[1] == key]


def rom_at(d, rec):
    size, bank, src, _dest = rec
    o = snes_to_file(bank, src)
    return d[o:o + size]


def vram(v, word, size):
    return v[word * 2:word * 2 + size]


def dissolved(d, src, k, appear):
    """The water tiles after k steps of `$80:9208` from the source (going) or zeroes (coming)."""
    order = d[snes_to_file(*ORDER):snes_to_file(*ORDER) + 64]
    buf = bytearray(len(src)) if appear else bytearray(src)
    for v in order[:k]:
        row, col = v >> 3, v & 7
        bit = 0x80 >> col
        for t in range(len(src) // 32):
            for plane in (2 * row, 2 * row + 1, 16 + 2 * row, 16 + 2 * row + 1):
                o = 32 * t + plane
                buf[o] = (buf[o] | (src[o] & bit)) if appear else (buf[o] & ~bit & 0xFF)
    return bytes(buf)


def main():
    if not os.path.exists(BIN):
        print("build the stepper first (docs/tooling.md)", file=sys.stderr)
        return 1
    d = load_rom()
    bad = []

    def expect(what, got, want):
        ok = got == want
        print("{:52s} {}".format(what, "ok" if ok else "DIFFERS"))
        if not ok:
            bad.append(what)

    # the toggles' switch, course 2 hole 3 (index 10): $6A2A 1 -> 0 at 2522
    flip = [f for f, _ln, v in flow("web_sw_switch_roll", "togon") if f > 2400][0]
    shots = snap("web_sw_switch_roll", [flip - 2, flip + 3])
    st = cm.switch_state(d, 10)
    for f, on in ((flip - 2, st["toggle"]), (flip + 3, st["toggle"] ^ 1)):
        rec = cm._switch_record(d, "toggle", on)
        expect("hole 10 f{}: the switch's tiles ($6A2A = {})".format(f, on), vram(shots[f], rec[3], rec[0]), rom_at(d, rec))
    # object 127's last upload before each snapshot
    ups = json.load(open(os.path.join(FIXTURES, "iters_web_sw_switch_roll.json")))["uploads"]
    for f in (flip - 2, flip + 3):
        last = [u for u in ups if u[3] in ("$84:DBF5", "$84:DC41") and u[0] <= f][-1]
        i = (last[2] - SWIRL_FIRST) // SWIRL_RECORD
        rec = cm.swirl_record(d, i // 10, i % 10)
        expect("hole 10 f{}: object 127's frame {} (list {})".format(f, i % 10, i // 10), vram(shots[f], rec[3], rec[0]), rom_at(d, rec))

    # the water switch: going (index 7, 2527) and coming (index 23, 2478); the
    # step k is in the NMI after the frame 2528 + k (web_sw_water_drain's
    # snapshots: vram_post of 2529 has one step)
    src = d[snes_to_file(*cm.WATER_GFX):snes_to_file(*cm.WATER_GFX) + cm.WATER_GFX_BYTES]
    word = cm.WATER_FIRST_TILE * 16
    for name, hole in (("web_sw_water_drain", 7), ("web_sw_water_fill", 23)):
        flip = [f for f, _ln, v in flow(name, "wateroff") if f > 2400][0]
        load = cm.switch_state(d, hole)["water"]
        frames = [flip - 1] + [flip + 1 + k for k in (1, 2, 20, 21, 40, 63, 64, 65)]
        shots = snap(name, frames)
        expect("hole {} f{}: the water at the load ($69CA = {})".format(hole, flip - 1, load),
               vram(shots[flip - 1], word, len(src)), bytes(len(src)) if load else src)
        for f in frames[1:]:
            k = min(64, f - flip - 1)
            expect("hole {} f{}: {} dissolve steps".format(hole, f, k),
                   vram(shots[f], word, len(src)), dissolved(d, src, k, load == 1))
    print("{} difference(s)".format(len(bad)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
