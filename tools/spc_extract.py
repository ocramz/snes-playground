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
  instruments.tsv           the $0600 table, ADSR/GAIN decoded
  samples.tsv               the $0400 directory, with lengths and users
  curve.tsv                 the $03E0 gate/velocity curve
  spc_map.txt               what went where

Sequences (songs and SFX) are parsed by tools/nspc.py, which builds its RAM
image from base_ram() here.

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
INSTRUMENT_TABLE = 0x0600     # SPC, 6 bytes/entry; decoded at SPC $0BCB
INSTRUMENT_COUNT = 78
CURVE_TABLE = 0x03E0          # SPC, 8 gate then 16 velocity; read at SPC $0AFC

# ADSR/GAIN timings, fullsnes "SNES APU DSP ADSR/GAIN". Indexed by the raw
# field; entry 0 of the sustain-rate table is "never decays".
ATTACK_MS = [4100, 2500, 1500, 1000, 640, 380, 260, 160,
             96, 64, 40, 24, 16, 10, 6, 0]
DECAY_MS = [1200, 740, 440, 290, 180, 110, 74, 37]
RATE_MS = [None, 38000, 28000, 24000, 19000, 14000, 12000, 9400,
           7100, 5900, 4700, 3500, 2900, 2400, 1800, 1500,
           1200, 880, 740, 590, 440, 370, 290, 220,
           180, 150, 110, 92, 74, 55, 37, 18]
GAIN_MODES = ["linear decrease", "exp decrease", "linear increase",
              "bent increase"]


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


def make_spc(ram, song_id, title, game="Kirby's Dream Course", length_s=180,
             fade_ms=10000, sfx_id=0x00, comment="static rip, port0 patched"):
    """Build a .spc (v0.30 with ID666 text tags) from a RAM image.

    sfx_id lands in the port-1 slot of the constant table. The driver polls
    port 1 at SPC $1137 and starts that sequence through the same $1168
    entry songs use, so a nonzero sfx_id makes the file play one sound
    effect (see tools/nspc.py --sfx-spc, which pairs it with a silent song
    so the sequencer keeps ticking)."""
    ram = bytearray(ram)
    # Patch: MOV A,$F4+X / CMP A,$F4+X / BNE  ->  MOV A,$05F0+X / NOP NOP NOP
    expect = bytes([0xF4, 0xF4, 0x74, 0xF4, 0xD0, 0xFA])
    if bytes(ram[PORT_READ_PATCH_ADDR:PORT_READ_PATCH_ADDR + 6]) != expect:
        raise ValueError("driver bytes at ${:04X} are not the expected port read".format(
            PORT_READ_PATCH_ADDR))
    ram[PORT_READ_PATCH_ADDR:PORT_READ_PATCH_ADDR + 6] = bytes(
        [0xF5, PORT_TABLE_ADDR & 0xFF, PORT_TABLE_ADDR >> 8, 0x00, 0x00, 0x00])
    ram[PORT_TABLE_ADDR:PORT_TABLE_ADDR + 4] = bytes([song_id, sfx_id, 0xFF, 0x00])

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
    hdr[0x7E:0x9E] = text(comment, 32)
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


def _ms(v):
    return "never" if v is None else "{}ms".format(v)


def decode_adsr(adsr1, adsr2):
    """Decode the two ADSR bytes the driver writes to DSP $x5/$x6.

    ADSR1: bit 7 enable, bits 6-4 decay rate, bits 3-0 attack rate.
    ADSR2: bits 7-5 sustain level, bits 4-0 sustain (release) rate.
    """
    enabled = bool(adsr1 & 0x80)
    ar = adsr1 & 0x0F
    dr = (adsr1 >> 4) & 0x07
    sl = (adsr2 >> 5) & 0x07
    sr = adsr2 & 0x1F
    return {
        "enabled": enabled, "ar": ar, "dr": dr, "sl": sl, "sr": sr,
        "attack": _ms(ATTACK_MS[ar]),
        "decay": _ms(DECAY_MS[dr]),
        "sustain_level": "{}/8".format(sl + 1),
        "sustain_rate": _ms(RATE_MS[sr]),
    }


def decode_gain(gain):
    """DSP $x7. Bit 7 clear = direct level; set = mode in bits 6-5, rate 4-0."""
    if not gain & 0x80:
        return "direct {}/127".format(gain & 0x7F)
    return "{} rate {} ({})".format(
        GAIN_MODES[(gain >> 5) & 3], gain & 0x1F, _ms(RATE_MS[gain & 0x1F]))


