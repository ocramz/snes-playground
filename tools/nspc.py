#!/usr/bin/env python3
"""Parse N-SPC sequences: the 33 songs and the 125 sound effects.

Everything below was read out of the driver image (SPC $0800..$120B, ROM
0x002A9D..0x0034A8), not assumed from the N-SPC family in general. Routine
addresses are SPC addresses inside that image.

Lookup
------
SPC $1168 is the one sequence-start routine. It takes an id in A, doubles
it (`ASL A` at $1143 for the port-1 path, $09CE for port 0 -- the shift
also discards bit 7, which is the SNES's retrigger toggle) and reads a
16-bit pointer from `$3AFE + 2*id`. That table is the first 254 bytes of
the block the SNES uploads from $96:8000 (0x0B0000), so:

    id $00        -> $0000, "stop"
    id $01..$7D   -> a sound effect inside the same block
    id $7E        -> $6502, wherever sub_spc_upload_song just put a song

There is no id $7F entry: `$3AFE + 2*$7F` = $3BFC, which is already the
first word of sound effect 1's word list. Songs are always requested as
$7E ($80:B4DC loads #$007E literally), so the id the SNES writes to port 0
is never the song's own number.

Sequence layout
---------------
A pointer from that table addresses a **word list**, walked by SPC $09B9
(read word, advance by 2) and dispatched at $0A43:

    high byte != 0      the word is a pointer to a pattern
    word == $0000       end of song; SPC $09CC restarts with id 0 (silence)
    high != 0 is false
      and low != 0      repeat count, and the NEXT word is the target the
                        list jumps back to ($0A4B..$0A5A, counter at $42)

A **pattern** is 8 consecutive 16-bit track pointers, one per DSP voice
(SPC $1183 and $0A63 both step X by 2 through a rotating $47 voice mask).
A track pointer whose high byte is zero means the voice is unused for that
pattern ($0A87 keys it off). The song advances to the next word as soon as
any track hits its end-of-track byte ($0AC0 -> $0A5A -> $0A43).

Event grammar
-------------
Bytes are fetched one at a time by SPC $0BC1 and classified at $0AF1:

    $00         end of track. Inside an $EF call ($80+X != 0) it returns or
                repeats instead ($0ABC/$0ADA); for a voice owned by a sound
                effect (bit set in $22) it releases the voice ($0AC6).
    $01-$7F     note duration in ticks, kept in $0200+X. If the NEXT byte
                is also < $80 it is a gate/velocity byte: bits 6-4 index
                the 8 gate values at $03E0, bits 3-0 the 16 velocity values
                at $03E8 (SPC $0AFC-$0B0D). Both persist until changed.
    $80-$C7     note. Pitch index = byte & $7F (SPC $08D3), plus the global
                ($50) and per-track ($02F0+X) transposes.
    $C8         tie: SPC $08BF returns without a key-on and the look-ahead
                at $0F5A skips the key-off, so the previous note holds.
    $C9         rest: also no key-on, but the look-ahead keys off ($0F62).
    $CA-$DF     percussion note. SPC $08C3 sets instrument
                ($5F + byte - $CA) and forces pitch index $A4 & $7F = $24.
    $E0-$FA     command; argument counts come from the table at $0E54. The
                dispatcher at $0BAF only tests that byte for zero, but the
                note look-ahead at $0F69 adds it to skip whole commands, so
                it is the real length table.
    $FB-$FF     no jump-table entry ($0E1E is 27 entries wide). Invalid.

Timing
------
The sequencer tick is SPC $0A22, called from the main loop at $0884-$088F
whenever `$51 += tempo * timer0_ticks` carries; timer 0 runs at 500 Hz
($082F), so the tick rate is 500 Hz * tempo/256. Starting a sequence resets
the tempo to $20 ($0A1C) and the first $E7 command replaces it. Songs and
effects are advanced by the same tick, so an effect plays at the tempo of
whatever song is running. sequence_timeline() turns that into seconds.

Usage
-----
    python3 tools/nspc.py --all                 # 33 songs + 125 effects
    python3 tools/nspc.py --song 2 --midi
    python3 tools/nspc.py --sfx 0x0B --spc
    python3 tools/nspc.py --sfx 0x0B --spc --sfx-carrier silent

Outputs under --out (default build/spc):
    songs/song_NN.txt/.json/.mid    one line per event, plus structure
    songs/summary.tsv               per-song counts and timing
    sfx/sfx_NN.txt/.json/.mid/.spc  the same for sound effects
    sfx/index.tsv                   effect -> tracks, instruments, callers
    sfx_table.tsv                   the three SNES-side $80:B7C9 tables
    song_callsites.tsv              every call into the play-song routines

The MIDI export is lossy on purpose; see docs/audio.md.
"""

import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lorom import file_to_snes, fmt_file, fmt_snes  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from spc_extract import (INSTRUMENT_COUNT, SONG_COUNT, SONG_ID_BASE,  # noqa: E402
                         base_ram, make_spc, songs)

SEQ_TABLE = 0x3AFE            # SPC; read at $1169/$116D and $09D0/$09D4
ARG_TABLE = 0x0E54            # SPC; = $0DF4 + $60 = $0D74 + $E0
JUMP_TABLE = 0x0E1E           # SPC; = $0D5E + (2*$E0 & $FF)
CURVE_GATE = 0x03E0           # SPC
CURVE_VEL = 0x03E8            # SPC
SONG_SLOT = 0x6502            # SPC; sub_spc_upload_song's fixed destination
SFX_BLOCK = (0x3B00, 0x6502)  # SPC; the $96:8000 block, 10,754 bytes
SFX_ID_MAX = 0x7D
SONG_ID = 0x7E

# Sequencer timing, all read out of the driver's main loop.
TIMER0_HZ = 500.0             # 8 kHz / $10, the divider set at SPC $082F
RESET_TEMPO = 0x20            # SPC $0A1C, on every sequence start
SOUND_ROOM_TEMPO = 0x25       # song 0's $E7, what effects run at there
# The first sequencer tick of a freshly built .spc, measured by watching
# SPC $5E in tools/spcrender: three ticks at the power-on tempo $10 (32 ms
# each: idle, start, voice reset), one at $20 (16 ms), then pattern load.
SEQ_START_S = 0.117
FADE_MS = 10000               # looping songs: fade after two passes
SONG_TAIL_S = 2.0             # non-looping songs: room for release and echo
SFX_TAIL_S = 0.1              # effects: release is 8 ms; this is headroom
LOOP_FOREVER_MIN = 0x81       # SPC $0A4B-$0A4F: see pattern_order()

# SNES side, bank $80. Three entry points share one body: all take the id
# in a 16-bit A, upload the song when it is not the one in $1004, and differ
# only in whether they then write $7E to port 0.
SONG_PLAY = 0x0034AC          # $80:B4AC  upload if needed, then start
SONG_RESTART = 0x0034F1       # $80:B4F1  start without uploading
SONG_PRELOAD = 0x003521       # $80:B521  upload without starting
SONG_ENTRIES = [(SONG_PLAY, "play"), (SONG_RESTART, "restart"),
                (SONG_PRELOAD, "preload")]
