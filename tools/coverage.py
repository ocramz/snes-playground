#!/usr/bin/env python3
"""Which ROM bytes the extractors account for, bank by bank.

"Extract all assets" needs a denominator. This paints every byte of the ROM
with the first claim that applies, from what the other tools already wrote
under build/, and reports what is left:

    compressed    a HAL stream something in the ROM points at
    uncompressed  a ROM chunk a VRAM queue record copies as it is
    palette       a CGRAM image or a partial palette load
    sprites       metasprite frame lists and their pointer tables (bank $89)
    audio         the APU init blocks and the 33 song blocks
    vramblock     VRAM transfer record blocks
    data          sized non-code rows of symbols.tsv
    executed      instructions tools/snesstep ran (`--coverage` files under
                  build/emu/cov/); the strongest evidence for code
    code          sized code rows of symbols.tsv, plus every instruction
                  tools/objanim.py reaches from a thread object's entry
    lead          a stream the scan found and nothing references -- possibly
                  real, possibly an accident of alignment
    padding       runs of 32 or more `$FF` or `$00`
    unknown       none of the above

A claim is an address range, not proof of meaning: `code` in particular
means "reached by following control flow", and `lead` is not counted as
accounted for. Later classes in the list above never overwrite earlier ones.

Run the extractors first (`tools/extract_all.py`); a missing input is
reported and its class simply stays empty.

    python3 tools/coverage.py            # table + build/coverage.tsv
    python3 tools/coverage.py --runs 20  # also list the largest unknown runs
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import AddressError, file_to_snes, fmt_file, fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

# Painted in this order, so an earlier class is never overwritten.
CLASSES = ["compressed", "uncompressed", "palette", "sprites", "audio",
           "vramblock", "data", "executed", "code", "lead", "padding"]
ACCOUNTED = [c for c in CLASSES if c not in ("lead",)]
UNKNOWN = 0
PAD_RUN = 32
BANK = 0x8000


def read_tsv(path):
    if not os.path.exists(path):
        print("note: {} missing, skipped".format(path), file=sys.stderr)
        return []
    with open(path) as f:
        lines = f.read().splitlines()
    if not lines:
        return []
    head = lines[0].lstrip("# ").split("\t")
    return [dict(zip(head, l.split("\t"))) for l in lines[1:]
            if l.strip() and not l.startswith("#")]


class Paint(object):
    def __init__(self, size):
        self.cls = bytearray(size)

    def claim(self, name, start, length):
        if length <= 0 or start < 0:
            return
        cid = CLASSES.index(name) + 1
        end = min(len(self.cls), start + length)
        for i in range(start, end):
            if not self.cls[i]:
                self.cls[i] = cid


def claims(data, root, paint):
    # Compressed streams, referenced ones first so that a lead never takes
    # bytes a real stream owns.
    gfx = read_tsv(os.path.join(root, "gfx", "index.tsv"))
    for row in gfx:
        if row.get("referenced_by", "-") not in ("-", ""):
            paint.claim("compressed", int(row["file_offset"], 16),
                        int(row["packed"]))
    for row in read_tsv(os.path.join(root, "manifest.tsv")):
        if row.get("status") == "verified" and row.get("packed", "").isdigit() \
                and row.get("kind", "").split()[0] not in ("uncompressed", "cgram"):
            paint.claim("compressed", int(row["file_offset"], 16),
                        int(row["packed"]))

    for row in read_tsv(os.path.join(root, "gfx", "direct", "index.tsv")):
        paint.claim("uncompressed", int(row["src_file"], 16), int(row["size"]))

    import vram
    for _, bank, src, length in vram.find_cgram_sites(data):
        paint.claim("palette", snes_to_file(bank, src),
                    min(length, vram.CGRAM_BYTES))
    for row in read_tsv(os.path.join(root, "scenes", "loads.tsv")):
        if row.get("kind") == "cgram" and row.get("src_file", "").startswith("0x") \
                and row.get("unpacked", "").isdigit():
            paint.claim("palette", int(row["src_file"], 16), int(row["unpacked"]))
    for _, count, src, _ in vram.find_cgram_partial_sites(data):
        if count is not None and src >= 0x8000:
            paint.claim("palette", snes_to_file(vram.CGRAM_PARTIAL_BANK, src),
                        count)

    # Bank $89: frames and the tables that point at them.
    import frametabs
    import sprites
    tpath = os.path.join(root, "sprites", "tables.tsv")
    if os.path.exists(tpath):
        for t in sprites.read_tables(tpath):
            base = snes_to_file(t["bank"], t["addr"])
            if t["bank"] == frametabs.FRAME_BANK:
                paint.claim("sprites", base, 2 * t["entries"])
            for w in sprites.frame_table(data, t["bank"], t["addr"], t["entries"]):
                info = frametabs.frame_ok(data, frametabs.FRAME_BANK, w) \
                    if w not in (0, 0xFFFF) else None
                if info:
                    paint.claim("sprites", info["start"],
                                info["end"] - info["start"])
    for row in read_tsv(os.path.join(root, "sprites", "lists.tsv")):
        info = frametabs.frame_ok(data, frametabs.FRAME_BANK,
                                  int(row["list_addr"][4:], 16))
        if info:
            paint.claim("sprites", info["start"], info["end"] - info["start"])

    import spc_extract
    try:
        for _, chains in spc_extract.init_sets(data):
            for off, _ in chains:
                paint.claim("audio", off, spc_extract.read_chain(data, off)[1] - off)
        for _, _, off, _ in spc_extract.songs(data):
            paint.claim("audio", off, spc_extract.read_chain(data, off)[1] - off)
    except (ValueError, AddressError) as e:
        print("note: audio extents skipped: {}".format(e), file=sys.stderr)

    for site in vram.queue_sites(data):
        for bank, addr in site["blocks"]:
            n = len(vram.parse_block(data, bank, addr))
            paint.claim("vramblock", snes_to_file(bank, addr), 8 * n + 1)

    sym = os.path.join(os.path.dirname(os.path.abspath(root)), "symbols.tsv")
    if not os.path.exists(sym):
        sym = "symbols.tsv"
    code_rows = []
    for row in read_tsv(sym):
        off, size = row.get("file_offset", "-"), row.get("size", "-")
        if not off.startswith("0x") or not size.isdigit():
            continue
        if row.get("type") == "code":
            code_rows.append((int(off, 16), int(size)))
        else:
            paint.claim("data", int(off, 16), int(size))
    import glob
    for path in sorted(glob.glob(os.path.join(root, "emu", "cov", "*.tsv"))):
        for row in read_tsv(path):
            paint.claim("executed", int(row["file_offset"], 16), int(row["len"]))
    for off, size in code_rows:
        paint.claim("code", off, size)

    import objanim
    for obj in objanim.trace(data):
        for lo, hi in obj["span"]:
            paint.claim("code", lo, hi - lo)

    for row in gfx:
        if row.get("referenced_by", "-") in ("-", ""):
            paint.claim("lead", int(row["file_offset"], 16), int(row["packed"]))

    # Padding last: a run of one byte value that nothing else wanted.
    for value in (0xFF, 0x00):
        i = 0
        n = len(data)
        while i < n:
            if data[i] != value:
                i += 1
                continue
            j = i
            while j < n and data[j] == value:
                j += 1
            if j - i >= PAD_RUN:
                paint.claim("padding", i, j - i)
            i = j


def unknown_runs(paint):
    out = []
    run = None
    for i, c in enumerate(paint.cls):
        if c == UNKNOWN and run is None:
            run = i
        elif c != UNKNOWN and run is not None:
            out.append((run, i))
            run = None
        if run is not None and (i + 1) % BANK == 0:
            out.append((run, i + 1))      # runs do not cross a bank
            run = None
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build")
    ap.add_argument("--runs", type=int, default=0,
                    help="also print this many of the largest unknown runs")
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    paint = Paint(len(data))
    claims(data, args.out, paint)

    banks = len(data) // BANK
    head = ["bank"] + CLASSES + ["unknown", "accounted_pct"]
    rows = []
    for b in range(banks):
        seg = paint.cls[b * BANK:(b + 1) * BANK]
        counts = [0] * (len(CLASSES) + 1)
        for c in seg:
            counts[c] += 1
        done = sum(counts[CLASSES.index(c) + 1] for c in ACCOUNTED)
        rows.append(["${:02X}".format(0x80 | b)] + counts[1:] + [counts[0]] +
                    ["{:.1f}".format(100.0 * done / BANK)])
    total = [0] * (len(CLASSES) + 1)
    for c in paint.cls:
        total[c] += 1
    done = sum(total[CLASSES.index(c) + 1] for c in ACCOUNTED)
    rows.append(["all"] + total[1:] + [total[0]] +
                ["{:.1f}".format(100.0 * done / len(data))])

    path = os.path.join(args.out, "coverage.tsv")
    with open(path, "w") as f:
        f.write("\t".join(head) + "\n")
        for r in rows:
            f.write("\t".join(str(c) for c in r) + "\n")
    runs = sorted(unknown_runs(paint), key=lambda r: r[0] - r[1])
    upath = os.path.join(args.out, "coverage_unknown.tsv")
    with open(upath, "w") as f:
        f.write("file_offset\tsnes_addr\tbytes\n")
        for lo, hi in runs:
            if hi - lo >= PAD_RUN:
                f.write("{}\t{}\t{}\n".format(
                    fmt_file(lo), fmt_snes(*file_to_snes(lo)), hi - lo))

    widths = [max(len(str(r[i])) for r in rows + [head]) for i in range(len(head))]
    for r in [head] + rows:
        print("  ".join(str(c).rjust(w) for c, w in zip(r, widths)))
    print("\n{:.1f}% of the ROM accounted for; {} bytes unknown, {} more in "
          "unreferenced streams".format(
              100.0 * done / len(data), total[0],
              total[CLASSES.index("lead") + 1]))
    for lo, hi in runs[:args.runs]:
        print("  unknown {}  {}  {} bytes".format(
            fmt_file(lo), fmt_snes(*file_to_snes(lo)), hi - lo))
    print("wrote {} and {}".format(path, upath))
    return 0


if __name__ == "__main__":
    sys.exit(main())
