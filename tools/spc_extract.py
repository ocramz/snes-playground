#!/usr/bin/env python3
"""Extract the sound side: N-SPC driver, samples, songs, and playable .spc files.

Everything here follows the SNES-side upload code, not guesswork:

  * $80:AA30  IPL upload loop; its block table at $80:AA99 holds one block,
              0x0A0B bytes -> SPC $0800 (the driver), entry $0800.
  * $80:B651  "init set" upload: table of lists at $80:B729, each list is
              (addr16, bank16) long pointers to block chains, 0-terminated.
              Set 0 = samples ($95:8000 -> $8200), SFX/song-table block
              ($96:8000 -> $3B00), sample directory ($96:AA08 -> $0400).
              Set 1 = instrument table ($95:FD16 -> $0600) and a 0x18-byte
              table -> $03E0.
  * $80:B69B  per-song upload: table at $80:B745, 4 bytes per song
              (addr16, bank16), song id = 0x7E + n, 33 songs, each a single
              block to SPC $6502. The SNES then writes 0x7E to port 0.
  * SPC $1168 song start reads the pointer at $3AFE + 2*song, i.e. the song
              table lives at $3B00 inside the $96:8000 block.

Block chains are (len16, addr16, data) records ended by len == 0.

Outputs (all under --out, default build/spc):
  driver_0800.bin           raw driver image
  blocks/*.bin              every uploaded block, named by SPC address
  songs/song_NN_id7E.bin    raw song sequence block (SPC $6502 image)
  songs/song_NN_id7E.spc    playable SPC state (see make_spc for the trick)
  samples/sample_NN.wav     BRR samples decoded via the $0400 directory
  spc_map.txt               what went where

The .spc files are built without an emulator: RAM is assembled exactly as
the game uploads it, PC = $0800 so the driver runs its own init, and the
6-byte port-0 read at $08B6 is patched to fetch from a constant table at
$05F0 = [0x7E, 0x00, 0xFF, 0x00] (song 0x7E, no SFX, volume 0xFF). The
driver therefore sees "song 0x7E requested" on its first poll and starts
it. Play in any SPC player; if a player refuses, the patch is the first
thing to suspect.

Every file requests id 0x7E regardless of which song it holds, and that is
correct rather than a copy-paste bug: the song table entry for 0x7E is the
one that points at SPC $6502, which is where sub_spc_upload_song puts
whichever song was selected. Verified by reading the table at SPC
$3AFE + 2*id, where id 0x7E yields $6502 and 0x7F yields $3C00.
"""

import argparse
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from brr import decode_brr, read_directory, write_wav  # noqa: E402
from lorom import file_to_snes, fmt_file, fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402

IPL_TABLE = 0x002A99          # $80:AA99
INIT_SET_TABLE = 0x003729     # $80:B729, 2 entries
INIT_SET_COUNT = 2
SONG_TABLE = 0x003745         # $80:B745
SONG_COUNT = 33
SONG_ID_BASE = 0x7E
DRIVER_ENTRY = 0x0800
PORT_READ_PATCH_ADDR = 0x08B6
PORT_TABLE_ADDR = 0x05F0
SAMPLE_DIR = 0x0400
SAMPLE_COUNT = 80


def u16(d, o):
    return int.from_bytes(d[o:o + 2], "little")


def read_chain(d, off):
    """(len, addr, data) records until len == 0. Returns (blocks, end)."""
    blocks = []
    p = off
    while True:
        ln, addr = u16(d, p), u16(d, p + 2)
        p += 4
        if ln == 0:
            return blocks, p
        if ln > 0x8000 or addr + ln > 0x10000:
            raise ValueError("bad block at {}: len {:04X} addr {:04X}".format(
                fmt_file(p - 4), ln, addr))
        blocks.append((ln, addr, d[p:p + ln]))
        p += ln


def init_sets(d):
    """Yield (set_index, [(src_off, blocks)])."""
    for i in range(INIT_SET_COUNT):
        lst = snes_to_file(0x80, u16(d, INIT_SET_TABLE + 2 * i))
        chains = []
        q = lst
        while True:
            a, b = u16(d, q), u16(d, q + 2)
            if a == 0:
                break
            off = snes_to_file(b & 0xFF, a)
            chains.append((off, read_chain(d, off)[0]))
            q += 4
        yield i, chains


def songs(d):
    for n in range(SONG_COUNT):
        a, b = u16(d, SONG_TABLE + 4 * n), u16(d, SONG_TABLE + 4 * n + 2)
        off = snes_to_file(b & 0xFF, a)
        yield n, SONG_ID_BASE + n, off, read_chain(d, off)[0]


def driver(d):
    p = IPL_TABLE
    blocks = []
    while True:
        ln, addr = u16(d, p), u16(d, p + 2)
        p += 4
        if ln == 0:
            return blocks, addr
        blocks.append((ln, addr, d[p:p + ln]))
        p += ln


def base_ram(d):
    """64 KB image after the IPL upload and both init sets."""
    ram = bytearray(0x10000)
    log = []
    blocks, entry = driver(d)
    for ln, addr, data in blocks:
        ram[addr:addr + ln] = data
        log.append("driver  {} -> ${:04X}..${:04X} ({} bytes), entry ${:04X}".format(
            fmt_file(IPL_TABLE + 4), addr, addr + ln, ln, entry))
    for i, chains in init_sets(d):
        for off, blks in chains:
            for ln, addr, data in blks:
                ram[addr:addr + ln] = data
                b, a = file_to_snes(off)
                log.append("set {}   {} ({}) -> ${:04X}..${:04X} ({} bytes)".format(
                    i, fmt_snes(b, a), fmt_file(off), addr, addr + ln, ln))
    return ram, log


