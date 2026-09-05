#!/usr/bin/env python3
"""HAL LZ decompressor (the format the game's sub_hal_decompress at $80:9F18
implements) plus a brute-force stream scanner.

Format, as read from the routine at $80:9F18 (0x001F18):

    command byte  c
      c == 0xFF                       end of stream
      (c & 0xE0) != 0xE0              type = c & 0xE0, length = (c & 0x1F) + 1
      (c & 0xE0) == 0xE0              type = (c << 3) & 0xE0,
                                      length = ((c & 3) << 8 | next byte) + 1
    type 0x00  literal: copy `length` bytes from the stream
    type 0x20  run:     next byte, repeated `length` times
    type 0x40  run16:   next two bytes, repeated `length` times (2*length out)
    type 0x60  ramp:    next byte, then incrementing, `length` times
    type 0x80  copy:    big-endian u16 offset from the START of the output,
                        copy `length` bytes forward
    type 0xA0  copy with every byte bit-reversed
    type 0xC0  copy walking backwards from the offset
    type 0xE0  never produced (it is the long-form escape)

Offsets for the copy commands are relative to the destination base the caller
passed in Y, i.e. relative to output[0]. This is the same format `exhal`
(Devin Acker) implements for other HAL titles.

    python3 tools/halcomp.py '$93:E7D5'                # decompress, report size
    python3 tools/halcomp.py '$93:E7D5' -o build/x.bin
    python3 tools/halcomp.py --scan '$95:8000' '$9B:FFFF'   # find streams
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import (  # noqa: E402
    AddressError, file_to_snes, fmt_file, fmt_snes, parse_addr, snes_to_file,
)
from romcheck import RomError, load_rom  # noqa: E402

MAX_OUT = 0x10000  # a 16-bit destination index cannot address more


class CompressionError(ValueError):
    pass


_BITREV = bytes(int("{:08b}".format(i)[::-1], 2) for i in range(256))


def decompress(data, offset, max_out=MAX_OUT, strict=True):
    """Decompress the stream starting at file offset.

    Returns (output_bytes, bytes_consumed). `bytes_consumed` includes the
    0xFF terminator. With strict=True any malformed command raises
    CompressionError; the scanner relies on that to reject false starts.
    """
    out = bytearray()
    p = offset
    n = len(data)
    while True:
        if p >= n:
            raise CompressionError("ran off end of ROM")
        c = data[p]
        p += 1
        if c == 0xFF:
            return bytes(out), p - offset
        if (c & 0xE0) == 0xE0:
            kind = (c << 3) & 0xE0
            if p >= n:
                raise CompressionError("truncated long command")
            length = (((c & 3) << 8) | data[p]) + 1
            p += 1
            if kind == 0xE0:
                raise CompressionError("long command with type 7")
        else:
            kind = c & 0xE0
            length = (c & 0x1F) + 1

        if kind == 0x00:
            chunk = data[p:p + length]
            if len(chunk) != length:
                raise CompressionError("truncated literal")
            out += chunk
            p += length
        elif kind == 0x20:
            out += bytes([data[p]]) * length
            p += 1
        elif kind == 0x40:
            out += data[p:p + 2] * length
            p += 2
        elif kind == 0x60:
            b = data[p]
            p += 1
            out += bytes((b + i) & 0xFF for i in range(length))
        else:
            src = (data[p] << 8) | data[p + 1]
            p += 2
            if kind == 0x80:
                if src + length > len(out):
                    # The real routine reads whatever is in RAM here; a
                    # legitimate stream never does, so treat it as corrupt.
                    if strict or src >= len(out):
                        raise CompressionError(
                            "copy from 0x{:04X}+{} past output (0x{:04X})".format(
                                src, length, len(out)))
                    # Overlapping forward copy, byte by byte.
                for i in range(length):
                    out.append(out[src + i])
            elif kind == 0xA0:
                if src + length > len(out):
                    raise CompressionError("reversed copy past output")
                for i in range(length):
                    out.append(_BITREV[out[src + i]])
            elif kind == 0xC0:
                if src >= len(out) or src - length + 1 < 0:
                    raise CompressionError("backward copy out of range")
                for i in range(length):
                    out.append(out[src - i])
        if len(out) > max_out:
            raise CompressionError("output exceeds 0x{:X} bytes".format(max_out))


def scan(data, start, end, min_out=64, min_ratio=1.05, step=1):
    """Try every offset in [start, end) as a stream start.

    Yields (offset, packed_size, unpacked_size) for streams that decode
    cleanly, reach the 0xFF terminator, produce at least min_out bytes and
    actually compress (unpacked/packed >= min_ratio). Offsets inside an
    already-accepted stream are skipped, so the result is a non-overlapping
    catalogue. A run of pure literal commands can fake a stream; the ratio
    filter is what rejects those.
    """
    p = start
    while p < end:
        try:
            out, used = decompress(data, p)
        except (CompressionError, IndexError):
            p += step
            continue
        if len(out) >= min_out and used > 1 and len(out) / used >= min_ratio:
            yield p, used, len(out)
            p += used
        else:
            p += step


def _write(path, blob):
    parent = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(parent):
        os.makedirs(parent)
    with open(path, "wb") as f:
        f.write(blob)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("address", nargs="*", help="stream start(s), '$93:E7D5' or 0x09E7D5")
    ap.add_argument("-o", "--output", help="write decompressed bytes here (single address)")
    ap.add_argument("--scan", nargs=2, metavar=("START", "END"),
                    help="brute-force scan a range for streams")
    ap.add_argument("--min-out", type=int, default=64)
    ap.add_argument("--min-ratio", type=float, default=1.05)
    args = ap.parse_args()

    try:
        data = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    def to_off(text):
        kind, value = parse_addr(text)
        return snes_to_file(*value) if kind == "snes" else value

    if args.scan:
        try:
            start, end = to_off(args.scan[0]), to_off(args.scan[1]) + 1
        except AddressError as e:
            print("error: {}".format(e), file=sys.stderr)
            return 1
        print("# offset      snes       packed  unpacked  ratio")
        for off, used, size in scan(data, start, end, args.min_out, args.min_ratio):
            b, a = file_to_snes(off)
            print("{}  {}  {:6d}  {:8d}  {:5.2f}".format(
                fmt_file(off), fmt_snes(b, a), used, size, size / used))
        return 0

    if not args.address:
        ap.print_help()
        return 2
    if args.output and len(args.address) != 1:
        print("error: -o takes exactly one address", file=sys.stderr)
        return 1

    status = 0
    for text in args.address:
        try:
            off = to_off(text)
            out, used = decompress(data, off)
        except (AddressError, CompressionError) as e:
            print("{}: error: {}".format(text, e), file=sys.stderr)
            status = 1
            continue
        b, a = file_to_snes(off)
        print("{} ({}): {} packed -> {} bytes (ratio {:.2f}), stream ends at {}".format(
            fmt_snes(b, a), fmt_file(off), used, len(out), len(out) / used,
            fmt_file(off + used)))
        if args.output:
            _write(args.output, out)
            print("wrote {}".format(args.output))
    return status


if __name__ == "__main__":
    sys.exit(main())