def instruments(ram, count=INSTRUMENT_COUNT):
    """Yield one dict per instrument. Layout proven by SPC $0BCB, which
    multiplies the index by 6, adds $0600, writes bytes 0-3 to DSP
    $x4-$x7 (SRCN, ADSR1, ADSR2, GAIN) and keeps bytes 4-5 as a 16-bit
    big-endian pitch scaler ($0C16: byte 4 -> $0221+X, byte 5 -> $0220+X)."""
    for i in range(count):
        o = INSTRUMENT_TABLE + 6 * i
        e = ram[o:o + 6]
        pitch = (e[4] << 8) | e[5]
        yield {
            "index": i, "addr": o, "raw": bytes(e),
            # SPC $0BF4: a sample number with bit 7 set selects noise, the
            # low 5 bits being the noise clock written to FLG.
            "noise": bool(e[0] & 0x80),
            "sample": (e[0] & 0x1F) if e[0] & 0x80 else e[0],
            "adsr1": e[1], "adsr2": e[2], "gain": e[3],
            "pitch": pitch, "pitch_mul": pitch / 256.0,
            "adsr": decode_adsr(e[1], e[2]), "gain_text": decode_gain(e[3]),
        }


def write_instruments(ram, path):
    rows = ["\t".join([
        "index", "spc_addr", "raw", "sample", "noise", "adsr1", "adsr2",
        "adsr_enabled", "attack", "decay", "sustain_level", "sustain_rate",
        "gain", "gain_decoded", "pitch", "pitch_mul"])]
    n = 0
    for it in instruments(ram):
        a = it["adsr"]
        rows.append("\t".join([
            str(it["index"]), "${:04X}".format(it["addr"]),
            " ".join("{:02X}".format(b) for b in it["raw"]),
            str(it["sample"]), "yes" if it["noise"] else "no",
            "${:02X}".format(it["adsr1"]), "${:02X}".format(it["adsr2"]),
            "yes" if a["enabled"] else "no (GAIN)",
            a["attack"], a["decay"], a["sustain_level"], a["sustain_rate"],
            "${:02X}".format(it["gain"]), it["gain_text"],
            "${:04X}".format(it["pitch"]), "{:.4f}".format(it["pitch_mul"])]))
        n += 1
    with open(path, "w") as f:
        f.write("\n".join(rows) + "\n")
    return n


def write_samples(ram, path):
    """One row per $0400 directory entry, cross-referenced to instruments."""
    users = {}
    for it in instruments(ram):
        if not it["noise"]:
            users.setdefault(it["sample"], []).append(it["index"])
    rows = ["\t".join([
        "index", "start", "loop", "loop_offset", "blocks", "samples",
        "looped", "duplicate_of", "instruments"])]
    seen = {}
    n = 0
    for i, (s, l) in enumerate(read_directory(ram, SAMPLE_DIR, SAMPLE_COUNT)):
        dup = seen.get((s, l))
        if dup is None and s not in (0, 0xFFFF):
            seen[(s, l)] = i
        if s in (0, 0xFFFF):
            decoded, looped = [], False
        else:
            decoded, looped = decode_brr(ram, s, l, loop_times=0)
        rows.append("\t".join([
            str(i), "${:04X}".format(s), "${:04X}".format(l),
            str(l - s), str(len(decoded) // 16), str(len(decoded)),
            "yes" if looped else "no",
            "-" if dup is None else str(dup),
            ",".join(str(u) for u in users.get(i, [])) or "-"]))
        n += 1
    with open(path, "w") as f:
        f.write("\n".join(rows) + "\n")
    return n, len(seen)


def write_curve(ram, path):
    """The 24-byte $03E0 block: 8 gate values then 16 velocity values.

    SPC $0AFC reads it after a duration byte: the optional following byte
    < $80 is split by XCN/AND #$07 into $03E0+n (gate, the fraction of the
    duration the note is held) and AND #$0F into $03E8+n (velocity, the
    per-note volume multiplier)."""
    rows = ["\t".join(["kind", "index", "spc_addr", "value", "fraction",
                       "read_by"])]
    for i in range(8):
        v = ram[CURVE_TABLE + i]
        rows.append("\t".join([
            "gate", str(i), "${:04X}".format(CURVE_TABLE + i),
            "${:02X}".format(v), "{:.3f}".format(v / 256.0),
            "SPC $0B00 (duration byte bits 6-4)"]))
    for i in range(16):
        v = ram[CURVE_TABLE + 8 + i]
        rows.append("\t".join([
            "velocity", str(i), "${:04X}".format(CURVE_TABLE + 8 + i),
            "${:02X}".format(v), "{:.3f}".format(v / 256.0),
            "SPC $0B0A (duration byte bits 3-0)"]))
    with open(path, "w") as f:
        f.write("\n".join(rows) + "\n")
    return 24


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

    n_instr = write_instruments(ram, os.path.join(out, "instruments.tsv"))
    n_dir, n_distinct = write_samples(ram, os.path.join(out, "samples.tsv"))
    n_curve = write_curve(ram, os.path.join(out, "curve.tsv"))
    log.append("tables: {} instruments, {} directory entries ({} distinct "
               "samples), {} curve values".format(
                   n_instr, n_dir, n_distinct, n_curve))

    with open(os.path.join(out, "spc_map.txt"), "w") as f:
        f.write("\n".join(log) + "\n")
    print("\n".join(log))
    print("\nwrote {}".format(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