def make_spc(ram, song_id, title, game="Kirby's Dream Course", length_s=180, fade_ms=10000):
    """Build a .spc (v0.30 with ID666 text tags) from a RAM image."""
    ram = bytearray(ram)
    # Patch: MOV A,$F4+X / CMP A,$F4+X / BNE  ->  MOV A,$05F0+X / NOP NOP NOP
    expect = bytes([0xF4, 0xF4, 0x74, 0xF4, 0xD0, 0xFA])
    if bytes(ram[PORT_READ_PATCH_ADDR:PORT_READ_PATCH_ADDR + 6]) != expect:
        raise ValueError("driver bytes at ${:04X} are not the expected port read".format(
            PORT_READ_PATCH_ADDR))
    ram[PORT_READ_PATCH_ADDR:PORT_READ_PATCH_ADDR + 6] = bytes(
        [0xF5, PORT_TABLE_ADDR & 0xFF, PORT_TABLE_ADDR >> 8, 0x00, 0x00, 0x00])
    ram[PORT_TABLE_ADDR:PORT_TABLE_ADDR + 4] = bytes([song_id, 0x00, 0xFF, 0x00])

    def text(s, n):
        return s.encode("ascii", "replace")[:n].ljust(n, b"\0")

    hdr = bytearray(0x100)
    hdr[0x00:0x21] = b"SNES-SPC700 Sound File Data v0.30"
    hdr[0x21:0x23] = b"\x1a\x1a"
    hdr[0x23] = 0x1A          # ID666 tag present
    hdr[0x24] = 30            # minor version
    struct.pack_into("<HBBBBB", hdr, 0x25, DRIVER_ENTRY, 0, 0, 0, 0x00, 0xCF)
    hdr[0x2E:0x4E] = text(title, 32)
    hdr[0x4E:0x6E] = text(game, 32)
    hdr[0x6E:0x7E] = text("snes-playground", 16)
    hdr[0x7E:0x9E] = text("static rip, port0 patched", 32)
    hdr[0x9E:0xA9] = text("", 11)
    hdr[0xA9:0xAC] = text(str(length_s), 3)
    hdr[0xAC:0xB1] = text(str(fade_ms), 5)
    hdr[0xB1:0xD1] = text("HAL Laboratory", 32)
    hdr[0xD1] = 0
    hdr[0xD2] = 0
    dsp = bytearray(128)
    dsp[0x5D] = SAMPLE_DIR >> 8     # DIR
    dsp[0x6C] = 0xE0                # FLG: mute + echo off until driver sets it
    dsp[0x0C] = dsp[0x1C] = 0x7F    # MVOL, driver overwrites
    return bytes(hdr) + bytes(ram) + bytes(dsp) + bytes(64) + bytes(64)


def _mkdir(p):
    if not os.path.isdir(p):
        os.makedirs(p)


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/spc")
    ap.add_argument("--no-wav", action="store_true")
    ap.add_argument("--loops", type=int, default=2, help="extra loop passes in WAVs")
    args = ap.parse_args()

    try:
        d = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    out = args.out
    for sub in ("blocks", "songs", "samples"):
        _mkdir(os.path.join(out, sub))

    ram, log = base_ram(d)
    blocks, entry = driver(d)
    with open(os.path.join(out, "driver_0800.bin"), "wb") as f:
        f.write(blocks[0][2])
    with open(os.path.join(out, "ram_base.bin"), "wb") as f:
        f.write(ram)
    for i, chains in init_sets(d):
        for off, blks in chains:
            for ln, addr, data in blks:
                with open(os.path.join(out, "blocks", "set{}_{:04X}.bin".format(i, addr)), "wb") as f:
                    f.write(data)

    for n, sid, off, blks in songs(d):
        song_ram = bytearray(ram)
        for ln, addr, data in blks:
            song_ram[addr:addr + ln] = data
            with open(os.path.join(out, "songs", "song_{:02d}_id{:02X}.bin".format(n, sid)), "wb") as f:
                f.write(data)
        b, a = file_to_snes(off)
        log.append("song {:2d} id {:02X}  {} ({}) -> {}".format(
            n, sid, fmt_snes(b, a), fmt_file(off),
            ", ".join("${:04X}..${:04X}".format(ad, ad + ln) for ln, ad, _ in blks)))
        spc = make_spc(song_ram, SONG_ID_BASE, "Song {:02d} (id 0x{:02X})".format(n, sid))
        with open(os.path.join(out, "songs", "song_{:02d}_id{:02X}.spc".format(n, sid)), "wb") as f:
            f.write(spc)

    if not args.no_wav:
        seen = {}
        for i, (s, l) in enumerate(read_directory(ram, SAMPLE_DIR, SAMPLE_COUNT)):
            if s in (0, 0xFFFF):
                continue
            if (s, l) in seen:
                continue
            seen[(s, l)] = i
            samples, looped = decode_brr(ram, s, l, loop_times=args.loops)
            path = os.path.join(out, "samples", "sample_{:02d}_{:04X}.wav".format(i, s))
            write_wav(path, samples)
            log.append("sample {:2d} ${:04X} loop ${:04X} {:6d} samples{}".format(
                i, s, l, len(samples), " looped" if looped else ""))

    with open(os.path.join(out, "spc_map.txt"), "w") as f:
        f.write("\n".join(log) + "\n")
    print("\n".join(log))
    print("\nwrote {}".format(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
