#!/usr/bin/env python3
"""Re-derive the course grid layer statistics quoted in docs/courses.md.

The claims about what tables 1-4 mean are statistical, not disassembled, so
they need to be reproducible. This recomputes them from the extracted data
and prints the same numbers the doc quotes. Run `tools/courses.py` first.

    python3 tools/course_stats.py
    python3 tools/course_stats.py --out build/courses    # non-default dir

Reported:
  * cell counts and how many holes were usable
  * the layer-1 zero / layer-3 zero conditional probabilities
  * whether layer 2 is ever non-zero outside the play area
  * how many non-zero layer-4 values are a single bit
  * value histograms per layer
"""

import argparse
import collections
import os
import sys


def load_layer(hole_dir, t):
    names = [x for x in os.listdir(hole_dir)
             if x.startswith("t{:02d}_".format(t)) and x.endswith(".bin")]
    if not names:
        return None
    with open(os.path.join(hole_dir, names[0]), "rb") as f:
        return f.read()


def collect(root):
    holes = []
    for name in sorted(os.listdir(root)):
        d = os.path.join(root, name)
        if not os.path.isdir(d):
            continue
        layers = [load_layer(d, t) for t in (1, 2, 3, 4)]
        if any(x is None for x in layers):
            continue
        if len(set(len(x) for x in layers)) != 1:
            continue
        holes.append((name, layers))
    return holes


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/courses")
    args = ap.parse_args()

    if not os.path.isdir(args.out):
        print("error: {} not found; run tools/courses.py first".format(args.out),
              file=sys.stderr)
        return 1
    holes = collect(args.out)
    if not holes:
        print("error: no holes with all four equal-length layers", file=sys.stderr)
        return 1

    total = 0
    t1_zero = t3_zero = both_zero = 0
    t2_nonzero = t2_outside = 0
    t4_nonzero = t4_singlebit = t4_outside = 0
    hist = [collections.Counter() for _ in range(4)]

    for _, (l1, l2, l3, l4) in holes:
        for i in range(len(l1)):
            a, b, c, e = l1[i], l2[i], l3[i], l4[i]
            total += 1
            for j, v in enumerate((a, b, c, e)):
                hist[j][v] += 1
            if a == 0:
                t1_zero += 1
            if c == 0:
                t3_zero += 1
            if a == 0 and c == 0:
                both_zero += 1
            if b:
                t2_nonzero += 1
                if a == 0:
                    t2_outside += 1
            if e:
                t4_nonzero += 1
                if e & (e - 1) == 0:
                    t4_singlebit += 1
                if a == 0:
                    t4_outside += 1

    print("holes: {}   cells: {}".format(len(holes), total))
    print()
    print("layer 1 (tile/terrain type, also the occupancy mask)")
    print("  zero cells: {} ({:.1f}%)".format(t1_zero, 100 * t1_zero / total))
    print("  distinct values: {}".format(len(hist[0])))
    print("  most common: {}".format(
        ", ".join("${:02X}x{}".format(v, n) for v, n in hist[0].most_common(6))))
    print()
    print("layer 3 (height)")
    print("  zero cells: {}".format(t3_zero))
    print("  P(layer3==0 | layer1==0) = {:.4f}".format(both_zero / t1_zero))
    print("  P(layer1==0 | layer3==0) = {:.4f}".format(both_zero / t3_zero))
    print("  value histogram: {}".format(
        ", ".join("{}:{}".format(v, hist[2][v]) for v in sorted(hist[2]))))
    print()
    print("layer 2 (sparse per-cell content)")
    print("  non-zero: {}   of those outside the play area (layer1==0): {}".format(
        t2_nonzero, t2_outside))
    print("  distinct values: {}".format(len(hist[1])))
    print()
    print("layer 4 (per-cell flag bits)")
    print("  non-zero: {}   single-bit: {} ({:.1f}%)   outside play area: {}".format(
        t4_nonzero, t4_singlebit,
        100 * t4_singlebit / t4_nonzero if t4_nonzero else 0, t4_outside))
    print("  distinct values: {}".format(len(hist[3])))
    print()
    print("These were correlations when first measured; the layer names are")
    print("now confirmed from the code that consumes them. sub_terrain_probe")
    print("at $81:9479 reads $7E:6B90 as shape and $7E:7390 as elevation,")
    print("$81:92AC reads $7E:7B90 as the wall flags, and $81:811B dispatches")
    print("$7E:8390 through the special-tile table. See docs/terrain.md and")
    print("docs/tiles.md; tools/terrain.py reimplements the probe.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
