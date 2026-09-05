#!/usr/bin/env python3
"""SPC700 disassembler, for reading the N-SPC sound driver.

Operates on a raw driver image plus its load address (the IPL upload table
at $80:AA99 says the game's driver is 0x0A0B bytes loaded at SPC $0800),
or on a full 64 KB RAM image.

    python3 tools/dis_spc700.py build/spc/driver_0800.bin --base 0x0800
    python3 tools/dis_spc700.py build/spc/driver_0800.bin --base 0x0800 --start 0x0800 --count 80
    python3 tools/dis_spc700.py build/spc/ram.bin --start 0x0800 --stop-at-ret

Operand byte order follows the hardware: for two-operand forms the bytes
are stored in reverse of the assembler syntax (MOV d,#i is [8F ii dd]),
except that a relative branch offset always comes last (CBNE d,r is
[2E dd rr]).
"""

import argparse
import sys

# Mnemonic and operand syntax per opcode. Placeholders: d, !a, #i, r, u,
# m.b, (X), (Y), (X)+, [d]+Y, [d+X], d+X, d+Y, !a+X, !a+Y, dd,ds, d.N.
OPS = [
    "NOP", "TCALL 0", "SET1 d.0", "BBS d.0,r", "OR A,d", "OR A,!a", "OR A,(X)", "OR A,[d+X]",
    "OR A,#i", "OR dd,ds", "OR1 C,m.b", "ASL d", "ASL !a", "PUSH PSW", "TSET1 !a", "BRK",
    "BPL r", "TCALL 1", "CLR1 d.0", "BBC d.0,r", "OR A,d+X", "OR A,!a+X", "OR A,!a+Y", "OR A,[d]+Y",
    "OR d,#i", "OR (X),(Y)", "DECW d", "ASL d+X", "ASL A", "DEC X", "CMP X,!a", "JMP [!a+X]",
    "CLRP", "TCALL 2", "SET1 d.1", "BBS d.1,r", "AND A,d", "AND A,!a", "AND A,(X)", "AND A,[d+X]",
    "AND A,#i", "AND dd,ds", "OR1 C,/m.b", "ROL d", "ROL !a", "PUSH A", "CBNE d,r", "BRA r",
    "BMI r", "TCALL 3", "CLR1 d.1", "BBC d.1,r", "AND A,d+X", "AND A,!a+X", "AND A,!a+Y", "AND A,[d]+Y",
    "AND d,#i", "AND (X),(Y)", "INCW d", "ROL d+X", "ROL A", "INC X", "CMP X,d", "CALL !a",
    "SETP", "TCALL 4", "SET1 d.2", "BBS d.2,r", "EOR A,d", "EOR A,!a", "EOR A,(X)", "EOR A,[d+X]",
    "EOR A,#i", "EOR dd,ds", "AND1 C,m.b", "LSR d", "LSR !a", "PUSH X", "TCLR1 !a", "PCALL u",
    "BVC r", "TCALL 5", "CLR1 d.2", "BBC d.2,r", "EOR A,d+X", "EOR A,!a+X", "EOR A,!a+Y", "EOR A,[d]+Y",
    "EOR d,#i", "EOR (X),(Y)", "CMPW YA,d", "LSR d+X", "LSR A", "MOV X,A", "CMP Y,!a", "JMP !a",
    "CLRC", "TCALL 6", "SET1 d.3", "BBS d.3,r", "CMP A,d", "CMP A,!a", "CMP A,(X)", "CMP A,[d+X]",
    "CMP A,#i", "CMP dd,ds", "AND1 C,/m.b", "ROR d", "ROR !a", "PUSH Y", "DBNZ d,r", "RET",
    "BVS r", "TCALL 7", "CLR1 d.3", "BBC d.3,r", "CMP A,d+X", "CMP A,!a+X", "CMP A,!a+Y", "CMP A,[d]+Y",
    "CMP d,#i", "CMP (X),(Y)", "ADDW YA,d", "ROR d+X", "ROR A", "MOV A,X", "CMP Y,d", "RETI",
    "SETC", "TCALL 8", "SET1 d.4", "BBS d.4,r", "ADC A,d", "ADC A,!a", "ADC A,(X)", "ADC A,[d+X]",
    "ADC A,#i", "ADC dd,ds", "EOR1 C,m.b", "DEC d", "DEC !a", "MOV Y,#i", "POP PSW", "MOV d,#i",
    "BCC r", "TCALL 9", "CLR1 d.4", "BBC d.4,r", "ADC A,d+X", "ADC A,!a+X", "ADC A,!a+Y", "ADC A,[d]+Y",
    "ADC d,#i", "ADC (X),(Y)", "SUBW YA,d", "DEC d+X", "DEC A", "MOV X,SP", "DIV YA,X", "XCN A",
    "EI", "TCALL 10", "SET1 d.5", "BBS d.5,r", "SBC A,d", "SBC A,!a", "SBC A,(X)", "SBC A,[d+X]",
    "SBC A,#i", "SBC dd,ds", "MOV1 C,m.b", "INC d", "INC !a", "CMP Y,#i", "POP A", "MOV (X)+,A",
    "BCS r", "TCALL 11", "CLR1 d.5", "BBC d.5,r", "SBC A,d+X", "SBC A,!a+X", "SBC A,!a+Y", "SBC A,[d]+Y",
    "SBC d,#i", "SBC (X),(Y)", "MOVW YA,d", "INC d+X", "INC A", "MOV SP,X", "DAS A", "MOV A,(X)+",
    "DI", "TCALL 12", "SET1 d.6", "BBS d.6,r", "MOV d,A", "MOV !a,A", "MOV (X),A", "MOV [d+X],A",
    "CMP X,#i", "MOV !a,X", "MOV1 m.b,C", "MOV d,Y", "MOV !a,Y", "MOV X,#i", "POP X", "MUL YA",
    "BNE r", "TCALL 13", "CLR1 d.6", "BBC d.6,r", "MOV d+X,A", "MOV !a+X,A", "MOV !a+Y,A", "MOV [d]+Y,A",
    "MOV d,X", "MOV d+Y,X", "MOVW d,YA", "MOV d+X,Y", "DEC Y", "MOV A,Y", "CBNE d+X,r", "DAA A",
    "CLRV", "TCALL 14", "SET1 d.7", "BBS d.7,r", "MOV A,d", "MOV A,!a", "MOV A,(X)", "MOV A,[d+X]",
    "MOV A,#i", "MOV X,!a", "NOT1 m.b", "MOV Y,d", "MOV Y,!a", "NOTC", "POP Y", "SLEEP",
    "BEQ r", "TCALL 15", "CLR1 d.7", "BBC d.7,r", "MOV A,d+X", "MOV A,!a+X", "MOV A,!a+Y", "MOV A,[d]+Y",
    "MOV X,d", "MOV X,d+Y", "MOV dd,ds", "MOV Y,d+X", "INC Y", "MOV Y,A", "DBNZ Y,r", "STOP",
]
assert len(OPS) == 256

