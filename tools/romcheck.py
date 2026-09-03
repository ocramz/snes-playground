#!/usr/bin/env python3
"""Verify the subject ROM and decode its cartridge header.

Other tools import load_rom() from here, so integrity is checked on every run
rather than being a step someone remembers to do. If the ROM does not match,
every offset recorded in docs/ and symbols.tsv is meaningless — so this exits
nonzero and refuses to hand out the bytes.

Override the path with the KDC_ROM environment variable.
"""

import hashlib
import os
import sys

DEFAULT_ROM = (
    "/Users/marco/Downloads/Kirby's Dream Course (USA)/"
    "Kirby's Dream Course (USA).sfc"
)

EXPECTED_SIZE = 1048576
EXPECTED_SHA1 = "e1f29ad02981ec84156b68d4fb95b2182dc8cd82"
EXPECTED_MD5 = "3f2ee922cd23c9c211777be1d26ea2a8"

# LoROM: the header sits at the top of bank 0's 32 KB window.
HEADER = 0x7FC0
EXT_HEADER = 0x7FB0
HIROM_HEADER = 0xFFC0

MAP_MODES = {
    0x20: "LoROM, SlowROM",
    0x21: "HiROM, SlowROM",
    0x30: "LoROM, FastROM",
    0x31: "HiROM, FastROM",
    0x32: "ExLoROM",
    0x35: "ExHiROM",
}

CART_TYPES = {
    0x00: "ROM only",
    0x01: "ROM + RAM",
    0x02: "ROM + RAM + battery",
}

REGIONS = {
    0x00: "Japan",
    0x01: "North America",
    0x02: "Europe",
}


class RomError(Exception):
    pass


def rom_path():
    return os.environ.get("KDC_ROM", DEFAULT_ROM)


def load_rom(verify=True):
    """Read the ROM into memory, verifying it unless explicitly told not to.

    Returns the raw bytes. Callers must treat them as read-only; nothing in
    this repo ever writes back to the ROM file.
    """
    path = rom_path()
    if not os.path.exists(path):
        raise RomError(
            "ROM not found at {}\nSet KDC_ROM to its location.".format(path)
        )
    with open(path, "rb") as f:
        data = f.read()

    if verify:
        if len(data) % 1024 == 512:
            raise RomError(
                "ROM has a 512-byte copier header ({} bytes). Every offset in "
                "this repo assumes a headerless image; strip it or adjust by "
                "0x200 deliberately.".format(len(data))
            )
        if len(data) != EXPECTED_SIZE:
            raise RomError(
                "size is {} bytes, expected {}".format(len(data), EXPECTED_SIZE)
            )
        got = hashlib.sha1(data).hexdigest()
        if got != EXPECTED_SHA1:
            raise RomError(
                "SHA-1 mismatch.\n  got      {}\n  expected {}\n"
                "This is a different dump or a modified ROM; recorded offsets "
                "do not apply. Do not adjust offsets to compensate.".format(
                    got, EXPECTED_SHA1)
            )
    return data


def _text(data, offset, length):
    raw = data[offset:offset + length]
    return "".join(chr(b) if 0x20 <= b < 0x7F else "." for b in raw)


