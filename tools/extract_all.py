#!/usr/bin/env python3
"""Run every extractor in dependency order and write a manifest.

Each tool here works alone and takes hand-picked addresses; this runs them
all against a clean `build/` and then cross-references what came out, so a
later session can ask "what is this stream" and get an answer rather than a
guess.

Tracks, in the order they have to run:

    courses    course tables -> per-hole tilemaps, renders, geometry JSON
    scenes     screen setup blocks and what each loader entry loads
    gfx        HAL streams: referenced ones first, then a scan of the gaps
    vram       VRAM loader and queue records, the uncompressed tile chunks
               the queue copies, CGRAM images, the course OBJ page
    sprites    frame tables, the 234 thread objects, and their sheets
    spc        driver, songs, samples, sound effects; then every song and
               effect rendered to WAV by tools/spcrender (needs cargo)
    text       strings and the font sheet
    emu        run the game headless (tools/snesstep): every reachable
               screen to build/screens/, executed-code coverage
    emuholes   play all 232 holes and the 20 demos, build sprite sheets
               from live state (about 30 minutes; only with --only emuholes)
    coverage   which ROM bytes all of the above account for

`--only` runs a subset. Everything is idempotent: re-running overwrites.

The manifest at `build/manifest.tsv` is the cross-reference. Its `status`
column is the point of the whole exercise:

    verified   something in the ROM points at this: a decompressor call
               site, a loader, a course pointer table, a VRAM queue record,
               a CGRAM move, or a song table entry
    lead       a compression scan found it and nothing references it

A stream that no pointer reaches may be an accident of alignment, so the
distinction is not cosmetic. A VRAM record can also name a ROM bank
directly, which means that asset is stored uncompressed and no scan will
ever find it; those are the `uncompressed` rows, taken from
`tools/vram.py direct`.

    python3 tools/extract_all.py
    python3 tools/extract_all.py --only courses,scenes
    python3 tools/extract_all.py --manifest-only
"""

import argparse
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import fmt_file, fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

# (track, description, argv). Ordered by dependency: courses and scenes
# stand alone, sprites wants the composed OBJ page from vram.
STEPS = [
    ("courses", "course tables -> per-hole files", ["courses.py"]),
    ("courses", "row directory assertions", ["coursemap.py", "--check"]),
    ("courses", "isometric renders", ["coursemap.py"]),
    ("courses", "geometry JSON and heightmaps", ["terrain.py", "--export"]),
    ("scenes", "screen blocks, loaders, callers, bundles", ["scenes.py", "all"]),
    ("gfx", "whole-ROM stream scan", ["extract_gfx.py"]),
    ("vram", "VRAM loader records", ["vram.py", "loaders"]),
    ("vram", "VRAM queue records, every call site", ["vram.py", "queue"]),
    ("vram", "uncompressed tile chunks the queue copies", ["vram.py", "direct"]),
    ("vram", "CGRAM images", ["vram.py", "cgram"]),
    ("vram", "composed course OBJ page",
     ["vram.py", "objpage", "--scene", "course",
      "--png", "build/vram/obj/course.png",
      "-o", "build/vram/obj/course.bin"]),
    ("sprites", "frame-pointer tables and lists", ["frametabs.py"]),
    ("sprites", "thread object traces", ["objanim.py"]),
    ("sprites", "object, table and block sheets", ["objsheets.py"]),
    ("spc", "driver, songs, samples, instrument tables", ["spc_extract.py"]),
    ("spc", "song and effect sequences, MIDI, per-effect SPC",
     ["nspc.py", "--all", "--midi", "--spc"]),
    ("spc", "render songs and effects to WAV; measure and tag lengths",
     ["render_audio.py"]),
    ("spc", "renderer check: BRR decode against brr.py",
     ["audio_check.py", "brr"]),
    ("spc", "renderer check: key-ons against the sequence timeline",
     ["audio_check.py", "kon"]),
    ("text", "strings in the font encoding", ["text.py", "--strings"]),
    ("text", "the font sheet", ["text.py", "--font-sheet"]),
    ("emu", "emulator vs the static facts", ["snesstep/oracles.py", "all"]),
    ("emu", "every reachable screen, rendered", ["snesstep/screens.py"]),
    ("emu", "base snapshot for Kirby's animation renders",
     ["kirbyanim.py", "--make-base"]),
    ("emu", "Kirby's 51 animation scripts, decoded and replayed",
     ["kirbyanim.py"]),
    ("emuholes", "all 232 holes in play -> live-state sprite sheets",
     ["snesstep/holes.py"]),
    ("emuholes", "the 20 DEMOPLAY SELECT demos", ["snesstep/demos.py"]),
    ("emuholes", "merged live-state sheets",
     ["emusheets.py", "--cache", "build/emu/holes/emusheets.pickle",
      "--merge", "build/emu/demos/emusheets.pickle",
      "--out", "build/sprites/emu"]),
    ("emuholes", "actor id -> object type check", ["actorids.py"]),
    ("emuholes", "Kirby's animations as seen in play, by state and angle",
     ["kirbyanim.py", "--live"]),
    ("emuholes", "course 1 played to the end: hole-outs, results, ranking",
     ["snesstep/autoplay.py", "--course", "0", "--frames", "17000"]),
]
# Tracks that run only when named in --only.
OPT_IN = {"emuholes"}
# Runs after the manifest is written, because it reads it.
COVERAGE = ("coverage", "ROM byte attribution", ["coverage.py"])
TRACKS = sorted(set(step[0] for step in STEPS + [COVERAGE]))


