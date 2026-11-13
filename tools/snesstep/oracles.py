#!/usr/bin/env python3
"""Check snesstep snapshots against facts established by static analysis.

Each oracle names a ROM asset (decompressed with tools/halcomp.py, or read
raw) and where the docs say it lands. A snapshot passes when the asset's
bytes are found there. The static findings and the executed code must agree.

    python3 tools/snesstep/oracles.py course SNAP [--xfer xfer.tsv]
    python3 tools/snesstep/oracles.py title  SNAP
    python3 tools/snesstep/oracles.py all    # runs snesstep itself and checks

Oracles (sources: docs/scenes.md, docs/graphics.md, docs/compression.md):

  course  $90:FBBC (font, graphics set B 1)  at VRAM word $4000
          $8D:CA0A (tileset 0)               at VRAM word $6000
          $98:C000 (palette 0, 256 colours)  in CGRAM; colours 0-39 are the
          per-course BG3 palette ($80:D4F7) loaded after it, so 40-255 count
  title   $8B:8000 (title BG tiles)          at VRAM word $0000 (measured:
          decompressed to $7F:0C00, DMA'd 16 KB to $0000)
          $8E:EC7F, which docs/compression.md calls "title screen tiles",
          is reported but not required: the title never loads it.

With --xfer (a `--log-vram-dma` log from the same run), VRAM bytes that do
not match are attributed to the later transfers that overwrote them.
"""

import argparse
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from halcomp import decompress  # noqa: E402
from lorom import snes_to_file  # noqa: E402
from romcheck import load_rom  # noqa: E402

BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")


def stream(rom, bank, addr):
    out, _ = decompress(rom, snes_to_file(bank, addr))
    return out


def load(snap, name):
    with open(os.path.join(snap, name), "rb") as f:
        return f.read()