# Call sites that do not load a constant id, and where it comes from.
COMPUTED_SONG_SITES = {
    "$83:BA26": "SOUND ROOM BGM: id = $7E + the selected number "
                "($83:BA20-$83:BA23)",
    "$87:8580": "script opcode: id is the next byte of the stream at [$D0] "
                "($87:8579-$87:857D)",
}

# SNES side, bank $80. sub_spc_sfx_trigger is a JSL with 16-bit A and X.
SFX_TRIGGER = 0x003542        # $80:B542
SFX_SLOTS = 0x0037C9          # $80:B7C9
SFX_IDS = 0x003847            # $80:B847
SFX_PRIORITY = 0x0038C5       # $80:B8C5
SFX_TABLE_LEN = 126

# Argument counts as they stand in this ROM's driver; parse_track reads the
# live table and refuses to run if it has moved, so a different driver
# fails loudly instead of decoding into noise.
EXPECTED_ARGS = [1, 1, 2, 3, 0, 1, 2, 1, 2, 1, 1, 3, 0, 1, 2, 3,
                 1, 3, 3, 0, 1, 3, 0, 3, 3, 3, 1]

# cmd -> (name, [argument names], handler address, what the handler does).
# Every entry was read at its handler; where the mechanism is clear but the
# conventional name is a guess, the note says so.
COMMANDS = {
    0xE0: ("instrument", ["instrument"], 0x0BCB,
           "index*6 + $0600; bytes 0-3 -> DSP SRCN/ADSR1/ADSR2/GAIN, 4-5 -> pitch scaler"),
    0xE1: ("pan", ["pan"], 0x0C24,
           "raw byte -> $0351+X, low 5 bits -> $0331+X; bits 7-6 are phase-invert flags"),
    0xE2: ("pan_fade", ["duration", "target"], 0x0C32,
           "slope (target-current)/duration -> $0340+X"),
    0xE3: ("vibrato_on", ["delay", "rate", "depth"], 0x0C4B,
           "$02B0+X delay, $02A1+X rate, $B1+X/$02C1+X depth"),
    0xE4: ("vibrato_off", [], 0x0C57,
           "same three variables cleared (handler entered with A = 0)"),
    0xE5: ("master_volume", ["volume"], 0x0C72, "$59, the global volume"),
    0xE6: ("master_volume_fade", ["duration", "target"], 0x0C77,
           "slope into $5C, applied per tick at $0B4C"),
    0xE7: ("tempo", ["tempo"], 0x0C89,
           "$53; the tick rate is 500 Hz * tempo/256 (timer 0 divisor $10 at $082F)"),
    0xE8: ("tempo_fade", ["duration", "target"], 0x0C8E, "slope into $56"),
    0xE9: ("transpose_global", ["semitones"], 0x0CA0,
           "$50, added to every note at $08D6"),
    0xEA: ("transpose_track", ["semitones"], 0x0CA3,
           "$02F0+X, added to this voice's notes at $08D9"),
    0xEB: ("tremolo_on", ["delay", "rate", "depth"], 0x0CA7,
           "$02E0+X delay, $02D1+X rate, $C1+X depth"),
    0xEC: ("tremolo_off", [], 0x0CB3, "depth cleared"),
    0xED: ("track_volume", ["volume"], 0x0CD4, "$0301+X"),
    0xEE: ("track_volume_fade", ["duration", "target"], 0x0CDD,
           "slope into $0310+X"),
    0xEF: ("call", ["addr_lo", "addr_hi", "repeats"], 0x0CFA,
           "saves $30/$31+X to $0230+X, jumps to the target, repeats counted in $80+X"),
    0xF0: ("vibrato_fade_in", ["duration"], 0x0C62,
           "depth/duration -> $02C0+X, a per-tick vibrato ramp"),
    0xF1: ("pitch_slide_up", ["delay", "duration", "semitones"], 0x0CB6,
           "target = note + semitones; slide starts at the written note ($0290+X = 1)"),
    0xF2: ("pitch_slide_into", ["delay", "duration", "semitones"], 0x0CBA,
           "$0290+X = 0, so $0912 first drops the note by semitones and slides up into it"),
    0xF3: ("pitch_slide_off", [], 0x0CD0, "$0280+X = 0 disables the slide"),
    0xF4: ("fine_tune", ["fraction"], 0x0CF6,
           "$0381+X, the fractional part of the pitch ($0360+X at $08DF)"),
    0xF5: ("echo_on", ["voice_mask", "volume_l", "volume_r"], 0x0D1D,
           "$4A voice mask, $61/$63 volumes, clears FLG bit 5 to enable echo writes"),
    0xF6: ("echo_off", [], 0x0D51, "volumes zeroed, FLG bit 5 set"),
    0xF7: ("echo_params", ["delay", "feedback", "fir_preset"], 0x0D58,
           "delay -> EDL via $0D7A, feedback -> $4E, preset*8 indexes the FIR table at $10DE"),
    0xF8: ("echo_volume_fade", ["duration", "target_l", "target_r"], 0x0D30,
           "slopes into $64/$66"),
    0xF9: ("pitch_slide_to", ["delay", "duration", "note"], 0x0DCF,
           "portamento to an absolute note; also pre-scanned after a note at $0DC5"),
    0xFA: ("percussion_base", ["instrument"], 0x0DBC,
           "$5F, the instrument $CA maps to (SPC $0BD5)"),
}

MAX_WORDS = 512               # word-list guard
MAX_TRACK_BYTES = 0x4000      # per-track guard


def u16(mem, addr):
    return mem[addr] | (mem[addr + 1] << 8)


def _check_tables(ram):
    got = list(ram[ARG_TABLE:ARG_TABLE + len(EXPECTED_ARGS)])
    if got != EXPECTED_ARGS:
        raise ValueError(
            "the command length table at SPC ${:04X} is not this driver's "
            "(got {}). Refusing to decode.".format(
                ARG_TABLE, " ".join("{:02X}".format(b) for b in got)))
    for i, cmd in enumerate(sorted(COMMANDS)):
        want = COMMANDS[cmd][2]
        got = u16(ram, JUMP_TABLE + 2 * i)
        if got != want:
            raise ValueError(
                "command ${:02X} dispatches to ${:04X}, expected ${:04X}".format(
                    cmd, got, want))


# --------------------------------------------------------------------------
# track and song parsing


def _ev(addr, raw, kind, text, **kw):
    d = {"addr": addr, "raw": list(raw), "kind": kind, "text": text}
    d.update(kw)
    return d


