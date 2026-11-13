#!/usr/bin/env python3
"""Find the frame-pointer tables that index metasprite lists.

Bank `$89` holds metasprite frame lists and, interleaved with them, word
tables that point at those lists. Two object systems read them:

* the script-driven objects hold a table address and bank (`$7E:0B9E,X`,
  `$7E:0BBE,X`) plus an index (`$7E:0B7E,X`);
* the thread-driven objects hold a 16-bit table address in `$7E:5E1C,X` and an
  index in `$7E:5D9C,X`. Their draw routines `$80:E55A` / `$80:E5A2` do
  `LDA $5D9C,X / ASL / CLC / ADC $5E1C,X / STA $DE / LDA $9E / STA $E0 /
  LDA [$DE] / STA $C0` and then enqueue `$C0`, so the slot is a **table** and
  `$5D9C` the entry. A few objects install their own draw routine instead
  (`$87:8C93`, `$87:932E`, `$87:98AA`: `LDA $5E1C,Y / STA $C0`), and for those
  the slot is a frame **list**. Both readings are real; which one applies is
  a property of the object, and the bytes tell them apart (see `frame_ok`).

Finders, because they fail differently. All of them scan the **whole** ROM.

*anim1c* -- animation-script opcode `$1C` is `sub_obj_set_frame_ptr
$80:9B98`, whose 3-byte operand is exactly `addr16 bank8` of a table. This is
what names `$89:9295`, `$92F3`, `$9351` and `$9365`, the operands of the four
object-type scripts at `$87:99FE`.

*obj2* -- `LDA #imm16 / STA $5E1C,Y`: 297 stores, 96 distinct values. 86 are
tables, 8 are frame lists for the custom draw routines.

*obj2x* -- `LDA $bb:aaaa,X / STA $5E1C,Y`: the long table is one level up, a
list of obj2 values. Every word of it is fed through the obj2 classifier.

*longidx* / *longabs* -- `LDA $bb:aaaa,X` (`$BF`) or `LDA $bb:aaaa` (`$AF`)
with `bb` in banks `$84`/`$89`, **followed by `STA $C0`**, the frame-list
word `sub_oam_enqueue` pushes. The un-indexed form reads entry 0 only, so it
names one word, not a table.

*longraw* -- the same loads with any other consumer. Inferred only, and held
to the structural filters. A load followed by `JSL $80:8696` is dropped
outright: that is a table of VRAM transfer blocks, not of frames, and 21 of
those used to be accepted here because their words happened to parse.

*dbr* -- plain `LDA $aaaa,X` (`$BD`) near a `JSL $80:8B02`, executed with
`DBR=$89`; the long scans cannot see these.

*struct* -- runs of words that all address well-formed frame lists. Finds
tables no code idiom reaches, at the cost of false positives.

What makes any of this reliable is the strict frame check. Byte 4 of a part
record uses bit 7 (last) and bit 0 (size) and nothing else -- every part of
every code-confirmed table is `$00 $01 $80 $81` -- so a list is accepted only
when all of its records look like that and it ends inside the data region.
The lenient check that preceded it accepted `FF FF FF FF FF` as a one-part
frame, which let velocity tables and the `$FF` padding in as "frames".

A table's extent ends at the first word that fails, at the lowest target (a
table cannot run into its own data), or where the next table starts.

Byte accounting then reports how much of the region the accepted tables and
lists explain, and is written to `build/sprites/accounting.txt`. Two frames
that overlap without sharing a record boundary mean one of them is bogus;
entries that point mid-list on a boundary are deliberate and are not counted.

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
# Banks the structural scan walks: the frame bank, and the code banks, which
# carry small frame-pointer tables inline (`$83:D227`, `$85:BCE8`, ...).
STRUCT_BANKS = (0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x89)
# LDA #imm16 followed by one of these stores the immediate as a frame LIST.
LIST_STORES = (
    (bytes((0x85, 0xC0)), "immc0"),                 # STA $C0 -> sub_oam_enqueue
    (bytes((0x99, 0x9C, 0x5D)), "imm5d9c"),         # STA $5D9C,Y, see $84:D27C
)
# Frame lists and their pointer tables fill bank $89 from $89:8000 to the
# start of the $FF padding; the end was established by scanning back for the
# last non-$FF byte.
DATA_LO = 0x048000
DATA_HI = 0x04F36D
# Part byte 4: bit 7 = last record, bit 0 = size. Nothing else is ever set.
PART_FLAG_SPARE = 0x7E
ENQUEUE = (0x80, 0x8B02)     # sub_oam_enqueue
MAX_PARTS = 64
BACKSCAN = 48                # how far back from a JSL to look for the load
NULL_ENTRIES = (0x0000, 0xFFFF)   # both appear as "no frame" holes

ANIM_SET_FRAME_PTR = 0x1C    # animation opcode -> sub_obj_set_frame_ptr $80:9B98
# STA $5E1C,Y / STA $5E1C,X -- the thread objects' frame table slot.
OBJ2_STORES = (bytes((0x99, 0x1C, 0x5E)), bytes((0x9D, 0x1C, 0x5E)))
# What consumes a long table load, by the bytes that follow it.
SINKS = (
    (bytes((0x85, 0xC0)), "frame"),                 # STA $C0
    (bytes((0x99, 0x1C, 0x5E)), "obj2"),            # STA $5E1C,Y
    (bytes((0x9D, 0x1C, 0x5E)), "obj2"),            # STA $5E1C,X
    (bytes((0xFA, 0x9D, 0x1C, 0x5E)), "obj2"),      # PLX / STA $5E1C,X
    (bytes((0x22, 0x96, 0x86, 0x80)), "vram"),      # JSL sub_vram_queue
)

# The confirming finders follow an addressing mode whose consumer is known.
# anim1c is not one of them on its own: `$1C` is also `TRB abs` in native
# code and an ordinary byte in data, so `1C lo hi 84` turns up by chance
# (`$84:AEB7` "names" a table at `$84:A969` that way). The four real script
# operands are all confirmed independently by obj2 stores.
SOURCE_CONFIDENCE = {
    "anim1c": "inferred",
    "obj2": "confirmed",
    "obj2x": "confirmed",
    "longidx": "confirmed",
    "longabs": "confirmed",
    "dbr": "confirmed",
    "longraw": "inferred",
    "struct": "inferred",
}
# Finders that only ever read entry 0, so they name a word and not a table.
SINGLE_ENTRY = ("longabs",)
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
    """Parse a frame list; return a dict if it is well formed, else None.

    Well formed means: terminates on a last-record flag, every record's flag
    byte uses only the size and last bits, and the whole list lies inside the
    data region. The last two are what keep `$FF` padding and tables of other
    things out -- five `$FF` bytes are otherwise a perfectly good one-part
    frame, and a lenient parse succeeds almost anywhere.

    `end` is the end of the list's **own** bytes. A list that hands over to
    another with a `$80` record stops there; the bytes it continues into
    belong to that other list and must not be counted twice.
    """
    if addr < 0x8000:
        return None
    try:
        off = snes_to_file(bank, addr)
    except AddressError:
        return None
    parts, far_end = sprites.parse_frame(data, off, max_parts=max_parts)
    real = [p for p in parts if "control" not in p]
    if not real or not real[-1]["last"]:
        return None                      # ran to the cap without terminating
    if any(p["raw"][4] & PART_FLAG_SPARE for p in real):
        return None
    if any(p.get("error") for p in parts if "control" in p):
        return None
    end = own_end(data, off, max_parts)
    if bank == FRAME_BANK and not (DATA_LO <= off and end <= DATA_HI + 1
                                   and far_end <= DATA_HI + 1):
        return None
    return {"parts": len(real), "start": off, "end": end}


def own_end(data, off, max_parts=MAX_PARTS):
    """File offset just past a list's own records (see `frame_ok`)."""
    p = off
    for _ in range(max_parts):
        b = data[p]
        if b == 0x7E:
            p += 3
        elif b == 0x80:
            return p + 3
        elif data[p + 4] & 0x80:
            return p + sprites.RECORD
        else:
            p += sprites.RECORD
    return p


