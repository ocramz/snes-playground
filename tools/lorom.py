#!/usr/bin/env python3
"""LoROM address conversion.

The single most error-prone operation in this project. Every conversion goes
through here rather than being re-derived by hand; see CLAUDE.md for the
formulas and the reasoning behind the preconditions.

Assumes a headerless LoROM image (file offset == ROM offset, no +0x200 copier
skew). romcheck.py enforces that assumption against the actual ROM.
"""

import re
import sys

BANK_SIZE = 0x8000  # LoROM exposes 32 KB per bank, at $8000-$FFFF


class AddressError(ValueError):
    """A malformed or non-ROM address. Never silently corrected."""


def snes_to_file(bank, addr):
    """Convert a SNES bank:addr to a file offset.

    Rejects addresses below $8000: in LoROM the lower half of a bank is WRAM
    mirror / I/O / SRAM, not ROM. Masking such an address would invent a
    plausible-looking offset for a location that does not exist in the file.
    """
    if not 0x00 <= bank <= 0xFF:
        raise AddressError("bank ${:02X} out of range".format(bank))
    if not 0x0000 <= addr <= 0xFFFF:
        raise AddressError("address ${:04X} out of range".format(addr))
    if addr < 0x8000:
        raise AddressError(
            "${:02X}:{:04X} is not ROM: LoROM banks map ROM only at "
            "$8000-$FFFF (below that is WRAM mirror / I/O / SRAM)".format(bank, addr)
        )
    return ((bank & 0x7F) * BANK_SIZE) + (addr - 0x8000)


def file_to_snes(offset, size=None):
    """Convert a file offset to canonical FastROM ($80+) bank:addr.

    The low-bank alias is the same byte: bank & 0x7F.
    """
    if offset < 0:
        raise AddressError("negative file offset {}".format(offset))
    if size is not None and offset >= size:
        raise AddressError(
            "file offset 0x{:06X} is past end of ROM (0x{:06X} bytes)".format(offset, size)
        )
    bank = (offset // BANK_SIZE) | 0x80
    if bank > 0xFF:
        raise AddressError("file offset 0x{:X} exceeds LoROM address space".format(offset))
    addr = (offset % BANK_SIZE) + 0x8000
    return bank, addr


def fmt_snes(bank, addr):
    return "${:02X}:{:04X}".format(bank, addr)


def fmt_file(offset):
    return "0x{:06X}".format(offset)


_SNES_RE = re.compile(r"^\$?([0-9A-Fa-f]{1,2}):([0-9A-Fa-f]{1,4})$")


def parse_addr(text):
    """Parse either address form, returning ('snes', (bank, addr)) or
    ('file', offset).

    Accepted: '$95:8000', '95:8000', '0x0A8000', '0A8000h', '688128'.
    """
    text = text.strip()
    m = _SNES_RE.match(text)
    if m:
        return "snes", (int(m.group(1), 16), int(m.group(2), 16))
    if text.lower().startswith("0x"):
        return "file", int(text, 16)
    if text.lower().endswith("h"):
        return "file", int(text[:-1], 16)
    if text.isdigit():
        return "file", int(text)
    raise AddressError(
        "cannot parse {!r}: use '$95:8000' for SNES or '0x0A8000' for a file "
        "offset".format(text)
    )


# Every example here is also printed in CLAUDE.md's worked-examples table.
# Keeping them in one asserted list is what stops the docs and the code from
# drifting apart.
WORKED_EXAMPLES = [
    (0x80, 0x8000, 0x000000, "init code, STZ $4200"),
    (0x00, 0x8000, 0x000000, "low-bank alias of the same byte"),
    (0x00, 0xFFC0, 0x007FC0, "cart header, 'Kirby's Dream Co...'"),
    (0x00, 0xFF00, 0x007F00, "emulation RESET target"),
    (0x95, 0x8000, 0x0A8000, "start of the dense data banks"),
    (0x9B, 0xFFFF, 0x0DFFFF, "end of them"),
]


def selftest():
    failures = []

    for bank, addr, expected, what in WORKED_EXAMPLES:
        got = snes_to_file(bank, addr)
        if got != expected:
            failures.append(
                "{} -> {}, expected {} ({})".format(
                    fmt_snes(bank, addr), fmt_file(got), fmt_file(expected), what
                )
            )

    # Reverse direction always yields the canonical $80+ form, so only the
    # FastROM examples round-trip identically.
    for bank, addr, offset, what in WORKED_EXAMPLES:
        if bank < 0x80:
            continue
        got_bank, got_addr = file_to_snes(offset)
        if (got_bank, got_addr) != (bank, addr):
            failures.append(
                "{} -> {}, expected {} ({})".format(
                    fmt_file(offset), fmt_snes(got_bank, got_addr), fmt_snes(bank, addr), what
                )
            )

    # Low-bank input must map to the same byte as its FastROM mirror.
    if snes_to_file(0x15, 0x8000) != snes_to_file(0x95, 0x8000):
        failures.append("$15:8000 and $95:8000 must be the same byte")

    # Addresses that must be REJECTED, not coerced into a number.
    for bank, addr in [(0x85, 0x1234), (0x00, 0x0000), (0x80, 0x7FFF)]:
        try:
            got = snes_to_file(bank, addr)
        except AddressError:
            pass
        else:
            failures.append(
                "{} should have been rejected, returned {}".format(
                    fmt_snes(bank, addr), fmt_file(got)
                )
            )

    for text in ["$95:8000", "0x0A8000", "688128"]:
        parse_addr(text)  # raises on failure

    if failures:
        for f in failures:
            print("FAIL: " + f, file=sys.stderr)
        print("\n{} check(s) failed".format(len(failures)), file=sys.stderr)
        return 1

    print("ok: {} worked examples, both directions, plus rejection cases".format(
        len(WORKED_EXAMPLES)))
    return 0


def main(argv):
    args = argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__.strip())
        print("\nusage: lorom.py '$95:8000' | lorom.py 0x0A8000 | lorom.py --selftest")
        return 0 if args else 2
    if args[0] == "--selftest":
        return selftest()

    status = 0
    for text in args:
        try:
            kind, value = parse_addr(text)
            if kind == "snes":
                bank, addr = value
                offset = snes_to_file(bank, addr)
                print("{}  ->  {}".format(fmt_snes(bank, addr), fmt_file(offset)))
            else:
                bank, addr = file_to_snes(value)
                alias = bank & 0x7F
                print("{}  ->  {}  (alias {})".format(
                    fmt_file(value), fmt_snes(bank, addr), fmt_snes(alias, addr)))
        except AddressError as e:
            print("error: {}".format(e), file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
