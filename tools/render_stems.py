#!/usr/bin/env python3
"""Render a song as stems: one WAV per DSP voice and one per BRR sample,
each with and without echo.

    python3 tools/render_stems.py --song 6
    python3 tools/render_stems.py --song 6 --song 22 --by sample --mix wet
    python3 tools/render_stems.py --all

A voice is not an instrument. The driver changes instrument on a voice
between notes, and percussion notes pick their own instrument, so a voice
stem is one line of the arrangement (song 6's voice 1 plays some twenty
sounds, drums and melody). A sample stem is one sound wherever it is played,
which is the nearest thing to a drum, bass or lead track: it follows the BRR
start address each voice loaded at its last key-on, so the directory's
duplicate entries count as one sample.

Each stem is its own pass of tools/spcrender over the song's .spc, with
every other voice muted (--mute-voices) or every other sample muted
(--solo-source). A muted voice is left out of the main mix and of the echo
input, and nothing else changes: the SPC700 runs the same program and the
DSP plays the same notes, which is checked (every pass must count the same
key-ons as the mix). Echo is one shared bus, so a stem has to be rendered on
its own to carry its own echo; that is the wet set. The dry set adds
--no-echo, which leaves the echo return out of the output.

Lengths: no length options are passed, so every pass plays the song's
ID666 tag, the length render_audio.py measured and wrote. The stems and the
two mixes are therefore the same length and start at the same sample, ready
to line up in a DAW. A song whose tag render_audio.py has not set is
refused.

Outputs under --out (default build/spc/stems), per song:
    song_NN/mix.wav            the full mix, as render_audio.py renders it
    song_NN/mix_dry.wav        the full mix without echo
    song_NN/wet/voice_V.wav    voice V alone, with its echo
    song_NN/wet/sample_SS.wav  sample SS alone (samples.tsv index), with echo
    song_NN/dry/...            the same without echo
    song_NN/stems.tsv          one row per stem: key-ons, voices or samples,
                               the directory entries keyed, peak, rms
    song_NN/check.tsv          one row per set: the stems summed against the
                               mix they came from
    index.tsv                  one row per song: stems, size, the checks

What is checked. Every pass must count the same key-ons and produce the
same number of frames as the mix, or the run stops. Then each set's stems
are summed and compared with their mix (check.tsv):

    dry   The DSP sums the voices, scales the sum by MVOL and floors it; a
          stem is floored on its own, so n stems can fall short of the mix
          by up to n-1. The fade then rounds each file once, which adds up
          to (n+1)/2 either way. A dry set whose largest difference exceeds
          (n-1) + ceil((n+1)/2) fails, unless the mix itself clamped in the
          main sum or the output (spcrender's saturated_* counters), where
          stems cannot add up and the row says so.
    wet   The echo FIR, the feedback and the LSB masking round the summed
          signal again on every trip round the ring, so there is no such
          bound; the residual is reported, not judged, next to the mix's
          echo saturation count.
"""

import argparse
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import render_audio  # noqa: E402
from audio_check import read_wav  # noqa: E402
from brr import read_directory  # noqa: E402
from render_audio import RenderError, read_tsv, run_renderer  # noqa: E402
from spc_extract import (SAMPLE_COUNT, SAMPLE_DIR, SONG_COUNT,  # noqa: E402
                         SONG_ID_BASE, read_length_tag)

RATE = render_audio.RATE
SETS = {"wet": [], "dry": ["--no-echo"]}
FULL_SCALE = 32768.0


def song_spc(spc_dir, n):
    return os.path.join(spc_dir, "songs", "song_{:02d}_id{:02X}.spc".format(
        n, SONG_ID_BASE + n))


def check_tag(path, n, index_rows):
    """The .spc must carry the length render_audio.py measured."""
    if not os.path.exists(path):
        raise RenderError("{} is missing; run python3 tools/spc_extract.py "
                          "and python3 tools/render_audio.py".format(path))
    row = index_rows.get("{:02d}".format(n))
    with open(path, "rb") as f:
        tag = read_length_tag(f.read())
    if row is None or tag != (int(row["tag_length_s"]),
                              int(row["tag_fade_ms"])):
        raise RenderError(
            "song {:02d}: the .spc's length tag {} is not the one "
            "render_audio.py measured; run python3 tools/render_audio.py "
            "--song {}".format(n, tag, n))
    return tag