def describe(data):
    """Decode and print the cartridge header. Returns a list of problems."""
    problems = []

    hirom_region = data[HIROM_HEADER:HIROM_HEADER + 32]
    is_lorom = hirom_region == b"\xff" * 32

    title = _text(data, HEADER, 21)
    map_mode = data[HEADER + 0x15]
    cart_type = data[HEADER + 0x16]
    rom_size = data[HEADER + 0x17]
    ram_size = data[HEADER + 0x18]
    region = data[HEADER + 0x19]
    fixed = data[HEADER + 0x1A]
    version = data[HEADER + 0x1B]
    complement = int.from_bytes(data[HEADER + 0x1C:HEADER + 0x1E], "little")
    checksum = int.from_bytes(data[HEADER + 0x1E:HEADER + 0x20], "little")

    print("ROM:     {}".format(rom_path()))
    print("Size:    {} bytes ({} KB)".format(len(data), len(data) // 1024))
    print("SHA-1:   {}".format(hashlib.sha1(data).hexdigest()))
    print("MD5:     {}".format(hashlib.md5(data).hexdigest()))
    print()
    print("Maker:       {!r}".format(_text(data, EXT_HEADER, 2)))
    print("Game code:   {!r}".format(_text(data, EXT_HEADER + 2, 4)))
    print("Title:       {!r}".format(title))
    print("Map mode:    0x{:02X}  {}".format(
        map_mode, MAP_MODES.get(map_mode, "unknown")))
    print("Cart type:   0x{:02X}  {}".format(
        cart_type, CART_TYPES.get(cart_type, "unknown / coprocessor")))
    print("ROM size:    0x{:02X}  {} KB".format(rom_size, 1 << rom_size))
    print("SRAM size:   0x{:02X}  {}".format(
        ram_size, "{} KB".format(1 << ram_size) if ram_size else "none"))
    print("Region:      0x{:02X}  {}".format(
        region, REGIONS.get(region, "other")))
    print("Version:     1.{}".format(version))
    print("Checksum:    0x{:04X}  complement 0x{:04X}  xor 0x{:04X}".format(
        checksum, complement, checksum ^ complement))
    print("Mapping:     {}".format(
        "LoROM (HiROM header slot is unmapped 0xFF)" if is_lorom
        else "NOT plainly LoROM — HiROM header slot is populated"))
    print()

    # Print the whole table. Unused vectors are $FFFF, and picking out only a
    # few invites reading the padding at the wrong alignment.
    def vec(offset):
        return int.from_bytes(data[offset:offset + 2], "little")

    native = [("COP", 0x7FE4), ("BRK", 0x7FE6), ("ABORT", 0x7FE8),
              ("NMI", 0x7FEA), ("RESET", 0x7FEC), ("IRQ", 0x7FEE)]
    emulation = [("COP", 0x7FF4), ("ABORT", 0x7FF8), ("NMI", 0x7FFA),
                 ("RESET", 0x7FFC), ("IRQ/BRK", 0x7FFE)]

    def show(label, table):
        parts = []
        for name, off in table:
            v = vec(off)
            parts.append("{} ${:04X}{}".format(name, v, "" if v != 0xFFFF else "*"))
        print("{:<12} {}".format(label, "   ".join(parts)))

    show("Native:", native)
    show("Emulation:", emulation)
    print("             (* = $FFFF, unused)")

    # The reset thunk is short enough to be worth showing every run: it is the
    # one place that proves which bank the game actually executes from.
    reset = vec(0x7FFC)
    thunk_off = reset - 0x8000
    if 0 <= thunk_off < len(data):
        thunk = data[thunk_off:thunk_off + 6]
        print("RESET @ 0x{:06X}: {}".format(
            thunk_off, " ".join("{:02X}".format(b) for b in thunk)))

    if not is_lorom:
        problems.append("HiROM header slot is not empty; mapping is ambiguous")
    if checksum ^ complement != 0xFFFF:
        problems.append(
            "checksum 0x{:04X} ^ complement 0x{:04X} = 0x{:04X}, expected 0xFFFF "
            "(ROM may be modified or a bad dump)".format(
                checksum, complement, checksum ^ complement))
    if fixed != 0x33:
        problems.append(
            "header byte 0x7FDA is 0x{:02X}, not 0x33: extended header at "
            "0x7FB0 may not be valid".format(fixed))
    if (1 << rom_size) * 1024 != len(data):
        problems.append(
            "header claims {} KB but file is {} KB".format(
                1 << rom_size, len(data) // 1024))

    return problems


def main():
    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    problems = describe(data)
    if problems:
        print()
        for p in problems:
            print("warning: {}".format(p), file=sys.stderr)
        return 1
    print("\nok: ROM verified, header consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
