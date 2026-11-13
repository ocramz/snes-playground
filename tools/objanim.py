#!/usr/bin/env python3
"""Trace the thread objects: what each object type draws, uploads and waits for.

Most of what moves on screen is a *thread object*: a slot in the arrays at
`$7E:4E1C`-`$7E:629C` (64 slots, two bytes each, slot index in `$D2`) running
native 65816 code as a coroutine. This is the "second object system" that
docs/animation.md could not resolve; the pieces are:

    $80:DFBA  spawn.  A = object type. Reads `tbl_thread_types $80:ED3A`,
              four bytes per type: entry addr16, entry bank8, list8. The
              entry goes to `$4F9C,Y` / `$501C,Y`, the list to `$4E9C,Y`.
              234 types; the highest id any caller passes is 233.
    $80:E4B6, $80:E4F2, $80:E526
              spawn wrappers that also set position and install the default
              draw routine in `$519C,Y` (`$80:E55A` world, `$80:E5A2` screen).
    $80:E445  yield.  A = frames to wait. Pops its own return address into
              `$4F9C,X` / `$501C,X`, so the thread resumes after the `JSL`.
    $80:E060  exit (reached by `JML`).

Twelve small helpers are copied into WRAM at boot (`$80:E67F`, sources
`$80:E732`-`$80:E96B`) so that code in any bank can reach them with a near
`JSR`. They take their operands **inline**, after the call, and fix up their
own return address -- so a disassembler that does not know them runs straight
into the operand bytes and desyncs. The one that matters most:

    JSR $1030 / idx8 / frames8
              set the frame index (`$FF` = hide) and yield for `frames`.
              924 call sites; this is the animation primitive.
    JSR $1018 / variant8
              spawn another object of the caller's own type, with `variant`
              in `$589C` and the caller's position.
    JSR $105E / x16 / y16     set position
    JSR $1084, $10A3, $10C2, $10E7, $1104, $1151, $116A, $119D, $11D6
              motion parameters; 3, 3, 3, 4, 9, 0, 6, 6 and 6 inline bytes.

The fields a thread writes to be drawn:

    $5E1C,Y   frame pointer **table** (a word address in bank `$89`)
    $5D9C,Y   frame **index**; negative means "do not draw"
    $5E9C,Y   OAM priority queue
    $5F1C,Y   X        $5F9C,Y   Y

The default draw routines do `LDA $5D9C,X / ASL / CLC / ADC $5E1C,X /
STA $DE / LDA $9E / STA $E0 / LDA [$DE] / STA $C0` and enqueue `$C0` -- table
plus index. A few objects install their own (`$87:8C93`: `LDA $5E1C,Y /
STA $C0`) and keep a frame *list* in the slot instead.

A thread animates in two ways at once, and usually both: it changes the
index, and it re-uploads the tiles the frame points at. Bank `$86` is almost
nothing but

    LDA #idx  / STA $5D9C,Y        ; which layout
    LDA #blk  / JSL $80:8696       ; which tiles, see tools/vram.py
    LDA #n    / JSL $80:E445       ; for how long

so a frame's picture is (layout, VRAM contents), and the VRAM contents are
only knowable by following the code. That is what this tool does: recursive
descent from each type's entry point -- both arms of every branch, into
subroutines in the object banks `$83`-`$87`, through `JMP (abs,X)` tables --
and then a peephole over the reached instructions for the idioms above.

Events are reported in **address order**, which is the order the routine was
written in, not a simulated execution: branches are not evaluated. It is the
right order for the straight-line scripts that make up most objects and an
approximation for the rest.

    python3 tools/objanim.py                  # -> build/sprites/objects.tsv + objects/
    python3 tools/objanim.py --type 37        # print one object's events
    python3 tools/objanim.py --types          # dump tbl_thread_types
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import dis65816 as dis  # noqa: E402
from lorom import AddressError, file_to_snes, fmt_file, fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

TYPE_TABLE = (0x80, 0xED3A)
OBJECT_BANKS = (0x83, 0x84, 0x85, 0x86, 0x87)   # where thread code is followed
CODE_BANKS = range(0x80, 0x88)

SPAWN = {(0x80, 0xDFBA): "bare", (0x80, 0xE4B6): "world_below",
         (0x80, 0xE4F2): "world", (0x80, 0xE526): "screen"}
WAIT = (0x80, 0xE445)
EXIT = (0x80, 0xE060)
QUEUE = (0x80, 0x8696)
CGRAM_PARTIAL = (0x80, 0x90C8)
LOAD_TILESET = (0x80, 0xCE45)   # A = entry of the 28-way tileset jump table
ENQUEUE = {(0x80, 0x8B02), (0x80, 0x8B09), (0x80, 0xE60B), (0x80, 0xE635)}

# Helpers copied to WRAM by $80:E67F: address -> (inline operand bytes, name).
# The byte counts are `ADC #k` + 1 in each helper's return-address fix-up;
# $1030 yields instead and resumes two bytes on.
RAM_HELPERS = {
    0x1018: (1, "clone"), 0x1030: (2, "frame"), 0x105E: (4, "pos"),
    0x1084: (3, "motion"), 0x10A3: (3, "motion"), 0x10C2: (3, "motion"),
    0x10E7: (4, "motion"), 0x1104: (9, "motion"), 0x1151: (0, "motion"),
    0x116A: (6, "motion"), 0x119D: (6, "motion"), 0x11D6: (6, "motion"),
}

# Slot fields, by absolute address (indexed ,X or ,Y).
F_TABLE, F_INDEX, F_QUEUE, F_DRAW = 0x5E1C, 0x5D9C, 0x5E9C, 0x519C
# Code pointers a thread plants in a slot: (address field, bank field).
# Resume PC, per-frame handler, draw routine, and the continuation a shared
# script segment returns through (`LDA $641C,Y / STA $DE / LDA $649C,Y /
# STA $E0 / JML [$1EDE]`; the direct page is `$1E00` in thread context).
# Whatever they name is code that belongs to the object, so it is followed
# like a branch.
CODE_FIELDS = {0x4F9C: 0x501C, 0x509C: 0x511C, 0x519C: 0x521C, 0x641C: 0x649C}
LIST_WORD = 0xC0              # dp: the frame list sub_oam_enqueue pushes
SLOT = 0xD2                   # dp: the running object's slot index

RETURN_VIA_SLOT = bytes((0xDC, 0xDE, 0x1E))   # JML [$1EDE], see CODE_FIELDS

MAX_INSNS = 6000              # per object; the largest real one is far below
MAX_JUMP_TABLE = 64


def thread_types(data):
    """[(type, bank, addr, list)] from `tbl_thread_types $80:ED3A`.

    The table has no terminator; it ends where an entry stops being a code
    pointer. That yields 234 entries, and 233 is also the largest immediate
    any spawn call site loads, which is the independent check.
    """
    base = snes_to_file(*TYPE_TABLE)
    out = []
    while True:
        e = data[base + 4 * len(out):base + 4 * len(out) + 4]
        addr, bank, lst = e[0] | e[1] << 8, e[2], e[3]
        if addr < 0x8000 or bank not in CODE_BANKS or lst > 0x10:
            return out
        out.append((len(out), bank, addr, lst))


def reach(data, bank, addr, max_insns=MAX_INSNS):
    """Everything reachable from one entry point.

    Returns `(insns, size, unresolved)`: {file offset: Insn}, {file offset:
    bytes the instruction occupies **including inline operands**}, and the
    offsets of jumps that could not be followed. Entry width is 16-bit A and
    X/Y: the scheduler resumes threads that way and every type's first
    instructions load 16-bit immediates.
    """
    seen, size = {}, {}
    unresolved = []
    work = [(snes_to_file(bank, addr), False, False)]

    def push(target, m8, x8):
        tb, ta = target
        if ta < 0x8000 or tb not in CODE_BANKS:
            return
        work.append((snes_to_file(tb, ta), m8, x8))

    while work and len(seen) < max_insns:
        off, m8, x8 = work.pop()
        prev = None
        while off not in seen and len(seen) < max_insns:
            if off >= 0x40000:
                break
            ins, m8n, x8n = dis.decode(data, off, m8, x8)
            mn = ins.mnemonic
            if mn in ("BRK", "COP", "STP", "WDM"):
                break                     # walked into data
            seen[off] = ins
            size[off] = len(ins.raw)
            if mn in ("RTS", "RTL", "RTI"):
                break
            if mn in ("JMP", "JML"):
                if ins.mode in (dis.ABS, dis.LONG):
                    tb, ta = ins.target
                    tb |= 0x80
                    if (tb, ta) != EXIT and tb in OBJECT_BANKS:
                        push((tb, ta), m8n, x8n)
                elif ins.mode == dis.ABSIX:
                    for t in jump_table(data, ins.bank, ins.operand):
                        push((ins.bank, t), m8n, x8n)
                elif data[off:off + 3] != RETURN_VIA_SLOT:
                    unresolved.append(ins.offset)
                break
            if mn in ("BRA", "BRL"):
                push(ins.target, m8n, x8n)
                break
            if ins.mode in (dis.REL8, dis.REL16):
                push(ins.target, m8n, x8n)
            elif mn == "JSR" and ins.mode == dis.ABS and ins.operand < 0x8000:
                helper = RAM_HELPERS.get(ins.operand)
                if helper is None:
                    unresolved.append(ins.offset)
                    break                 # unknown RAM code: operands unknown
                size[off] += helper[0]
            elif mn in ("JSR", "JSL"):
                if ins.mode == dis.ABSIX:
                    for t in jump_table(data, ins.bank, ins.operand):
                        push((ins.bank, t), m8n, x8n)
                elif ins.target:
                    tb, ta = ins.target
                    tb |= 0x80
                    if tb in OBJECT_BANKS:
                        push((tb, ta), m8n, x8n)
            elif mn == "STA" and ins.mode in (dis.ABSX, dis.ABSY) and \
                    ins.operand in CODE_FIELDS and prev is not None and \
                    prev.mnemonic == "LDA" and prev.mode == dis.IMM_M and \
                    prev.operand >= 0x8000:
                tb = planted_bank(data, off, CODE_FIELDS[ins.operand], ins.bank)
                if tb in OBJECT_BANKS:
                    push((tb, prev.operand), False, False)
            prev = ins
            off, m8, x8 = off + size[off], m8n, x8n
    return seen, size, unresolved


def planted_bank(data, off, bank_field, default):
    """The bank stored next to a planted code address.

    The pair is written back to back, `LDA #addr / STA f,Y / LDA #bank /
    STA g,Y`, in either order; look a few bytes each way for the bank half
    and fall back to the bank the code is in.
    """
    lo, hi = bank_field & 0xFF, bank_field >> 8
    for j in range(off - 9, off + 9):
        if data[j] == 0xA9 and data[j + 2] == 0x00 and \
                data[j + 3] in (0x99, 0x9D) and data[j + 4] == lo and \
                data[j + 5] == hi:
            return data[j + 1] | 0x80
    return default


def jump_table(data, bank, addr):
    """Targets of a `JMP (abs,X)` table: words until one is not a code address.

    A table sits ahead of the routines it names, so it also ends where it
    would run into the lowest of them.
    """
    out = []
    lowest = 0x10000
    for i in range(MAX_JUMP_TABLE):
        a = addr + 2 * i
        if a < 0x8000 or a + 2 > 0x10000 or a >= lowest:
            break
        off = snes_to_file(bank, a)
        w = int.from_bytes(data[off:off + 2], "little")
        if w < 0x8000:
            break
        out.append(w)
        if w > addr:
            lowest = min(lowest, w)
    return out


def events(data, insns, size):
    """The draw/upload/wait idioms among reached instructions, address order."""
    order = sorted(insns)
    out = []
    by_end = {}
    for off in order:
        by_end[off + size[off]] = insns[off]

    def before(ins, n=1):
        """The n-th instruction that ends where the previous one starts."""
        cur = ins
        for _ in range(n):
            cur = by_end.get(cur.offset)
            if cur is None:
                return None
        return cur

    def imm(ins, mnem="LDA"):
        if ins is not None and ins.mnemonic == mnem and \
                ins.mode in (dis.IMM_M, dis.IMM_X):
            return ins.operand
        return None

    def value(ins):
        """What A holds at `ins`: ("imm", v), ("table", bank, addr) or None."""
        p = before(ins)
        if p is None:
            return None
        v = imm(p)
        if v is not None:
            return ("imm", v)
        if p.mnemonic == "LDA" and p.mode == dis.LONGX:
            return ("table", 0x80 | (p.operand >> 16) & 0x7F, p.operand & 0xFFFF)
        if p.mnemonic == "LDA" and p.mode == dis.LONG:
            return ("word", 0x80 | (p.operand >> 16) & 0x7F, p.operand & 0xFFFF)
        return None

    for off in order:
        ins = insns[off]
        mn, mode, op = ins.mnemonic, ins.mode, ins.operand
        ev = None
        if mode in (dis.ABSX, dis.ABSY) and op in (F_TABLE, F_INDEX, F_QUEUE, F_DRAW):
            field = {F_TABLE: "table", F_INDEX: "index", F_QUEUE: "queue",
                     F_DRAW: "draw"}[op]
            if mn == "STA":
                ev = {"kind": field, "value": value(ins)}
            elif mn == "STZ":
                ev = {"kind": field, "value": ("imm", 0)}
            elif mn in ("INC", "DEC") and field == "index":
                ev = {"kind": "index_step", "value": 1 if mn == "INC" else -1}
        elif mn == "STA" and mode == dis.DP and op == LIST_WORD:
            ev = {"kind": "list", "value": value(ins)}
        elif mn == "LDY" and mode == dis.DP and op == SLOT:
            # Y is the object's own slot again; until now it may have been a
            # freshly spawned child's, see tools/objsheets.py child_tables.
            ev = {"kind": "self", "value": None}
        elif mn == "JSR" and mode == dis.ABS and op in RAM_HELPERS:
            n, name = RAM_HELPERS[op]
            arg = data[off + 3:off + 3 + n]
            if name == "frame":
                # idx8, frames8: the index (or hide) and how long it shows.
                ev = {"kind": "frame", "value": ("imm", arg[0]), "wait": arg[1]}
            elif name == "clone":
                ev = {"kind": "clone", "value": ("imm", arg[0])}
            elif name == "pos":
                ev = {"kind": "pos", "value": (
                    int.from_bytes(arg[0:2], "little"),
                    int.from_bytes(arg[2:4], "little"))}
        elif mn in ("JSL", "JML") and ins.target:
            target = (ins.target[0] | 0x80, ins.target[1])
            if target == QUEUE:
                ev = {"kind": "upload", "value": value(ins)}
            elif target == WAIT:
                ev = {"kind": "wait", "value": value(ins)}
            elif target == EXIT:
                ev = {"kind": "exit", "value": None}
            elif target in SPAWN:
                ev = {"kind": "spawn", "value": value(ins), "how": SPAWN[target]}
            elif target == LOAD_TILESET:
                ev = {"kind": "tileset", "value": value(ins)}
            elif target == CGRAM_PARTIAL:
                # LDA #count / LDX #src / LDY #cgram_byte / JSL
                y, x, a = before(ins, 1), before(ins, 2), before(ins, 3)
                ev = {"kind": "palette",
                      "value": (imm(a), imm(x, "LDX"), imm(y, "LDY"))}
        if ev:
            ev["bank"], ev["addr"] = ins.bank, ins.addr
            out.append(ev)
    return out


def fmt_value(v):
    if v is None:
        return "?"
    if v[0] == "imm":
        return "#${:04X}".format(v[1])
    return "{}:{}".format(v[0], fmt_snes(v[1], v[2]))


def fmt_event(ev):
    v = ev["value"]
    if ev["kind"] == "index_step":
        text = "{:+d}".format(v)
    elif ev["kind"] == "palette":
        text = "count={} src={} cgram={}".format(
            *("?" if x is None else "${:04X}".format(x) for x in v))
    elif ev["kind"] in ("exit", "self"):
        text = ""
    elif ev["kind"] == "pos":
        text = "x=${:04X} y=${:04X}".format(*v)
    elif ev["kind"] == "frame":
        text = "{} for {} frames".format(
            "hide" if v[1] == 0xFF else "index {}".format(v[1]), ev["wait"])
    else:
        text = fmt_value(v)
    if ev["kind"] == "spawn":
        text += " ({})".format(ev["how"])
    return "{}  {:<10} {}".format(fmt_snes(ev["bank"], ev["addr"]), ev["kind"], text)


def trace(data, types=None):
    """[{type, bank, addr, list, insns, bytes, events, unresolved}]"""
    out = []
    for tid, bank, addr, lst in thread_types(data):
        if types is not None and tid not in types:
            continue
        insns, size, unresolved = reach(data, bank, addr)
        out.append({"type": tid, "bank": bank, "addr": addr, "list": lst,
                    "insns": len(insns), "bytes": sum(size.values()),
                    "events": events(data, insns, size),
                    "unresolved": unresolved,
                    "span": spans(size)})
    return out


def spans(size):
    """Contiguous [start, end) file ranges an object's code occupies."""
    out = []
    for off in sorted(size):
        if out and out[-1][1] == off:
            out[-1][1] = off + size[off]
        else:
            out.append([off, off + size[off]])
    return out


