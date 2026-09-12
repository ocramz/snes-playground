#!/usr/bin/env python3
"""Check symbols.tsv for the invariants CLAUDE.md promises.

The file is meant to be greppable by either address form, which only works
if the two stay consistent, and it is meant to be sorted so that a diff
shows real changes rather than reordering. Neither is self-enforcing.

Checks: the header row, five tab-separated fields plus a comment, address
syntax `$BB:AAAA`, file offsets that match the LoROM mapping, sorted order,
no duplicate addresses or names, known `type` values, and label prefixes
that match the type.

    python3 tools/symcheck.py
    python3 tools/symcheck.py --fix-order     # rewrite in sorted order
"""

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import fmt_file, snes_to_file  # noqa: E402

HEADER = "snes_addr\tfile_offset\ttype\tname\tsize\tcomment"
TYPES = ("code", "data", "gfx", "music", "ptr", "ram", "reg", "tbl")
PREFIXES = ("sub_", "loc_", "dat_", "tbl_", "ptr_", "gfx_", "mus_", "pal_", "ram_")
ADDR = re.compile(r"^\$[0-9A-F]{2}:[0-9A-F]{4}$")


def parse_addr(text):
    bank, _, addr = text.lstrip("$").partition(":")
    return int(bank, 16), int(addr, 16)


def check(path):
    with open(path) as f:
        lines = f.read().splitlines()
    problems = []
    if not lines or lines[0] != HEADER:
        problems.append("line 1: header row is not {!r}".format(HEADER))
    rows = []
    for n, line in enumerate(lines[1:], start=2):
        if not line.strip():
            problems.append("line {}: blank".format(n))
            continue
        parts = line.split("\t")
        if len(parts) != 6:
            problems.append("line {}: {} fields, expected 6".format(n, len(parts)))
            continue
        snes, off, kind, name, size, _ = parts
        if not ADDR.match(snes):
            problems.append("line {}: {!r} is not $BB:AAAA".format(n, snes))
            continue
        bank, addr = parse_addr(snes)
        rows.append((n, bank, addr, snes, off, kind, name, size))

        if kind not in TYPES:
            problems.append("line {}: type {!r} not one of {}".format(
                n, kind, ", ".join(TYPES)))
        if not name.startswith(PREFIXES):
            problems.append("line {}: name {!r} has no known prefix".format(n, name))
        if size != "-" and not size.isdigit():
            problems.append("line {}: size {!r} is not decimal or '-'".format(n, size))

        # RAM and register addresses have no file offset; ROM addresses must
        # have one that matches the mapping.
        is_ram = bank in (0x7E, 0x7F) or addr < 0x8000
        if is_ram:
            if off != "-":
                problems.append("line {}: {} is RAM but has file offset {}".format(
                    n, snes, off))
        else:
            try:
                want = fmt_file(snes_to_file(bank, addr))
            except Exception as e:
                problems.append("line {}: {} does not map: {}".format(n, snes, e))
                continue
            if off != want:
                problems.append("line {}: {} maps to {}, not {}".format(
                    n, snes, want, off))

    for i in range(1, len(rows)):
        if (rows[i][1], rows[i][2]) < (rows[i - 1][1], rows[i - 1][2]):
            problems.append("line {}: {} sorts before {} on the previous line".format(
                rows[i][0], rows[i][3], rows[i - 1][3]))
    for field, label in ((3, "address"), (6, "name")):
        seen = {}
        for r in rows:
            seen.setdefault(r[field], []).append(r[0])
        for value, where in sorted(seen.items()):
            if len(where) > 1:
                problems.append("duplicate {} {!r} on lines {}".format(
                    label, value, ", ".join(str(w) for w in where)))
    return rows, problems


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--path", default="symbols.tsv")
    ap.add_argument("--fix-order", action="store_true",
                    help="rewrite the file sorted by address")
    args = ap.parse_args()

    rows, problems = check(args.path)
    if args.fix_order:
        with open(args.path) as f:
            lines = f.read().splitlines()
        body = sorted((l for l in lines[1:] if l.strip()),
                      key=lambda l: parse_addr(l.split("\t")[0]))
        with open(args.path, "w") as f:
            f.write("\n".join([HEADER] + body) + "\n")
        print("rewrote {} in sorted order".format(args.path))
        return 0

    for p in problems:
        print(p)
    print("{}: {} symbols, {} problems".format(args.path, len(rows), len(problems)))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
