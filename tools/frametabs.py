#!/usr/bin/env python3
"""Find the frame-pointer tables that index metasprite lists.

`$89:8000` is one such table, not the index. An object holds the address and
bank of a table (`$7E:0B9E,X`, `$7E:0BBE,X`) plus an index into it
(`$7E:0B7E,X`); other subsystems index their own tables directly with an
ordinary RAM counter. So the tables are scattered, and finding them is what
turns bank `$89` from a blob into a catalogue.

Five finders, because they fail differently. All five scan the **whole** ROM.

*anim1c* -- anchored, the strongest. Animation-script opcode `$1C` is
`sub_obj_set_frame_ptr $80:9B98`, whose 3-byte operand is exactly
`addr16 bank8` of a frame pointer table (it is the only `STA $0B9E,X` in the
ROM). So the byte pattern `1C lo hi bank` inside a script names a table
outright. This is what recovers `$89:9295`, `$92F3`, `$9351` and `$9365` --
the operands of the four object-type scripts at `$87:99FE`.

*longidx* -- `LDA $bb:aaaa,X` (`$BF`) with `bb` in banks `$84`/`$89`: the
table's bank is in the instruction.

*longabs* -- `LDA $bb:aaaa` (`$AF`), the un-indexed long read that fetches
entry 0 of a table. `$89:CCDB` is reached only this way, from
`$84:E241` and `$86:8476`, both `LDA $89:CCDB / STA $C0` -- `$C0` is the
frame-list word `sub_oam_enqueue` pushes onto its queue.

*dbr* -- plain `LDA $aaaa,X` (`$BD`) near a `JSL $80:8B02`, executed with
`DBR=$89`; the long scans cannot see these.

*obj2* -- `LDA #imm16` feeding `STA $5E1C,Y`, the second object system's
frame pointer slot (321 store sites, 297 of them immediate, 96 distinct
values). Marked **inferred**: the immediates are table-shaped and four of
them are exactly the `$1C`-confirmed tables, but the draw path that consumes
`$5E1C,Y` (`$87:8C93` -> `$80:E60B` -> `$80:8B09` -> queue -> `$80:8C08` ->
`$80:8D89`) uses the word as a frame *list* pointer, so something between the
store and the draw must still resolve table+index. Unresolved; see
docs/animation.md.

*struct* -- runs of words that all happen to address well-formed frame lists.
Finds tables no code path reaches yet, at the cost of false positives.

A candidate at T is accepted when at least `--min-live` of its first 8 words
are not `$FFFF`, and every live word `w` satisfies `w > T` (a table precedes
its data; true of every known one) and parses as a frame list that terminates
cleanly. The extent ends at the first word that fails, or at the lowest
target -- a table cannot run into its own data.

Byte accounting then reports how much of the frame-data region every accepted
table explains, and what is left over, and is written to
`build/sprites/accounting.txt`. Double-claimed bytes mean a bogus table, so
they are counted separately.

    python3 tools/frametabs.py                     # -> build/sprites/tables.tsv
    python3 tools/frametabs.py --only-code         # skip the structural scan
    python3 tools/frametabs.py --check '$89:9295'  # explain one candidate
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sprites  # noqa: E402
from lorom import (AddressError, file_to_snes, fmt_file, fmt_snes,  # noqa: E402
                   parse_addr, snes_to_file)
from romcheck import RomError, load_rom  # noqa: E402

FRAME_BANK = 0x89
TABLE_BANKS = (0x84, 0x89)
# Frame data in bank $89 runs from just past the $89:8000 table to the start
# of the $FF padding; established by scanning back for the last non-$FF byte.
DATA_LO = 0x0480D2
DATA_HI = 0x04F36D
ENQUEUE = (0x80, 0x8B02)     # sub_oam_enqueue
MAX_PARTS = 64
BACKSCAN = 48                # how far back from a JSL to look for the load
NULL_ENTRIES = (0x0000, 0xFFFF)   # both appear as "no frame" holes

ANIM_SET_FRAME_PTR = 0x1C    # animation opcode -> sub_obj_set_frame_ptr $80:9B98
# STA $5E1C,Y -- the second object system's frame pointer slot.
OBJ2_STORE = bytes((0x99, 0x1C, 0x5E))

# Only obj2 is speculative among the code finders; everything else follows a
# real addressing mode or a decoded script operand.
SOURCE_CONFIDENCE = {
    "anim1c": "confirmed",
    "longidx": "confirmed",
    "longabs": "confirmed",
    "dbr": "confirmed",
    "obj2": "inferred",
    "struct": "inferred",
}
MAX_REFS = 6                 # call sites listed per table before eliding
# Banks $80-$87 are the ones that hold executable code (CLAUDE.md). Scanning
# the whole ROM is right -- a reference can live in any code bank -- but a
# byte pattern found inside banks $88+ is data that happens to look like an
# instruction, so it only ever earns "inferred" and has to pass the alignment
# filter like any other guess.
CODE_END = 0x040000


def word(data, bank, addr):
    off = snes_to_file(bank, addr)
    return int.from_bytes(data[off:off + 2], "little")


def trim_nulls(data, bank, addr, entries):
    """Drop trailing null entries; they belong to whatever follows."""
    while entries and word(data, bank, addr + 2 * (entries - 1)) in NULL_ENTRIES:
        entries -= 1
    return entries


def truncate_at_neighbours(data, tables, min_live):
    """Cap each table where the next one starts.

    Without this a table runs straight through its successors: the words of
    `$89:92F3` are perfectly valid frame pointers when read as a continuation
    of `$89:9295`, so nothing intrinsic to the data stops the walk.
    """
    out = []
    ordered = sorted(tables, key=lambda t: (t["bank"], t["addr"]))
    for i, t in enumerate(ordered):
        limit = 0x10000
        for nxt in ordered[i + 1:]:
            if nxt["bank"] == t["bank"] and nxt["addr"] > t["addr"]:
                limit = nxt["addr"]
                break
        entries = min(t["entries"], max(0, (limit - t["addr"]) // 2))
        entries = trim_nulls(data, t["bank"], t["addr"], entries)
        targets = [w for w in (word(data, t["bank"], t["addr"] + 2 * j)
                               for j in range(entries))
                   if w not in NULL_ENTRIES]
        if len(targets) < min_live:
            continue
        t = dict(t, entries=entries, live=len(targets), targets=targets)
        out.append(t)
    return out


def frame_ok(data, bank, addr, max_parts=MAX_PARTS):
    """Parse a frame list; return a dict if it is well formed, else None."""
    if addr < 0x8000:
        return None
    try:
        off = snes_to_file(bank, addr)
    except AddressError:
        return None
    parts, end = sprites.parse_frame(data, off, max_parts=max_parts)
    real = [p for p in parts if "control" not in p]
    if not real or not real[-1]["last"]:
        return None                      # ran to the cap without terminating
    if end > snes_to_file(bank, 0xFFFF) + 1:
        return None
    return {"parts": len(real), "start": off, "end": end}


def frames_consistent(data, targets):
    """True when a table's own frames never overlap at different alignments.

    Frames are packed back to back, so two entries either name the same frame
    or disjoint ones. A table assembled out of coincidence almost always has
    entries whose frames straddle each other, which is the cheapest reliable
    way to reject one.
    """
    spans = []
    for w in sorted(set(targets)):
        info = frame_ok(data, FRAME_BANK, w)
        if not info:
            return False
        spans.append((info["start"], info["end"]))
    spans.sort()
    for (s1, e1), (s2, _) in zip(spans, spans[1:]):
        if s2 != s1 and s2 < e1:
            return False
    return True


def compatible(data, targets, confirmed):
    """True when none of these frames straddles a confirmed frame.

    A speculative table that reads the same bytes at a different record
    boundary than a code-confirmed table is simply wrong, and this is the
    cheapest way to say so.
    """
    for w in set(targets):
        info = frame_ok(data, FRAME_BANK, w)
        if not info:
            return False
        for cs, ce in confirmed.items():
            if cs == info["start"]:
                continue
            if info["start"] < ce and cs < info["end"]:
                return False
    return True


def table_at(data, bank, addr, min_live=4, max_entries=256, strict=False):
    """Validate a frame-pointer table at (bank, addr). Returns a dict or None."""
    entries, live, targets = 0, 0, []
    # "A table precedes its data" only constrains a table that lives in the
    # frame bank itself; $84:92C5 points backwards into bank $89 and is real.
    same_bank = bank == FRAME_BANK
    lowest = 0x10000
    for i in range(max_entries):
        a = addr + 2 * i
        if a + 2 > 0x10000 or (same_bank and a >= lowest):
            break                        # a table cannot run into its own data
        w = int.from_bytes(data[snes_to_file(bank, a):snes_to_file(bank, a) + 2],
                           "little")
        if w in NULL_ENTRIES:
            entries += 1
            continue
        if (same_bank and w <= addr) or frame_ok(data, FRAME_BANK, w) is None:
            break
        entries += 1
        live += 1
        targets.append(w)
        lowest = min(lowest, w)
    if live < min_live:
        return None
    if strict and not frames_consistent(data, targets):
        return None
    entries = trim_nulls(data, bank, addr, entries)
    return {"bank": bank, "addr": addr, "entries": entries, "live": live,
            "targets": targets}


def scan_code(data):
    """Table addresses named by the code idioms.

    Returns {(bank, addr): {"refs": {finder: {file offset}}}} over the
    **whole** ROM. The scan used to stop at 0x40000 (banks $80-$87), which is
    where the engine code is, but that also hid every reference living in a
    later bank -- `$89:CCDB` is named from `$84:E241` *and* `$86:8476`, and the
    `$1C` script operands are in bank `$87` and beyond.
    """
    found = {}
    end = len(data)

    def note(bank, addr, how, site):
        # Keep the sites per finder: "reached from code" has to be asked of
        # the finder that claims to confirm, not of the union. $89:9411 is
        # named by an obj2 store in bank $85 and by a `1C` byte pattern in the
        # course data at $9A:EBF7, and only the second one is an anim1c claim.
        rec = found.setdefault((bank, addr), {"refs": {}})
        rec["refs"].setdefault(how, set()).add(site)

    table_banks_lo = set(b & 0x7F for b in TABLE_BANKS)

    # Anchored: animation opcode $1C, whose operand is literally addr16+bank8
    # of a frame pointer table (sub_obj_set_frame_ptr $80:9B98).
    for i in range(end - 4):
        if data[i] != ANIM_SET_FRAME_PTR:
            continue
        addr = int.from_bytes(data[i + 1:i + 3], "little")
        bank = data[i + 3]
        if (bank & 0x7F) in table_banks_lo and addr >= 0x8000:
            note(0x80 | (bank & 0x7F), addr, "anim1c", i)

    # Anchored: LDA #imm16 / STA $5E1C,Y -- the second object system.
    for i in range(3, end - 3):
        if data[i:i + 3] != OBJ2_STORE or data[i - 3] != 0xA9:
            continue
        addr = int.from_bytes(data[i - 2:i], "little")
        if addr >= 0x8000:
            note(FRAME_BANK, addr, "obj2", i - 3)

    # LDA long,X / LDA long -- the table's bank is in the instruction.
    for i in range(end - 4):
        if data[i] not in (0xBF, 0xAF):
            continue
        addr = int.from_bytes(data[i + 1:i + 3], "little")
        bank = data[i + 3]
        if (bank & 0x7F) in table_banks_lo and addr >= 0x8000:
            note(0x80 | (bank & 0x7F), addr,
                 "longidx" if data[i] == 0xBF else "longabs", i)

    # LDA abs,X feeding sub_oam_enqueue, executed with DBR=$89.
    tail = bytes([0x22, ENQUEUE[1] & 0xFF, ENQUEUE[1] >> 8, ENQUEUE[0]])
    for i in range(end - 4):
        if data[i:i + 4] != tail:
            continue
        for j in range(max(0, i - BACKSCAN), i):
            if data[j] == 0xBD:
                addr = int.from_bytes(data[j + 1:j + 3], "little")
                if addr >= 0x8000:
                    note(FRAME_BANK, addr, "dbr", j)
            elif data[j] == 0xBF and data[j + 3] in TABLE_BANKS:
                note(0x80 | (data[j + 3] & 0x7F),
                     int.from_bytes(data[j + 1:j + 3], "little"), "longidx", j)
    return found


def confidence_of(refs):
    """A table is confirmed when a *confirming* finder reached it from code.

    `refs` is {finder: {file offset}}. A claim whose only sites sit outside
    the code banks is a data coincidence -- `1C xx xx 89` occurs by chance in
    the course tilemap banks -- so it is demoted rather than trusted.
    """
    for how, sites in refs.items():
        if SOURCE_CONFIDENCE.get(how) != "confirmed":
            continue
        if any(o < CODE_END for o in sites):
            return "confirmed"
    return "inferred"


def all_refs(refs):
    return set().union(*refs.values()) if refs else set()


def fmt_refs(refs):
    """Call sites as SNES addresses, capped so the TSV stays readable."""
    flat = sorted(all_refs(refs)) if isinstance(refs, dict) else sorted(refs)
    if not flat:
        return "-"
    out = [fmt_snes(*file_to_snes(o)) for o in flat[:MAX_REFS]]
    if len(flat) > MAX_REFS:
        out.append("+{}".format(len(flat) - MAX_REFS))
    return ";".join(out)


def scan_struct(data, banks=TABLE_BANKS, min_live=4):
    """Table addresses that look like tables purely by structure."""
    out = {}
    for bank in banks:
        base = snes_to_file(bank, 0x8000)
        for a in range(0x8000, 0xFFFE, 2):
            w = int.from_bytes(data[base + a - 0x8000:base + a - 0x8000 + 2], "little")
            # Cheap pre-filter: the first word must plausibly start a table.
            if w == 0xFFFF or w <= a or w < 0x8000:
                continue
            if frame_ok(data, FRAME_BANK, w) is None:
                continue
            t = table_at(data, bank, a, min_live)
            if t:
                out[(bank, a)] = {"refs": {"struct": set()}}
    return out


def dedupe(tables):
    """Drop tables wholly contained in a larger one starting earlier.

    Run this **after** `truncate_at_neighbours`, never before. Before
    truncation every table's extent is the validator's optimistic reach, so
    `$89:9295` appears to contain `$92F3`, `$9351` and `$9365` and this would
    delete three tables the `$1C` operands name outright.
    """
    keep = []
    for t in sorted(tables, key=lambda t: (t["bank"], t["addr"])):
        end = t["addr"] + 2 * t["entries"]
        covered = any(p["bank"] == t["bank"] and p["addr"] <= t["addr"] and
                      p["addr"] + 2 * p["entries"] >= end for p in keep)
        if not covered:
            keep.append(t)
    return keep


def accounting(data, tables):
    """Coverage of the frame-data region, and misaligned overlaps.

    Several tables pointing at the *same* frame is normal -- `$89:9351` and
    `$89:9365` deliberately share entries. The defect signal is two frames
    that overlap while starting at *different* offsets, which means one of
    them is being read at the wrong alignment and its table is bogus.
    """
    extents = {}
    for t in tables:
        for w in set(t["targets"]):
            info = frame_ok(data, FRAME_BANK, w)
            if info:
                extents[info["start"]] = max(extents.get(info["start"], 0),
                                             info["end"])
    claim = bytearray(DATA_HI - DATA_LO + 1)
    owner = {}
    misaligned = set()
    for start, end in sorted(extents.items()):
        for o in range(max(start, DATA_LO), min(end, DATA_HI + 1)):
            i = o - DATA_LO
            if claim[i] and owner.get(i) != start:
                misaligned.add(start)
                misaligned.add(owner[i])
            claim[i] = 1
            owner.setdefault(i, start)
    covered = sum(claim)
    unclaimed, run = [], None
    for i, c in enumerate(claim):
        if not c and run is None:
            run = i
        elif c and run is not None:
            unclaimed.append((run + DATA_LO, i + DATA_LO))
            run = None
    if run is not None:
        unclaimed.append((run + DATA_LO, len(claim) + DATA_LO))
    return covered, len(extents), sorted(misaligned), unclaimed


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/sprites")
    ap.add_argument("--only-code", action="store_true", help="skip the structural scan")
    ap.add_argument("--min-live", type=int, default=4)
    ap.add_argument("--check", help="explain one candidate table address")
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    if args.check:
        kind, value = parse_addr(args.check)
        bank, addr = value if kind == "snes" else (FRAME_BANK, 0)
        t = table_at(data, bank, addr, args.min_live)
        if not t:
            print("{}: not a valid frame-pointer table".format(args.check))
            return 1
        print("{}: {} entries, {} live -- the validator's untruncated reach, "
              "before neighbouring tables cap it".format(
                  fmt_snes(bank, addr), t["entries"], t["live"]))
        for i, w in enumerate(t["targets"][:40]):
            info = frame_ok(data, FRAME_BANK, w)
            print("  {:3d}: {}  {} parts".format(i, fmt_snes(FRAME_BANK, w),
                                                 info["parts"]))
        return 0

    # Code-anchored tables are trusted: they follow real addressing. A few of
    # their entries deliberately point mid-list to draw a subset of a frame's
    # parts, so internal overlap is noted, not grounds for rejection.
    sources = scan_code(data)
    print("code scan: {} candidate addresses".format(len(sources)))
    tables, speculative = [], []
    for (bank, addr), rec in sorted(sources.items()):
        # obj2-only candidates are held back and filtered like the structural
        # ones: what $5E1C,Y actually holds is not settled, so they must not
        # be allowed to re-cut a confirmed table's frames.
        conf = confidence_of(rec["refs"])
        inferred = conf == "inferred"
        t = table_at(data, bank, addr, args.min_live, strict=inferred)
        if not t:
            continue
        t["source"] = ";".join(sorted(rec["refs"]))
        t["confidence"] = conf
        t["refs"] = dict(rec["refs"])
        (speculative if inferred else tables).append(t)
    tables = dedupe(truncate_at_neighbours(data, tables, args.min_live))
    report_sources(tables, "code-confirmed")

    # Speculative candidates -- obj2 first, then structural -- must be
    # internally consistent *and* must not contradict a confirmed frame's
    # alignment.
    if not args.only_code:
        speculative.extend(struct_candidates(data, args.min_live))
    extra = []
    for t in speculative:
        confirmed = confirmed_extents(data, tables + extra)
        if any(p["bank"] == t["bank"] and
               p["addr"] <= t["addr"] < p["addr"] + 2 * p["entries"]
               for p in tables + extra):
            continue
        if not compatible(data, t["targets"], confirmed):
            continue
        extra.append(t)
    print("speculative: {} further tables pass".format(len(extra)))
    tables = dedupe(truncate_at_neighbours(data, tables + extra, args.min_live))
    report_sources(tables, "accepted")

    path = os.path.join(args.out, "tables.tsv")
    parent = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(parent):
        os.makedirs(parent)
    with open(path, "w") as f:
        f.write("table_addr\ttable_file\tentries\tlive\tfirst_target"
                "\tlast_target\tsource\tconfidence\trefs\n")
        for t in tables:
            off = snes_to_file(t["bank"], t["addr"])
            f.write("\t".join([
                fmt_snes(t["bank"], t["addr"]), fmt_file(off),
                str(t["entries"]), str(t["live"]),
                fmt_snes(FRAME_BANK, min(t["targets"])),
                fmt_snes(FRAME_BANK, max(t["targets"])),
                t["source"], t["confidence"],
                fmt_refs(t.get("refs", ()))]) + "\n")
    print("wrote {}".format(path))

    report = accounting_report(data, tables)
    apath = os.path.join(args.out, "accounting.txt")
    with open(apath, "w") as f:
        f.write(report + "\n")
    print(report)
    print("wrote {}".format(apath))
    return 0


def struct_candidates(data, min_live):
    """Structural candidates, as table dicts ready for the speculative pass."""
    out = []
    for (bank, addr), rec in sorted(scan_struct(data, min_live=min_live).items()):
        t = table_at(data, bank, addr, min_live, strict=True)
        if not t:
            continue
        t["source"] = "struct"
        t["confidence"] = "inferred"
        t["refs"] = {}
        out.append(t)
    return out


def confirmed_extents(data, tables):
    """{frame start offset: end offset} over every frame these tables name."""
    out = {}
    for t in tables:
        for w in t["targets"]:
            info = frame_ok(data, FRAME_BANK, w)
            if info:
                out[info["start"]] = info["end"]
    return out


def report_sources(tables, label):
    counts = {}
    for t in tables:
        for h in t["source"].split(";"):
            counts[h] = counts.get(h, 0) + 1
    print("{}: {} tables ({})".format(
        label, len(tables),
        ", ".join("{} {}".format(v, k) for k, v in sorted(counts.items()))))


def accounting_report(data, tables):
    """The byte-accounting block, as text, so it can be printed and stored."""
    covered, nframes, misaligned, unclaimed = accounting(data, tables)
    total = DATA_HI - DATA_LO + 1
    lines = ["byte accounting over {}..{} ({} bytes):".format(
        fmt_file(DATA_LO), fmt_file(DATA_HI), total)]
    lines.append("  {} tables, {} of them confirmed".format(
        len(tables), sum(1 for t in tables if t["confidence"] == "confirmed")))
    lines.append("  {} distinct frames cover {} bytes ({:.1f}%)".format(
        nframes, covered, 100.0 * covered / total))
    lines.append("  misaligned overlaps: {}".format(len(misaligned) or "none"))
    for start in misaligned[:8]:
        lines.append("    frame at {}".format(fmt_file(start)))
    lines.append("  unclaimed {} bytes in {} runs".format(
        total - covered, len(unclaimed)))
    for lo, hi in sorted(unclaimed, key=lambda r: r[1] - r[0], reverse=True)[:16]:
        lines.append("    {}..{}  {} bytes".format(
            fmt_file(lo), fmt_file(hi - 1), hi - lo))
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