def record_starts(data, off, max_parts=MAX_PARTS):
    """File offsets at which a record of the list at `off` begins.

    Stops at a `$80` continuation: what follows it belongs to another list.
    """
    out = set()
    p = off
    for _ in range(max_parts):
        out.add(p)
        b = data[p]
        if b == 0x7E:
            p += 3
            continue
        if b == 0x80:
            break
        if data[p + 4] & 0x80:
            break
        p += sprites.RECORD
    return out


def classify_obj2(data, addr):
    """What a word stored to `$5E1C` names: ("table", t), ("list", info) or None.

    A real table read as a part list needs its third word's low byte to be a
    valid flag byte and the walk to terminate cleanly, which almost never
    happens; a real list read as a table passes about one time in five,
    whenever its first two bytes happen to address a record boundary. So a
    list wins unless the table reading has at least two live entries.
    """
    info = frame_ok(data, FRAME_BANK, addr)
    t = table_at(data, FRAME_BANK, addr, min_live=1, strict=True)
    if info and (not t or t["live"] < 2):
        return "list", info
    if t:
        return "table", t
    return None


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


MAX_SPECULATIVE_HOLES = 2    # consecutive null entries a guessed table may hold


def table_at(data, bank, addr, min_live=4, max_entries=256, strict=False):
    """Validate a frame-pointer table at (bank, addr). Returns a dict or None.

    `strict` is for candidates nothing in the code vouches for: their frames
    must not overlap each other, they must name at least two different
    frames (`89 89 89 89` is otherwise a table of `$89:8989`), and a long run
    of nulls ends them rather than bridging to whatever follows.
    """
    entries, live, targets = 0, 0, []
    # "A table precedes its data" only constrains a table that lives in the
    # frame bank itself; $84:92C5 points backwards into bank $89 and is real.
    same_bank = bank == FRAME_BANK
    lowest = 0x10000
    holes = 0
    for i in range(max_entries):
        a = addr + 2 * i
        if a + 2 > 0x10000 or (same_bank and a >= lowest):
            break                        # a table cannot run into its own data
        w = int.from_bytes(data[snes_to_file(bank, a):snes_to_file(bank, a) + 2],
                           "little")
        if w in NULL_ENTRIES:
            holes += 1
            if strict and holes > MAX_SPECULATIVE_HOLES:
                break
            entries += 1
            continue
        if (same_bank and w <= addr) or frame_ok(data, FRAME_BANK, w) is None:
            break
        holes = 0
        entries += 1
        live += 1
        targets.append(w)
        lowest = min(lowest, w)
    if live < min_live:
        return None
    if strict and (len(set(targets)) < 2 or not frames_consistent(data, targets)):
        return None
    entries = trim_nulls(data, bank, addr, entries)
    return {"bank": bank, "addr": addr, "entries": entries, "live": live,
            "targets": targets}


