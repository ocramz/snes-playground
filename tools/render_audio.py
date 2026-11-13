#!/usr/bin/env python3
"""Render every song and sound effect to WAV, and index what came out.

There is no emulator on this machine, so the sound is produced by
tools/spcrender, a small SPC700 + S-DSP model in Rust (std only) that plays
a .spc file and writes 32 kHz stereo 16-bit PCM. This script builds it when
needed and drives it over the .spc files that spc_extract.py and nspc.py
write. See docs/audio.md, "Rendering", for how the renderer was validated.

    python3 tools/render_audio.py                 # everything
    python3 tools/render_audio.py --only songs
    python3 tools/render_audio.py --song 6 --sfx 0x0B
    python3 tools/render_audio.py --rebuild       # force a cargo build

Inputs (regenerate with spc_extract.py, then nspc.py --all --midi --spc):
    build/spc/songs/song_NN_idXX.spc     33 songs
    build/spc/sfx/sfx_XX.spc             125 effects, played over song 0

Each input is first rebuilt in memory from the ROM and compared with the
file on disk; a stale file (the old silent carrier, a changed driver patch)
is refused rather than rendered. Only the length tag is allowed to differ,
because this script is what sets it.

Lengths are measured, not computed. The tempo formula in nspc.py gives a
lower bound only: the driver's tick accumulator at SPC $0884-$088B keeps
just the low byte of tempo x elapsed timer ticks, so a main-loop pass that
takes 14 ms or more throws a whole tick away and the music runs late.
What is measured, by playing each file:

    looping song   the two moments the driver takes the word-list jump
                   (SPC $0A58 writing $40). The second one, rounded up to a
                   whole second because the tag is in whole seconds, is the
                   play length; the fade is 10 s.
    ending song    played until the driver has cleared its current-song
                   byte (SPC $04) and the output has been silent for 250 ms.
    effect         played until the driver has released every effect voice
                   (SPC $22) and the output has been silent for 250 ms.

The measured length and fade are then written into the .spc's ID666 tag,
and the WAV is rendered to exactly those numbers.

Outputs under --out (default build/spc/wav):
    songs/song_NN.wav    looping: tag length + tag fade, to the sample.
                         Ending: to silence, never longer than the tag
    sfx/sfx_XX.wav       from the first non-zero sample to silence
    index.tsv            one row per file: duration, loop points, voices,
                         levels, how late it ran, which code plays it

The renderer is built with CARGO_TARGET_DIR=build/spcrender, so nothing is
written outside build/.
"""

import argparse
import json
import math
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import nspc  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from spc_extract import (SONG_COUNT, SONG_ID_BASE, base_ram, make_spc,  # noqa: E402
                         same_but_for_length, set_length_tag)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CRATE = os.path.join(HERE, "spcrender")
TARGET_DIR = os.path.join(REPO, "build", "spcrender")
RENDERER = os.path.join(TARGET_DIR, "release", "spcrender")

RATE = 32000
WORDLIST_PTR = 0x40           # SPC; the song's word-list pointer, low byte
LOOP_JUMP_PC = 0x0A58         # SPC; MOVW $40,YA, taken when a song loops
CURRENT_SONG = 0x04           # SPC; zeroed at $09CC when a song ends
SFX_VOICES = 0x22             # SPC; mask of voices an effect still owns
# How far past the tempo formula's figure a measuring run may go. The
# busiest song runs 28% late; anything that needs more than this is reported.
CAP_FACTOR = 1.5
CAP_EXTRA_S = 10
SILENT_BY_DESIGN = {("song", 0): "song 0 is the 0-note carrier: five muted "
                                 "voices resting for 72 ticks, forever"}


class RenderError(Exception):
    pass


def _sources():
    out = [os.path.join(CRATE, "Cargo.toml")]
    for name in sorted(os.listdir(os.path.join(CRATE, "src"))):
        if name.endswith(".rs"):
            out.append(os.path.join(CRATE, "src", name))
    return out