def mismatched_words(vram, word, blob):
    bad = set()
    for i, b in enumerate(blob):
        if vram[word * 2 + i] != b:
            bad.add(word + i // 2)
    return bad


def report(name, same, total, note="", info=False):
    ok = same == total
    label = "info" if info else ("PASS" if ok else "FAIL")
    print("{:5s} {:44s} {:6d}/{:<6d} {}".format(label, name, same, total, note))
    return ok


def read_xfer(path):
    rows = []
    with open(path) as f:
        head = f.readline().rstrip("\n").split("\t")
        for line in f:
            r = dict(zip(head, line.rstrip("\n").split("\t")))
            if r["target"] != "vram":
                continue
            r["frame"] = int(r["frame"])
            r["d0"] = int(r["dest"].lstrip("$"), 16)
            r["d1"] = int(r["dest_end"].lstrip("$"), 16)
            rows.append(r)
    return rows


def explain(xfer, bad, snap_frame, word, nbytes):
    """The transfers after the asset's own upload that wrote the bad words."""
    lo, hi = word, word + nbytes // 2 - 1
    own = [r for r in xfer if r["d0"] == lo and r["frame"] <= snap_frame and r["kind"] == "dma"]
    if not own:
        return "  (no DMA starting at ${:04X} in the log)".format(lo)
    base = own[-1]
    later = [r for r in xfer if r["frame"] <= snap_frame
             and (r["frame"], int(r["line"])) > (base["frame"], int(base["line"]))
             and r["d0"] <= hi and r["d1"] >= lo]
    covered = set()
    for r in later:
        covered |= set(range(max(r["d0"], lo), min(r["d1"], hi) + 1))
    lines = ["  uploaded frame {} line {} from {} ({} bytes); {} later writes overlap:".format(
        base["frame"], base["line"], base["src"], base["bytes"], len(later))]
    for r in later[:12]:
        lines.append("    frame {:5d} {} {} -> ${:04X}-${:04X} ({} bytes)".format(
            r["frame"], r["kind"], r["src"] if r["src"] != "-" else r["pc"], r["d0"], r["d1"], r["bytes"]))
    if len(later) > 12:
        lines.append("    ... {} more".format(len(later) - 12))
    lines.append("  mismatching words explained by later writes: {}/{}".format(
        len(bad & covered), len(bad)))
    return "\n".join(lines)


def course(rom, snap, xfer=None, check_palette="cgram"):
    vram = load(snap, "vram.bin")
    cgram = load(snap, "cgram.bin")
    frame = int(os.path.basename(snap.rstrip("/")).lstrip("f").split("_")[0])
    ok = True
    # The font stream unpacks to 3,328 bytes but its record block uploads
    # 3,072 (tiles 0-191, docs/scenes.md); the tileset is uploaded whole.
    for name, bank, addr, word, size in (
            ("$90:FBBC font -> VRAM $4000", 0x90, 0xFBBC, 0x4000, 3072),
            ("$8D:CA0A tileset 0 -> VRAM $6000", 0x8D, 0xCA0A, 0x6000, None)):
        blob = stream(rom, bank, addr)[:size]
        bad = mismatched_words(vram, word, blob)
        same = sum(1 for i, b in enumerate(blob) if vram[word * 2 + i] == b)
        ok &= report(name, same, len(blob), "bytes", info=check_palette == "none")
        if bad and xfer:
            print(explain(xfer, bad, frame, word, len(blob)))
    pal = rom[snes_to_file(0x98, 0xC000):snes_to_file(0x98, 0xC000) + 512]
    wram = load(snap, "wram.bin")
    stage = wram[0x400:0x600]
    if check_palette == "staging":
        # Before the upload: the CGRAM image sits in the staging buffer
        # $7E:0400 that the NMI DMAs to CGRAM (docs/scenes.md, "cgram").
        same = sum(1 for i in range(256) if stage[2 * i:2 * i + 2] == pal[2 * i:2 * i + 2])
        ok &= report("$98:C000 palette 0 -> staging $7E:0400", same, 256, "colours")
    elif check_palette == "cgram":
        same = sum(1 for i in range(256) if stage[2 * i:2 * i + 2] == cgram[2 * i:2 * i + 2])
        ok &= report("CGRAM == staging $7E:0400 (after upload)", same, 256, "colours")
        diff = [i for i in range(40, 256) if pal[2 * i:2 * i + 2] != cgram[2 * i:2 * i + 2]]
        report("$98:C000 palette 0 -> CGRAM colours 40-255", 216 - len(diff), 216,
               "colours" + ("; differ: " + ",".join(map(str, diff)) if diff else "")
               + " (informational: partial palettes land on top)")
    return ok


def course_palette_only(rom, snap):
    cgram = load(snap, "cgram.bin")
    stage = load(snap, "wram.bin")[0x400:0x600]
    pal = rom[snes_to_file(0x98, 0xC000):snes_to_file(0x98, 0xC000) + 512]
    same = sum(1 for i in range(256) if stage[2 * i:2 * i + 2] == cgram[2 * i:2 * i + 2])
    ok = report("CGRAM == staging $7E:0400 (after upload)", same, 256, "colours")
    diff = [i for i in range(40, 256) if pal[2 * i:2 * i + 2] != cgram[2 * i:2 * i + 2]]
    print("info  $98:C000 colours 40-255 equal in CGRAM: {}/216; differ: {} (partial palettes "
          "via $80:90C8 land on top in the same frame)".format(216 - len(diff), diff or "none"))
    return ok


def title(rom, snap, xfer=None):
    vram = load(snap, "vram.bin")
    # The stream unpacks to 17,008 bytes; the record block DMAs the first
    # 16,384 ($7F:0C00-$7F:4BFF -> VRAM $0000-$1FFF, xfer.tsv frame 273).
    blob = stream(rom, 0x8B, 0x8000)[:0x4000]
    same = sum(1 for i, b in enumerate(blob) if vram[i] == b)
    ok = report("$8B:8000 title BG tiles -> VRAM $0000", same, len(blob), "bytes (first 16 KB)")
    other = stream(rom, 0x8E, 0xEC7F)
    probe = other[:32]
    hits = [off // 2 for off in range(0, len(vram) - 32, 2) if vram[off:off + 32] == probe]
    print("info  $8E:EC7F ({} bytes, 'title screen tiles' in compression.md): {}".format(
        len(other), "found at " + ",".join("${:04X}".format(h) for h in hits) if hits else "not in VRAM"))
    return ok


def run(args):
    subprocess.run([BIN, "--quiet"] + args, check=True, cwd=ROOT)


def run_all(rom):
    """Self-contained acceptance: run the game and check the oracles."""
    out = os.path.join(ROOT, "build", "emu", "oracles")
    ok = True
    # Attract mode: the demo hole's course bundle is uploaded at frames
    # 1528-1560; 1554 is after the tileset/font loads and before the
    # per-hole sprite slots and the palette arrive, 1561 after the palette.
    run(["--frames", "1600", "--out", os.path.join(out, "attract"), "--log-vram-dma",
         "--snap-at", "298,1554,1561,1589"])
    xfer = read_xfer(os.path.join(out, "attract", "xfer.tsv"))
    snap = os.path.join(out, "attract", "f{:06d}")
    print("course scene, attract demo, frame 1554 (bundle uploaded, palette staged)")
    ok &= course(rom, snap.format(1554), xfer, "staging")
    print("course scene, attract demo, frame 1561 (palette uploaded)")
    ok &= course_palette_only(rom, snap.format(1561))
    print("course scene, attract demo, frame 1589 (settled; sprite slots reloaded per hole)")
    course(rom, snap.format(1589), xfer, "none")
    print("title scene, frame 298")
    ok &= title(rom, os.path.join(out, "attract", "f000298"))
    return ok


def main():
    ap = argparse.ArgumentParser(description="check snapshots against static findings")
    ap.add_argument("which", choices=["course", "title", "all"])
    ap.add_argument("snaps", nargs="*")
    ap.add_argument("--xfer", help="xfer.tsv from --log-vram-dma, to explain mismatches")
    a = ap.parse_args()
    rom = load_rom()
    if a.which == "all":
        return 0 if run_all(rom) else 1
    xfer = read_xfer(a.xfer) if a.xfer else None
    fn = course if a.which == "course" else title
    ok = True
    for snap in a.snaps:
        print(snap)
        ok &= fn(rom, snap, xfer)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