def run(step, args):
    track, what, argv = step
    cmd = [sys.executable, os.path.join(HERE, argv[0])] + argv[1:]
    print("== {:8s} {}".format(track, what))
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True)
    dt = time.time() - t0
    tail = (proc.stdout or "").strip().splitlines()
    for line in tail[-3:]:
        print("   {}".format(line))
    if proc.returncode != 0:
        print("   FAILED ({:.1f}s), exit {}".format(dt, proc.returncode))
        for line in (proc.stderr or "").strip().splitlines()[-5:]:
            print("   {}".format(line))
    else:
        print("   ok ({:.1f}s)".format(dt))
    return proc.returncode == 0, proc


def read_tsv(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        lines = f.read().splitlines()
    if not lines:
        return []
    head = lines[0].split("\t")
    return [dict(zip(head, l.split("\t"))) for l in lines[1:] if l.strip()]


def course_pointers(d):
    """Every source a bank $88 course table points at."""
    from courses import ENTRIES, TABLE_COUNT, default_entries, entry
    defaults = default_entries(d)
    out = {}
    for t in range(TABLE_COUNT):
        for i in range(ENTRIES):
            bank, addr = entry(d, t, i)
            if (bank, addr) == defaults[t] or addr < 0x8000:
                continue
            out.setdefault(snes_to_file(bank, addr), []).append(
                "course table {} hole {}".format(t, i))
    return out


def audio_pointers(d):
    """Song sources and the APU init-set blocks.

    These live in banks $95-$98 and are reached by their own tables rather
    than by any graphics loader, so without this they would all read as
    unreferenced leads.
    """
    out = {}
    song_table = snes_to_file(0x80, 0xB745)
    for i in range(33):
        off = song_table + 4 * i
        addr = int.from_bytes(d[off:off + 2], "little")
        bank = int.from_bytes(d[off + 2:off + 4], "little") & 0xFF
        if addr >= 0x8000:
            out.setdefault(snes_to_file(bank, addr), []).append(
                "song {} (id ${:02X})".format(i, 0x7E + i))

    # tbl_spc_init_sets: 2 entries, each a zero-terminated list of long
    # pointers to block chains.
    sets = snes_to_file(0x80, 0xB729)
    for s in range(2):
        lst = int.from_bytes(d[sets + 2 * s:sets + 2 * s + 2], "little")
        if lst < 0x8000:
            continue
        # Entries are (addr16, bank16), four bytes, and the list ends on a
        # zero address -- not three bytes, which walks off into code.
        p = snes_to_file(0x80, lst)
        for _ in range(8):
            addr = int.from_bytes(d[p:p + 2], "little")
            bank = int.from_bytes(d[p + 2:p + 4], "little") & 0xFF
            if addr == 0:
                break
            if addr >= 0x8000:
                out.setdefault(snes_to_file(bank, addr), []).append(
                    "APU init set {}".format(s))
            p += 4
    return out


def build_manifest(d, out_path):
    """Join the stream scan against everything that points into the ROM."""
    refs = {}
    root = os.path.dirname(os.path.abspath(out_path))

    def note(off, why):
        refs.setdefault(off, []).append(why)

    for off, why in audio_pointers(d).items():
        note(off, why[0])

    for off, why in course_pointers(d).items():
        note(off, why[0] if len(why) == 1 else "{} course pointers".format(len(why)))

    for row in read_tsv(os.path.join(root, "scenes", "loads.tsv")):
        src = row.get("src_file", "")
        if src.startswith("0x"):
            note(int(src, 16), "{} loader {} ({})".format(
                row.get("table"), row.get("entry"), row.get("kind")))

    for row in read_tsv(os.path.join(root, "vram", "index.tsv")):
        src = row.get("src_file", "")
        if src.startswith("0x"):
            note(int(src, 16), "VRAM loader {}".format(row.get("site_addr")))

    rows = []
    for row in read_tsv(os.path.join(root, "gfx", "index.tsv")):
        off = int(row["file_offset"], 16)
        why = refs.pop(off, [])
        # The scan's own reason: a decompressor call site or a pointer table.
        if row.get("referenced_by", "-") not in ("-", ""):
            why.append(row["referenced_by"])
        rows.append({
            "file_offset": row["file_offset"],
            "snes_addr": row["snes_addr"],
            "kind": row.get("kind", ""),
            "packed": row.get("packed", ""),
            "unpacked": row.get("unpacked", ""),
            "status": "verified" if why else "lead",
            "referenced_by": "; ".join(why[:3]),
        })

    # Uncompressed assets: ROM chunks a VRAM queue record copies as they are.
    for row in read_tsv(os.path.join(root, "gfx", "direct", "index.tsv")):
        refs.pop(int(row["src_file"], 16), None)
        rows.append({
            "file_offset": row["src_file"],
            "snes_addr": row["src_addr"],
            "kind": "uncompressed " + row.get("kind", ""),
            "packed": row["size"], "unpacked": row["size"],
            "status": "verified",
            "referenced_by": "VRAM queue, {} site(s), first {}".format(
                row.get("sites"), row.get("first_site")),
        })

    # Full CGRAM images, block-moved rather than decompressed.
    from vram import CGRAM_BYTES, find_cgram_sites
    seen = set()
    for site, bank, src, length in find_cgram_sites(d):
        off = snes_to_file(bank, src)
        if off in seen:
            continue
        seen.add(off)
        refs.pop(off, None)
        size = min(length, CGRAM_BYTES)
        rows.append({
            "file_offset": fmt_file(off), "snes_addr": fmt_snes(bank, src),
            "kind": "cgram image", "packed": size, "unpacked": size,
            "status": "verified",
            "referenced_by": "MVN at {}".format(fmt_file(site)),
        })

    # Anything pointed at that the scan never found: uncompressed assets and
    # streams the scan's thresholds rejected. These matter most.
    for off, why in sorted(refs.items()):
        bank, addr = (off // 0x8000) | 0x80, (off % 0x8000) + 0x8000
        rows.append({
            "file_offset": fmt_file(off),
            "snes_addr": fmt_snes(bank, addr),
            "kind": "unscanned",
            "packed": "", "unpacked": "",
            "status": "verified",
            "referenced_by": "; ".join(why[:3]),
        })

    rows.sort(key=lambda r: int(r["file_offset"], 16))
    cols = ["file_offset", "snes_addr", "kind", "packed", "unpacked",
            "status", "referenced_by"]
    with open(out_path, "w") as f:
        f.write("\t".join(cols) + "\n")
        for r in rows:
            f.write("\t".join(str(r[c]) for c in cols) + "\n")

    verified = sum(1 for r in rows if r["status"] == "verified")
    unscanned = sum(1 for r in rows if r["kind"] == "unscanned")
    print("manifest: {} entries, {} verified, {} leads, {} referenced but "
          "not found by the scan".format(
              len(rows), verified, len(rows) - verified, unscanned))
    return rows


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma-separated track names")
    ap.add_argument("--manifest-only", action="store_true",
                    help="skip the extractors, just rebuild build/manifest.tsv")
    ap.add_argument("--out", default="build",
                    help="where the manifest goes and where it looks for the "
                         "extractors' output; the extractors themselves "
                         "always write under build/")
    args = ap.parse_args()

    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    if not os.path.isdir(args.out):
        os.makedirs(args.out)

    failed = []
    want = None
    if not args.manifest_only:
        want = set(args.only.split(",")) if args.only else None
        if want and want - set(TRACKS):
            print("error: unknown track(s) {}; known: {}".format(
                ", ".join(sorted(want - set(TRACKS))), ", ".join(TRACKS)),
                file=sys.stderr)
            return 2
        for step in STEPS:
            if want and step[0] not in want:
                continue
            if not want and step[0] in OPT_IN:
                continue
            ok, _ = run(step, args)
            if not ok:
                failed.append("{}: {}".format(step[0], step[1]))

    print()
    build_manifest(d, os.path.join(args.out, "manifest.tsv"))
    if not args.manifest_only and (not want or "coverage" in want):
        ok, _ = run(COVERAGE, args)
        if not ok:
            failed.append("coverage: ROM byte attribution")
    if failed:
        print("\n{} step(s) failed:".format(len(failed)))
        for f in failed:
            print("  {}".format(f))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
