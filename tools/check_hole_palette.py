#!/usr/bin/env python3
"""Check the BG colours the exporter draws a hole with against the game's CGRAM.

For each hole index (course * 8 + hole), run tools/snesstep through
`inputs/play_hole1.txt` with the hole picked by pokes at 2050, as
tools/snesstep/holes.py does, and take one snapshot in play. The course
slot `$7E:6A5C` is poked too: the course map sets it to 2 * course
(every snapshot of the autoplay `game` and `extra` runs), and a poke of
`$6A5A` alone leaves it at 0, which gives every hole course 1's song list
and ripple colours.

The snapshot's CGRAM after the NMI's upload (`cgram_post.bin`) is compared
with `coursemap.hole_palette` for BG colours 0-127, except the entries an
object cycles while the hole is in play:
    coursemap.palette_cycles  the ripple (113), the boost panels (112), the
                              warp or snap panels (114, 115)
    palette 7 colour 1        object 111's per-frame handler $84:81B7
    palette 7 colour 15       object 111's outline walk ($98:D3E6)
Two more writers are known and not modelled; their colours are counted
apart ("unmodelled"), not as failures:
    BG3 colours 0-19          the scenery's own cycles ($84:CF31 on courses 2
                              and 5, $84:D072 on course 8)
    palette 4 or 5 c12-15     objects 116-118 of the $58-$5D tiles

    python3 tools/check_hole_palette.py                 # one hole per course 1-8
    python3 tools/check_hole_palette.py --holes 0-63
    python3 tools/check_hole_palette.py --holes 17 --frame 2300 --verbose

Exit status 1 if any hole differs.
"""

import argparse
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from coursemap import _layer2_values, hole_palette, palette_cycles  # noqa: E402
from romcheck import load_rom  # noqa: E402
from tiles import snes_color  # noqa: E402

BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
SCRIPT = os.path.join(HERE, "snesstep", "inputs", "play_hole1.txt")
POKE_FRAME = 2050
DEFAULT_HOLES = [9, 17, 25, 33, 41, 49, 57, 0]   # hole 2 of courses 2-8, then course 1


def holes_arg(text):
    out = []
    for part in text.split(","):
        if "-" in part:
            lo, hi = part.split("-")
            out.extend(range(int(lo), int(hi) + 1))
        else:
            out.append(int(part))
    return out


def cycling(d, index):
    """The CGRAM indices an object rewrites in play on this hole, as modelled."""
    skip = {7 * 16 + 1, 7 * 16 + 15}
    for cyc in palette_cycles(d, index):
        skip |= set(range(cyc["cgram"], cyc["cgram"] + cyc["count"]))
    return skip


def unmodelled(d, index):
    """The CGRAM indices of the known writers that are not modelled."""
    out = set()
    if index // 8 % 8 in (1, 4, 7):
        out |= set(range(20))
    if _layer2_values(d, index) & set(range(0x58, 0x5E)):
        out |= set(range(4 * 16 + 12, 4 * 16 + 16)) | set(range(5 * 16 + 12, 5 * 16 + 16))
    return out


def snapshot(index, frame, out):
    course, hole = divmod(index, 8)
    subprocess.run(
        [BIN, "--frames", str(frame + 2), "--input", SCRIPT,
         "--poke", "{}:$7E:6A5A={:04X}".format(POKE_FRAME, course),
         "--poke", "{}:$7E:6A5C={:04X}".format(POKE_FRAME, 2 * course),
         "--poke", "{}:$7E:6A5E={:04X}".format(POKE_FRAME, hole),
         "--snap-at", str(frame), "--no-dsp", "--quiet", "--out", out],
        check=True, capture_output=True)
    with open(os.path.join(out, "f{:06d}".format(frame), "cgram_post.bin"), "rb") as f:
        raw = f.read()
    return [raw[2 * i] | (raw[2 * i + 1] << 8) for i in range(256)]


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--holes", type=holes_arg, default=DEFAULT_HOLES)
    ap.add_argument("--frame", type=int, default=2300, help="the snapshot frame (in play)")
    ap.add_argument("--verbose", action="store_true", help="list every differing colour")
    args = ap.parse_args()
    if not os.path.exists(BIN):
        raise SystemExit("build the stepper first: make tools")
    d = load_rom()
    bad = 0
    with tempfile.TemporaryDirectory() as tmp:
        for index in args.holes:
            cg = snapshot(index, args.frame, os.path.join(tmp, "h{:03d}".format(index)))
            skip = cycling(d, index)
            known = unmodelled(d, index)
            pal = hole_palette(d, index)
            diff, other = [], 0
            for i in range(128):
                if i in skip:
                    continue
                want = pal[i // 16][i % 16]
                got = snes_color(cg[i])
                if want != got:
                    if i in known:
                        other += 1
                    else:
                        diff.append((i, want, got, cg[i]))
            status = "ok" if not diff else "{} differ".format(len(diff))
            if other:
                status += " ({} unmodelled)".format(other)
            kinds = ",".join(c["name"] for c in palette_cycles(d, index)) or "plain"
            print("hole {:3d} (course {} hole {}, {}): {}".format(
                index, index // 8 + 1, index % 8 + 1, kinds, status))
            if diff:
                bad += 1
                ranges = sorted({i // 16 for i, _, _, _ in diff})
                print("    palettes {}".format(ranges))
                if args.verbose:
                    for i, want, got, word in diff:
                        print("    colour {:3d} (pal {} c {:2d}): exporter {} game {} (${:04X})".format(
                            i, i // 16, i % 16, want, got, word))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
