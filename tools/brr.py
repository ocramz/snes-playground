#!/usr/bin/env python3
"""Decode SPC700 BRR samples to 16-bit mono WAV.

BRR (fullsnes "SNES APU DSP BRR Samples"): 9-byte blocks, header byte then
16 nibbles. Header: bits 7-4 shift, bits 3-2 filter, bit 1 loop, bit 0 end.
Filters use the two previous output samples:

    0: s = n
    1: s = n + old * 15/16
    2: s = n + old * 61/32 - older * 15/16
    3: s = n + old * 115/64 - older * 13/16

Given a 64 KB SPC RAM image (or any buffer plus a base address) and a
sample-directory entry (start, loop) this decodes until the end flag.

    python3 tools/brr.py RAM.bin --dir 0x0400 --count 80 -o build/samples/
    python3 tools/brr.py RAM.bin --start 0x8200 -o build/samples/one.wav

The SPC has no fixed sample rate: pitch is per-note. WAVs are written at
--rate (default 32000, the DSP's native output rate) so they play back at
"pitch 0x1000" speed; this is the usual convention for ripped BRR.
"""

import argparse
import os
import struct
import sys


def _clamp16(v):
    # DSP arithmetic wraps to 16 bits after clamping to 15 bits + sign.
    if v > 0x7FFF:
        v = 0x7FFF
    elif v < -0x8000:
        v = -0x8000
    v &= 0xFFFF
    if v & 0x8000:
        v -= 0x10000
    # Then the result is clipped to 15 bits (sign-extended).
    v = ((v << 1) & 0xFFFF)
    if v & 0x8000:
        v -= 0x10000
    return v >> 1


def decode_brr(ram, start, loop=None, max_blocks=8000, loop_times=0):
    """Decode from `start` until a block with the end flag. Returns
    (samples, looped) where samples is a list of ints in [-32768, 32767].

    loop_times > 0 re-enters the loop point that many extra times when the
    end block also has its loop flag set, giving a longer preview.
    """
    out = []
    old = older = 0
    p = start
    blocks = 0
    loops_left = loop_times
    while blocks < max_blocks and p + 9 <= len(ram):
        hdr = ram[p]
        shift = hdr >> 4
        flt = (hdr >> 2) & 3
        for i in range(16):
            b = ram[p + 1 + i // 2]
            n = (b >> 4) if i % 2 == 0 else (b & 0xF)
            if n >= 8:
                n -= 16
            if shift <= 12:
                s = (n << shift) >> 1
            else:
                s = (-1 if n < 0 else 0) << 11  # invalid shift: sign only
            if flt == 1:
                s += old + ((-old) >> 4)
            elif flt == 2:
                s += (old << 1) + ((-((old << 1) + old)) >> 5) - older + (older >> 4)
            elif flt == 3:
                s += (old << 1) + ((-(old + (old << 2) + (old << 3))) >> 6) \
                    - older + (((older << 1) + older) >> 4)
            s = _clamp16(s)
            older, old = old, s
            out.append(s)
        blocks += 1
        p += 9
        if hdr & 1:
            if (hdr & 2) and loop is not None and loops_left > 0 and loop < len(ram):
                loops_left -= 1
                p = loop
                continue
            return out, bool(hdr & 2)
    return out, False


def write_wav(path, samples, rate=32000):
    parent = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(parent):
        os.makedirs(parent)
    data = struct.pack("<{}h".format(len(samples)), *samples)
    with open(path, "wb") as f:
        f.write(b"RIFF")
        f.write(struct.pack("<I", 36 + len(data)))
        f.write(b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        f.write(b"data")
        f.write(struct.pack("<I", len(data)))
        f.write(data)


def read_directory(ram, dir_addr, count):
    ents = []
    for i in range(count):
        o = dir_addr + 4 * i
        s = int.from_bytes(ram[o:o + 2], "little")
        l = int.from_bytes(ram[o + 2:o + 4], "little")
        ents.append((s, l))
    return ents


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ram", help="64 KB SPC RAM image (or a buffer with --base)")
    ap.add_argument("--base", default="0", help="address of the file's first byte")
    ap.add_argument("--dir", help="sample directory address, decode every entry")
    ap.add_argument("--count", type=int, default=64, help="directory entries")
    ap.add_argument("--start", help="decode one sample at this address")
    ap.add_argument("--loops", type=int, default=2, help="extra loop passes for looped samples")
    ap.add_argument("--rate", type=int, default=32000)
    ap.add_argument("-o", "--output", required=True, help="directory (with --dir) or .wav")
    args = ap.parse_args()

    with open(args.ram, "rb") as f:
        buf = f.read()
    base = int(args.base, 0)
    ram = bytes(base) + buf  # pad so addresses index directly
    if len(ram) < 0x10000:
        ram = ram + bytes(0x10000 - len(ram))

    if args.start:
        s = int(args.start, 0)
        samples, looped = decode_brr(ram, s, None, loop_times=0)
        write_wav(args.output, samples, args.rate)
        print("wrote {} ({} samples, loop={})".format(args.output, len(samples), looped))
        return 0
    if not args.dir:
        ap.error("need --dir or --start")
    seen = {}
    for i, (s, l) in enumerate(read_directory(ram, int(args.dir, 0), args.count)):
        if s == 0xFFFF or s == 0 or s >= len(ram):
            continue
        if (s, l) in seen:
            print("  {:2d}: same as sample {}".format(i, seen[(s, l)]))
            continue
        seen[(s, l)] = i
        samples, looped = decode_brr(ram, s, l, loop_times=args.loops)
        if not samples:
            continue
        path = os.path.join(args.output, "sample_{:02d}_{:04X}.wav".format(i, s))
        write_wav(path, samples, args.rate)
        print("  {:2d}: ${:04X} loop ${:04X} {:6d} samples{} -> {}".format(
            i, s, l, len(samples), " (looped)" if looped else "", path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