def sample_names(ram_base):
    """BRR start address -> the lowest directory index that starts there."""
    with open(ram_base, "rb") as f:
        ram = f.read()
    names = {}
    for i, (start, _) in enumerate(read_directory(ram, SAMPLE_DIR,
                                                  SAMPLE_COUNT)):
        names.setdefault(start, i)
    return names


def addr(text):
    return int(text.lstrip("$"), 16)


def label(start, names):
    """A sample by its samples.tsv index, or its address if not in the
    directory."""
    return ("{:02d}".format(names[start]) if start in names
            else "${:04X}".format(start))


def by_index(starts, names):
    return sorted(starts, key=lambda a: (names.get(a, SAMPLE_COUNT), a))


def plan_song(kon_rows, names, by):
    """The stem passes for one song: (kind, name, extra args, key-on rows)."""
    stems = []
    if by in ("voice", "both"):
        for v in sorted({int(r["voice"]) for r in kon_rows}):
            rows = [r for r in kon_rows if int(r["voice"]) == v]
            stems.append(("voice", "voice_{}".format(v),
                          ["--mute-voices", hex(0xFF ^ (1 << v))], rows))
    if by in ("sample", "both"):
        for a in by_index({addr(r["brr_addr"]) for r in kon_rows}, names):
            rows = [r for r in kon_rows if addr(r["brr_addr"]) == a]
            name = "sample_" + label(a, names).lstrip("$")
            stems.append(("sample", name,
                          ["--solo-source", "0x{:04X}".format(a)], rows))
    return stems


def describe(rows, names):
    """What a stem contains, from the mix's key-on log: the voices, the
    samples (samples.tsv index) and the directory entries keyed."""
    played = by_index({addr(r["brr_addr"]) for r in rows}, names)
    return {"voices": ",".join(sorted({r["voice"] for r in rows}, key=int)),
            "samples": ",".join(label(a, names) for a in played),
            "srcn": ",".join(sorted({r["srcn"] for r in rows}, key=int))}


def sum_check(mix_path, stem_paths):
    """The stems summed against the mix: largest difference, residual RMS."""
    mix = read_wav(mix_path)
    total = np.zeros_like(mix)
    for path in stem_paths:
        stem = read_wav(path)
        if stem.shape != mix.shape:
            raise RenderError("{} is {} frames, the mix {}".format(
                path, stem.shape[0], mix.shape[0]))
        total += stem
    diff = mix - total
    del total
    mix_rms = float(np.sqrt(np.mean(np.square(mix, dtype=np.float64))))
    res_rms = float(np.sqrt(np.mean(np.square(diff, dtype=np.float64))))
    dbfs = 20 * np.log10(res_rms / FULL_SCALE) if res_rms else float("-inf")
    return {"max_abs_diff": int(np.abs(diff).max()) if diff.size else 0,
            "frames_differing": int(np.count_nonzero(diff.any(axis=1))),
            "frames": int(mix.shape[0]),
            "mix_rms": "{:.1f}".format(mix_rms),
            "residual_rms": "{:.3f}".format(res_rms),
            "residual_dbfs": "{:.1f}".format(dbfs)}


def dry_bound(n):
    """Largest |mix - sum of n dry stems| that rounding alone can give."""
    return (n - 1) + (n + 2) // 2


def saturation(res):
    return "{}/{}/{}".format(res["saturated_main"], res["saturated_echo"],
                             res["saturated_output"])


STEM_COLUMNS = ["set", "kind", "name", "voices", "samples", "srcn", "key_ons",
                "peak", "rms", "silent", "saturated", "file"]
CHECK_COLUMNS = ["set", "kind", "stems", "mix", "frames", "frames_differing",
                 "max_abs_diff", "bound", "mix_rms", "residual_rms",
                 "residual_dbfs", "mix_saturated", "ok"]
INDEX_COLUMNS = ["song", "key_ons", "voice_stems", "sample_stems", "sets",
                 "seconds", "bytes", "dry_ok", "wet_max_abs_diff",
                 "wet_residual_dbfs", "wet_mix_saturated", "dir"]


