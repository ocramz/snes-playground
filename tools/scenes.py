#!/usr/bin/env python3
"""Recover each screen's PPU setup and the graphics it loads.

A frame list or a tilemap only means something against the VRAM and CGRAM a
particular screen set up. Both are static: the game keeps one 18-byte block
per screen and applies it wholesale.

`sub_scene_screen_setup` at `$80:CABC (0x004ABC)` is

    ASL A / TAX / LDA $80:CAC7,X / JSL $80:903A

so `tbl_scene_screen_blocks` at `$80:CAC7` is 20 word pointers into bank
`$80`. `$80:9040` then applies the block it names:

    byte 0        -> $2105 BGMODE          (also kept at $83)
    byte 1        -> $2101 OBSEL           (also kept at $82)
    bytes 2-3     Y, bytes 4-5  X  -> $80:8542  BG1
    bytes 6-7     Y, bytes 8-9  X  -> $80:8598  BG2
    bytes 10-11   Y, bytes 12-13 X  -> $80:85EC  BG3
    bytes 14-15   Y, bytes 16-17 X  -> $80:8642  BG4

and each BG setter reads Y as the tilemap word address, the low two bits of
X as the tilemap size, and `X >> 12` as the character base in 4K-word units
(`$80:8542` does `AND #$03` then `XBA / LSR x4 / ORA $0084`).

That makes the course scene's block at `$80:CB91` read

    09 03 | 0050 0100 | 0058 0100 | 003C 0040 | 0000 0000

= mode 1 with BG3 priority, OBSEL `$03`, BG1 map `$5000`, BG2 map `$5800`
(the two addresses the course tilemap uploader writes), and BG3 map `$3C00`
with character base `$4000` (the font). OBSEL `$03` puts the sprite name
base at VRAM word `$6000` with sizes 8x8 and 16x16 — which is why the two
OBJ loads land exactly on `$6000` and `$7000`.

Graphics arrive through four jump tables of loader routines, each entered
as `CMP #n / BCS / ASL / TAX / JMP (table,X)`:

    $80:CC81   8 entries   graphics set A
    $80:CD89   6 entries   graphics set B
    $80:CE45  28 entries   tilesets
    $80:D2FE  33 entries   palette sets

This walks every entry and records what it decompresses, where it stages
it, which VRAM records it queues and which CGRAM image it moves.

    python3 tools/scenes.py blocks     # the 20 screen setups
    python3 tools/scenes.py loaders    # what each jump-table entry loads
    python3 tools/scenes.py callers    # who selects which scene
    python3 tools/scenes.py all        # everything, to build/scenes
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dis65816 import IMM_M, IMM_X, LONGX  # noqa: E402
from halcomp import CompressionError, decompress  # noqa: E402
from lorom import fmt_file, fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from vram import parse_block  # noqa: E402

SCENE_SETUP = (0x80, 0xCABC)
SCENE_TABLE = (0x80, 0xCAC7)
SCENE_COUNT = 20
BLOCK_BYTES = 18

LOAD_ASSET = (0x80, 0xCA9F)       # decompress to $7F:0000
LOAD_ASSET_VRAM = (0x80, 0xCAA9)  # ... then queue a VRAM record block
VRAM_QUEUE = (0x80, 0x8696)       # queue a VRAM record block directly
CGRAM_PARTIAL = (0x80, 0x90C8)    # A colours from $98:X to CGRAM colour Y
CGRAM_BANK = 0x98                 # hardwired in the MVN at $80:90D4
DECOMPRESS = (0x80, 0x9F18)       # sub_hal_decompress, straight to WRAM

JUMP_TABLES = [
    ("gfx_a", 0x80, 0xCC81, 8),
    ("gfx_b", 0x80, 0xCD89, 6),
    ("tileset", 0x80, 0xCE45, 28),
    ("palette", 0x80, 0xD2FE, 33),
]

BG_SIZES = {0: "32x32", 1: "64x32", 2: "32x64", 3: "64x64"}
# $2101 bits 5-7: (small, large) sprite sizes in pixels.
OBJ_SIZES = {
    0: (8, 16), 1: (8, 32), 2: (8, 64), 3: (16, 32),
    4: (16, 64), 5: (32, 64), 6: (16, 32), 7: (16, 32),
}


def word(d, off):
    return int.from_bytes(d[off:off + 2], "little")


def screen_blocks(d):
    """The 20 screen setup blocks, decoded."""
    base = snes_to_file(*SCENE_TABLE)
    out = []
    for i in range(SCENE_COUNT):
        addr = word(d, base + 2 * i)
        off = snes_to_file(0x80, addr)
        raw = d[off:off + BLOCK_BYTES]
        obsel = raw[1]
        bgs = []
        for b in range(4):
            y = word(d, off + 2 + 4 * b)
            x = word(d, off + 4 + 4 * b)
            bgs.append({
                "map_word": y,
                "char_word": (x >> 12) * 0x1000,
                "size": BG_SIZES[x & 3],
                "raw_x": x,
            })
        out.append({
            "scene": i,
            "block_addr": addr,
            "block_file": off,
            "bgmode": raw[0],
            "mode": raw[0] & 7,
            "bg3_priority": bool(raw[0] & 8),
            "obsel": obsel,
            "obj_name_base": (obsel & 7) << 13,
            "obj_name_select": (obsel >> 3) & 3,
            "obj_page2": ((obsel & 7) << 13) + (((obsel >> 3) & 3) + 1) * 0x1000,
            "obj_sizes": OBJ_SIZES[(obsel >> 5) & 7],
            "bg": bgs,
            "raw": raw,
        })
    return out


def scene_callers(d):
    """Sites doing `LDA #$00nn / JSL $80:CABC` - who selects a scene."""
    tail = bytes([0x22, SCENE_SETUP[1] & 0xFF, SCENE_SETUP[1] >> 8, SCENE_SETUP[0]])
    out = []
    for i in range(len(d) - 7):
        if d[i] != 0xA9 or d[i + 2] != 0x00:
            continue
        if d[i + 3:i + 7] != tail:
            continue
        out.append((i, d[i + 1]))
    return out


def jump_entries(d, bank, addr, count):
    """Targets of a `JMP (table,X)` dispatcher; the table follows the JMP."""
    off = snes_to_file(bank, addr)
    # CMP #n / BCS / ASL A / TAX / JMP (tbl,X) -- the table address is the
    # JMP's operand, and the table itself sits right after it.
    jmp = d.find(b"\x7c", off, off + 16)
    if jmp < 0:
        return []
    tbl = word(d, jmp + 1)
    tbl_off = snes_to_file(bank, tbl)
    return [(i, word(d, tbl_off + 2 * i)) for i in range(count)]


def walk_loader(d, bank, addr, limit=0x140, depth=0, seen=None):
    """What one loader routine does, by decoding it instruction by instruction.

    Pattern matching on raw bytes misses these routines: several pick a
    source with a branch, several delegate to a `JSL` helper, and an operand
    byte can look like the start of an idiom. So step real instructions,
    keep the last immediate loaded into A, X and Y, and act when a call
    lands on one of the four known targets. Branches are not followed; the
    scan continues linearly to the routine's `RTL`, which records both arms
    of a two-way source choice rather than guessing which one runs.

    Four call targets matter:

        $80:CA9F  sub_load_asset        A=bank X=src Y=dest, stage to $7F
        $80:CAA9  sub_load_asset_vram   ... then queue the block in Y
        $80:8696  sub_vram_queue        A = a VRAM record block
        $80:90C8  sub_cgram_partial     A=colours X=src Y=first colour index,
                                        source bank hardwired to $98

    plus the full-image CGRAM move, `LDY #$0400` followed by `MVN $00,bank`.
    """
    from dis65816 import decode

    if seen is None:
        seen = set()
    key = (bank, addr)
    if key in seen or depth > 2:
        return []
    seen.add(key)

    off = snes_to_file(bank, addr)
    if d[off] == 0x80 and d[off + 1] == 0xFE:      # BRA to itself = unused slot
        return [{"kind": "unused", "site": off}]
    end = min(off + limit, len(d) - 4)
    acts = []
    a = x = y = None
    block_tables = []
    m8 = x8 = False
    i = off
    while i < end:
        try:
            ins, m8, x8 = decode(d, i, m8, x8, bank=bank)
        except (KeyError, IndexError):
            break
        mn, md, opnd = ins.mnemonic, ins.mode, ins.operand

        if mn == "LDA" and md == IMM_M:
            a = opnd
        elif mn == "LDX" and md == IMM_X:
            x = opnd
        elif mn == "LDY" and md == IMM_X:
            y = opnd
        elif mn == "LDA" and md == LONGX:
            # `LDA $80:tbl,X / JSL $80:8696` picks a VRAM block from a table
            # at run time. Remember the table; A is no longer a constant.
            # A loader can name two and branch between them -- tileset 18 at
            # `$80:D0E7` reads `$80:D0FC`, or `$80:D10C` when `$1801` is set
            # -- so keep every table seen since the last queue call.
            block_tables.append(opnd & 0xFFFF)
            a = None
        elif mn in ("LDX", "LDY", "LDA"):
            # Loaded from memory: the register is no longer a known constant.
            if mn == "LDA":
                a = None
            elif mn == "LDX":
                x = None
            else:
                y = None
        elif mn == "MVN" and y == 0x0400 and a is not None and x is not None:
            # MVN is stored dest-bank first, so the source bank is the high
            # byte of the operand word: `54 00 98` is MVN $00,$98.
            acts.append({"kind": "cgram", "src_bank": (opnd >> 8) & 0xFF,
                         "src": x, "colours": (a + 1) // 2, "length": a + 1,
                         "first_colour": 0, "site": i})
        elif mn in ("JSL", "JML", "JSR", "JMP") and opnd is not None:
            if mn in ("JSL", "JML"):
                target = (opnd >> 16, opnd & 0xFFFF)
            else:
                target = (bank, opnd)
            if target == LOAD_ASSET and None not in (a, x, y):
                acts.append({"kind": "stage", "src_bank": a, "src": x,
                             "dest": y, "site": i})
            elif target == LOAD_ASSET_VRAM and None not in (a, x, y):
                acts.append({"kind": "vram", "src_bank": a, "src": x,
                             "block": y, "site": i})
            elif target == VRAM_QUEUE and a is not None:
                acts.append({"kind": "queue", "block": a, "site": i})
            elif target == VRAM_QUEUE and block_tables:
                for t in block_tables:
                    acts.append({"kind": "queue_table", "table": t, "site": i})
                block_tables = []
            elif target == DECOMPRESS and None not in (a, x, y):
                acts.append({"kind": "wram", "src_bank": a, "src": x,
                             "dest": y, "site": i})
            elif target == CGRAM_PARTIAL and None not in (a, x, y):
                acts.append({"kind": "cgram", "src_bank": CGRAM_BANK, "src": x,
                             "colours": a, "length": a * 2,
                             "first_colour": y, "site": i})
            elif target[0] == 0x80 and mn in ("JSL", "JML", "JSR"):
                acts.extend(walk_loader(d, target[0], target[1], limit,
                                        depth + 1, seen))
        i += len(ins.raw)
        if mn in ("RTS", "RTL", "RTI", "STP", "JMP", "JML"):
            break
    return acts


def describe(d, act):
    """Add the unpacked size and VRAM destinations to one loader action."""
    out = dict(act)
    if act["kind"] in ("stage", "vram", "wram"):
        try:
            blob, packed = decompress(d, snes_to_file(act["src_bank"], act["src"]))
            out["packed"] = packed
            out["unpacked"] = len(blob)
        except (CompressionError, ValueError, IndexError):
            out["packed"] = out["unpacked"] = None
    if act["kind"] in ("vram", "queue"):
        try:
            out["records"] = parse_block(d, 0x80, act["block"])
        except (ValueError, IndexError):
            out["records"] = []
        # A record whose source is neither of the staging banks reads
        # straight out of ROM, so that asset is stored uncompressed.
        for r in out.get("records", []):
            r["direct"] = (r["src"] >> 16) not in (0x7E, 0x7F)
    return out


def dests(act):
    return ", ".join("${:04X}+{}".format(r["vram_word"], r["size"])
                     for r in act.get("records", []))


def act_row(d, name, idx, routine, a):
    """One `loads.tsv` row for a loader action."""
    if a["kind"] == "unused":
        return (name, idx, routine, "unused", "", "", "", "branches to itself")
    if a["kind"] == "queue_table":
        return (name, idx, routine, "queue_table",
                fmt_snes(0x80, a["table"]), "", "",
                "block chosen at run time from a table")
    if a["kind"] == "wram":
        src = fmt_snes(a["src_bank"], a["src"])
        return (name, idx, routine, "wram", src,
                fmt_file(snes_to_file(a["src_bank"], a["src"])),
                a.get("unpacked", ""), "$7E:{:04X}".format(a["dest"]))
    if a["kind"] == "cgram":
        src = fmt_snes(a["src_bank"], a["src"])
        return (name, idx, routine, "cgram", src,
                fmt_file(snes_to_file(a["src_bank"], a["src"])),
                a["length"], "CGRAM colour {}+{}".format(
                    a["first_colour"], a["colours"]))
    if a["kind"] == "queue":
        srcs = []
        for r in a.get("records", []):
            if r["direct"]:
                srcs.append(fmt_snes(r["src"] >> 16, r["src"] & 0xFFFF))
        return (name, idx, routine, "queue_direct" if srcs else "queue",
                " ".join(srcs), "", sum(r["size"] for r in a.get("records", [])),
                dests(a))
    src = fmt_snes(a["src_bank"], a["src"])
    file_off = fmt_file(snes_to_file(a["src_bank"], a["src"]))
    if a["kind"] == "stage":
        return (name, idx, routine, "stage", src, file_off, a["unpacked"],
                "$7F:{:04X}".format(a["dest"]))
    return (name, idx, routine, "vram", src, file_off, a["unpacked"], dests(a))


def cmd_blocks(d, args):
    blocks = screen_blocks(d)
    for b in blocks:
        print("scene {:2d}  block {} ({})  BGMODE ${:02X} = mode {}{}  "
              "OBSEL ${:02X} = OBJ base ${:04X}/${:04X}, sizes {}x{} and {}x{}"
              .format(b["scene"], fmt_snes(0x80, b["block_addr"]),
                      fmt_file(b["block_file"]), b["bgmode"], b["mode"],
                      ", BG3 priority" if b["bg3_priority"] else "",
                      b["obsel"], b["obj_name_base"], b["obj_page2"],
                      b["obj_sizes"][0], b["obj_sizes"][0],
                      b["obj_sizes"][1], b["obj_sizes"][1]))
        for n, bg in enumerate(b["bg"], start=1):
            if not bg["raw_x"] and not bg["map_word"]:
                continue
            print("          BG{}  map ${:04X}  chars ${:04X}  {}".format(
                n, bg["map_word"], bg["char_word"], bg["size"]))
    if args.out:
        path = os.path.join(args.out, "blocks.tsv")
        with open(path, "w") as f:
            f.write("scene\tblock_addr\tblock_file\tbgmode\tmode\tbg3_priority"
                    "\tobsel\tobj_base\tobj_page2\tobj_small\tobj_large"
                    "\tbg1_map\tbg1_chars\tbg1_size\tbg2_map\tbg2_chars\tbg2_size"
                    "\tbg3_map\tbg3_chars\tbg3_size\tbg4_map\tbg4_chars\tbg4_size\n")
            for b in blocks:
                cols = [b["scene"], fmt_snes(0x80, b["block_addr"]),
                        fmt_file(b["block_file"]), "${:02X}".format(b["bgmode"]),
                        b["mode"], int(b["bg3_priority"]),
                        "${:02X}".format(b["obsel"]),
                        "${:04X}".format(b["obj_name_base"]),
                        "${:04X}".format(b["obj_page2"]),
                        b["obj_sizes"][0], b["obj_sizes"][1]]
                for bg in b["bg"]:
                    cols += ["${:04X}".format(bg["map_word"]),
                             "${:04X}".format(bg["char_word"]), bg["size"]]
                f.write("\t".join(str(c) for c in cols) + "\n")
        print("wrote {}".format(path))
    return 0


def cmd_loaders(d, args):
    rows = []
    for name, bank, addr, count in JUMP_TABLES:
        print("== {} jump table at {} ({} entries)".format(
            name, fmt_snes(bank, addr), count))
        for idx, target in jump_entries(d, bank, addr, count):
            routine = fmt_snes(bank, target)
            acts = [describe(d, a) for a in walk_loader(d, bank, target)]
            if not acts:
                print("  {:2d} {}  (no recognised loads)".format(idx, routine))
                rows.append((name, idx, routine, "none", "", "", "", ""))
                continue
            for a in acts:
                row = act_row(d, name, idx, routine, a)
                rows.append(row)
                print("  {:2d} {}  {:12s} {:10s} {:6s} -> {}".format(
                    idx, routine, row[3], row[4], str(row[6]), row[7]))
    if args.out:
        path = os.path.join(args.out, "loads.tsv")
        with open(path, "w") as f:
            f.write("table\tentry\troutine\tkind\tsrc_addr\tsrc_file"
                    "\tunpacked\tdestination\n")
            for r in rows:
                f.write("\t".join(str(x) for x in r) + "\n")
        print("wrote {} ({} loads)".format(path, len(rows)))
    return 0


def cmd_callers(d, args):
    calls = scene_callers(d)
    from collections import defaultdict
    by_scene = defaultdict(list)
    for off, scene in calls:
        by_scene[scene].append(off)
    for scene in sorted(by_scene):
        sites = by_scene[scene]
        print("scene {:2d}: {} call site{} -- {}".format(
            scene, len(sites), "" if len(sites) == 1 else "s",
            ", ".join(fmt_file(s) for s in sites[:6])
            + (" ..." if len(sites) > 6 else "")))
    missing = [i for i in range(SCENE_COUNT) if i not in by_scene]
    if missing:
        print("no immediate caller found for scene(s): {}".format(
            ", ".join(str(m) for m in missing)))
    if args.out:
        path = os.path.join(args.out, "callers.tsv")
        with open(path, "w") as f:
            f.write("scene\tsite_file\tsite_addr\n")
            for off, scene in sorted(calls, key=lambda c: (c[1], c[0])):
                bank = (off // 0x8000) | 0x80
                f.write("{}\t{}\t{}\n".format(
                    scene, fmt_file(off),
                    fmt_snes(bank, (off % 0x8000) + 0x8000)))
        print("wrote {}".format(path))
    return 0


def scene_bundle(d, site):
    """Every loader a scene-entry routine runs, in order.

    A scene is set up by a straight run of `LDA #n / JSL <jump table>` pairs.
    `sub_course_enter $80:C307` is the model:

        LDA #$0000 / JSL $80:CABC      screen block 0
        LDA #$0000 / JSL $80:CC81      graphics set A entry 0
        LDA #$0000 / JSL $80:CE45      tileset entry 0
        LDA #$0000 / JSL $80:D2FE      palette entry 0
        JSL $80:D6A8                   per-course backdrop
        LDA #$0000 / JSL $80:CD89      graphics set B entry 0
        LDA #$0001 / JSL $80:CD89      ... and entry 1

    so walking forward from the scene call to the routine's end collects the
    whole bundle. `site` is the file offset of the `LDA` before the call.
    """
    from dis65816 import decode

    tables = dict(((b, a), n) for n, b, a, _ in JUMP_TABLES)
    tables[SCENE_SETUP] = "scene"
    out = []
    a = None
    m8 = x8 = False
    bank = (site // 0x8000) | 0x80
    i = site
    end = min(site + 0x100, len(d) - 4)
    while i < end:
        try:
            ins, m8, x8 = decode(d, i, m8, x8, bank=bank)
        except (KeyError, IndexError):
            break
        if ins.mnemonic == "LDA" and ins.mode == IMM_M:
            a = ins.operand
        elif ins.mnemonic in ("JSL", "JML") and ins.operand is not None:
            target = (ins.operand >> 16, ins.operand & 0xFFFF)
            if target in tables:
                out.append((tables[target], a))
                a = None
        i += len(ins.raw)
        if ins.mnemonic in ("RTS", "RTL", "RTI", "STP"):
            break
    return out


def cmd_bundles(d, args):
    """Pair each screen block with the graphics and palette its scene loads."""
    blocks = screen_blocks(d)
    loads = {}
    for name, bank, addr, count in JUMP_TABLES:
        for idx, target in jump_entries(d, bank, addr, count):
            loads[(name, idx)] = [describe(d, a)
                                  for a in walk_loader(d, bank, target)]

    rows = []
    for site, scene in scene_callers(d):
        bundle = scene_bundle(d, site)
        if not bundle or bundle[0][0] != "scene":
            continue
        b = blocks[scene] if scene < len(blocks) else None
        print("scene {:2d}  entry {}  block {}  OBJ base ${:04X}".format(
            scene, fmt_file(site),
            fmt_snes(0x80, b["block_addr"]) if b else "?",
            b["obj_name_base"] if b else 0))
        for table, idx in bundle[1:]:
            if idx is None:
                continue
            acts = loads.get((table, idx), [])
            what = []
            for a in acts:
                if a["kind"] in ("stage", "vram", "wram", "cgram"):
                    what.append(fmt_snes(a["src_bank"], a["src"]))
                elif a["kind"] == "queue_direct" or a["kind"] == "queue":
                    what.append("block ${:04X}".format(a.get("block", 0)))
                else:
                    what.append(a["kind"])
            print("          {:8s} {:2d}  {}".format(
                table, idx, ", ".join(what) if what else "-"))
            rows.append((scene, fmt_file(site), table, idx,
                         " ".join(what) if what else ""))
    if args.out:
        path = os.path.join(args.out, "bundles.tsv")
        with open(path, "w") as f:
            f.write("scene\tentry_site\ttable\tentry\tsources\n")
            for r in rows:
                f.write("\t".join(str(x) for x in r) + "\n")
        print("wrote {} ({} rows)".format(path, len(rows)))
    return 0


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command",
                    choices=("blocks", "loaders", "callers", "bundles", "all"))
    ap.add_argument("--out", default="build/scenes",
                    help="directory for the TSVs; '' to print only")
    args = ap.parse_args()

    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    if args.out and not os.path.isdir(args.out):
        os.makedirs(args.out)

    if args.command in ("blocks", "all"):
        cmd_blocks(d, args)
    if args.command in ("loaders", "all"):
        cmd_loaders(d, args)
    if args.command in ("callers", "all"):
        cmd_callers(d, args)
    if args.command in ("bundles", "all"):
        cmd_bundles(d, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