def summary_row(obj):
    evs = obj["events"]

    def imms(kind):
        return sorted(set(e["value"][1] for e in evs if e["kind"] == kind and
                          e["value"] and e["value"][0] == "imm"))

    def count(kind):
        return sum(1 for e in evs if e["kind"] == kind)

    return [obj["type"], fmt_snes(obj["bank"], obj["addr"]),
            fmt_file(snes_to_file(obj["bank"], obj["addr"])), obj["list"],
            obj["insns"], obj["bytes"],
            ",".join("${:04X}".format(v) for v in imms("table")) or "-",
            count("index") + count("index_step") + count("frame"),
            count("upload"), count("wait") + count("frame"),
            count("list"), count("palette"),
            ",".join(str(v) for v in imms("spawn")) or "-",
            len(obj["unresolved"])]


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/sprites")
    ap.add_argument("--type", type=lambda s: int(s, 0), action="append",
                    help="print this object type's events (repeatable)")
    ap.add_argument("--types", action="store_true", help="dump tbl_thread_types")
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    try:
        if args.types:
            for tid, bank, addr, lst in thread_types(data):
                print("{:3d}  {}  {}  list {}".format(
                    tid, fmt_snes(bank, addr),
                    fmt_file(snes_to_file(bank, addr)), lst))
            return 0

        if args.type:
            for obj in trace(data, set(args.type)):
                print("type {} at {}: {} instructions, {} bytes reached, "
                      "{} unresolved jumps".format(
                          obj["type"], fmt_snes(obj["bank"], obj["addr"]),
                          obj["insns"], obj["bytes"], len(obj["unresolved"])))
                for ev in obj["events"]:
                    print("  " + fmt_event(ev))
            return 0

        objs = trace(data)
    except AddressError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    outdir = os.path.join(args.out, "objects")
    if not os.path.isdir(outdir):
        os.makedirs(outdir)
    for obj in objs:
        with open(os.path.join(outdir, "{:03d}.json".format(obj["type"])), "w") as f:
            json.dump({"type": obj["type"],
                       "entry": fmt_snes(obj["bank"], obj["addr"]),
                       "list": obj["list"], "insns": obj["insns"],
                       "bytes": obj["bytes"],
                       "unresolved": [fmt_snes(*file_to_snes(o))
                                      for o in obj["unresolved"]],
                       "events": [dict(e, addr=fmt_snes(e["bank"], e["addr"]))
                                  for e in obj["events"]]}, f, indent=1)
    path = os.path.join(args.out, "objects.tsv")
    with open(path, "w") as f:
        f.write("type\tentry\tentry_file\tlist\tinsns\tbytes\ttables\tindex_sets"
                "\tuploads\twaits\tlists\tpalettes\tspawns\tunresolved\n")
        for obj in objs:
            f.write("\t".join(str(c) for c in summary_row(obj)) + "\n")
    drawn = sum(1 for o in objs if any(e["kind"] in ("table", "list")
                                       for e in o["events"]))
    print("{} object types traced; {} set a frame table or list, {} upload "
          "tiles".format(len(objs), drawn,
                         sum(1 for o in objs
                             if any(e["kind"] == "upload" for e in o["events"]))))
    print("wrote {} and {}/".format(path, outdir))
    return 0


if __name__ == "__main__":
    sys.exit(main())