def parse_track(ram, start, bounds=None):
    """Decode one track. Returns (events, error_or_None).

    `bounds` is an optional (lo, hi) the track and any $EF target must stay
    inside; violations are reported, not raised.
    """
    events = []
    addr = start
    error = None
    while True:
        if addr >= 0x10000 or addr - start > MAX_TRACK_BYTES:
            error = "ran off the end at ${:04X} without an end-of-track".format(addr)
            break
        if bounds and not (bounds[0] <= addr < bounds[1]):
            error = "address ${:04X} is outside the sequence block".format(addr)
            break
        b = ram[addr]
        if b == 0x00:
            events.append(_ev(addr, [b], "end", "end of track"))
            break
        if b <= 0x7F:
            raw = [b]
            gate = vel = None
            nxt = ram[addr + 1]
            if nxt <= 0x7F:
                raw.append(nxt)
                gate = (nxt >> 4) & 0x07
                vel = nxt & 0x0F
            text = "duration {}".format(b)
            if gate is not None:
                text += ", gate {} (${:02X}), velocity {} (${:02X})".format(
                    gate, ram[CURVE_GATE + gate], vel, ram[CURVE_VEL + vel])
            events.append(_ev(addr, raw, "duration", text,
                              duration=b, gate=gate, velocity=vel))
            addr += len(raw)
            continue
        if b <= 0xC7:
            n = b & 0x7F
            events.append(_ev(addr, [b], "note",
                              "note {} ({}{})".format(n, NOTE_NAMES[n % 12], n // 12),
                              note=n))
            addr += 1
            continue
        if b == 0xC8:
            events.append(_ev(addr, [b], "tie", "tie (hold the previous note)"))
            addr += 1
            continue
        if b == 0xC9:
            events.append(_ev(addr, [b], "rest", "rest"))
            addr += 1
            continue
        if b <= 0xDF:
            k = b - 0xCA
            events.append(_ev(addr, [b], "percussion",
                              "percussion {} (instrument $5F+{})".format(k, k),
                              percussion=k))
            addr += 1
            continue
        if b in COMMANDS:
            name, argnames, handler, _ = COMMANDS[b]
            argc = ram[ARG_TABLE + b - 0xE0]
            args = list(ram[addr + 1:addr + 1 + argc])
            raw = [b] + args
            text = "{}".format(name)
            if b == 0xE0 and argc == 1 and args[0] >= 0x80:
                # SPC $0BCF: bit 7 set takes the percussion path, so the
                # instrument is $5F + (arg - $CA), not arg itself.
                text += " percussion base+{} (${:02X})".format(
                    args[0] - 0xCA, args[0])
                events.append(_ev(addr, raw, "command", text, command=b,
                                  name=name, args=args,
                                  percussion_relative=args[0] - 0xCA))
                addr += 1 + argc
                continue
            if b == 0xEF and argc == 3:
                target = args[0] | (args[1] << 8)
                text += " ${:04X} x{}".format(target, args[2])
                if bounds and not (bounds[0] <= target < bounds[1]):
                    error = "$EF at ${:04X} targets ${:04X}, outside the block".format(
                        addr, target)
            elif args:
                text += " " + ", ".join(
                    "{}=${:02X}".format(n, v) for n, v in zip(argnames, args))
                if b == 0xF9 and argc == 3:
                    n = args[2] & 0x7F
                    text += " (note {} {}{})".format(
                        n, NOTE_NAMES[n % 12], n // 12)
            events.append(_ev(addr, raw, "command", text,
                              command=b, name=name, args=args))
            addr += 1 + argc
            if error:
                break
            continue
        error = "byte ${:02X} at ${:04X} has no command-table entry".format(b, addr)
        break
    return events, error


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def parse_song(ram, pointer, bounds=None, name=None):
    """Parse one sequence from its word-list pointer.

    Returns a dict with the word list, the patterns it names, the 8 track
    pointers of each, and every track's decoded events. Tracks are keyed by
    their start address so a pattern shared between songs is parsed once.
    """
    out = {"name": name, "pointer": pointer, "bounds": bounds,
           "words": [], "patterns": [], "tracks": {},
           "loops": False, "errors": []}
    if pointer == 0:
        out["errors"].append("null pointer (the 'stop' entry)")
        return out

    p = pointer
    seen = set()
    pattern_addrs = []
    while len(out["words"]) < MAX_WORDS:
        if bounds and not (bounds[0] <= p < bounds[1]):
            out["errors"].append(
                "word list left the block at ${:04X}".format(p))
            break
        if p in seen:
            out["errors"].append("word list revisits ${:04X}".format(p))
            break
        seen.add(p)
        w = u16(ram, p)
        if w == 0:
            out["words"].append({"addr": p, "kind": "end", "value": w})
            break
        if w >> 8:
            out["words"].append({"addr": p, "kind": "pattern", "value": w})
            pattern_addrs.append(w)
            p += 2
        else:
            target = u16(ram, p + 2)
            out["words"].append({"addr": p, "kind": "loop", "value": w,
                                 "count": w & 0xFF, "target": target})
            out["loops"] = True
            p += 4
    else:
        out["errors"].append("word list exceeded {} words".format(MAX_WORDS))

    for a in pattern_addrs:
        if any(pt["addr"] == a for pt in out["patterns"]):
            continue
        tracks = [u16(ram, a + 2 * i) for i in range(8)]
        out["patterns"].append({"addr": a, "tracks": tracks})
        if bounds and not (bounds[0] <= a < bounds[1] - 16):
            out["errors"].append(
                "pattern ${:04X} is outside the block".format(a))

    pending = []
    for pat in out["patterns"]:
        for t in pat["tracks"]:
            if t >> 8:
                pending.append(t)
    while pending:
        t = pending.pop(0)
        if t in out["tracks"]:
            continue
        events, err = parse_track(ram, t, bounds)
        out["tracks"][t] = {"addr": t, "events": events, "error": err,
                            "end": events[-1]["addr"] if events else t}
        if err:
            out["errors"].append("track ${:04X}: {}".format(t, err))
        for e in events:
            if e["kind"] == "command" and e["command"] == 0xEF:
                tgt = e["args"][0] | (e["args"][1] << 8)
                if tgt >> 8 and tgt not in out["tracks"]:
                    pending.append(tgt)
    return out


def song_stats(song):
    """Counts, plus the instrument indices actually reachable.

    Percussion events and $E0 arguments >= $80 name an instrument relative
    to the percussion base set by $FA, so they are resolved against every
    base the sequence sets (SPC $0BD1-$0BD5).
    """
    instr = set()
    rel = set()
    bases = set()
    tempos = []
    notes = 0
    events = 0
    for t in sorted(song["tracks"]):
        for e in song["tracks"][t]["events"]:
            events += 1
            if e["kind"] in ("note", "percussion"):
                notes += 1
                if e["kind"] == "percussion":
                    rel.add(e["percussion"])
            elif e["kind"] == "command":
                if e["command"] == 0xE0:
                    if "percussion_relative" in e:
                        rel.add(e["percussion_relative"])
                    else:
                        instr.add(e["args"][0])
                elif e["command"] == 0xE7:
                    tempos.append(e["args"][0])
                elif e["command"] == 0xFA:
                    bases.add(e["args"][0])
    resolved = set()
    for base in (bases or set([0])):
        for k in rel:
            resolved.add(base + k)
    voices = set()
    for pat in song["patterns"]:
        for i, t in enumerate(pat["tracks"]):
            if t >> 8:
                voices.add(i)
    return {"instruments": sorted(instr), "tempos": tempos, "notes": notes,
            "events": events, "voices": sorted(voices),
            "percussion_base": sorted(bases),
            "percussion_instruments": sorted(resolved)}


# --------------------------------------------------------------------------
# text and json output


def write_text(song, path, title):
    lines = [title,
             "pointer ${:04X}".format(song["pointer"])]
    if song["bounds"]:
        lines.append("block   ${:04X}..${:04X}".format(*song["bounds"]))
    st = song_stats(song)
    lines.append("voices  {}".format(
        ", ".join(str(v) for v in st["voices"]) or "none"))
    lines.append("")
    lines.append("word list")
    for w in song["words"]:
        if w["kind"] == "pattern":
            lines.append("  ${:04X}  {:04X}       pattern ${:04X}".format(
                w["addr"], w["value"], w["value"]))
        elif w["kind"] == "loop":
            lines.append("  ${:04X}  {:04X} {:04X}  repeat {} -> ${:04X}".format(
                w["addr"], w["value"], w["target"], w["count"], w["target"]))
        else:
            lines.append("  ${:04X}  0000       end of song".format(w["addr"]))
    lines.append("")
    for pat in song["patterns"]:
        lines.append("pattern ${:04X}".format(pat["addr"]))
        for i, t in enumerate(pat["tracks"]):
            lines.append("  voice {}  {}".format(
                i, "${:04X}".format(t) if t >> 8 else "unused"))
    lines.append("")
    for t in sorted(song["tracks"]):
        tr = song["tracks"][t]
        lines.append("track ${:04X}".format(t))
        for e in tr["events"]:
            lines.append("  ${:04X}  {:<14} {}".format(
                e["addr"], " ".join("{:02X}".format(b) for b in e["raw"]),
                e["text"]))
        if tr["error"]:
            lines.append("  !! {}".format(tr["error"]))
        lines.append("")
    if song["errors"]:
        lines.append("errors")
        for e in song["errors"]:
            lines.append("  {}".format(e))
        lines.append("")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def write_json(song, path):
    doc = dict(song)
    doc["tracks"] = [song["tracks"][t] for t in sorted(song["tracks"])]
    doc["stats"] = song_stats(song)
    with open(path, "w") as f:
        json.dump(doc, f, indent=1, sort_keys=True)
        f.write("\n")


# --------------------------------------------------------------------------
# MIDI export
#
# Lossy by construction: vibrato, tremolo, pitch slides, echo, the pitch
# scaler and the per-instrument tuning are all dropped. What survives is
# note, time, gate, velocity, instrument changes, volume and pan.

DIVISION = 48            # MIDI ticks per quarter note
TICK_RATE_HZ = 500.0     # SPC timer 0: 8 kHz / $10 (SPC $082F)


def _vlq(n):
    out = bytearray([n & 0x7F])
    n >>= 7
    while n:
        out.insert(0, 0x80 | (n & 0x7F))
        n >>= 7
    return bytes(out)


def _mtrk(events):
    """events: list of (abstime, priority, bytes). Returns a chunk."""
    events.sort(key=lambda e: (e[0], e[1]))
    body = bytearray()
    last = 0
    for t, _, data in events:
        body += _vlq(t - last)
        body += data
        last = t
    body += b"\x00\xFF\x2F\x00"          # end of track
    return b"MTrk" + struct.pack(">I", len(body)) + bytes(body)


def _render_track(ram, addr, bounds, base_tick, note_base):
    """Walk one track, returning (notes, end_tick, ctrl) where notes is a
    list of (start, length, note, velocity, percussion) in sequencer ticks."""
    notes = []
    ctrl = []
    t = base_tick
    duration = 1
    gate = 0x7F
    vel = 0xFC
    stack = []
    addr0 = addr
    guard = 0
    last = None
    while guard < 20000:
        guard += 1
        if addr >= 0x10000 or (bounds and not (bounds[0] <= addr < bounds[1])):
            break
        b = ram[addr]
        if b == 0x00:
            if stack:
                target, ret, left = stack.pop()
                if left > 1:
                    stack.append((target, ret, left - 1))
                    addr = target
                else:
                    addr = ret
                continue
            break
        if b <= 0x7F:
            duration = b
            if ram[addr + 1] <= 0x7F:
                g = ram[addr + 1]
                gate = ram[CURVE_GATE + ((g >> 4) & 7)]
                vel = ram[CURVE_VEL + (g & 0x0F)]
                addr += 1
            addr += 1
            continue
        if b <= 0xC7 or (0xCA <= b <= 0xDF):
            perc = b >= 0xCA
            n = 35 + (b - 0xCA) if perc else (b & 0x7F) + note_base
            length = max(1, (duration * gate) >> 8)
            last = len(notes)
            notes.append([t, length, max(0, min(127, n)),
                          max(1, min(127, vel >> 1)), perc])
            t += duration
            addr += 1
            continue
        if b == 0xC8:                      # tie: extend the held note
            if last is not None:
                notes[last][1] += duration
            t += duration
            addr += 1
            continue
        if b == 0xC9:
            t += duration
            addr += 1
            last = None
            continue
        if b in COMMANDS:
            argc = ram[ARG_TABLE + b - 0xE0]
            args = list(ram[addr + 1:addr + 1 + argc])
            if b == 0xEF and argc == 3:
                target = args[0] | (args[1] << 8)
                if target >> 8 and len(stack) < 8:
                    stack.append((target, addr + 4, max(1, args[2])))
                    addr = target
                    continue
            elif b in (0xE1, 0xED, 0xE7) or (b == 0xE0 and args[0] < 0x80):
                ctrl.append((t, b, args[0]))
            addr += 1 + argc
            continue
        break
    return notes, t, ctrl


def write_midi(ram, song, path, note_base=24, max_patterns=64):
    """Type 1 SMF, one track per DSP voice, written with struct alone."""
    order = []
    counts = {}
    i = 0
    while i < len(song["words"]) and len(order) < max_patterns:
        w = song["words"][i]
        if w["kind"] == "pattern":
            order.append(w["value"])
            i += 1
        elif w["kind"] == "loop":
            n = counts.get(w["addr"], 0)
            back = [j for j, x in enumerate(song["words"])
                    if x["addr"] == w["target"]]
            if n < 1 and back:
                counts[w["addr"]] = n + 1
                i = back[0]
            else:
                i += 1
        else:
            break

    pat = dict((p["addr"], p["tracks"]) for p in song["patterns"])
    voice_notes = dict((v, []) for v in range(8))
    voice_ctrl = dict((v, []) for v in range(8))
    tempo = 0x20
    base = 0
    for a in order:
        tracks = pat.get(a)
        if not tracks:
            continue
        ends = []
        for v, tp in enumerate(tracks):
            if not tp >> 8:
                continue
            notes, end, ctrl = _render_track(
                ram, tp, song["bounds"], base, note_base)
            voice_notes[v].append(notes)
            voice_ctrl[v].extend(ctrl)
            for _, cmd, val in ctrl:
                if cmd == 0xE7:
                    tempo = val
            ends.append(end)
        cut = min(ends) if ends else base
        for v in range(8):
            if voice_notes[v] and voice_notes[v][-1]:
                voice_notes[v][-1] = [n for n in voice_notes[v][-1]
                                      if n[0] < cut]
        base = cut

    chunks = []
    name = (song["name"] or "sequence").encode("ascii", "replace")[:60]
    usec = int(round(1e6 * DIVISION * 256.0 / (TICK_RATE_HZ * max(1, tempo))))
    meta = [(0, 0, b"\xFF\x03" + _vlq(len(name)) + name),
            (0, 0, b"\xFF\x51\x03" + struct.pack(">I", usec)[1:])]
    chunks.append(_mtrk(meta))

    used = 0
    total_notes = 0
    for v in range(8):
        flat = [n for chunk in voice_notes[v] for n in chunk]
        if not flat and not voice_ctrl[v]:
            continue
        used += 1
        ch = v if v < 9 else v + 1
        vname = "voice {}".format(v).encode("ascii")
        ev = [(0, 0, b"\xFF\x03" + _vlq(len(vname)) + vname)]
        for t, cmd, val in sorted(voice_ctrl[v]):
            if cmd == 0xE0:
                ev.append((t, 1, bytes([0xC0 | ch, val & 0x7F])))
            elif cmd == 0xE1:
                ev.append((t, 1, bytes([0xB0 | ch, 10,
                                        min(127, (val & 0x1F) * 127 // 20)])))
            elif cmd == 0xED:
                ev.append((t, 1, bytes([0xB0 | ch, 7, val >> 1])))
        for start, length, note, vel, perc in flat:
            c = 9 if perc else ch
            ev.append((start, 2, bytes([0x90 | c, note, vel])))
            ev.append((start + length, 0, bytes([0x80 | c, note, 0])))
            total_notes += 1
        chunks.append(_mtrk(ev))

    hdr = b"MThd" + struct.pack(">IHHH", 6, 1, len(chunks), DIVISION)
    with open(path, "wb") as f:
        f.write(hdr)
        for c in chunks:
            f.write(c)
    return used, total_notes


def count_midi_notes(path):
    """Read a file back and count note-ons, so the writer is checked against
    its own output rather than trusted. Returns (tracks, note_ons)."""
    with open(path, "rb") as f:
        d = f.read()
    if d[:4] != b"MThd":
        raise ValueError("{}: not a MIDI file".format(path))
    ntrk = struct.unpack(">H", d[10:12])[0]
    off = 8 + struct.unpack(">I", d[4:8])[0]
    notes = 0
    for _ in range(ntrk):
        if d[off:off + 4] != b"MTrk":
            raise ValueError("{}: missing MTrk at {}".format(path, off))
        n = struct.unpack(">I", d[off + 4:off + 8])[0]
        body = d[off + 8:off + 8 + n]
        if not body.endswith(b"\x00\xFF\x2F\x00"):
            raise ValueError("{}: track has no end-of-track".format(path))
        i = 0
        while i < len(body):
            while body[i] & 0x80:       # variable-length delta
                i += 1
            i += 1
            s = body[i]
            i += 1
            if s == 0xFF:
                i += 1
                ln = 0
                while body[i] & 0x80:
                    ln = (ln << 7) | (body[i] & 0x7F)
                    i += 1
                ln = (ln << 7) | body[i]
                i += 1 + ln
            elif s & 0xF0 in (0xC0, 0xD0):
                i += 1
            else:
                if s & 0xF0 == 0x90 and body[i + 1]:
                    notes += 1
                i += 2
        off += 8 + n
    return ntrk, notes


# --------------------------------------------------------------------------
# timing: the pattern order the driver actually plays, and a tick timeline


def pattern_order(ram, pointer, loops=2, bounds=None, max_patterns=4096):
    """Walk a word list the way SPC $0A43-$0A5A does and return the
    patterns in playing order.

    A repeat word's low byte is a count kept in $42:

        $0A4B  DEC $42
        $0A4D  BPL $0A51      ; still counting down
        $0A4F  MOV $42,A      ; went negative: (re)load the count
        $0A51  CALL $09B9     ; read the jump target
        $0A54  MOV X,$42
        $0A56  BEQ $0A43      ; reached zero: carry on with the next word
        $0A58  MOVW $40,YA    ; otherwise jump

    $42 is zero when a song starts ($0A0F), so the first visit decrements
    it to $FF and loads the count. A count of $01-$7F then jumps that many
    times. A count of $81 or more decrements to a value that is still
    negative, so it is reloaded on every visit and the jump is taken
    forever. Every looping song in this ROM uses $C8, which reads as "200"
    but never runs out. ($80 would jump 128 times.)

    Returns a dict:
        order    pattern addresses, the repeating part given `loops` times
        intro    how many leading entries are played once
        loop     length of the repeating part, 0 if the song ends
        ended    True if the list reached its $0000 terminator
        error    None, or why the walk stopped early
    """
    out = {"order": [], "intro": 0, "loop": 0, "ended": False, "error": None}
    p = pointer
    counter = 0
    seen = {}
    order = []
    while len(order) < max_patterns:
        if bounds and not (bounds[0] <= p < bounds[1]):
            out["error"] = "word list left the block at ${:04X}".format(p)
            break
        w = u16(ram, p)
        if w >> 8:
            state = (p, counter)
            if state in seen:
                first = seen[state]
                body = order[first:]
                # The first pass through the body runs with $42 still at its
                # start value, so the state repeats one pass late. Fold whole
                # copies of the body back out of the intro.
                while first >= len(body) and order[first - len(body):first] == body:
                    first -= len(body)
                out["intro"] = first
                out["loop"] = len(body)
                out["order"] = order[:first] + body * loops
                return out
            seen[state] = len(order)
            order.append(w)
            p += 2
            continue
        if w == 0:
            out["ended"] = True
            break
        counter = (counter - 1) & 0xFF
        if counter & 0x80:
            counter = w & 0xFF
        target = u16(ram, p + 2)
        p += 4
        if counter:
            p = target
    else:
        out["error"] = "more than {} patterns without repeating".format(
            max_patterns)
    out["order"] = order
    out["intro"] = len(order)
    return out


def tick_clock(tempos, initial=RESET_TEMPO):
    """Return f(tick) -> seconds after tick 0, given (tick, tempo) changes.

    One tick lasts 256 / (500 * tempo) seconds. A tempo command read on tick
    t sets the length of the interval that follows t.
    """
    changes = []
    cur = initial
    for t, val in sorted(set(tempos)):
        if val != cur and val:
            changes.append((t, val))
            cur = val
    marks = [(0, 0.0, initial)]          # (tick, seconds at tick, tempo after)
    for t, val in changes:
        t0, s0, tempo = marks[-1]
        marks.append((t, s0 + (t - t0) * 256.0 / (TIMER0_HZ * tempo), val))

    def seconds(tick):
        lo, hi = 0, len(marks) - 1
        while lo < hi:                     # last mark at or before tick
            mid = (lo + hi + 1) // 2
            if marks[mid][0] <= tick:
                lo = mid
            else:
                hi = mid - 1
        t0, s0, tempo = marks[lo]
        return s0 + (tick - t0) * 256.0 / (TIMER0_HZ * tempo)

    return seconds


def sequence_timeline(ram, song, loops=2, sfx=False, tempo=RESET_TEMPO):
    """Every note-on of a parsed sequence, by sequencer tick.

    For a song the patterns are laid end to end in pattern_order(); each
    one lasts until its first track reaches end-of-track ($0AC0), and the
    next pattern's first events are read on that same tick. An effect is a
    single pattern whose tracks each run to their own end ($0AC6), so it
    lasts as long as its longest track; pass sfx=True and the tempo of the
    song it is played over.

    Returns a dict:
        order        pattern addresses as played
        starts       the tick each of them starts on, plus the final tick
        notes        (tick, voice, is_percussion, pitch index or drum number)
        tempos       (tick, tempo) for every $E7 reached
        seconds      f(tick) -> seconds after the first tick
        loops        True if the song repeats forever
        intro_ticks  ticks before the repeating part (all of it if none)
        loop_ticks   ticks in one pass of the repeating part, else 0
        end_tick     last tick of what was laid out
        error        None, or why the layout stopped early
    """
    bounds = song["bounds"]
    known = dict((p["addr"], p["tracks"]) for p in song["patterns"])
    if sfx:
        walk = {"order": [p["addr"] for p in song["patterns"][:1]],
                "intro": 1, "loop": 0, "ended": True, "error": None}
    else:
        walk = pattern_order(ram, song["pointer"], loops, bounds)
    notes = []
    tempos = []
    starts = []
    error = walk["error"]
    base = 0
    for a in walk["order"]:
        starts.append(base)
        tracks = known.get(a) or [u16(ram, a + 2 * i) for i in range(8)]
        voices = []
        ends = []
        for v, tp in enumerate(tracks):
            if not tp >> 8:
                continue
            ns, end, ctrl = _render_track(ram, tp, bounds, base, 0)
            voices.append((v, ns, ctrl))
            ends.append(end)
        if not ends:
            error = "pattern ${:04X} has no tracks, so it never ends".format(a)
            break
        cut = max(ends) if sfx else min(ends)
        for v, ns, ctrl in voices:
            for start, _, pitch, _, perc in ns:
                if start < cut:
                    notes.append((start, v, perc, pitch))
            for t, cmd, val in ctrl:
                if cmd == 0xE7 and t <= cut:
                    tempos.append((t, val))
        base = cut
    starts.append(base)
    notes.sort()
    intro, loop = walk["intro"], walk["loop"]
    looping = bool(loop) and len(starts) > intro + loop
    return {
        "order": walk["order"], "starts": starts, "notes": notes,
        "tempos": sorted(set(tempos)),
        "seconds": tick_clock(tempos, tempo),
        "loops": looping,
        "intro_ticks": starts[intro] if looping else base,
        "loop_ticks": starts[intro + loop] - starts[intro] if looping else 0,
        "end_tick": base,
        "error": error,
    }


def sequence_length(tl, sfx=False):
    """Play length for the ID666 tag, from a sequence_timeline(loops=2).

    Looping songs: the intro and two passes of the loop, then a fade.
    Songs that end: the natural end plus room for release and echo, no fade.
    Effects: the end of the longest track, no fade. The tag is in whole
    seconds, so everything is rounded up; the exact figures are returned
    alongside.
    """
    sec = tl["seconds"]
    if tl["loops"]:
        intro_s = sec(tl["intro_ticks"])
        loop_s = sec(tl["intro_ticks"] + tl["loop_ticks"]) - intro_s
        play_s = SEQ_START_S + sec(tl["intro_ticks"] + 2 * tl["loop_ticks"])
        fade_ms = FADE_MS
    else:
        intro_s = sec(tl["end_tick"])
        loop_s = 0.0
        play_s = SEQ_START_S + intro_s + (SFX_TAIL_S if sfx else SONG_TAIL_S)
        fade_ms = 0
    length_s = max(1, int(-(-play_s // 1)))
    return {"length_s": length_s, "fade_ms": fade_ms, "play_s": play_s,
            "intro_s": intro_s, "loop_s": loop_s, "loops": tl["loops"]}


def song_length(rom, ram, n):
    """(timeline, length) for song n, straight from the ROM."""
    sram, span = song_ram(rom, ram, n)
    song = parse_song(sram, u16(sram, SEQ_TABLE + 2 * SONG_ID),
                      span or (SONG_SLOT, 0x10000))
    tl = sequence_timeline(sram, song, loops=2)
    return tl, sequence_length(tl)


def carrier_tempo(rom, ram, carrier="song0"):
    """The tempo an effect is advanced at over the given carrier."""
    if carrier != "song0":
        return RESET_TEMPO
    tl, _ = song_length(rom, ram, 0)
    tempo = tl["tempos"][-1][1] if tl["tempos"] else RESET_TEMPO
    if tempo != SOUND_ROOM_TEMPO:
        raise ValueError(
            "song 0 sets tempo ${:02X}, expected ${:02X}".format(
                tempo, SOUND_ROOM_TEMPO))
    return tempo


# --------------------------------------------------------------------------
# sound effects: the SNES trigger tables and a playable .spc per effect

# The old carrier: a silent song planted at the song slot so the sequencer
# keeps ticking while an effect plays. SPC $0A3A returns immediately when
# $04 (the current song) is zero, so port 0 must name *something*; a
# one-word list pointing at an all-unused pattern is the smallest thing that
# qualifies. It has no $E7, so effects run at the reset tempo $20, and no
# $E5, so they play at the reset master volume $C0. The game never does
# this; see make_sfx_spc.
SILENT_SONG = struct.pack("<HH", SONG_SLOT + 6, 0x0000) + b"\x00" * 16


def sfx_tables(rom):
    """The three parallel 126-byte tables sub_spc_sfx_trigger indexes by id."""
    rows = []
    for i in range(SFX_TABLE_LEN):
        rows.append({"id": i,
                     "slots": rom[SFX_SLOTS + i],
                     "cmp": rom[SFX_IDS + i],
                     "priority": rom[SFX_PRIORITY + i]})
    return rows


def sfx_call_sites(rom):
    """Every JSL $80:B542 whose id is a preceding LDA #$00xx.

    A is 16 bits at the call (sub_spc_sfx_trigger does TAX with X 16-bit
    and $80:B5A9 masks the result with #$00FF), so the id load is the
    3-byte immediate form.
    """
    b, a = file_to_snes(SFX_TRIGGER)
    pat = bytes([0x22, a & 0xFF, a >> 8, b])
    sites = []
    i = 0
    while True:
        j = rom.find(pat, i)
        if j < 0:
            break
        i = j + 1
        sid = None
        if j >= 3 and rom[j - 3] == 0xA9 and rom[j - 1] == 0x00:
            sid = rom[j - 2]
        b, a = file_to_snes(j)
        sites.append({"offset": j, "snes": fmt_snes(b, a), "id": sid})
    return sites


def write_sfx_table(rom, path, sites):
    by_id = {}
    for s in sites:
        if s["id"] is not None:
            by_id.setdefault(s["id"], []).append(s["snes"])
    rows = ["\t".join(["id", "slot_mask", "slots", "compare_value",
                       "priority", "call_sites", "callers"])]
    for r in sfx_tables(rom):
        slots = ",".join(str(k) for k in range(3) if r["slots"] >> k & 1)
        calls = by_id.get(r["id"], [])
        rows.append("\t".join([
            "${:02X}".format(r["id"]), "${:02X}".format(r["slots"]),
            slots or "-", "${:02X}".format(r["cmp"]),
            "${:02X}".format(r["priority"]), str(len(calls)),
            " ".join(calls) or "-"]))
    with open(path, "w") as f:
        f.write("\n".join(rows) + "\n")


def song_call_sites(rom):
    """Every JSL into the three play-song entry points, bank $80.

    Like sfx_call_sites: A is 16 bits at the call ($80:B4B5 masks it with
    #$00FF itself), so a constant id is the 3-byte `LDA #$00xx` directly
    before the JSL. Anything else computes the id and is reported with
    id None.
    """
    sites = []
    for entry, kind in SONG_ENTRIES:
        b, a = file_to_snes(entry)
        pat = bytes([0x22, a & 0xFF, a >> 8, b])
        i = 0
        while True:
            j = rom.find(pat, i)
            if j < 0:
                break
            i = j + 1
            sid = None
            if j >= 3 and rom[j - 3] == 0xA9 and rom[j - 1] == 0x00:
                sid = rom[j - 2]
            sb, sa = file_to_snes(j)
            sites.append({"offset": j, "snes": fmt_snes(sb, sa), "id": sid,
                          "kind": kind, "entry": fmt_snes(b, a),
                          "before": " ".join("{:02X}".format(x)
                                             for x in rom[j - 6:j])})
    sites.sort(key=lambda s: s["offset"])
    return sites


def write_song_callsites(rom, path):
    """build/spc/song_callsites.tsv: which code starts which song.

    The id is what the SNES passes: 0 stops the music, $7E + n is song n.
    SOUND ROOM plays BGM n as id $7E + n ($83:BA20-$83:BA26), so its
    numbering is the song number.
    """
    sites = song_call_sites(rom)
    rows = ["\t".join(["site", "file_offset", "routine", "kind", "id",
                       "song", "bytes_before", "note"])]
    for s in sites:
        if s["id"] is None:
            sid, song = "-", "-"
            note = COMPUTED_SONG_SITES.get(s["snes"], "id computed at run time")
        elif s["id"] == 0:
            sid, song, note = "$00", "-", "stop the music"
        elif SONG_ID_BASE <= s["id"] < SONG_ID_BASE + SONG_COUNT:
            sid = "${:02X}".format(s["id"])
            song = "{:02d}".format(s["id"] - SONG_ID_BASE)
            note = ""
        else:
            sid, song = "${:02X}".format(s["id"]), "-"
            note = "below $7E: ignored by the routine"
        rows.append("\t".join([s["snes"], fmt_file(s["offset"]), s["entry"],
                               s["kind"], sid, song, s["before"], note or "-"]))
    with open(path, "w") as f:
        f.write("\n".join(rows) + "\n")
    return sites


def song_users(sites):
    """song number -> [call-site address], constant ids only."""
    out = {}
    for s in sites:
        if s["id"] is not None and s["id"] >= SONG_ID_BASE:
            out.setdefault(s["id"] - SONG_ID_BASE, []).append(
                s["snes"] if s["kind"] == "play"
                else "{} ({})".format(s["snes"], s["kind"]))
    return out


def make_sfx_spc(rom, ram, sfx_id, title, carrier="song0", length_s=180,
                 fade_ms=10000):
    """A .spc that plays one effect and nothing else.

    Same port-table patch spc_extract.make_spc uses, with the effect id in
    the port-1 slot. The port-0 slot must name a running song or the
    sequencer never ticks (SPC $0A3A), and which song matters, because the
    effect is advanced by that song's tick and scaled by its master volume:

      "song0"   song 0 uploaded to the song slot, exactly as the game's
                SOUND ROOM does before every FGM ($83:BA11 loads id $7E with
                $1004 already $7E from $83:B9BB, then $83:BA1A triggers the
                effect). Song 0 is a 72-tick rest on five muted voices that
                loops forever; its first tick sets tempo $25 and master
                volume $FF. Nothing here is synthetic except the port table.
      "silent"  the old behaviour: a hand-made empty song, which leaves the
                reset tempo $20 and master volume $C0 in force. Effects come
                out 37/32 = 15.6% longer and (192/255)^2 = 0.57x as loud as
                they do in the SOUND ROOM. Kept for comparison only.
    """
    if carrier == "song0":
        image, span = song_ram(rom, ram, 0)
        if span is None:
            raise ValueError("song 0 has no block to upload")
        comment = "sfx ${:02X} over song 0".format(sfx_id)
    elif carrier == "silent":
        image = bytearray(ram)
        n = len(SILENT_SONG)
        if any(image[SONG_SLOT:SONG_SLOT + n]):
            raise ValueError(
                "SPC ${:04X} is not empty in the base image; refusing to "
                "plant the silent song over real data".format(SONG_SLOT))
        image[SONG_SLOT:SONG_SLOT + n] = SILENT_SONG
        comment = "sfx ${:02X}, silent song".format(sfx_id)
    else:
        raise ValueError("unknown carrier {!r}".format(carrier))
    return make_spc(image, SONG_ID, title, sfx_id=sfx_id, comment=comment,
                    length_s=length_s, fade_ms=fade_ms)


# --------------------------------------------------------------------------


def _mkdir(p):
    if not os.path.isdir(p):
        os.makedirs(p)


def _bad_instruments(st, label, count=INSTRUMENT_COUNT):
    """Every instrument a sequence names must exist in the $0600 table."""
    bad = [i for i in st["instruments"] + st["percussion_instruments"]
           if not 0 <= i < count]
    return ["{}: instrument {} is outside the {}-entry table".format(
        label, ", ".join(str(i) for i in bad), count)] if bad else []


def song_ram(rom, ram, n):
    """Base RAM plus song n's block, exactly as sub_spc_upload_song does."""
    out = bytearray(ram)
    span = None
    for i, sid, off, blks in songs(rom):
        if i != n:
            continue
        for ln, addr, data in blks:
            out[addr:addr + ln] = data
            span = (addr, addr + ln)
    return out, span


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--song", type=lambda s: int(s, 0), help="song 0-32")
    ap.add_argument("--sfx", type=lambda s: int(s, 0), help="effect $01-$7D")
    ap.add_argument("--all", action="store_true", help="every song and effect")
    ap.add_argument("-o", "--out", default="build/spc")
    ap.add_argument("--midi", action="store_true", help="also write .mid")
    ap.add_argument("--spc", action="store_true", help="also write per-effect .spc")
    ap.add_argument("--sfx-carrier", choices=("song0", "silent"),
                    default="song0",
                    help="song an effect .spc plays over: song 0 as the "
                         "game's SOUND ROOM does (default), or the old "
                         "synthetic silent song")
    ap.add_argument("--note-base", type=lambda s: int(s, 0), default=24,
                    help="MIDI note for N-SPC note 0 (default 24; the true "
                         "octave depends on each sample's recorded pitch)")
    args = ap.parse_args()

    if args.song is None and args.sfx is None:
        args.all = True

    try:
        rom = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    ram, _ = base_ram(rom)
    try:
        _check_tables(ram)
    except ValueError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    out = args.out
    problems = []

    want_songs = range(SONG_COUNT) if args.all else (
        [args.song] if args.song is not None else [])
    want_sfx = range(1, SFX_ID_MAX + 1) if args.all else (
        [args.sfx] if args.sfx is not None else [])

    if want_songs:
        _mkdir(os.path.join(out, "songs"))
        rows = ["\t".join(["song", "spc_id", "rom", "pointer", "bytes",
                           "patterns", "words", "voices", "tracks",
                           "instruments", "percussion_base",
                           "percussion_instruments", "tempos", "events",
                           "notes", "midi_notes", "loops", "status",
                           "intro_ticks", "loop_ticks", "intro_s", "loop_s",
                           "length_s", "fade_ms", "used_by"])]
        users = song_users(write_song_callsites(
            rom, os.path.join(out, "song_callsites.tsv")))
        for n in want_songs:
            sram, span = song_ram(rom, ram, n)
            ptr = u16(sram, SEQ_TABLE + 2 * SONG_ID)
            bounds = span or (SONG_SLOT, 0x10000)
            song = parse_song(sram, ptr, bounds,
                              name="Kirby's Dream Course song {:02d}".format(n))
            st = song_stats(song)
            tl = sequence_timeline(sram, song, loops=2)
            ln = sequence_length(tl)
            if tl["error"]:
                song["errors"].append(tl["error"])
            base = os.path.join(out, "songs", "song_{:02d}".format(n))
            write_text(song, base + ".txt",
                       "song {:02d}  (SPC id ${:02X})".format(n, SONG_ID_BASE + n))
            write_json(song, base + ".json")
            midi = "-"
            if args.midi:
                _, want = write_midi(sram, song, base + ".mid", args.note_base)
                _, got = count_midi_notes(base + ".mid")
                if got != want:
                    problems.append(
                        "song {:02d}: wrote {} notes, the file holds "
                        "{}".format(n, want, got))
                midi = str(got)
            src = [o for i, s, o, b in songs(rom) if i == n][0]
            b, a = file_to_snes(src)
            rows.append("\t".join([
                "{:02d}".format(n), "${:02X}".format(SONG_ID_BASE + n),
                "{} ({})".format(fmt_snes(b, a), fmt_file(src)),
                "${:04X}".format(ptr), str(bounds[1] - bounds[0]),
                str(len(song["patterns"])), str(len(song["words"])),
                ",".join(str(v) for v in st["voices"]),
                str(len(song["tracks"])),
                ",".join(str(i) for i in st["instruments"]) or "-",
                ",".join(str(i) for i in st["percussion_base"]) or "-",
                ",".join(str(i) for i in st["percussion_instruments"]) or "-",
                ",".join("${:02X}".format(t) for t in st["tempos"]) or "-",
                str(st["events"]), str(st["notes"]), midi,
                "yes" if tl["loops"] else "no",
                "ok" if not song["errors"] else "; ".join(song["errors"]),
                str(tl["intro_ticks"]), str(tl["loop_ticks"]),
                "{:.3f}".format(ln["intro_s"]), "{:.3f}".format(ln["loop_s"]),
                str(ln["length_s"]), str(ln["fade_ms"]),
                " ".join(users.get(n, [])) or "-"]))
            problems.extend(_bad_instruments(st, "song {:02d}".format(n)))
            if song["errors"]:
                problems.append("song {:02d}: {}".format(n, song["errors"][0]))
        with open(os.path.join(out, "songs", "summary.tsv"), "w") as f:
            f.write("\n".join(rows) + "\n")
        print("songs: {} parsed -> {}".format(
            len(want_songs), os.path.join(out, "songs")))

    if want_sfx:
        _mkdir(os.path.join(out, "sfx"))
        sites = sfx_call_sites(rom)
        write_sfx_table(rom, os.path.join(out, "sfx_table.tsv"), sites)
        by_id = {}
        for s in sites:
            if s["id"] is not None:
                by_id.setdefault(s["id"], []).append(s["snes"])
        rows = ["\t".join(["id", "pointer", "patterns", "voices", "tracks",
                           "instruments", "percussion_instruments", "events",
                           "notes", "slot_mask", "priority", "call_sites",
                           "status", "ticks", "tempo", "play_s", "length_s"])]
        tempo = carrier_tempo(rom, ram, args.sfx_carrier)
        for sid in want_sfx:
            ptr = u16(ram, SEQ_TABLE + 2 * sid)
            song = parse_song(ram, ptr, SFX_BLOCK,
                              name="Kirby's Dream Course sfx ${:02X}".format(sid))
            st = song_stats(song)
            tl = sequence_timeline(ram, song, sfx=True, tempo=tempo)
            ln = sequence_length(tl, sfx=True)
            if tl["error"]:
                song["errors"].append(tl["error"])
            base = os.path.join(out, "sfx", "sfx_{:02X}".format(sid))
            write_text(song, base + ".txt", "sfx ${:02X}".format(sid))
            write_json(song, base + ".json")
            if args.midi:
                _, want = write_midi(ram, song, base + ".mid", args.note_base)
                _, got = count_midi_notes(base + ".mid")
                if got != want:
                    problems.append(
                        "sfx ${:02X}: wrote {} notes, the file holds "
                        "{}".format(sid, want, got))
            if args.spc:
                with open(base + ".spc", "wb") as f:
                    f.write(make_sfx_spc(
                        rom, ram, sid, "SFX ${:02X}".format(sid),
                        carrier=args.sfx_carrier, length_s=ln["length_s"],
                        fade_ms=ln["fade_ms"]))
            rows.append("\t".join([
                "${:02X}".format(sid), "${:04X}".format(ptr),
                str(len(song["patterns"])),
                ",".join(str(v) for v in st["voices"]),
                str(len(song["tracks"])),
                ",".join(str(i) for i in st["instruments"]) or "-",
                ",".join(str(i) for i in st["percussion_instruments"]) or "-",
                str(st["events"]), str(st["notes"]),
                "${:02X}".format(rom[SFX_SLOTS + sid]),
                "${:02X}".format(rom[SFX_PRIORITY + sid]),
                " ".join(by_id.get(sid, [])) or "-",
                "ok" if not song["errors"] else "; ".join(song["errors"]),
                str(tl["end_tick"]), "${:02X}".format(tempo),
                "{:.3f}".format(ln["play_s"]), str(ln["length_s"])]))
            problems.extend(_bad_instruments(st, "sfx ${:02X}".format(sid)))
            if song["errors"]:
                problems.append("sfx ${:02X}: {}".format(sid, song["errors"][0]))
        with open(os.path.join(out, "sfx", "index.tsv"), "w") as f:
            f.write("\n".join(rows) + "\n")
        named = [s for s in sites if s["id"] is not None]
        loose = [s for s in sites if s["id"] is None]
        print("sfx: {} parsed -> {}\n     {} JSL $80:B542 call sites, {} with "
              "an immediate id".format(len(want_sfx),
                                       os.path.join(out, "sfx"),
                                       len(sites), len(named)))
        if loose:
            print("     {} compute the id or read it from a table: {}".format(
                len(loose), " ".join(s["snes"] for s in loose)))
        for s in named:
            if not 0 <= s["id"] <= SFX_ID_MAX:
                problems.append("{} requests sfx ${:02X}, outside $00-${:02X}"
                                .format(s["snes"], s["id"], SFX_ID_MAX))
            elif s["id"] and not (SFX_BLOCK[0] <=
                                  u16(ram, SEQ_TABLE + 2 * s["id"]) <
                                  SFX_BLOCK[1]):
                problems.append(
                    "{} requests sfx ${:02X}, whose pointer is outside the "
                    "block".format(s["snes"], s["id"]))

    if problems:
        print("\n{} sequence(s) did not parse cleanly:".format(len(problems)),
              file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    print("all sequences parsed with no unknown bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
