#!/usr/bin/env python3
"""Which thread object each course actor id becomes, from the hole batch.

A hole's layer 2 places actors: tile values `$40-$52` and `$57` map to actor
ids `$0048-$0053` (docs/tiles.md), and what `$82:B3AF` builds from an id was
never traced. `tools/snesstep/holes.py` plays all 232 holes, and its cache
records which thread object types were alive in which hole. An actor id and
the object type it spawns must then occur in the same holes, so this tool
pairs them by set overlap:

    score = |holes with the actor AND the type| / |holes with either|

(the Jaccard index). An exact match is 1.0. Object types present in nearly
every hole (Kirby, the HUD, the camera) score low against everything except
an actor that is itself in nearly every hole, which is why they are scored
like any other; they are listed at the end for reference. An actor whose
best type scores below `--min` is reported as weak: most often a type that
draws nothing, so the batch never sees it.

Reads build/emu/holes/emusheets.pickle and build/courses/*/geometry.json;
writes build/sprites/emu/actors.tsv.

    python3 tools/actorids.py
"""

import argparse
import glob
import json
import os
import pickle
import sys


def holes_of_types(cache):
    with open(cache, "rb") as f:
        groups, seen_in = pickle.load(f)
    out = {}
    for (key, _), labels in seen_in.items():
        if key[0] != "obj":
            continue
        for label in labels:
            run = label.split("/")[0]
            if run.startswith("h") and run[1:].isdigit():
                out.setdefault(key[1], set()).add(int(run[1:]))
    return out


def holes_of_actors(courses):
    out = {}
    counts = {}
    for path in glob.glob(os.path.join(courses, "*", "geometry.json")):
        with open(path) as f:
            g = json.load(f)
        idx = g["index"]
        for c in g["cells"]:
            a = c.get("actor")
            if isinstance(a, int) and a:
                out.setdefault(a, set()).add(idx)
                counts[(a, idx)] = counts.get((a, idx), 0) + 1
    return out, counts


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", default="build/emu/holes/emusheets.pickle")
    ap.add_argument("--courses", default="build/courses")
    ap.add_argument("--out", default="build/sprites/emu/actors.tsv")
    ap.add_argument("--min", type=float, default=0.8,
                    help="lowest score reported as a match (default 0.8)")
    args = ap.parse_args()
    if not os.path.exists(args.cache):
        print("error: {} missing; run tools/snesstep/holes.py".format(args.cache),
              file=sys.stderr)
        return 1
    types = holes_of_types(args.cache)
    played = set().union(*types.values()) if types else set()
    actors, counts = holes_of_actors(args.courses)
    common = sorted(t for t, h in types.items() if len(h) >= 0.9 * len(played))

    rows = []
    for a in sorted(actors):
        holes = actors[a] & played
        if not holes:
            continue
        scored = []
        for t, th in types.items():
            inter = len(holes & th)
            if inter:
                scored.append((inter / len(holes | th), t, inter, len(th)))
        scored.sort(reverse=True)
        best = scored[0] if scored else (0.0, None, 0, 0)
        runner = scored[1] if len(scored) > 1 else (0.0, None, 0, 0)
        rows.append([
            "${:04X}".format(a), len(holes),
            sum(counts[(a, h)] for h in holes),
            best[1] if best[1] is not None else "-", "{:.3f}".format(best[0]),
            best[2], best[3],
            runner[1] if runner[1] is not None else "-", "{:.3f}".format(runner[0]),
            "match" if best[0] >= args.min else "weak",
            ",".join(str(h) for h in sorted(holes)[:12])])
    parent = os.path.dirname(os.path.abspath(args.out))
    if not os.path.isdir(parent):
        os.makedirs(parent)
    with open(args.out, "w") as f:
        f.write("actor\tholes\tcells\tobject_type\tscore\tshared_holes"
                "\ttype_holes\trunner_up\trunner_score\tverdict\tsome_holes\n")
        for r in rows:
            f.write("\t".join(str(c) for c in r) + "\n")
    for r in rows:
        print("actor {}  in {:3d} holes  -> type {:>3}  score {}  (next {:>3} {})  {}".format(
            r[0], r[1], r[3], r[4], r[7], r[8], r[9]))
    print("object types present in >= 90% of {} played holes: {}".format(
        len(played), " ".join(str(t) for t in common)))
    print("wrote {}".format(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