def sink_of(data, off):
    """Name the consumer of a value loaded just before file offset `off`."""
    for pattern, name in SINKS:
        if data[off:off + len(pattern)] == pattern:
            return name
    return None


def scan_code(data):
    """Addresses named by the code idioms.

    Returns `(tables, lists, dropped)`. `tables` and `lists` are
    {(bank, addr): {"refs": {finder: {file offset}}}} over the **whole** ROM;
    a reference can live in any code bank (`$89:CCDB` is named from
    `$84:E241` *and* `$86:8476`, and the `$1C` script operands are in bank
    `$87`). `dropped` counts the long loads that feed `sub_vram_queue`.
    """
    tables, lists = {}, {}
    dropped = 0
    end = len(data)

    def note(store, bank, addr, how, site):
        # Keep the sites per finder: "reached from code" has to be asked of
        # the finder that claims to confirm, not of the union. $89:9411 is
        # named by an obj2 store in bank $85 and by a `1C` byte pattern in the
        # course data at $9A:EBF7, and only the second one is an anim1c claim.
        rec = store.setdefault((bank, addr), {"refs": {}})
        rec["refs"].setdefault(how, set()).add(site)

    def note_obj2(addr, how, site):
        """File an obj2 value under tables or lists; False if it is neither."""
        found = classify_obj2(data, addr)
        if not found:
            return False
        note(tables if found[0] == "table" else lists, FRAME_BANK, addr, how, site)
        return True

    table_banks_lo = set(b & 0x7F for b in TABLE_BANKS)

    # Animation opcode $1C: the operand is addr16+bank8 of a table.
    for i in range(end - 4):
        if data[i] != ANIM_SET_FRAME_PTR:
            continue
        addr = int.from_bytes(data[i + 1:i + 3], "little")
        bank = data[i + 3]
        if (bank & 0x7F) in table_banks_lo and addr >= 0x8000:
            note(tables, 0x80 | (bank & 0x7F), addr, "anim1c", i)

    # LDA #imm16 / STA $5E1C,Y -- a thread object's table, or its list.
    for i in range(3, end - 3):
        if data[i:i + 3] not in OBJ2_STORES or data[i - 3] != 0xA9:
            continue
        addr = int.from_bytes(data[i - 2:i], "little")
        if addr >= 0x8000:
            note_obj2(addr, "obj2", i - 3)

    # LDA #imm16 / STA $C0 and friends: the immediate is a frame list.
    for i in range(end - 6):
        if data[i] != 0xA9 or i >= CODE_END:
            continue
        addr = int.from_bytes(data[i + 1:i + 3], "little")
        if addr < 0x8000:
            continue
        for pattern, how in LIST_STORES:
            if data[i + 3:i + 3 + len(pattern)] == pattern and \
                    frame_ok(data, FRAME_BANK, addr):
                note(lists, FRAME_BANK, addr, how, i)

    # LDA long,X / LDA long -- the table's bank is in the instruction, and
    # the instruction after it says what the words are.
    for i in range(end - 8):
        if data[i] not in (0xBF, 0xAF):
            continue
        addr = int.from_bytes(data[i + 1:i + 3], "little")
        bank = data[i + 3]
        if (bank & 0x7F) not in table_banks_lo or addr < 0x8000:
            continue
        bank = 0x80 | (bank & 0x7F)
        sink = sink_of(data, i + 4)
        if sink == "vram":
            dropped += 1
            continue
        if sink == "obj2":
            # One level up: a list of values for $5E1C. Walk it until a word
            # stops classifying; nulls are holes, not the end.
            base = snes_to_file(bank, addr)
            for n in range(64 if data[i] == 0xBF else 1):
                w = int.from_bytes(data[base + 2 * n:base + 2 * n + 2], "little")
                if w in NULL_ENTRIES:
                    continue
                if w < 0x8000 or not note_obj2(w, "obj2x", i):
                    break
            continue
        if sink == "frame":
            how = "longidx" if data[i] == 0xBF else "longabs"
        else:
            how = "longraw"
        note(tables, bank, addr, how, i)

    # LDA abs,X feeding sub_oam_enqueue, executed with DBR=$89.
    tail = bytes([0x22, ENQUEUE[1] & 0xFF, ENQUEUE[1] >> 8, ENQUEUE[0]])
    for i in range(end - 4):
        if data[i:i + 4] != tail:
            continue
        for j in range(max(0, i - BACKSCAN), i):
            if data[j] == 0xBD:
                addr = int.from_bytes(data[j + 1:j + 3], "little")
                if addr >= 0x8000:
                    note(tables, FRAME_BANK, addr, "dbr", j)
    return tables, lists, dropped


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