def write_tsv(path, columns, rows):
    with open(path, "w") as f:
        f.write("\t".join(columns) + "\n")
        for r in rows:
            f.write("\t".join(str(r.get(c, "-")) for c in columns) + "\n")


def render_song(n, args, names, index_rows, pool):
    spc = song_spc(args.spc, n)
    check_tag(spc, n, index_rows)
    out = os.path.join(args.out, "song_{:02d}".format(n))
    sets = ["wet", "dry"] if args.mix == "both" else [args.mix]
    for s in sets:
        os.makedirs(os.path.join(out, s), exist_ok=True)

    with tempfile.TemporaryDirectory(dir=args.out) as scratch:
        kon_log = os.path.join(scratch, "kon.tsv")
        mixes = {"wet": os.path.join(out, "mix.wav"),
                 "dry": os.path.join(out, "mix_dry.wav")}
        ref = {s: pool.submit(run_renderer,
                              [spc, "-o", mixes[s]] + SETS[s]
                              + (["--log-kon", kon_log] if s == "wet" else []))
               for s in SETS}
        ref = {s: f.result() for s, f in ref.items()}
        kon_rows = read_tsv(kon_log)
    for s, res in ref.items():
        if res["length_source"] != "id666":
            raise RenderError("song {:02d}: the {} mix did not play the "
                              "tag".format(n, s))
    total = ref["wet"]["kon_total"]
    if total == 0:
        return {"song": "{:02d}".format(n), "key_ons": 0, "dry_ok": "skipped",
                "dir": os.path.basename(out)}, []

    stems = plan_song(kon_rows, names, args.by)
    jobs = []
    for s in sets:
        for kind, name, extra, rows in stems:
            wav = os.path.join(out, s, name + ".wav")
            jobs.append((s, kind, name, rows, wav, pool.submit(
                run_renderer, [spc, "-o", wav] + extra + SETS[s])))

    stem_rows = []
    problems = []
    for s, kind, name, rows, wav, future in jobs:
        res = future.result()
        if res["kon_total"] != total:
            problems.append("song {:02d} {}/{}: {} key-ons, the mix {}".format(
                n, s, name, res["kon_total"], total))
        if res["samples"] != ref[s]["samples"]:
            problems.append("song {:02d} {}/{}: {} frames, the mix {}".format(
                n, s, name, res["samples"], ref[s]["samples"]))
        row = {"set": s, "kind": kind, "name": name, "key_ons": len(rows),
               "peak": res["peak"], "rms": "{:.1f}".format(res["rms"]),
               "silent": "yes" if res["silent"] else "no",
               "saturated": saturation(res),
               "file": os.path.relpath(wav, out)}
        row.update(describe(rows, names))
        stem_rows.append(row)
    if problems:
        raise RenderError("\n".join(problems))

    check_rows = []
    for s in sets:
        for kind in ("voice", "sample"):
            paths = [os.path.join(out, r["file"]) for r in stem_rows
                     if r["set"] == s and r["kind"] == kind]
            if not paths:
                continue
            c = sum_check(mixes[s], paths)
            res = ref[s]
            c.update({"set": s, "kind": kind, "stems": len(paths),
                      "mix": os.path.basename(mixes[s]),
                      "mix_saturated": saturation(res)})
            if s == "dry":
                c["bound"] = dry_bound(len(paths))
                if c["max_abs_diff"] <= c["bound"]:
                    c["ok"] = "yes"
                elif res["saturated_main"] or res["saturated_output"]:
                    c["ok"] = "mix clamps"
                else:
                    c["ok"] = "NO"
            check_rows.append(c)
    write_tsv(os.path.join(out, "stems.tsv"), STEM_COLUMNS, stem_rows)
    write_tsv(os.path.join(out, "check.tsv"), CHECK_COLUMNS, check_rows)

    size = sum(os.path.getsize(os.path.join(out, r["file"]))
               for r in stem_rows)
    size += sum(os.path.getsize(mixes[s]) for s in SETS)
    dry = [c for c in check_rows if c["set"] == "dry"]
    wet = [c for c in check_rows if c["set"] == "wet"]
    summary = {
        "song": "{:02d}".format(n), "key_ons": total,
        "voice_stems": sum(1 for k, *_ in stems if k == "voice"),
        "sample_stems": sum(1 for k, *_ in stems if k == "sample"),
        "sets": ",".join(sets),
        "seconds": "{:.3f}".format(ref["wet"]["seconds"]),
        "bytes": size,
        "dry_ok": ",".join(sorted({c["ok"] for c in dry})) if dry else "-",
        "dir": os.path.basename(out)}
    if wet:
        summary["wet_max_abs_diff"] = max(c["max_abs_diff"] for c in wet)
        summary["wet_residual_dbfs"] = max((c["residual_dbfs"] for c in wet),
                                           key=float)
        summary["wet_mix_saturated"] = saturation(ref["wet"])
    return summary, check_rows


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--song", type=lambda s: int(s, 0), action="append",
                    help="song 0-32 (repeatable)")
    ap.add_argument("--all", action="store_true", help="every song")
    ap.add_argument("--by", choices=("voice", "sample", "both"),
                    default="both", help="how to split (default both)")
    ap.add_argument("--mix", choices=("wet", "dry", "both"), default="both",
                    help="with echo, without, or both (default both)")
    ap.add_argument("--out", default="build/spc/stems")
    ap.add_argument("--spc", default="build/spc",
                    help="where the .spc files and ram_base.bin are")
    ap.add_argument("--index", default="build/spc/wav/index.tsv",
                    help="render_audio.py's index, for the measured lengths")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1,
                    help="renders to run at once")
    args = ap.parse_args()

    if args.all == (args.song is not None):
        ap.error("give --song N (repeatable) or --all")
    songs = list(range(SONG_COUNT)) if args.all else args.song
    for n in songs:
        if not 0 <= n < SONG_COUNT:
            ap.error("song {} is outside 0-{}".format(n, SONG_COUNT - 1))

    try:
        if not os.path.exists(args.index):
            raise RenderError("{} is missing; run python3 "
                              "tools/render_audio.py".format(args.index))
        index_rows = {r["id"]: r for r in read_tsv(args.index)
                      if r["kind"] == "song"}
        names = sample_names(os.path.join(args.spc, "ram_base.bin"))
        render_audio.ensure_renderer()
        os.makedirs(args.out, exist_ok=True)
        t0 = time.time()
        summaries = []
        failed = []
        with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
            for n in songs:
                summary, checks = render_song(n, args, names, index_rows, pool)
                summaries.append(summary)
                if summary["dry_ok"] == "skipped":
                    print("song {:02d}: no key-ons, nothing to split".format(n))
                    continue
                print("song {:02d}: {} voice + {} sample stems x {}, {:.0f} MB"
                      .format(n, summary["voice_stems"],
                              summary["sample_stems"], summary["sets"],
                              summary["bytes"] / 1e6))
                for c in checks:
                    print("  {}/{}: {} stems, mix minus sum at most {} "
                          "(bound {}), residual {} dBFS, mix saturated "
                          "main/echo/output {}: {}".format(
                              c["set"], c["kind"], c["stems"],
                              c["max_abs_diff"], c.get("bound", "-"),
                              c["residual_dbfs"], c["mix_saturated"],
                              c.get("ok", "reported")))
                    if c.get("ok") == "NO":
                        failed.append("song {:02d} {}/{}: off by {}, bound {}"
                                      .format(n, c["set"], c["kind"],
                                              c["max_abs_diff"], c["bound"]))
    except (RenderError, ValueError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    index = os.path.join(args.out, "index.tsv")
    rows = summaries
    if os.path.exists(index) and not args.all:
        fresh = {r["song"]: r for r in summaries}
        rows = [fresh.pop(r["song"], r) for r in read_tsv(index)]
        rows += list(fresh.values())
    rows.sort(key=lambda r: r["song"])
    write_tsv(index, INDEX_COLUMNS, rows)
    total = sum(int(r["bytes"]) for r in summaries if r.get("bytes"))
    print("wrote {:.0f} MB under {} in {:.1f} s".format(
        total / 1e6, args.out, time.time() - t0))
    if failed:
        print("\n{} dry set(s) do not add up to their mix:".format(len(failed)),
              file=sys.stderr)
        for f in failed:
            print("  " + f, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