# Which placeholder tokens consume bytes, and how many.
_TOKENS = [("dd,ds", 2), ("!a", 2), ("m.b", 2), ("#i", 1), ("u", 1), ("r", 1), ("d", 1)]

FLOW_END = {"RET", "RETI", "JMP", "BRA", "STOP", "SLEEP"}


def _operand_layout(syntax):
    """Return the list of (token, size) in BYTE order for an operand string."""
    parts = syntax.split(" ", 1)
    if len(parts) == 1:
        return []
    ops = parts[1]
    found = []
    if "dd,ds" in ops:
        found.append(("dd,ds", 2))
    else:
        # Scan operands left to right for tokens that carry bytes.
        for operand in ops.split(","):
            if "m.b" in operand:
                found.append(("m.b", 2))
            elif "!a" in operand:
                found.append(("!a", 2))
            elif "#i" in operand:
                found.append(("#i", 1))
            elif operand == "u":
                found.append(("u", 1))
            elif operand == "r":
                found.append(("r", 1))
            elif "d" in operand and operand not in ("A", "X", "Y", "YA", "SP", "PSW", "C"):
                found.append(("d", 1))
    # Hardware order: reverse of syntax, relative offset last.
    rel = [t for t in found if t[0] == "r"]
    rest = [t for t in found if t[0] != "r"]
    return list(reversed(rest)) + rel