def scan_struct(data, starts, banks=STRUCT_BANKS, min_live=3):
    """Table addresses that look like tables purely by structure.

    `starts` is the set of file offsets where a frame is already known to
    begin. A random word names one about one time in a hundred, so three in a
    row at any byte offset is a table and two is not evidence.
    """
    names = set(file_to_snes(o)[1] for o in starts)
    out = {}
    for bank in banks:
        base = snes_to_file(bank, 0x8000)
        run = {}                         # parity -> (first addr, live count)
        for a in range(0x8000, 0xFFFF):
            w = int.from_bytes(data[base + a - 0x8000:base + a - 0x7FFE], "little")
            first, live = run.get(a & 1, (None, 0))
            if w in names:
                run[a & 1] = (a if first is None else first, live + 1)
                run[("holes", a & 1)] = 0
                continue
            holes = run.get(("holes", a & 1), 0)
            if first is not None and w in NULL_ENTRIES and \
                    holes < MAX_SPECULATIVE_HOLES:
                run[("holes", a & 1)] = holes + 1
                continue                 # a hole inside a table
            if live >= min_live:
                out[(bank, first)] = {"refs": {"struct": set()}}
            run[a & 1] = (None, 0)
            run[("holes", a & 1)] = 0
    return out


def tile_runs(data, runs):
    """Frames that tile the unclaimed runs exactly, as [(addr, info)].

    The region is frames and tables packed back to back, so a run nothing
    claimed that parses as a chain of well-formed frames **is** frames: lists
    reached by an idiom no finder knows, or left unused. Walk each run until
    a parse fails; what is left stays unclaimed.
    """
    out = []
    for lo, hi in runs:
        p = lo
        while p < hi:
            addr = file_to_snes(p)[1]
            info = frame_ok(data, FRAME_BANK, addr)
            if not info or info["end"] > hi:
                break
            out.append((addr, info))
            p = info["end"]
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


