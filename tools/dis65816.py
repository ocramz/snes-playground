#!/usr/bin/env python3
"""Minimal 65816 disassembler with M/X flag tracking.

Linear disassembly from a start address. Tracks REP/SEP so immediate operand
widths are right, and (by default) stops at the first unconditional control
transfer (RTS/RTL/RTI/JMP/JML/BRA/BRL) because bytes after that are as likely
to be data as code. Use --length to force a byte count, and --m8/--x8 /
--m16/--x16 to set the entry width when it is known.

    python3 tools/dis65816.py '$80:9F18'
    python3 tools/dis65816.py 0x002A30 --length 0x70 --m16 --x16
    python3 tools/dis65816.py '$80:8000' --follow    # keep going past JMP/RTS

Long-pointer operands are resolved to file offsets in the comment column when
they point into ROM. Nothing here is a byte-exact reassembler; it is a reading
aid.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import (  # noqa: E402
    AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file,
)
from romcheck import RomError, load_rom  # noqa: E402

# Addressing modes. The size column is the operand byte count; 'imm_m' and
# 'imm_x' depend on the M / X flags.
IMP = "imp"      # implied
ACC = "acc"      # accumulator
IMM8 = "imm8"    # always 8-bit immediate (SEP/REP/COP/BRK/WDM)
IMM_M = "imm_m"  # immediate, width follows M
IMM_X = "imm_x"  # immediate, width follows X
DP = "dp"
DPX = "dp,x"
DPY = "dp,y"
DPI = "(dp)"
DPIX = "(dp,x)"
DPIY = "(dp),y"
DPIL = "[dp]"
DPILY = "[dp],y"
ABS = "abs"
ABSX = "abs,x"
ABSY = "abs,y"
ABSI = "(abs)"
ABSIX = "(abs,x)"
ABSIL = "[abs]"
LONG = "long"
LONGX = "long,x"
SR = "sr,s"
SRIY = "(sr,s),y"
REL8 = "rel8"
REL16 = "rel16"
MOVE = "move"    # MVN/MVP: two bank bytes

OPERAND_SIZE = {
    IMP: 0, ACC: 0, IMM8: 1, IMM_M: None, IMM_X: None,
    DP: 1, DPX: 1, DPY: 1, DPI: 1, DPIX: 1, DPIY: 1, DPIL: 1, DPILY: 1,
    ABS: 2, ABSX: 2, ABSY: 2, ABSI: 2, ABSIX: 2, ABSIL: 2,
    LONG: 3, LONGX: 3, SR: 1, SRIY: 1, REL8: 1, REL16: 2, MOVE: 2,
}

# (mnemonic, mode) for every opcode. Built from the standard 65816 table; the
# layout follows the opcode matrix column by column so it can be checked
# against a reference without hunting.
OPCODES = {
    0x00: ("BRK", IMM8), 0x01: ("ORA", DPIX), 0x02: ("COP", IMM8), 0x03: ("ORA", SR),
    0x04: ("TSB", DP), 0x05: ("ORA", DP), 0x06: ("ASL", DP), 0x07: ("ORA", DPIL),
    0x08: ("PHP", IMP), 0x09: ("ORA", IMM_M), 0x0A: ("ASL", ACC), 0x0B: ("PHD", IMP),
    0x0C: ("TSB", ABS), 0x0D: ("ORA", ABS), 0x0E: ("ASL", ABS), 0x0F: ("ORA", LONG),
    0x10: ("BPL", REL8), 0x11: ("ORA", DPIY), 0x12: ("ORA", DPI), 0x13: ("ORA", SRIY),
    0x14: ("TRB", DP), 0x15: ("ORA", DPX), 0x16: ("ASL", DPX), 0x17: ("ORA", DPILY),
    0x18: ("CLC", IMP), 0x19: ("ORA", ABSY), 0x1A: ("INC", ACC), 0x1B: ("TCS", IMP),
    0x1C: ("TRB", ABS), 0x1D: ("ORA", ABSX), 0x1E: ("ASL", ABSX), 0x1F: ("ORA", LONGX),
    0x20: ("JSR", ABS), 0x21: ("AND", DPIX), 0x22: ("JSL", LONG), 0x23: ("AND", SR),
    0x24: ("BIT", DP), 0x25: ("AND", DP), 0x26: ("ROL", DP), 0x27: ("AND", DPIL),
    0x28: ("PLP", IMP), 0x29: ("AND", IMM_M), 0x2A: ("ROL", ACC), 0x2B: ("PLD", IMP),
    0x2C: ("BIT", ABS), 0x2D: ("AND", ABS), 0x2E: ("ROL", ABS), 0x2F: ("AND", LONG),
    0x30: ("BMI", REL8), 0x31: ("AND", DPIY), 0x32: ("AND", DPI), 0x33: ("AND", SRIY),
    0x34: ("BIT", DPX), 0x35: ("AND", DPX), 0x36: ("ROL", DPX), 0x37: ("AND", DPILY),
    0x38: ("SEC", IMP), 0x39: ("AND", ABSY), 0x3A: ("DEC", ACC), 0x3B: ("TSC", IMP),
    0x3C: ("BIT", ABSX), 0x3D: ("AND", ABSX), 0x3E: ("ROL", ABSX), 0x3F: ("AND", LONGX),
    0x40: ("RTI", IMP), 0x41: ("EOR", DPIX), 0x42: ("WDM", IMM8), 0x43: ("EOR", SR),
    0x44: ("MVP", MOVE), 0x45: ("EOR", DP), 0x46: ("LSR", DP), 0x47: ("EOR", DPIL),
    0x48: ("PHA", IMP), 0x49: ("EOR", IMM_M), 0x4A: ("LSR", ACC), 0x4B: ("PHK", IMP),
    0x4C: ("JMP", ABS), 0x4D: ("EOR", ABS), 0x4E: ("LSR", ABS), 0x4F: ("EOR", LONG),
    0x50: ("BVC", REL8), 0x51: ("EOR", DPIY), 0x52: ("EOR", DPI), 0x53: ("EOR", SRIY),
    0x54: ("MVN", MOVE), 0x55: ("EOR", DPX), 0x56: ("LSR", DPX), 0x57: ("EOR", DPILY),
    0x58: ("CLI", IMP), 0x59: ("EOR", ABSY), 0x5A: ("PHY", IMP), 0x5B: ("TCD", IMP),
    0x5C: ("JML", LONG), 0x5D: ("EOR", ABSX), 0x5E: ("LSR", ABSX), 0x5F: ("EOR", LONGX),
    0x60: ("RTS", IMP), 0x61: ("ADC", DPIX), 0x62: ("PER", REL16), 0x63: ("ADC", SR),
    0x64: ("STZ", DP), 0x65: ("ADC", DP), 0x66: ("ROR", DP), 0x67: ("ADC", DPIL),
    0x68: ("PLA", IMP), 0x69: ("ADC", IMM_M), 0x6A: ("ROR", ACC), 0x6B: ("RTL", IMP),
    0x6C: ("JMP", ABSI), 0x6D: ("ADC", ABS), 0x6E: ("ROR", ABS), 0x6F: ("ADC", LONG),
    0x70: ("BVS", REL8), 0x71: ("ADC", DPIY), 0x72: ("ADC", DPI), 0x73: ("ADC", SRIY),
    0x74: ("STZ", DPX), 0x75: ("ADC", DPX), 0x76: ("ROR", DPX), 0x77: ("ADC", DPILY),
    0x78: ("SEI", IMP), 0x79: ("ADC", ABSY), 0x7A: ("PLY", IMP), 0x7B: ("TDC", IMP),
    0x7C: ("JMP", ABSIX), 0x7D: ("ADC", ABSX), 0x7E: ("ROR", ABSX), 0x7F: ("ADC", LONGX),
    0x80: ("BRA", REL8), 0x81: ("STA", DPIX), 0x82: ("BRL", REL16), 0x83: ("STA", SR),
    0x84: ("STY", DP), 0x85: ("STA", DP), 0x86: ("STX", DP), 0x87: ("STA", DPIL),
    0x88: ("DEY", IMP), 0x89: ("BIT", IMM_M), 0x8A: ("TXA", IMP), 0x8B: ("PHB", IMP),
    0x8C: ("STY", ABS), 0x8D: ("STA", ABS), 0x8E: ("STX", ABS), 0x8F: ("STA", LONG),
    0x90: ("BCC", REL8), 0x91: ("STA", DPIY), 0x92: ("STA", DPI), 0x93: ("STA", SRIY),
    0x94: ("STY", DPX), 0x95: ("STA", DPX), 0x96: ("STX", DPY), 0x97: ("STA", DPILY),
    0x98: ("TYA", IMP), 0x99: ("STA", ABSY), 0x9A: ("TXS", IMP), 0x9B: ("TXY", IMP),
    0x9C: ("STZ", ABS), 0x9D: ("STA", ABSX), 0x9E: ("STZ", ABSX), 0x9F: ("STA", LONGX),
    0xA0: ("LDY", IMM_X), 0xA1: ("LDA", DPIX), 0xA2: ("LDX", IMM_X), 0xA3: ("LDA", SR),
    0xA4: ("LDY", DP), 0xA5: ("LDA", DP), 0xA6: ("LDX", DP), 0xA7: ("LDA", DPIL),
    0xA8: ("TAY", IMP), 0xA9: ("LDA", IMM_M), 0xAA: ("TAX", IMP), 0xAB: ("PLB", IMP),
    0xAC: ("LDY", ABS), 0xAD: ("LDA", ABS), 0xAE: ("LDX", ABS), 0xAF: ("LDA", LONG),
    0xB0: ("BCS", REL8), 0xB1: ("LDA", DPIY), 0xB2: ("LDA", DPI), 0xB3: ("LDA", SRIY),
    0xB4: ("LDY", DPX), 0xB5: ("LDA", DPX), 0xB6: ("LDX", DPY), 0xB7: ("LDA", DPILY),
    0xB8: ("CLV", IMP), 0xB9: ("LDA", ABSY), 0xBA: ("TSX", IMP), 0xBB: ("TYX", IMP),
    0xBC: ("LDY", ABSX), 0xBD: ("LDA", ABSX), 0xBE: ("LDX", ABSY), 0xBF: ("LDA", LONGX),
    0xC0: ("CPY", IMM_X), 0xC1: ("CMP", DPIX), 0xC2: ("REP", IMM8), 0xC3: ("CMP", SR),
    0xC4: ("CPY", DP), 0xC5: ("CMP", DP), 0xC6: ("DEC", DP), 0xC7: ("CMP", DPIL),
    0xC8: ("INY", IMP), 0xC9: ("CMP", IMM_M), 0xCA: ("DEX", IMP), 0xCB: ("WAI", IMP),
    0xCC: ("CPY", ABS), 0xCD: ("CMP", ABS), 0xCE: ("DEC", ABS), 0xCF: ("CMP", LONG),
    0xD0: ("BNE", REL8), 0xD1: ("CMP", DPIY), 0xD2: ("CMP", DPI), 0xD3: ("CMP", SRIY),
    0xD4: ("PEI", DPI), 0xD5: ("CMP", DPX), 0xD6: ("DEC", DPX), 0xD7: ("CMP", DPILY),
    0xD8: ("CLD", IMP), 0xD9: ("CMP", ABSY), 0xDA: ("PHX", IMP), 0xDB: ("STP", IMP),
    0xDC: ("JML", ABSIL), 0xDD: ("CMP", ABSX), 0xDE: ("DEC", ABSX), 0xDF: ("CMP", LONGX),
    0xE0: ("CPX", IMM_X), 0xE1: ("SBC", DPIX), 0xE2: ("SEP", IMM8), 0xE3: ("SBC", SR),
    0xE4: ("CPX", DP), 0xE5: ("SBC", DP), 0xE6: ("INC", DP), 0xE7: ("SBC", DPIL),
    0xE8: ("INX", IMP), 0xE9: ("SBC", IMM_M), 0xEA: ("NOP", IMP), 0xEB: ("XBA", IMP),
    0xEC: ("CPX", ABS), 0xED: ("SBC", ABS), 0xEE: ("INC", ABS), 0xEF: ("SBC", LONG),
    0xF0: ("BEQ", REL8), 0xF1: ("SBC", DPIY), 0xF2: ("SBC", DPI), 0xF3: ("SBC", SRIY),
    0xF4: ("PEA", ABS), 0xF5: ("SBC", DPX), 0xF6: ("INC", DPX), 0xF7: ("SBC", DPILY),
    0xF8: ("SED", IMP), 0xF9: ("SBC", ABSY), 0xFA: ("PLX", IMP), 0xFB: ("XCE", IMP),
    0xFC: ("JSR", ABSIX), 0xFD: ("SBC", ABSX), 0xFE: ("INC", ABSX), 0xFF: ("SBC", LONGX),
}

TERMINATORS = {"RTS", "RTL", "RTI", "JMP", "JML", "BRA", "BRL", "STP"}


class Insn(object):
    __slots__ = ("offset", "bank", "addr", "raw", "mnemonic", "mode", "operand",
                 "m8", "x8", "text", "comment", "target")

    def __init__(self):
        self.comment = ""
        self.target = None


def decode(data, offset, m8, x8, bank=None):
    """Decode one instruction at file offset. Returns (Insn, new_m8, new_x8).

    `bank` is the program bank for absolute JMP/JSR target annotation; it
    defaults to the FastROM bank that contains `offset`.
    """
    op = data[offset]
    mnem, mode = OPCODES[op]
    size = OPERAND_SIZE[mode]
    if size is None:
        flag = m8 if mode == IMM_M else x8
        size = 1 if flag else 2
    raw = data[offset:offset + 1 + size]
    operand = int.from_bytes(raw[1:], "little") if size else None

    ins = Insn()
    ins.offset = offset
    ins.bank, ins.addr = file_to_snes(offset)
    if bank is not None:
        ins.bank = bank
    ins.raw = raw
    ins.mnemonic = mnem
    ins.mode = mode
    ins.operand = operand
    ins.m8, ins.x8 = m8, x8
    ins.text = _format(ins, size)

    # Flag tracking. PLP / RTI change flags unpredictably; leave them alone.
    if mnem == "SEP":
        m8 = m8 or bool(operand & 0x20)
        x8 = x8 or bool(operand & 0x10)
    elif mnem == "REP":
        m8 = m8 and not (operand & 0x20)
        x8 = x8 and not (operand & 0x10)
    return ins, m8, x8


def _format(ins, size):
    mode, v = ins.mode, ins.operand
    m = ins.mnemonic
    if mode in (IMP,):
        return m
    if mode == ACC:
        return m + " A"
    if mode == IMM8:
        return "{} #${:02X}".format(m, v)
    if mode in (IMM_M, IMM_X):
        return "{} #${:0{}X}".format(m, v, size * 2)
    if mode == DP:
        return "{} ${:02X}".format(m, v)
    if mode == DPX:
        return "{} ${:02X},X".format(m, v)
    if mode == DPY:
        return "{} ${:02X},Y".format(m, v)
    if mode == DPI:
        return "{} (${:02X})".format(m, v)
    if mode == DPIX:
        return "{} (${:02X},X)".format(m, v)
    if mode == DPIY:
        return "{} (${:02X}),Y".format(m, v)
    if mode == DPIL:
        return "{} [${:02X}]".format(m, v)
    if mode == DPILY:
        return "{} [${:02X}],Y".format(m, v)
    if mode == ABS:
        if m in ("JMP", "JSR"):
            ins.target = (ins.bank, v)
        return "{} ${:04X}".format(m, v)
    if mode == ABSX:
        return "{} ${:04X},X".format(m, v)
    if mode == ABSY:
        return "{} ${:04X},Y".format(m, v)
    if mode == ABSI:
        return "{} (${:04X})".format(m, v)
    if mode == ABSIX:
        return "{} (${:04X},X)".format(m, v)
    if mode == ABSIL:
        return "{} [${:04X}]".format(m, v)
    if mode == LONG:
        bank, addr = v >> 16, v & 0xFFFF
        if m in ("JSL", "JML"):
            ins.target = (bank, addr)
        return "{} ${:02X}:{:04X}".format(m, bank, addr)
    if mode == LONGX:
        return "{} ${:02X}:{:04X},X".format(m, v >> 16, v & 0xFFFF)
    if mode == SR:
        return "{} ${:02X},S".format(m, v)
    if mode == SRIY:
        return "{} (${:02X},S),Y".format(m, v)
    if mode == REL8:
        disp = v - 0x100 if v & 0x80 else v
        target = (ins.addr + 2 + disp) & 0xFFFF
        ins.target = (ins.bank, target)
        return "{} ${:04X}".format(m, target)
    if mode == REL16:
        disp = v - 0x10000 if v & 0x8000 else v
        target = (ins.addr + 3 + disp) & 0xFFFF
        ins.target = (ins.bank, target)
        return "{} ${:04X}".format(m, target)
    if mode == MOVE:
        # Operand order in the encoding is dest bank, source bank; the
        # conventional listing is MVN src,dst.
        return "{} ${:02X},${:02X}".format(m, v & 0xFF, v >> 8)
    raise AssertionError(mode)


def disassemble(data, offset, m8=False, x8=False, length=None, follow=False,
                max_insns=100000):
    """Yield Insn objects. Stops at the first terminator unless follow or a
    fixed length is given."""
    end = len(data) if length is None else min(len(data), offset + length)
    count = 0
    while offset < end and count < max_insns:
        ins, m8, x8 = decode(data, offset, m8, x8)
        if ins.mode == LONG and ins.mnemonic not in ("JSL", "JML"):
            _annotate_long(ins)
        elif ins.target and ins.mnemonic in ("JSL", "JML"):
            _annotate_long(ins, ins.target)
        yield ins
        offset += len(ins.raw)
        count += 1
        if length is None and not follow and ins.mnemonic in TERMINATORS:
            return


def _annotate_long(ins, target=None):
    if target is None:
        target = (ins.operand >> 16, ins.operand & 0xFFFF)
    bank, addr = target
    try:
        ins.comment = "file " + fmt_file(snes_to_file(bank, addr))
    except AddressError:
        ins.comment = "not ROM"


def render(ins):
    flags = "{}{}".format("m" if ins.m8 else "M", "x" if ins.x8 else "X")
    raw = " ".join("{:02X}".format(b) for b in ins.raw)
    line = "{}  {}  {}  {:<12} {:<24}".format(
        fmt_file(ins.offset), fmt_snes(ins.bank, ins.addr), flags, raw, ins.text)
    if ins.comment:
        line += " ; " + ins.comment
    return line.rstrip()


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("address", help="'$80:9F18' or 0x001F18")
    ap.add_argument("--length", help="disassemble exactly this many bytes")
    ap.add_argument("--follow", action="store_true",
                    help="continue past RTS/RTL/JMP/BRA (up to --max)")
    ap.add_argument("--max", type=int, default=400, help="max instructions")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--m8", action="store_true", help="entry with 8-bit A (default)")
    g.add_argument("--m16", action="store_true", help="entry with 16-bit A")
    g2 = ap.add_mutually_exclusive_group()
    g2.add_argument("--x8", action="store_true", help="entry with 8-bit X/Y (default)")
    g2.add_argument("--x16", action="store_true", help="entry with 16-bit X/Y")
    args = ap.parse_args()

    try:
        data = load_rom()
        kind, value = parse_addr(args.address)
        offset = snes_to_file(*value) if kind == "snes" else value
    except (RomError, AddressError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    length = None
    if args.length:
        length = int(args.length, 0)
    m8 = not args.m16
    x8 = not args.x16
    for ins in disassemble(data, offset, m8, x8, length, args.follow, args.max):
        print(render(ins))
    return 0


if __name__ == "__main__":
    sys.exit(main())