def ensure_renderer(force=False, quiet=False):
    """Build tools/spcrender if the binary is missing or older than its
    sources. Returns the path to the binary."""
    stale = force or not os.path.exists(RENDERER)
    if not stale:
        built = os.path.getmtime(RENDERER)
        stale = any(os.path.getmtime(p) > built for p in _sources())
    if stale:
        env = dict(os.environ, CARGO_TARGET_DIR=TARGET_DIR)
        cmd = ["cargo", "build", "--release", "--offline", "--manifest-path",
               os.path.join(CRATE, "Cargo.toml")]
        if not quiet:
            print("building spcrender -> {}".format(
                os.path.relpath(RENDERER, REPO)))
        proc = subprocess.run(cmd, env=env, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RenderError("cargo build failed:\n{}".format(proc.stderr))
    return RENDERER


def run_renderer(args):
    """Run spcrender and return its JSON summary as a dict."""
    proc = subprocess.run([RENDERER] + list(args), capture_output=True,
                          text=True)
    if proc.returncode != 0:
        raise RenderError("spcrender {} failed: {}".format(
            " ".join(args), proc.stderr.strip()))
    return json.loads(proc.stdout.strip().splitlines()[-1])


def read_tsv(path):
    with open(path) as f:
        lines = f.read().splitlines()
    head = lines[0].split("\t")
    return [dict(zip(head, l.split("\t"))) for l in lines[1:] if l.strip()]


def loop_jumps(watch_path):
    """Sample indices at which the driver took the word-list jump."""
    return [int(r["sample"]) for r in read_tsv(watch_path)
            if int(r["addr"][1:], 16) == WORDLIST_PTR
            and int(r["pc"][1:], 16) == LOOP_JUMP_PC]


def expected_song_spc(rom, ram, n):
    """What spc_extract.py writes for song n, and its static timing."""
    tl, length = nspc.song_length(rom, ram, n)
    image, _ = nspc.song_ram(rom, ram, n)
    spc = make_spc(image, SONG_ID_BASE,
                   "Song {:02d} (id 0x{:02X})".format(n, SONG_ID_BASE + n),
                   length_s=length["length_s"], fade_ms=length["fade_ms"])
    return spc, tl, length


def expected_sfx_spc(rom, ram, sid, tempo):
    """What nspc.py --spc writes for effect sid, and its static timing."""
    song = nspc.parse_song(ram, nspc.u16(ram, nspc.SEQ_TABLE + 2 * sid),
                           nspc.SFX_BLOCK)
    tl = nspc.sequence_timeline(ram, song, sfx=True, tempo=tempo)
    length = nspc.sequence_length(tl, sfx=True)
    spc = nspc.make_sfx_spc(rom, ram, sid, "SFX ${:02X}".format(sid),
                            length_s=length["length_s"],
                            fade_ms=length["fade_ms"])
    return spc, tl, length


def _check_fresh(path, expected, how):
    if not os.path.exists(path):
        raise RenderError("{} is missing; run {}".format(path, how))
    with open(path, "rb") as f:
        if not same_but_for_length(f.read(), expected):
            raise RenderError(
                "{} is not what the current tools produce (old carrier or "
                "driver patch); re-run {}".format(path, how))


def retag(path, length_s, fade_ms):
    """Write the measured play length into a .spc's ID666 tag."""
    with open(path, "rb") as f:
        spc = f.read()
    new = set_length_tag(spc, length_s, fade_ms)
    if new != spc:
        with open(path, "wb") as f:
            f.write(new)


def _cap(ideal_s):
    return int(math.ceil(ideal_s * CAP_FACTOR + CAP_EXTRA_S))


def _row(kind, ident, wav_path):
    return {"kind": kind, "id": ident, "file": os.path.relpath(wav_path, REPO),
            "loop_start_s": "-", "loop_length_s": "-", "timed_span": "-",
            "ideal_s": "-", "actual_s": "-", "late_ms": "-", "note": ""}


def _late(row, span, ideal_s, actual_s):
    row["timed_span"] = span
    row["ideal_s"] = "{:.3f}".format(ideal_s)
    row["actual_s"] = "{:.3f}".format(actual_s)
    row["late_ms"] = "{:.0f}".format((actual_s - ideal_s) * 1000)


def render_song(n, spc_path, wav_path, length, scratch):
    row = _row("song", "{:02d}".format(n), wav_path)
    if length["loops"]:
        # Pass 1, no audio written: find where the loop really falls.
        ideal_two = nspc.SEQ_START_S + length["intro_s"] + 2 * length["loop_s"]
        watch = os.path.join(scratch, "song_{:02d}_watch.tsv".format(n))
        run_renderer([spc_path, "--seconds", str(_cap(ideal_two)),
                      "--fade", "0", "--watch", hex(WORDLIST_PTR),
                      "--log-watch", watch])
        jumps = loop_jumps(watch)
        os.remove(watch)
        if len(jumps) < 2:
            raise RenderError(
                "song {:02d}: {} loop jump(s) in {} s, expected two".format(
                    n, len(jumps), _cap(ideal_two)))
        loop = jumps[1] - jumps[0]
        row["loop_start_s"] = "{:.3f}".format((jumps[0] - loop) / RATE)
        row["loop_length_s"] = "{:.3f}".format(loop / RATE)
        _late(row, "one loop", length["loop_s"], loop / RATE)
        tag = (int(math.ceil(jumps[1] / RATE)), nspc.FADE_MS)
        retag(spc_path, *tag)
        # Pass 2: no length arguments, so the renderer plays the tag.
        res = run_renderer([spc_path, "-o", wav_path])
        if res["length_source"] != "id666":
            raise RenderError("song {:02d}: the tag was not used".format(n))
    else:
        ideal_end = nspc.SEQ_START_S + length["intro_s"]
        res = run_renderer([
            spc_path, "-o", wav_path, "--until-silent",
            "--busy", hex(CURRENT_SONG), "--seconds", str(_cap(ideal_end))])
        if res["stop"] != "silent":
            row["note"] = "still playing after {} s".format(_cap(ideal_end))
        _late(row, "start to end", ideal_end, res["busy_end_sample"] / RATE)
        tag = (max(1, int(math.ceil(res["seconds"]))), 0)
        retag(spc_path, *tag)
    row["tag_length_s"], row["tag_fade_ms"] = tag
    return row, res


def render_sfx(sid, spc_path, wav_path, length):
    row = _row("sfx", "${:02X}".format(sid), wav_path)
    ideal_end = nspc.SEQ_START_S + length["intro_s"]
    res = run_renderer([
        spc_path, "-o", wav_path, "--until-silent", "--trim-leading",
        "--busy", hex(SFX_VOICES), "--seconds", str(_cap(ideal_end))])
    if res["stop"] != "silent":
        row["note"] = "still playing after {} s".format(_cap(ideal_end))
    _late(row, "start to end", ideal_end, res["busy_end_sample"] / RATE)
    # The .spc is not trimmed, so its tag covers the lead-in as well.
    whole = (res["lead_in_samples"] + res["samples"]) / RATE
    tag = (max(1, int(math.ceil(whole))), 0)
    retag(spc_path, *tag)
    row["tag_length_s"], row["tag_fade_ms"] = tag
    return row, res


COLUMNS = ["id", "kind", "duration_s", "loop_start_s", "loop_length_s",
           "voices", "key_ons", "peak", "rms", "silent", "stop", "lead_in_s",
           "tag_length_s", "tag_fade_ms", "timed_span", "ideal_s", "actual_s",
           "late_ms", "used_by", "file", "note"]


def _finish(row, res, used_by):
    row.update({
        "duration_s": "{:.3f}".format(res["seconds"]),
        "voices": ",".join(str(v) for v in res["voices_used"]) or "-",
        "key_ons": res["kon_total"],
        "peak": res["peak"], "rms": "{:.1f}".format(res["rms"]),
        "silent": "yes" if res["silent"] else "no",
        "stop": res["stop"],
        "lead_in_s": "{:.3f}".format(res["lead_in_samples"] / RATE),
        "used_by": " ".join(used_by) or "-",
    })
    row["note"] = row["note"] or "-"
    return row


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="build/spc/wav")
    ap.add_argument("--spc", default="build/spc",
                    help="where the .spc files are (default build/spc)")
    ap.add_argument("--only", choices=("songs", "sfx"),
                    help="render just one kind")
    ap.add_argument("--song", type=lambda s: int(s, 0), action="append",
                    help="song 0-32 (repeatable); limits the run")
    ap.add_argument("--sfx", type=lambda s: int(s, 0), action="append",
                    help="effect $01-$7D (repeatable); limits the run")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1,
                    help="renders to run at once")
    ap.add_argument("--rebuild", action="store_true",
                    help="rebuild spcrender even if it looks current")
    args = ap.parse_args()

    try:
        rom = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    picked = args.song is not None or args.sfx is not None
    songs = args.song or []
    effects = args.sfx or []
    if not picked:
        songs = list(range(SONG_COUNT)) if args.only != "sfx" else []
        effects = (list(range(1, nspc.SFX_ID_MAX + 1))
                   if args.only != "songs" else [])
    for n in songs:
        if not 0 <= n < SONG_COUNT:
            ap.error("song {} is outside 0-{}".format(n, SONG_COUNT - 1))
    for sid in effects:
        if not 1 <= sid <= nspc.SFX_ID_MAX:
            ap.error("effect ${:02X} is outside $01-${:02X}".format(
                sid, nspc.SFX_ID_MAX))

    ram, _ = base_ram(rom)
    try:
        ensure_renderer(force=args.rebuild)
        tempo = nspc.carrier_tempo(rom, ram, "song0")
        jobs = []
        for sub in ("songs", "sfx"):
            os.makedirs(os.path.join(args.out, sub), exist_ok=True)
        for n in songs:
            spc, _, length = expected_song_spc(rom, ram, n)
            path = os.path.join(args.spc, "songs", "song_{:02d}_id{:02X}.spc".format(
                n, SONG_ID_BASE + n))
            _check_fresh(path, spc, "python3 tools/spc_extract.py")
            wav = os.path.join(args.out, "songs", "song_{:02d}.wav".format(n))
            jobs.append(("song", n, (render_song, n, path, wav, length,
                                     args.out)))
        for sid in effects:
            spc, _, length = expected_sfx_spc(rom, ram, sid, tempo)
            path = os.path.join(args.spc, "sfx", "sfx_{:02X}.spc".format(sid))
            _check_fresh(path, spc, "python3 tools/nspc.py --all --midi --spc")
            wav = os.path.join(args.out, "sfx", "sfx_{:02X}.wav".format(sid))
            jobs.append(("sfx", sid, (render_sfx, sid, path, wav, length)))

        t0 = time.time()
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            futures = [pool.submit(job[0], *job[1:]) for _, _, job in jobs]
            results = [f.result() for f in futures]
        wall = time.time() - t0
    except (RenderError, ValueError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    song_users = nspc.song_users(nspc.song_call_sites(rom))
    sfx_users = {}
    for s in nspc.sfx_call_sites(rom):
        if s["id"] is not None:
            sfx_users.setdefault(s["id"], []).append(s["snes"])

    rows = []
    problems = []
    audio_s = cpu_s = 0.0
    opcodes = 0
    for (kind, ident, _), (row, res) in zip(jobs, results):
        users = (song_users if kind == "song" else sfx_users).get(ident, [])
        rows.append(_finish(row, res, users))
        audio_s += res["rendered_samples"] / RATE
        cpu_s += res["elapsed_seconds"]
        opcodes |= int(res["opcode_map"], 16)
        label = "{} {}".format(kind, row["id"])
        if res["halted"]:
            problems.append("{}: the SPC700 executed SLEEP/STOP".format(label))
        if res["silent"]:
            why = SILENT_BY_DESIGN.get((kind, ident))
            if why:
                row["note"] = "silent by design: " + why
            else:
                problems.append("{}: rendered silent".format(label))
        elif row["note"] != "-":
            problems.append("{}: {}".format(label, row["note"]))

    index = os.path.join(args.out, "index.tsv")
    full = not picked and args.only is None
    if full or not os.path.exists(index):
        merged = rows
        wrote = index
    else:
        # A partial run must not shrink the index: replace matching rows.
        fresh = dict(((r["kind"], r["id"]), r) for r in rows)
        merged = [fresh.pop((r["kind"], r["id"]), r) for r in read_tsv(index)]
        merged += [r for r in rows if (r["kind"], r["id"]) in fresh]
        wrote = "{} (rows merged)".format(index)
    with open(index, "w") as f:
        f.write("\t".join(COLUMNS) + "\n")
        for r in merged:
            f.write("\t".join(str(r.get(c, "-")) for c in COLUMNS) + "\n")

    n_song = sum(1 for r in rows if r["kind"] == "song")
    n_sfx = len(rows) - n_song
    kept = sum(float(r["duration_s"]) for r in rows)
    print("rendered {} songs and {} effects: {:.1f} min of audio".format(
        n_song, n_sfx, kept / 60))
    if cpu_s:
        print("speed: {:.0f}x real time per render ({:.1f} min emulated in "
              "{:.1f} s of CPU), {:.1f} s wall with {} jobs".format(
                  audio_s / cpu_s, audio_s / 60, cpu_s, wall, args.jobs))
    print("SPC700 opcodes executed across the run: {} of 256".format(
        bin(opcodes).count("1")))
    for kind, name in (("song", "song"), ("sfx", "effect")):
        d = sorted(float(r["duration_s"]) for r in rows if r["kind"] == kind)
        if d:
            print("{} durations: min {:.3f} s, median {:.3f} s, max {:.3f} "
                  "s".format(name, d[0], d[len(d) // 2], d[-1]))
        late = [(float(r["late_ms"]), r) for r in rows
                if r["kind"] == kind and r["late_ms"] != "-"]
        if late:
            worst = max(late, key=lambda x: x[0])
            print("{}s behind the tempo formula: median {:.0f} ms, worst "
                  "{:.0f} ms ({} {}, {} of {} s)".format(
                      name, sorted(x[0] for x in late)[len(late) // 2],
                      worst[0], kind, worst[1]["id"], worst[1]["timed_span"],
                      worst[1]["ideal_s"]))
    for r in rows:
        if r["silent"] == "yes":
            print("silent: {} {} -- {}".format(r["kind"], r["id"], r["note"]))
    print("wrote {}".format(wrote))
    if problems:
        print("\n{} problem(s):".format(len(problems)), file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