def accounting(data, tables, lists=()):
    """Coverage of the region, and misaligned overlaps.

    Several tables pointing at the *same* frame is normal, and so is an entry
    that points part-way into another frame on a record boundary to draw a
    subset of its parts. The defect signal is two frames that overlap
    **without** sharing a boundary: one of them is being read at the wrong
    alignment and whatever named it is bogus.
    """
    extents = {}
    for t in tables:
        for w in set(t["targets"]):
            info = frame_ok(data, FRAME_BANK, w)
            if info:
                extents[info["start"]] = max(extents.get(info["start"], 0),
                                             info["end"])
    for item in lists:
        info = frame_ok(data, FRAME_BANK, item["addr"])
        if info:
            extents[info["start"]] = max(extents.get(info["start"], 0),
                                         info["end"])
    size = DATA_HI - DATA_LO + 1
    claim = bytearray(size)              # 0 free, 1 frame, 2 table
    owner = {}
    misaligned = set()
    for start, end in sorted(extents.items()):
        for o in range(max(start, DATA_LO), min(end, DATA_HI + 1)):
            i = o - DATA_LO
            if claim[i] and owner.get(i) != start:
                first = owner[i]
                if start not in record_starts(data, first):
                    misaligned.add(start)
                    misaligned.add(first)
            claim[i] = 1
            owner.setdefault(i, start)
    table_bytes = 0
    for t in tables:
        if t["bank"] != FRAME_BANK:
            continue
        base = snes_to_file(t["bank"], t["addr"])
        for o in range(base, base + 2 * t["entries"]):
            if DATA_LO <= o <= DATA_HI and not claim[o - DATA_LO]:
                claim[o - DATA_LO] = 2
                table_bytes += 1
    frame_bytes = sum(1 for c in claim if c == 1)
    unclaimed, run = [], None
    for i, c in enumerate(claim):
        if not c and run is None:
            run = i
        elif c and run is not None:
            unclaimed.append((run + DATA_LO, i + DATA_LO))
            run = None
    if run is not None:
        unclaimed.append((run + DATA_LO, len(claim) + DATA_LO))
    return {"frames": len(extents), "frame_bytes": frame_bytes,
            "table_bytes": table_bytes, "misaligned": sorted(misaligned),
            "unclaimed": unclaimed}


def build_tables(data, sources, min_live):
    """Validate candidates into (confirmed, speculative) table dicts."""
    tables, speculative = [], []
    for (bank, addr), rec in sorted(sources.items()):
        conf = confidence_of(rec["refs"])
        inferred = conf == "inferred"
        single = all(h in SINGLE_ENTRY for h in rec["refs"])
        t = table_at(data, bank, addr, min_live if inferred else 1,
                     max_entries=1 if single else 256, strict=inferred)
        if not t:
            continue
        t["source"] = ";".join(sorted(rec["refs"]))
        t["confidence"] = conf
        t["refs"] = dict(rec["refs"])
        t["single"] = single
        (speculative if inferred else tables).append(t)
    return tables, speculative


