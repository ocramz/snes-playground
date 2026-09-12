#!/usr/bin/env python3
"""Disassemble the animation scripts that drive objects.

The interpreter is `sub_anim_script_run $80:9564 (0x001564)`, one call per
thread. Read from the disassembly:

    LDX $DA                 ; $DA = thread index * 2
    LDA $0CBE,X             ; wait timer; nonzero -> just DEC it and return
    LDY $0CFE,X             ; Y = script PC
    LDA $0D3E,X / STA $D2   ; script bank; $D0 = $0000 is set by the caller,
                            ; so [$D0],Y is a long pointer to the script
    TXA / ASL x3 / ADC #$0DBE / STA $D4    ; 8 local bytes per thread
  fetch ($957C):
    LDA [$D0],Y / INY       ; opcode byte
    CMP #$0070
    BCS packed
    ASL A / TAX / JSR ($95B6,X)            ; tbl_anim_opcodes, 61 entries
    BRA next
  packed ($958E):
    AND #$000F / STA $0CBE,X               ; wait ticks = low nibble
    LDA / AND #$0070 / LSR x3 / TAX
    JSR ($9630,X)                          ; tbl_anim_wait_actions, 8 entries
  next ($95A2):
    wait still zero -> back to fetch, so a 0-tick opcode runs the next one in
    the same frame; otherwise save PC and bank and fall into DEC $0CBE,X.

So an opcode below `$70` is a plain dispatch through `tbl_anim_opcodes
$80:95B6` and never waits by itself. `$70` and above is **packed**: the low
nibble is a wait in game ticks and bits 4-6 pick one of eight actions in
`tbl_anim_wait_actions $80:9630`. Opcodes `$3D-$6F` are past the end of the
61-entry opcode table and index into the wait-action table instead; nothing
emits them.

Opcode `$1C` is `sub_obj_set_frame_ptr $80:9B98`, the only `STA $0B9E,X` in
the ROM. Its three operand bytes are `addr16 bank8` of a frame *pointer
table*, which is the one static link from a script to the metasprite data --
following it is what lets this tool name the frames a script plays.

Ground truth is the four object-type scripts at `dat_anim_scripts_type0_3
$87:99FE (0x0399FE)`, reached through `tbl_obj_type_scripts $80:9F0C`
(4 entries of addr16+bank8, in address order types 2, 3, 0, 1). They total
52 bytes, each ends on opcode `$09`, and their four `$1C` operands are
exactly `$89:9295`, `$92F3`, `$9351` and `$9365`.

Everything `--scan` turns up beyond those four is **unconfirmed**: it walks
back from a `$1C` whose operand is a known frame table and takes the earliest
byte that decodes cleanly onto it, which is a guess about where the script
begins, not a reference anybody follows.

    python3 tools/anim.py --types              # the four ground-truth scripts
    python3 tools/anim.py --verify             # assert their lengths
    python3 tools/anim.py --script '$87:99FE'
    python3 tools/anim.py --script '$87:99FE' --frames
    python3 tools/anim.py --scan               # -> build/sprites/scripts.tsv
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import (AddressError, file_to_snes, fmt_file, fmt_snes,  # noqa: E402
                   parse_addr, snes_to_file)
from romcheck import RomError, load_rom  # noqa: E402

OPCODE_TABLE = (0x80, 0x95B6)        # tbl_anim_opcodes, 61 word entries
WAIT_TABLE = (0x80, 0x9630)          # tbl_anim_wait_actions, 8 word entries
OBJ_TYPE_SCRIPTS = (0x80, 0x9F0C)    # 4 x (addr16, bank8)
KNOWN_SCRIPTS = (0x87, 0x99FE)       # dat_anim_scripts_type0_3
OPCODE_COUNT = 61                    # $00-$3C; $3D-$6F fall off the table
PACKED_MIN = 0x70
SET_FRAME_TABLE = 0x1C
HALT = 0x09
FRAME_BANK = 0x89
TABLES_TSV = "build/sprites/tables.tsv"
BACKWALK = 64                        # how far back --scan looks for a start
MAX_SCRIPT = 512

# The four generic per-object words a "field" operand selects, from the word
# table at $80:9B4C; the handler adds $D8 (object index * 2).
FIELD_BASE = (0x0A9E, 0x0ABE, 0x0ADE, 0x0AFE)
# The read-modify-write ops at $80:9B10, each `LDA ($DC) / <op> $E0 / STA ($DC)`.
RMW_OPS = ("and", "ora", "add", "eor")

# opcode -> (operand kind, mnemonic, note)
#
# The operand size of every entry below was counted off the handler: each
# `LDA [$D0],Y` is a 16-bit fetch and the `INY`s after it say how many bytes
# it consumed, so one INY means the high byte was discarded and the operand
# is a single byte.
OPCODES = {
    0x00: ("none", "obj_destroy",
           "$9640: JSR $9C79 (object destructor), wait = $FFFF, STA $0874"),
    0x01: ("u8", "loop",
           "$9651: push PC and a 1-byte count as a 3-byte local stack frame"),
    0x02: ("none", "loop_end",
           "$9675: decrement the pushed count; branch back or pop the frame"),
    0x03: ("far", "jml",
           "$969B: far jump; sets Y and the script bank $D2"),
    0x04: ("far", "jsl",
           "$96D3: far call; pushes PC and bank as a 3-byte frame"),
    0x05: ("none", "rtl",
           "$96F8: far return; falls into end_thread when the stack is empty"),
    0x06: ("u8", "wait",
           "$9711: set the wait timer directly, 0-255 ticks"),
    0x07: ("near", "spawn",
           "$9A3A: allocate a thread ($9D09) starting here, same bank"),
    0x08: ("far", "set_obj_hook",
           "$9A74: store addr16+bank8 in $0B3E,X/$0B5E,X, the long vector "
           "$80:9510 calls each tick; $9D9B resets it to $80:94C6"),
    0x09: ("none", "halt",
           "$9A88: DEY back onto this byte, wait = $FFFF. The terminator"),
    0x0A: ("near", "beq_reg",
           "$99BA: branch when the thread register $0D7E,X is zero"),
    0x0B: ("near", "bne_reg",
           "$99C8: branch when the thread register is nonzero"),
    0x0C: ("none", "end_thread",
           "$9A20: unlink the thread ($9D18); destroy the object too when "
           "$08BE,X is negative"),
    0x0D: ("abs_op_u16", "rmw_abs",
           "$9AF2: [addr] <op>= imm16, op from $9B10"),
    0x0E: ("field_u16", "set_field",
           "$9B35: object field[n] = imm16"),
    0x0F: ("none", "reset_obj_hook",
           "$9B54: JSR $9D9B, object hook back to $80:94C6"),
    0x10: ("switch", "switch",
           "$99D6: jump via the thread register into a table of count words; "
           "register >= count falls through past the table"),
    0x11: ("switch", "switch_call",
           "$99FB: as switch, but pushes the address after the table as a "
           "2-byte frame first"),
    0x12: ("abs_u8", "store_byte",
           "$9B5A: byte at addr = imm8"),
    0x13: ("none", "end_linked_thread",
           "$9A6B: end_thread applied to the thread linked at $0C3E,X"),
    0x14: ("field_op_u16", "rmw_field",
           "$9ADA: object field[n] <op>= imm16"),
    0x15: ("abs_u16", "store_word",
           "$9B6A: word at addr = imm16"),
    0x16: ("near", "beq_reg_unwind",
           "$9B77: when the register is zero, drop a 3-byte local frame and "
           "jump; otherwise skip the operand"),
    0x17: ("near", "bne_reg_unwind",
           "$9B8F: the complement of beq_reg_unwind"),
    0x18: ("abs_op_u8", "rmw_abs8",
           "$9AB6: the 8-bit rmw_abs; calls the $9B10 handler under SEP #$20"),
    0x19: ("near", "jmp", "$9697: near jump, same bank"),
    0x1A: ("near", "jsr", "$96A6: near call, pushes a 2-byte frame"),
    0x1B: ("none", "rts",
           "$96BD: near return; falls into end_thread when the stack is empty"),
    0x1C: ("far", "set_frame_table",
           "$9B98 sub_obj_set_frame_ptr: bind a frame POINTER TABLE, "
           "addr -> $0B9E,X and bank -> $0BBE,X"),
    0x1D: ("u16", "set_reg", "$9BAC: thread register $0D7E,X = imm16"),
    0x1E: ("abs", "load_reg_abs", "$9BB6: register = word at addr"),
    0x1F: ("field", "store_reg_field", "$9BC4: object field[n] = register"),
    0x20: ("field", "load_reg_field", "$9BDC: register = object field[n]"),
    0x21: ("field", "wait_field", "$9BF4: wait timer = object field[n]"),
    0x22: ("vec", "set_draw_vec",
           "$9C24: $0BFE,X = addr; ram_obj_vec_draw, default $9E8E"),
    0x23: ("vec", "set_update_vec",
           "$9C2E: $0BDE,X = addr; ram_obj_vec_update, default $9E5C"),
    0x24: ("u8", "loop_reg",
           "$966E: loop with the count taken from the thread register. Shares "
           "$9655 with `loop`, so the operand byte is read past and ignored"),
    0x25: ("vec", "set_physics_vec",
           "$9C38: $0C1E,X = addr; ram_obj_vec_physics, default $9E33"),
    0x26: ("field", "frame_index_field",
           "$9C0C: frame index $0B7E,X = object field[n]"),
    0x27: ("pad_op_u16", "rmw_reg",
           "$9AEA: thread register <op>= imm16. Shares $9AF5 with rmw_field, "
           "so the first operand byte is read past and ignored"),
    0x28: ("u16", "set_x", "$9731: $091E,X = imm16, fraction $097E,X = $8000"),
    0x29: ("u16", "set_y", "$9741: $093E,X = imm16, fraction $099E,X = $8000"),
    0x2A: ("u16", "set_z", "$9751: $095E,X = imm16, fraction $09BE,X = $8000"),
    0x2B: ("u16", "add_x", "$9912: $091E,X += imm16 (whole part only)"),
    0x2C: ("u16", "add_y", "$9920: $093E,X += imm16"),
    0x2D: ("u16", "add_z", "$992E: $095E,X += imm16"),
    0x2E: ("fx88", "add_vx",
           "$97DF: X velocity += signed 8.8 ($0A3E,X frac, $09DE,X whole)"),
    0x2F: ("fx88", "add_vy", "$9804: Y velocity += signed 8.8"),
    0x30: ("fx88", "add_vz", "$9829: Z velocity += signed 8.8"),
    0x31: ("slot_u16", "slot_set_a",
           "$984E: $0FBE,X = imm16 and STZ $0FCE,X, X = slot * 2"),
    0x32: ("slot_u16", "slot_set_b", "$9861: $0FC6,X = imm16, STZ $0FD6,X"),
    0x33: ("slot_fx88", "slot_set_c",
           "$9874: $0FEE,X/$0FDE,X = signed 8.8"),
    0x34: ("slot_fx88", "slot_set_d", "$9898: $0FF6,X/$0FE6,X = signed 8.8"),
    0x35: ("slot_fx88", "slot_add_c", "$98BC: $0FEE,X/$0FDE,X += signed 8.8"),
    0x36: ("slot_fx88", "slot_add_d", "$98E7: $0FF6,X/$0FE6,X += signed 8.8"),
    0x37: ("slot_u16", "slot_add_a", "$993C: $0FBE,X += imm16"),
    0x38: ("slot_u16", "slot_add_b", "$9950: $0FC6,X += imm16"),
    0x39: ("none", "stop",
           "$9964: zero all three velocity pairs, whole and fractional"),
    0x3A: ("u8", "slot_clear",
           "$9979: zero $0FEE/$0FDE/$0FF6/$0FE6 for one slot"),
    0x3B: ("xyz", "set_pos",
           "$9761: set X, Y and Z at once, each fraction $8000"),
    0x3C: ("u8", "set_queue",
           "$998E: $0B1E,X = OAM priority queue; sub_obj_draw copies it to "
           "$2880 for sub_oam_enqueue"),
}

# packed action (bits 4-6) -> (operand kind, mnemonic, note)
WAIT_ACTIONS = {
    0: ("u8", "frame",
        "$971D sub_anim_set_frame: frame index = byte; $FF stores $FFFF, "
        "which sub_obj_draw reads as invisible"),
    1: ("none", "frame_next", "$9A92: INC the frame index"),
    2: ("none", "frame_prev", "$9A98: DEC the frame index"),
    3: ("s8", "frame_add", "$9A9E: frame index += signed byte"),
    4: ("fx88", "set_vx", "$9785: X velocity = signed 8.8"),
    5: ("fx88", "set_vy", "$97A3: Y velocity = signed 8.8"),
    6: ("fx88", "set_vz", "$97C1: Z velocity = signed 8.8"),
    7: ("far", "far_call",
        "$999A: JSL $80:9D98 = JML [$0876] to addr16+bank8, with the thread "
        "register in A; the result is stored back into the register"),
}

# Fixed operand widths. "switch" is variable and handled separately.
KIND_SIZE = {
    "none": 0, "u8": 1, "s8": 1, "field": 1,
    "u16": 2, "fx88": 2, "near": 2, "abs": 2, "vec": 2,
    "far": 3, "abs_u8": 3, "field_u16": 3, "slot_u16": 3, "slot_fx88": 3,
    "abs_op_u8": 4, "field_op_u16": 4, "pad_op_u16": 4,
    "abs_op_u16": 5,
    "xyz": 6,
}

# Opcodes after which control does not fall through to the next byte.
TERMINATORS = {0x00, 0x03, 0x05, 0x09, 0x0C, 0x13, 0x19, 0x1B}


def signed8(b):
    return b - 0x100 if b & 0x80 else b


def u16(data, off):
    return int.from_bytes(data[off:off + 2], "little")


def operand_size(kind, data, off):
    """Bytes the operand occupies. `switch` carries its own length."""
    if kind == "switch":
        return 1 + 2 * data[off]
    return KIND_SIZE[kind]


def format_operand(kind, data, off, bank):
    """Human-readable operand text for one instruction."""
    if kind == "none":
        return ""
    if kind == "u8":
        return "${:02X}".format(data[off])
    if kind == "s8":
        return "{:+d}".format(signed8(data[off]))
    if kind == "field":
        return "field{} (${:04X})".format(data[off],
                                          FIELD_BASE[data[off] & 3])
    if kind == "u16":
        return "${:04X}".format(u16(data, off))
    if kind == "fx88":
        w = u16(data, off)
        return "{:+.3f} (${:04X})".format(signed8(w >> 8) + (w & 0xFF) / 256.0, w)
    if kind == "near":
        return fmt_snes(bank, u16(data, off))
    if kind == "vec":
        # The per-object vectors are reached by JSR ($0BFE,X) and friends from
        # sub_obj_tick_all in bank $80, so the operand is a bank $80 address
        # whatever bank the script itself lives in. $80:9F0B is a bare RTS.
        return fmt_snes(0x80, u16(data, off))
    if kind == "abs":
        return "${:04X}".format(u16(data, off))
    if kind == "far":
        return fmt_snes(data[off + 2], u16(data, off))
    if kind == "abs_u8":
        return "${:04X} = ${:02X}".format(u16(data, off), data[off + 2])
    if kind == "abs_u16":
        return "${:04X} = ${:04X}".format(u16(data, off), u16(data, off + 2))
    if kind == "field_u16":
        return "field{} = ${:04X}".format(data[off], u16(data, off + 1))
    if kind == "slot_u16":
        return "slot{} = ${:04X}".format(data[off], u16(data, off + 1))
    if kind == "slot_fx88":
        w = u16(data, off + 1)
        return "slot{} = {:+.3f}".format(
            data[off], signed8(w >> 8) + (w & 0xFF) / 256.0)
    if kind == "abs_op_u16":
        return "${:04X} {}= ${:04X}".format(
            u16(data, off), rmw_name(data[off + 2]), u16(data, off + 3))
    if kind == "abs_op_u8":
        return "${:04X} {}= ${:02X}".format(
            u16(data, off), rmw_name(data[off + 2]), data[off + 3])
    if kind == "field_op_u16":
        return "field{} {}= ${:04X}".format(
            data[off], rmw_name(data[off + 1]), u16(data, off + 2))
    if kind == "pad_op_u16":
        return "reg {}= ${:04X}  (pad ${:02X})".format(
            rmw_name(data[off + 1]), u16(data, off + 2), data[off])
    if kind == "xyz":
        return "x=${:04X} y=${:04X} z=${:04X}".format(
            u16(data, off), u16(data, off + 2), u16(data, off + 4))
    if kind == "switch":
        n = data[off]
        return "{} cases: {}".format(n, " ".join(
            fmt_snes(bank, u16(data, off + 1 + 2 * i)) for i in range(n)))
    raise ValueError("unknown operand kind {!r}".format(kind))


def rmw_name(index):
    return RMW_OPS[index] if index < len(RMW_OPS) else "op{}?".format(index)


def decode_one(data, bank, addr):
    """Decode the instruction at (bank, addr). Returns a dict, or None."""
    try:
        off = snes_to_file(bank, addr)
    except AddressError:
        return None
    if off >= len(data):
        return None
    op = data[off]
    if op >= PACKED_MIN:
        action = (op >> 4) & 7
        kind, name, note = WAIT_ACTIONS[action]
        size = 1 + operand_size(kind, data, off + 1)
        return {"addr": addr, "bank": bank, "off": off, "op": op, "size": size,
                "name": name, "kind": kind, "note": note, "packed": True,
                "action": action, "wait": op & 0x0F,
                "text": format_operand(kind, data, off + 1, bank),
                "terminator": False}
    if op not in OPCODES:
        # $3D-$6F index past tbl_anim_opcodes into tbl_anim_wait_actions.
        return {"addr": addr, "bank": bank, "off": off, "op": op, "size": 1,
                "name": "?invalid", "kind": "none", "packed": False,
                "note": "past the 61-entry opcode table", "wait": 0,
                "text": "", "terminator": True, "invalid": True}
    kind, name, note = OPCODES[op]
    size = 1 + operand_size(kind, data, off + 1)
    return {"addr": addr, "bank": bank, "off": off, "op": op, "size": size,
            "name": name, "kind": kind, "note": note, "packed": False,
            "wait": 0, "text": format_operand(kind, data, off + 1, bank),
            "terminator": op in TERMINATORS}


def decode(data, bank, addr, max_bytes=MAX_SCRIPT):
    """Linear decode from a script start until a non-falling-through opcode."""
    out, cur, used = [], addr, 0
    while used < max_bytes:
        ins = decode_one(data, bank, cur)
        if ins is None:
            break
        out.append(ins)
        used += ins["size"]
        if ins["terminator"]:
            break
        cur += ins["size"]
        if cur > 0xFFFF:
            break
    return out


def script_length(instructions):
    return sum(i["size"] for i in instructions)


def obj_type_scripts(data):
    """The four (type, bank, addr) entries of tbl_obj_type_scripts $80:9F0C."""
    base = snes_to_file(*OBJ_TYPE_SCRIPTS)
    return [(i, data[base + 3 * i + 2], u16(data, base + 3 * i))
            for i in range(4)]


def frame_sequence(data, instructions, tables=None):
    """Frames a script plays, with the tick at which each becomes current.

    Only a linear reading: branches, loops and `switch` are not followed, so
    anything past the first terminator is not here.
    """
    seq, tick, table, index = [], 0, None, None
    for ins in instructions:
        if ins["op"] == SET_FRAME_TABLE:
            table = (data[ins["off"] + 3], u16(data, ins["off"] + 1))
        elif ins["packed"]:
            if ins["action"] == 0:
                b = data[ins["off"] + 1]
                index = None if b == 0xFF else b
            elif ins["action"] == 1 and index is not None:
                index += 1
            elif ins["action"] == 2 and index is not None:
                index -= 1
            elif ins["action"] == 3 and index is not None:
                index += signed8(data[ins["off"] + 1])
            if ins["action"] <= 3:
                seq.append({"tick": tick, "table": table, "index": index,
                            "list": resolve_frame(data, table, index),
                            "wait": ins["wait"], "at": ins["addr"]})
            tick += ins["wait"]
        elif ins["op"] == 0x06:
            tick += data[ins["off"] + 1]
    return seq


def resolve_frame(data, table, index):
    """The frame list a (table, index) pair names, or None."""
    if table is None or index is None or index < 0:
        return None
    bank, addr = table
    try:
        w = u16(data, snes_to_file(bank, addr + 2 * index))
    except AddressError:
        return None
    return None if w in (0x0000, 0xFFFF) else w


def known_tables(path):
    """Frame-table addresses from frametabs.py, as a {(bank, addr)} set."""
    out = set()
    if not os.path.exists(path):
        return out
    with open(path) as f:
        header = f.readline().rstrip("\n").split("\t")
        for line in f:
            row = dict(zip(header, line.rstrip("\n").split("\t")))
            kind, value = parse_addr(row["table_addr"])
            if kind == "snes":
                out.add(value)
    return out


def print_script(data, bank, addr, label=None, show_notes=False):
    ins = decode(data, bank, addr)
    print("{}{} ({}), {} bytes, {} instructions".format(
        (label + ": ") if label else "", fmt_snes(bank, addr),
        fmt_file(snes_to_file(bank, addr)), script_length(ins), len(ins)))
    for i in ins:
        raw = " ".join("{:02X}".format(b)
                       for b in data[i["off"]:i["off"] + min(i["size"], 8)])
        head = "{:<18}".format(i["name"] if not i["packed"]
                               else "{} wait={}".format(i["name"], i["wait"]))
        print("  {}  {:<24}  {}{}".format(
            fmt_snes(bank, i["addr"]), raw, head, i["text"]))
        if show_notes:
            print("      {}".format(i["note"]))
    return ins


def cmd_types(data, args):
    total = 0
    for kind, sbank, saddr in obj_type_scripts(data):
        ins = print_script(data, sbank, saddr, "object type {}".format(kind),
                           args.notes)
        total += script_length(ins)
        if args.frames:
            for f in frame_sequence(data, ins):
                print("      tick {:>3}: {} index {} -> {}".format(
                    f["tick"],
                    fmt_snes(*f["table"]) if f["table"] else "(no table)",
                    "hidden" if f["index"] is None else f["index"],
                    fmt_snes(FRAME_BANK, f["list"]) if f["list"] else "-"))
        print()
    print("{} bytes over 4 scripts".format(total))
    return 0


def cmd_verify(data, args):
    """Assert the only ground truth there is: the four object-type scripts."""
    failures = []
    total = 0
    tables = known_tables(args.tables)
    for kind, sbank, saddr in obj_type_scripts(data):
        ins = decode(data, sbank, saddr)
        n = script_length(ins)
        total += n
        if not ins or ins[-1]["op"] != HALT:
            failures.append("type {} at {} does not end on opcode $09".format(
                kind, fmt_snes(sbank, saddr)))
        for i in ins:
            if i["op"] != SET_FRAME_TABLE:
                continue
            t = (data[i["off"] + 3], u16(data, i["off"] + 1))
            if tables and t not in tables:
                failures.append(
                    "type {}: $1C operand {} is not in {}".format(
                        kind, fmt_snes(*t), args.tables))
        print("type {}: {} -> {} bytes, ends {}".format(
            kind, fmt_snes(sbank, saddr), n,
            "${:02X}".format(ins[-1]["op"]) if ins else "-"))
    # The four are contiguous: $87:99FE..$87:9A31 inclusive.
    if total != 52:
        failures.append("expected 52 bytes over the four scripts, got {}".format(total))
    starts = sorted(snes_to_file(b, a) for _, b, a in obj_type_scripts(data))
    lo = snes_to_file(*KNOWN_SCRIPTS)
    if starts[0] != lo:
        failures.append("lowest script is {}, expected {}".format(
            fmt_file(starts[0]), fmt_file(lo)))
    for f in failures:
        print("FAIL: {}".format(f), file=sys.stderr)
    print("{} bytes total, {} check(s) failed".format(total, len(failures)))
    return 1 if failures else 0


def find_script_start(data, bank, site_addr, back=BACKWALK):
    """Guess where the script containing the `$1C` at `site_addr` begins.

    Every byte in `[site - back, site]` that decodes cleanly onto the `$1C`
    and reaches a terminator is a candidate, and there are always several --
    the tail of the preceding script re-decodes into the next one. The four
    known scripts are packed back to back, each ending on `$09`, so a
    candidate whose preceding byte is a halt is preferred; that is what picks
    `$87:9A14` over `$87:9A0F`. Returns (addr, instructions) or (None, None).

    Still a guess: nothing in the ROM points at these starts.
    """
    candidates = []
    for start in range(max(0x8000, site_addr - back), site_addr + 1):
        ins = decode(data, bank, start)
        if not ins or not ins[-1]["terminator"]:
            continue
        if any(i.get("invalid") for i in ins):
            continue
        if not any(i["addr"] == site_addr for i in ins):
            continue
        candidates.append((start, ins))
    if not candidates:
        return (None, None)
    after_halt = [c for c in candidates
                  if c[0] > 0x8000
                  and data[snes_to_file(bank, c[0]) - 1] == HALT]
    return (after_halt or candidates)[0]


def cmd_scan(data, args):
    tables = known_tables(args.tables)
    if not tables:
        print("error: no tables in {}; run tools/frametabs.py first".format(
            args.tables), file=sys.stderr)
        return 1
    rows, seen = [], set()
    sites = unreadable = 0
    for off in range(len(data) - 4):
        if data[off] != SET_FRAME_TABLE:
            continue
        target = (data[off + 3], u16(data, off + 1))
        if target not in tables:
            continue
        sites += 1
        bank, addr = file_to_snes(off)
        start, ins = find_script_start(data, bank, addr, args.back)
        if start is None:
            unreadable += 1
            continue
        if (bank, start) in seen:
            continue
        seen.add((bank, start))
        known = any(start == a and bank == b
                    for _, b, a in obj_type_scripts(data))
        rows.append({
            "start": (bank, start), "site": (bank, addr), "table": target,
            "bytes": script_length(ins), "instructions": len(ins),
            "end": ins[-1]["op"],
            "confidence": "confirmed" if known else "unconfirmed",
        })
    path = os.path.join(args.out, "scripts.tsv")
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent)
    with open(path, "w") as f:
        f.write("script_addr\tscript_file\tbytes\tinstructions\tend_opcode"
                "\tset_frame_table_at\tframe_table\tconfidence\n")
        for r in sorted(rows, key=lambda r: r["start"]):
            f.write("\t".join([
                fmt_snes(*r["start"]),
                fmt_file(snes_to_file(*r["start"])),
                str(r["bytes"]), str(r["instructions"]),
                "${:02X}".format(r["end"]),
                fmt_snes(*r["site"]), fmt_snes(*r["table"]),
                r["confidence"]]) + "\n")
    good = sum(1 for r in rows if r["confidence"] == "confirmed")
    print("{} $1C sites name a table in {}; {} did not decode back to a "
          "script start, {} distinct starts left".format(
              sites, args.tables, unreadable, len(rows)))
    print("  {} confirmed (the tbl_obj_type_scripts four), {} unconfirmed"
          .format(good, len(rows) - good))
    print("wrote {}".format(path))
    return 0


def cmd_opcodes(data, args):
    """The opcode table itself, with the handler each entry dispatches to."""
    base = snes_to_file(*OPCODE_TABLE)
    print("tbl_anim_opcodes {} ({}), {} entries".format(
        fmt_snes(*OPCODE_TABLE), fmt_file(base), OPCODE_COUNT))
    for op in range(OPCODE_COUNT):
        target = u16(data, base + 2 * op)
        kind, name, note = OPCODES[op]
        size = KIND_SIZE.get(kind, "var")
        print("  ${:02X}  {:<20} {:>3} operand byte(s)  handler {}".format(
            op, name, size, fmt_snes(0x80, target)))
        if args.notes:
            print("        {}".format(note))
    wbase = snes_to_file(*WAIT_TABLE)
    print("\ntbl_anim_wait_actions {} ({}), 8 entries; opcode $70-$FF, "
          "wait = bits 0-3, action = bits 4-6".format(
              fmt_snes(*WAIT_TABLE), fmt_file(wbase)))
    for a in range(8):
        kind, name, note = WAIT_ACTIONS[a]
        ops = "$7N/$FN" if a == 7 else "${:X}N".format(8 + a)
        print("  {}  {:<20} {:>3} operand byte(s)  handler {}".format(
            ops, name, KIND_SIZE[kind], fmt_snes(0x80, u16(data, wbase + 2 * a))))
        if args.notes:
            print("        {}".format(note))
    return 0


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--script", help="disassemble the script at this address")
    ap.add_argument("--types", action="store_true",
                    help="disassemble the four tbl_obj_type_scripts scripts")
    ap.add_argument("--opcodes", action="store_true", help="dump the opcode table")
    ap.add_argument("--scan", action="store_true",
                    help="find further scripts from $1C operands")
    ap.add_argument("--verify", action="store_true",
                    help="assert the four known scripts decode as documented")
    ap.add_argument("--frames", action="store_true",
                    help="also print the frame sequence with tick counts")
    ap.add_argument("--notes", action="store_true",
                    help="print the handler note for each opcode")
    ap.add_argument("--tables", default=TABLES_TSV,
                    help="frametabs.py output, used to validate $1C operands")
    ap.add_argument("--back", type=int, default=BACKWALK,
                    help="how far --scan walks back looking for a start")
    ap.add_argument("--out", default="build/sprites")
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    if args.opcodes:
        return cmd_opcodes(data, args)
    if args.verify:
        return cmd_verify(data, args)
    if args.scan:
        return cmd_scan(data, args)
    if args.types:
        return cmd_types(data, args)
    if args.script:
        kind, value = parse_addr(args.script)
        bank, addr = value if kind == "snes" else file_to_snes(value)
        ins = print_script(data, bank, addr, None, args.notes)
        if args.frames:
            print()
            for f in frame_sequence(data, ins):
                print("  tick {:>3}: {} index {} -> {}".format(
                    f["tick"],
                    fmt_snes(*f["table"]) if f["table"] else "(no table)",
                    "hidden" if f["index"] is None else f["index"],
                    fmt_snes(FRAME_BANK, f["list"]) if f["list"] else "-"))
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