LAYOUT = [_operand_layout(s) for s in OPS]


def decode(mem, pc):
    """Decode at address pc in a 64 KB-addressed buffer. Returns
    (length, text, target_or_None)."""
    op = mem[pc]
    syntax = OPS[op]
    layout = LAYOUT[op]
    size = 1 + sum(n for _, n in layout)
    raw = mem[pc:pc + size]
    if len(raw) < size:
        return len(raw), ".db " + " ".join("${:02X}".format(b) for b in raw), None
    vals = {}
    i = 1
    for tok, n in layout:
        vals[tok] = int.from_bytes(raw[i:i + n], "little")
        i += n
    text = syntax
    target = None
    if "dd,ds" in vals:
        v = vals["dd,ds"]
        text = text.replace("dd,ds", "${:02X},${:02X}".format(v >> 8, v & 0xFF))
    if "m.b" in vals:
        v = vals["m.b"]
        text = text.replace("m.b", "${:04X}.{}".format(v & 0x1FFF, v >> 13))
    if "!a" in vals:
        text = text.replace("!a", "${:04X}".format(vals["!a"]))
        if syntax.startswith(("CALL", "JMP !a")):
            target = vals["!a"]
    if "#i" in vals:
        text = text.replace("#i", "#${:02X}".format(vals["#i"]))
    if "u" in vals:
        target = 0xFF00 | vals["u"]
        text = text.replace(" u", " ${:04X}".format(target))
    if "d" in vals:
        # Replace the bare 'd' token (not the 'd' in dd,ds or other words).
        text = _replace_d(text, "${:02X}".format(vals["d"]))
    if "r" in vals:
        disp = vals["r"] - 0x100 if vals["r"] & 0x80 else vals["r"]
        target = (pc + size + disp) & 0xFFFF
        text = _replace_token(text, "r", "${:04X}".format(target))
    return size, text, target


def _replace_d(text, repl):
    out = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == "d" and (i == 0 or not text[i - 1].isalnum()) and \
                (i + 1 == len(text) or not text[i + 1].isalnum()):
            out.append(repl)
        else:
            out.append(c)
        i += 1
    return "".join(out)


def _replace_token(text, tok, repl):
    parts = text.split(",")
    parts = [repl if p.strip() == tok else p for p in parts]
    return ",".join(parts)


def disassemble(mem, start, count=None, end=None, stop_at_ret=False):
    pc = start
    n = 0
    while pc < 0x10000 and (count is None or n < count) and (end is None or pc < end):
        size, text, target = decode(mem, pc)
        raw = " ".join("{:02X}".format(b) for b in mem[pc:pc + size])
        yield pc, raw, text, target
        mnem = text.split(" ")[0]
        pc += size
        n += 1
        if stop_at_ret and mnem in FLOW_END:
            return


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", help="driver image or 64 KB RAM dump")
    ap.add_argument("--base", default="0", help="SPC address of the file's first byte")
    ap.add_argument("--start", help="first address to disassemble (default: base)")
    ap.add_argument("--end", help="stop before this address")
    ap.add_argument("--count", type=int, help="max instructions")
    ap.add_argument("--stop-at-ret", action="store_true")
    args = ap.parse_args()

    with open(args.image, "rb") as f:
        buf = f.read()
    base = int(args.base, 0)
    mem = bytes(base) + buf
    mem = mem + bytes(max(0, 0x10000 - len(mem)))
    start = int(args.start, 0) if args.start else base
    end = int(args.end, 0) if args.end else base + len(buf)
    for pc, raw, text, target in disassemble(mem, start, args.count, end, args.stop_at_ret):
        print("{:04X}  {:<12} {}".format(pc, raw, text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