def covered(t, others):
    """True when table `t` starts inside another table's extent."""
    return any(p is not t and p["bank"] == t["bank"] and
               p["addr"] <= t["addr"] < p["addr"] + 2 * p["entries"]
               for p in others)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/sprites")
    ap.add_argument("--only-code", action="store_true", help="skip the structural scan")
    ap.add_argument("--min-live", type=int, default=3,
                    help="live entries a speculative table needs (default 3)")
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
        t = table_at(data, bank, addr, 1)
        info = frame_ok(data, bank, addr) if bank == FRAME_BANK else None
        if info:
            print("{}: parses as a frame LIST, {} parts".format(
                fmt_snes(bank, addr), info["parts"]))
        if not t:
            print("{}: not a valid frame-pointer table".format(args.check))
            return 0 if info else 1
        print("{}: {} entries, {} live -- the validator's untruncated reach, "
              "before neighbouring tables cap it".format(
                  fmt_snes(bank, addr), t["entries"], t["live"]))
        for i, w in enumerate(t["targets"][:40]):
            info = frame_ok(data, FRAME_BANK, w)
            print("  {:3d}: {}  {} parts".format(i, fmt_snes(FRAME_BANK, w),
                                                 info["parts"]))
        return 0

    sources, list_sources, dropped = scan_code(data)
    print("code scan: {} table candidates, {} frame lists, {} loads of VRAM "
          "block tables ignored".format(len(sources), len(list_sources), dropped))
    tables, speculative = build_tables(data, sources, args.min_live)
    # A word read once with `LDA long` is an alias into a table when some
    # table already covers it; only a standalone one is worth a row.
    whole = [t for t in tables if not t["single"]]
    singles = [t for t in tables if t["single"] and not covered(t, whole)]
    tables = dedupe(truncate_at_neighbours(data, whole + singles, 1))
    report_sources(tables, "code-confirmed")

    lists = []
    for (bank, addr), rec in sorted(list_sources.items()):
        info = frame_ok(data, bank, addr)
        lists.append({"bank": bank, "addr": addr, "parts": info["parts"],
                      "source": ";".join(sorted(rec["refs"])),
                      "refs": dict(rec["refs"])})

    # Whatever the confirmed tables and lists leave unclaimed, and that tiles
    # into well-formed frames, is frame data too.
    acc = accounting(data, tables, lists)
    known = set(snes_to_file(i["bank"], i["addr"]) for i in lists)
    for addr, info in tile_runs(data, acc["unclaimed"]):
        if info["start"] in known:
            continue
        lists.append({"bank": FRAME_BANK, "addr": addr, "parts": info["parts"],
                      "source": "tile", "refs": {}})
    lists.sort(key=lambda i: i["addr"])

    # Speculative tables: words that all name a frame start already known.
    # They regroup frames rather than add any, and they must still not cut
    # across a confirmed table.
    extra = []
    if not args.only_code:
        starts = set(confirmed_extents(data, tables))
        starts.update(snes_to_file(i["bank"], i["addr"]) for i in lists)
        for t in speculative + struct_candidates(data, starts, args.min_live):
            if covered(t, tables + extra):
                continue
            if any(snes_to_file(FRAME_BANK, w) not in starts for w in t["targets"]):
                continue
            extra.append(t)
    print("speculative: {} further tables pass".format(len(extra)))
    tables = dedupe(truncate_at_neighbours(data, tables + extra, 1))
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

    lpath = os.path.join(args.out, "lists.tsv")
    with open(lpath, "w") as f:
        f.write("list_addr\tlist_file\tparts\tsource\trefs\n")
        for item in lists:
            f.write("\t".join([
                fmt_snes(item["bank"], item["addr"]),
                fmt_file(snes_to_file(item["bank"], item["addr"])),
                str(item["parts"]), item["source"],
                fmt_refs(item["refs"])]) + "\n")
    print("wrote {} ({} frame lists no table names, {} of them found only "
          "by tiling)".format(lpath, len(lists),
                              sum(1 for i in lists if i["source"] == "tile")))

    report = accounting_report(data, tables, lists)
    apath = os.path.join(args.out, "accounting.txt")
    with open(apath, "w") as f:
        f.write(report + "\n")
    print(report)
    print("wrote {}".format(apath))
    return 0


def struct_candidates(data, starts, min_live):
    """Structural candidates, as table dicts ready for the speculative pass."""
    out = []
    found = scan_struct(data, starts, min_live=min_live)
    for (bank, addr), rec in sorted(found.items()):
        t = table_at(data, bank, addr, min_live, strict=True)
        if not t:
            continue
        t["source"] = "struct"
        t["confidence"] = "inferred"
        t["refs"] = {}
        t["single"] = False
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


def accounting_report(data, tables, lists=()):
    """The byte-accounting block, as text, so it can be printed and stored."""
    acc = accounting(data, tables, lists)
    total = DATA_HI - DATA_LO + 1
    used = acc["frame_bytes"] + acc["table_bytes"]
    lines = ["byte accounting over {}..{} ({} bytes):".format(
        fmt_file(DATA_LO), fmt_file(DATA_HI), total)]
    lines.append("  {} tables, {} of them confirmed; {} table-less lists".format(
        len(tables), sum(1 for t in tables if t["confidence"] == "confirmed"),
        len(lists)))
    lines.append("  {} distinct frames cover {} bytes ({:.1f}%)".format(
        acc["frames"], acc["frame_bytes"], 100.0 * acc["frame_bytes"] / total))
    lines.append("  pointer tables cover {} bytes ({:.1f}%)".format(
        acc["table_bytes"], 100.0 * acc["table_bytes"] / total))
    lines.append("  misaligned overlaps: {}".format(len(acc["misaligned"]) or "none"))
    for start in acc["misaligned"][:8]:
        lines.append("    frame at {}".format(fmt_file(start)))
    lines.append("  unclaimed {} bytes ({:.1f}%) in {} runs".format(
        total - used, 100.0 * (total - used) / total, len(acc["unclaimed"])))
    for lo, hi in sorted(acc["unclaimed"], key=lambda r: r[1] - r[0],
                         reverse=True)[:16]:
        lines.append("    {}..{}  {} bytes".format(
            fmt_file(lo), fmt_file(hi - 1), hi - lo))
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
