#!/usr/bin/env python3
"""Dump a ROM region, by SNES address or file offset.

Prints an annotated hexdump by default; -o writes raw bytes to a file. Written
output belongs under build/ (gitignored) — never commit extracted ROM data.

    python3 tools/dump.py '$80:8000' 16
    python3 tools/dump.py 0x0A8000 0x100
    python3 tools/dump.py '$9A:8000' 0x1000 -o build/bank9a.bin
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import (  # noqa: E402
    AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file,
)
from romcheck import RomError, load_rom  # noqa: E402


def parse_len(text):
    text = text.strip()
    if text.lower().startswith("0x"):
        return int(text, 16)
    if text.lower().endswith("h"):
        return int(text[:-1], 16)
    return int(text)


def hexdump(data, start_offset, width=16):
    """Hexdump annotated with both address forms, so output can be pasted into
    notes without re-deriving anything."""
    lines = []
    for i in range(0, len(data), width):
        chunk = data[i:i + width]
        offset = start_offset + i
        bank, addr = file_to_snes(offset)
        hexpart = " ".join("{:02X}".format(b) for b in chunk)
        hexpart += "   " * (width - len(chunk))
        ascii_part = "".join(
            chr(b) if 0x20 <= b < 0x7F else "." for b in chunk)
        lines.append("{}  {}  {}  |{}|".format(
            fmt_file(offset), fmt_snes(bank, addr), hexpart, ascii_part))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("address", help="'$95:8000' (SNES) or '0x0A8000' (file offset)")
    ap.add_argument("length", help="byte count, decimal or 0x-hex")
    ap.add_argument("-o", "--output", help="write raw bytes here instead of a hexdump")
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    try:
        kind, value = parse_addr(args.address)
        offset = snes_to_file(*value) if kind == "snes" else value
        length = parse_len(args.length)
    except (AddressError, ValueError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    if length <= 0:
        print("error: length must be positive", file=sys.stderr)
        return 1
    if offset + length > len(data):
        print("error: {}+{} runs past end of ROM ({})".format(
            fmt_file(offset), length, fmt_file(len(data))), file=sys.stderr)
        return 1

    # A region that crosses a bank boundary is contiguous in the file but not
    # in SNES address space — worth flagging, since it usually means the region
    # was mis-sized.
    if (offset % 0x8000) + length > 0x8000:
        print("note: region crosses a bank boundary; it is contiguous in the "
              "file but not in SNES address space", file=sys.stderr)

    chunk = data[offset:offset + length]

    if args.output:
        parent = os.path.dirname(os.path.abspath(args.output))
        if not os.path.isdir(parent):
            os.makedirs(parent)
        with open(args.output, "wb") as f:
            f.write(chunk)
        bank, addr = file_to_snes(offset)
        print("wrote {} bytes from {} ({}) to {}".format(
            len(chunk), fmt_snes(bank, addr), fmt_file(offset), args.output))
    else:
        print(hexdump(chunk, offset))
    return 0


if __name__ == "__main__":
    sys.exit(main())
