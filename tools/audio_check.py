#!/usr/bin/env python3
"""Check tools/spcrender against three things that are not spcrender.

Nobody here can listen to the output, and a renderer that is wrong tends to
produce something that still looks like audio. Each check below compares a
render with a model built independently of the Rust code:

  brr   One DSP voice, keyed on at pitch $1000 with a fixed envelope, for
        each of the 25 distinct samples. The expected output is computed
        here from tools/brr.py's decode_brr() pushed through the documented
        fixed-point chain (Gaussian taps at phase 0, envelope, VxVOL, MVOL)
        and must equal the render bit for bit.

  kon   Every song and effect. The key-ons the renderer's DSP acted on must
        be the note-ons tools/nspc.py lays out (sequence_timeline), on the
        same voice and the same sequencer tick. Ticks are taken from the
        driver itself: SPC $0AA8 writes $5E once per tick. Then the same
        note-ons are timed with the static tempo formula (500 Hz x
        tempo/256) to see how far real time drifts from it.

  vlc   A few songs through VLC's bundled libgme, a different SPC700 and
        DSP implementation, compared after alignment by RMS envelope in
        50 ms windows, by waveform correlation and by spectrum. libgme
        skips leading silence and post-filters its output, so this is a
        similarity measure, not an equality one. A synthetic 500 Hz square
        wave of known amplitude measures libgme's output gain.

    python3 tools/audio_check.py                # all three
    python3 tools/audio_check.py brr
    python3 tools/audio_check.py kon --songs 6,13
    python3 tools/audio_check.py vlc --songs 6,22

Outputs under --out (default build/spc/check): brr.tsv, kon.tsv, vlc.tsv,
plus the 25 one-voice test .spc files and their renders. The song and VLC
renders are deleted once measured. Exit status is non-zero if brr or kon
finds a disagreement; vlc only reports.
"""

import argparse
import bisect
import os
import struct
import subprocess
import sys
import time
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import nspc  # noqa: E402
import render_audio  # noqa: E402
from brr import decode_brr, read_directory  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from spc_extract import (SAMPLE_COUNT, SAMPLE_DIR, SONG_COUNT,  # noqa: E402
                         base_ram)

RATE = 32000
VLC = "/Applications/VLC.app/Contents/MacOS/VLC"

# brr: the test voice.
PROGRAM_ADDR = 0x0200         # SPC; free in the base image, asserted below
TEST_GAIN = 0x7F              # direct gain: envelope = $7F * 16 = $7F0
TEST_VOL = 0x7F
TEST_PITCH = 0x1000           # one BRR sample per output sample
GAUSS_PHASE0 = (0x172, 0x519, 0x176)   # gauss[$0FF], gauss[$1FF], gauss[$100]
BRR_LOOP_PASSES = 2

# kon: the driver's own tick marker.
TICK_MARK_ADDR = 0x5E         # SPC $0AA6-$0AA8: MOV X,#$00 / MOV $5E,X
TICK_MARK_PC = 0x0AA8
WORDLIST_ADDR = 0x40          # written when a pattern is loaded mid-tick
DSP_KON_LATENCY = 3           # samples from the KON write to the logged event


def read_wav(path):
    """(frames x channels int64 array). Tolerates a truncated RIFF header,
    which is what a killed VLC leaves behind."""
    try:
        with wave.open(path) as w:
            ch = w.getnchannels()
            assert w.getsampwidth() == 2 and w.getframerate() == RATE
            raw = w.readframes(w.getnframes())
    except (wave.Error, EOFError):
        with open(path, "rb") as f:
            blob = f.read()
        at = blob.find(b"data")
        if at < 0 or blob[20:22] != b"\x01\x00":
            raise
        ch = struct.unpack_from("<H", blob, 22)[0]
        raw = blob[at + 8:]
    raw = raw[:len(raw) - len(raw) % (2 * ch)]
    return np.frombuffer(raw, dtype="<i2").reshape(-1, ch).astype(np.int64)


def raw_spc(ram, pc, title):
    """A .spc holding an arbitrary RAM image; no driver patch."""
    hdr = bytearray(0x100)
    hdr[0x00:0x21] = b"SNES-SPC700 Sound File Data v0.30"
    hdr[0x21:0x23] = b"\x1a\x1a"
    hdr[0x23] = 0x1A
    hdr[0x24] = 30
    struct.pack_into("<HBBBBB", hdr, 0x25, pc, 0, 0, 0, 0x00, 0xEF)
    hdr[0x2E:0x4E] = title.encode("ascii")[:32].ljust(32, b"\0")
    dsp = bytearray(128)
    dsp[0x6C] = 0xE0              # reset state until the program says otherwise
    return bytes(hdr) + bytes(ram) + bytes(dsp) + bytes(64) + bytes(64)


def dsp_program(writes):
    """SPC700 code: MOV $F2,#reg / MOV $F3,#val for each pair, then spin."""
    code = bytearray()
    for reg, val in writes:
        code += bytes([0x8F, reg, 0xF2, 0x8F, val, 0xF3])
    return bytes(code) + b"\x2F\xFE"          # BRA to itself


def voice_writes(srcn, pitch=TEST_PITCH, dir_page=SAMPLE_DIR >> 8,
                 vol=TEST_VOL):
    return [
        (0x6C, 0x20),                           # FLG: run, echo writes off
        (0x0C, TEST_VOL), (0x1C, TEST_VOL),     # MVOL
        (0x2C, 0x00), (0x3C, 0x00),             # EVOL
        (0x5D, dir_page),                       # DIR
        (0x00, vol), (0x01, vol),               # V0VOL
        (0x02, pitch & 0xFF), (0x03, pitch >> 8),
        (0x04, srcn),
        (0x05, 0x00), (0x07, TEST_GAIN),        # ADSR off, direct gain
        (0x4C, 0x01),                           # KON voice 0
    ]


def model_voice(samples15):
    """What the DSP outputs for 15-bit BRR samples s[k] at pitch $1000.

    At that pitch the interpolation phase is always 0, so the 4-point
    kernel reduces to three fixed taps on (s[k], s[k+1], s[k+2]); the
    fourth, gauss[0], is zero. The DSP holds samples doubled, shifts each
    product right by 11, wraps the three-tap sum to 16 bits, clears bit 0,
    then applies the envelope (>>11, bit 0 cleared), the voice volume (>>7)
    and the master volume (>>7). fullsnes "4-Point Gaussian Interpolation"
    and "Output Mixer".
    """
    d = np.asarray(samples15, dtype=np.int64) * 2
    g = ((GAUSS_PHASE0[0] * d[:-2]) >> 11) + ((GAUSS_PHASE0[1] * d[1:-1]) >> 11) \
        + ((GAUSS_PHASE0[2] * d[2:]) >> 11)
    g = ((g + 0x8000) & 0xFFFF) - 0x8000
    g = np.clip(g, -0x8000, 0x7FFF) & ~1
    out = ((g * (TEST_GAIN << 4)) >> 11) & ~1
    out = np.clip((out * TEST_VOL) >> 7, -0x8000, 0x7FFF)
    return (out * TEST_VOL) >> 7


def audible_samples(blocks):
    """How many output samples a non-looping sample of `blocks` BRR blocks
    produces at pitch $1000 before the DSP mutes it.

    A block whose header says "end" without "loop" silences the voice on
    the first sample for which it is the current block (fullsnes: "End+Mute
    ... Release, Env=000h"), and the decoder runs ahead of playback. Three
    groups of four samples are decoded during key-on; group j (j >= 3) is
    decoded while output sample 4*(j-2) is produced. The last group of the
    block before the end block is group 4*(blocks-1)-1, decoded during
    output sample 16*blocks-28; the end block is current from the next
    sample, which is still output with the old envelope. So outputs
    0..16*blocks-27 sound and everything later is zero: the final block and
    the last eight samples of the one before it are never heard.
    """
    return max(0, 16 * blocks - 26)


def check_brr(rom, out):
    ram, _ = base_ram(rom)
    if any(ram[PROGRAM_ADDR:PROGRAM_ADDR + 0x80]):
        raise ValueError("SPC ${:04X} is not free in the base image".format(
            PROGRAM_ADDR))
    rows = [["sample", "start", "loop", "looped", "blocks", "compared",
             "mismatches", "max_abs_diff", "offset", "muted_tail_zero",
             "corr_vs_raw", "gain_vs_raw", "result"]]
    seen = {}
    bad = 0
    offsets = set()
    total = 0
    for i, (start, loop) in enumerate(read_directory(ram, SAMPLE_DIR, SAMPLE_COUNT)):
        if start in (0, 0xFFFF) or (start, loop) in seen:
            continue
        seen[(start, loop)] = i
        one_pass, looped = decode_brr(ram, start, loop, loop_times=0)
        blocks = len(one_pass) // 16
        samples = decode_brr(ram, start, loop,
                             loop_times=BRR_LOOP_PASSES if looped else 0)[0]
        expect = model_voice(samples)
        if not looped:
            expect = expect[:audible_samples(blocks)]
        image = bytearray(ram)
        prog = dsp_program(voice_writes(i))
        image[PROGRAM_ADDR:PROGRAM_ADDR + len(prog)] = prog
        spc = os.path.join(out, "brr_{:02d}.spc".format(i))
        with open(spc, "wb") as f:
            f.write(raw_spc(image, PROGRAM_ADDR, "BRR test {:02d}".format(i)))
        wav = os.path.join(out, "brr_{:02d}.wav".format(i))
        seconds = (len(samples) + 256) / RATE
        render_audio.run_renderer([spc, "-o", wav, "--seconds",
                                   "{:.6f}".format(seconds)])
        got = read_wav(wav)
        left, right = got[:, 0], got[:, 1]
        nz = np.nonzero(left)[0]
        enz = np.nonzero(expect)[0]
        if len(nz) == 0 or len(enz) == 0:
            rows.append([i, "${:04X}".format(start), "${:04X}".format(loop),
                         "yes" if looped else "no", blocks, 0, "-", "-", "-",
                         "-", "-", "-", "FAIL: no output"])
            bad += 1
            continue
        offset = int(nz[0] - enz[0])
        seg = left[offset:offset + len(expect)]
        n = min(len(seg), len(expect))
        diff = np.abs(seg[:n] - expect[:n])
        mism = int(np.count_nonzero(diff))
        stereo = bool(np.array_equal(left, right))
        tail_zero = "-"
        if not looped:
            tail_zero = "yes" if not np.any(left[offset + len(expect):]) else "no"
        # Against the raw decode: the kernel peaks on its middle tap, so
        # output k lines up with s[k+1].
        raw = np.asarray(samples[1:1 + n], dtype=np.float64)
        ref = seg[:n].astype(np.float64)
        corr = float(np.corrcoef(raw, ref)[0, 1]) if n > 2 else 0.0
        gain = float(np.dot(raw, ref) / np.dot(raw, raw)) if n > 2 else 0.0
        ok = mism == 0 and n == len(expect) and stereo and tail_zero != "no"
        bad += 0 if ok else 1
        offsets.add(offset)
        total += n
        rows.append([i, "${:04X}".format(start), "${:04X}".format(loop),
                     "yes" if looped else "no", blocks, n, mism,
                     int(diff.max()) if n else 0, offset, tail_zero,
                     "{:.6f}".format(corr), "{:.4f}".format(gain),
                     "ok" if ok else "FAIL"])
    path = os.path.join(out, "brr.tsv")
    with open(path, "w") as f:
        for r in rows:
            f.write("\t".join(str(x) for x in r) + "\n")
    # decode_brr gives 15-bit samples and the DSP outputs 16-bit ones, hence
    # the leading 2.
    scale = 2 * (sum(GAUSS_PHASE0) / 2048.0) * ((TEST_GAIN << 4) / 2048.0) \
        * (TEST_VOL / 128.0) ** 2
    gains = [float(r[11]) for r in rows[1:] if r[11] != "-"]
    corrs = [float(r[10]) for r in rows[1:] if r[10] != "-"]
    print("brr: {} samples, {} output samples compared, {} sample(s) "
          "disagree".format(len(rows) - 1, total, bad))
    print("     first audible output sample: {} (constant: {})".format(
        sorted(offsets), "yes" if len(offsets) == 1 else "no"))
    print("     vs raw decode_brr shifted one sample: correlation min "
          "{:.6f}, gain {:.4f}..{:.4f} (nominal {:.4f})".format(
              min(corrs), min(gains), max(gains), scale))
    print("     wrote {}".format(path))
    return bad


# --------------------------------------------------------------------------


def tick_marks(watch_rows):
    """Sample index of each sequencer tick, from the watch log.

    SPC $0AA8 writes $5E at the start of every tick's voice loop. When a
    pattern ends the next one is loaded and the loop restarts inside the
    same tick, which writes $5E again; that second write is preceded by
    word-list reads (INCW $40), which no ordinary tick performs.
    """
    marks = []
    wordlist_since = False
    for r in watch_rows:
        addr = int(r["addr"][1:], 16)
        if addr == WORDLIST_ADDR:
            wordlist_since = True
        elif addr == TICK_MARK_ADDR and int(r["pc"][1:], 16) == TICK_MARK_PC:
            if marks and wordlist_since:
                wordlist_since = False
                continue
            wordlist_since = False
            marks.append(int(r["sample"]))
    return marks


def compare_sequence(spc, tl, seconds, scratch, label):
    kon = os.path.join(scratch, label + "_kon.tsv")
    watch = os.path.join(scratch, label + "_watch.tsv")
    render_audio.run_renderer([
        spc, "--seconds", str(seconds), "--fade", "0", "--log-kon", kon,
        "--watch", "{},{}".format(hex(TICK_MARK_ADDR), hex(WORDLIST_ADDR)),
        "--log-watch", watch])
    marks = tick_marks(render_audio.read_tsv(watch))
    events = render_audio.read_tsv(kon)
    os.remove(watch)
    os.remove(kon)
    # Leave the last tick out: its key-ons may fall after the render ends.
    # And stop where the layout stops, if the render outlasted it.
    horizon = min(len(marks) - 1, tl["end_tick"])
    predicted = {}
    for tick, voice, _, _ in tl["notes"]:
        if tick < horizon:
            predicted[(tick, voice)] = tick
    measured = {}
    for e in events:
        s = int(e["sample"])
        tick = bisect.bisect_right(marks, s - DSP_KON_LATENCY) - 1
        if 0 <= tick < horizon:
            measured[(tick, int(e["voice"]))] = s
    both = sorted(set(predicted) & set(measured))
    missing = sorted(set(predicted) - set(measured))
    extra = sorted(set(measured) - set(predicted))
    res = {"label": label, "ticks": horizon, "predicted": len(predicted),
           "logged": len(measured), "matched": len(both),
           "missing": len(missing), "extra": len(extra),
           "first_missing": missing[:3], "first_extra": extra[:3]}
    if both:
        lat = np.array([measured[k] - marks[k[0]] for k in both]) / RATE * 1000
        res.update(lat_min=float(lat.min()), lat_med=float(np.median(lat)),
                   lat_max=float(lat.max()))
        ideal = np.array([tl["seconds"](k[0]) for k in both])
        real = np.array([measured[k] for k in both]) / RATE
        err = real - ideal
        offset = float(np.median(err))
        dev = np.abs(err - offset) * 1000
        res.update(offset=offset, err_med=float(np.median(dev)),
                   err_p95=float(np.percentile(dev, 95)),
                   err_max=float(dev.max()))
        # How much later the last tick came than the tempo formula says.
        last = min(horizon, tl["end_tick"]) - 1
        if last > 0:
            span = (marks[last] - marks[0]) / RATE
            res["drift_ms"] = (span - tl["seconds"](last)) * 1000
    return res


KON_COLS = ["label", "ticks", "predicted", "logged", "matched", "missing",
            "extra", "lat_min", "lat_med", "lat_max", "offset", "err_med",
            "err_p95", "err_max", "drift_ms", "first_missing", "first_extra"]


def check_kon(rom, out, songs, effects):
    ram, _ = base_ram(rom)
    tempo = nspc.carrier_tempo(rom, ram, "song0")
    results = []
    for n in songs:
        spc, _, length = render_audio.expected_song_spc(rom, ram, n)
        sram, span = nspc.song_ram(rom, ram, n)
        song = nspc.parse_song(sram, nspc.u16(sram, nspc.SEQ_TABLE + 2 * nspc.SONG_ID),
                               span)
        # Three passes, so the layout outlasts the two that are rendered.
        tl = nspc.sequence_timeline(sram, song, loops=3)
        path = os.path.join(out, "kon_song_{:02d}.spc".format(n))
        with open(path, "wb") as f:
            f.write(spc)
        # The static length is a lower bound; play a third longer so two
        # full passes are covered even when the driver runs late.
        results.append(compare_sequence(path, tl,
                                        int(length["length_s"] * 1.3) + 2, out,
                                        "song_{:02d}".format(n)))
        os.remove(path)
    for sid in effects:
        spc, tl, length = render_audio.expected_sfx_spc(rom, ram, sid, tempo)
        path = os.path.join(out, "kon_sfx_{:02X}.spc".format(sid))
        with open(path, "wb") as f:
            f.write(spc)
        results.append(compare_sequence(path, tl, length["length_s"] + 1, out,
                                        "sfx_{:02X}".format(sid)))
        os.remove(path)

    def fmt(v):
        return "{:.3f}".format(v) if isinstance(v, float) else str(v)

    path = os.path.join(out, "kon.tsv")
    with open(path, "w") as f:
        f.write("\t".join(KON_COLS) + "\n")
        for r in results:
            f.write("\t".join(fmt(r.get(c, "-")) for c in KON_COLS) + "\n")

    bad = 0
    for kind in ("song", "sfx"):
        rs = [r for r in results if r["label"].startswith(kind)]
        if not rs:
            continue
        pred = sum(r["predicted"] for r in rs)
        match = sum(r["matched"] for r in rs)
        miss = sum(r["missing"] for r in rs)
        extra = sum(r["extra"] for r in rs)
        timed = [r for r in rs if "err_med" in r]
        print("kon: {} {}s: {} note-ons laid out, {} matched on voice and "
              "tick, {} missing, {} extra".format(len(rs), kind, pred, match,
                                                  miss, extra))
        if timed:
            print("     key-on after its tick began: median {:.2f} ms, max "
                  "{:.2f} ms".format(
                      float(np.median([r["lat_med"] for r in timed])),
                      max(r["lat_max"] for r in timed)))
            print("     vs 500 Hz x tempo/256: start offset {:.4f}..{:.4f} "
                  "s; |error| median {:.2f} ms, worst p95 {:.2f} ms, worst "
                  "max {:.2f} ms".format(
                      min(r["offset"] for r in timed),
                      max(r["offset"] for r in timed),
                      float(np.median([r["err_med"] for r in timed])),
                      max(r["err_p95"] for r in timed),
                      max(r["err_max"] for r in timed)))
            drift = [r["drift_ms"] for r in timed if "drift_ms" in r]
            if drift:
                print("     last tick later than the formula by {:.1f}..{:.1f} "
                      "ms".format(min(drift), max(drift)))
        for r in rs:
            if r["missing"] or r["extra"] or (r["predicted"] and not r["matched"]):
                bad += 1
                print("     DISAGREE {}: missing {} {} extra {} {}".format(
                    r["label"], r["missing"], r["first_missing"], r["extra"],
                    r["first_extra"]))
    print("     wrote {}".format(path))
    return bad


# --------------------------------------------------------------------------


def vlc_transcode(spc, wav, seconds, log):
    """Decode a .spc with VLC's libgme to a 32 kHz stereo WAV.

    VLC's gme demuxer ignores the ID666 length, and a first try without a
    bound wrote 1.4 GB before stopping. --stop-time bounds it; the size
    guard below is the backstop.
    """
    if os.path.exists(wav):
        os.remove(wav)
    limit = int((seconds + 20) * RATE * 4)
    cmd = [VLC, "-I", "dummy", "--no-video", "--play-and-exit",
           "--stop-time={}".format(int(seconds)), spc,
           "--sout", "#transcode{acodec=s16l,channels=2,samplerate=32000}"
           ":std{access=file,mux=wav,dst=" + wav + "}", "vlc://quit"]
    with open(log, "w") as lf:
        proc = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT)
        t0 = time.time()
        how = "exited"
        while proc.poll() is None:
            time.sleep(0.2)
            size = os.path.getsize(wav) if os.path.exists(wav) else 0
            if size > limit:
                proc.kill()
                how = "killed at the size guard"
                break
            if time.time() - t0 > 90:
                proc.kill()
                how = "killed after 90 s"
                break
        proc.wait()
    if not os.path.exists(wav) or os.path.getsize(wav) < 1000:
        return None, how
    # Never leave more than the wanted span on disk.
    with open(wav, "r+b") as f:
        f.truncate(min(os.path.getsize(wav), limit))
    return wav, how


def align(mine, theirs, span=1 << 19):
    """Lag (in samples) by which `mine` trails `theirs`, by cross-correlation."""
    n = min(span, len(mine), len(theirs))
    a = np.fft.rfft(mine[:n].astype(np.float64), 2 * n)
    b = np.fft.rfft(theirs[:n].astype(np.float64), 2 * n)
    cc = np.fft.irfft(a * np.conj(b))
    lag = int(np.argmax(cc))
    return lag - 2 * n if lag > n else lag


def rms_windows(x, win):
    k = len(x) // win
    return np.sqrt((x[:k * win].astype(np.float64).reshape(k, win) ** 2).mean(1))


def spectrogram(x, n=2048, hop=1024):
    w = np.hanning(n)
    frames = (len(x) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    return np.abs(np.fft.rfft(x[idx] * w, axis=1))


def band_levels(spec, n=2048):
    """Mean power in third-octave bands from 50 Hz up, in dB."""
    freqs = np.fft.rfftfreq(n, 1.0 / RATE)
    power = (spec ** 2).mean(0)
    edges = 50.0 * 2 ** (np.arange(0, 26) / 3.0)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = (freqs >= lo) & (freqs < hi)
        if hi <= RATE / 2 and sel.any():
            out.append((np.sqrt(lo * hi), 10 * np.log10(power[sel].sum() + 1e-12)))
    return out


TF_BANDS = (125, 250, 500, 1000, 2000, 4000, 8000)


def transfer(a, b, n=2048, hop=1024):
    """Per octave band: |H| of b relative to a, and their coherence.

    H is the cross-spectrum over a's auto-spectrum, averaged over frames; a
    coherence of 1 means b is a linearly filtered copy of a in that band.
    """
    w = np.hanning(n)
    frames = (len(a) - n) // hop
    idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
    fa = np.fft.rfft(a[idx] * w, axis=1)
    fb = np.fft.rfft(b[idx] * w, axis=1)
    sxy = (np.conj(fa) * fb).mean(0)
    sxx = (np.abs(fa) ** 2).mean(0)
    syy = (np.abs(fb) ** 2).mean(0)
    freqs = np.fft.rfftfreq(n, 1.0 / RATE)
    out = {}
    for c in TF_BANDS:
        sel = (freqs >= c / 2 ** 0.5) & (freqs < c * 2 ** 0.5)
        if sxx[sel].sum() <= 0 or syy[sel].sum() <= 0:
            continue
        out[c] = (float(np.abs(sxy[sel].sum()) / sxx[sel].sum()),
                  float(np.abs(sxy[sel].sum()) ** 2 /
                        (sxx[sel].sum() * syy[sel].sum())))
    return out


def compare_audio(mine, theirs):
    """Similarity figures between two mono signals, after alignment."""
    lag = align(mine, theirs)
    if lag >= 0:
        a, b = mine[lag:], theirs
    else:
        a, b = mine, theirs[-lag:]
    n = min(len(a), len(b))
    a, b = a[:n].astype(np.float64), b[:n].astype(np.float64)
    ea, eb = rms_windows(a, RATE // 20), rms_windows(b, RATE // 20)
    sa, sb = spectrogram(a), spectrogram(b)
    la, lb = band_levels(sa), band_levels(sb)
    da = np.array([x[1] for x in la])
    db = np.array([x[1] for x in lb])
    # Remove the overall level difference before comparing band shapes.
    delta = (da - db) - np.median(da - db)
    centre = np.array([x[0] for x in la])
    mid = (centre >= 200) & (centre <= 4000)
    tf = transfer(a, b)
    # Tempo agreement: once aligned at the start, the last few seconds must
    # still line up. A decoder that kept different time would slide here.
    tail = min(n, 4 * RATE)
    drift = align(a[n - tail:], b[n - tail:], span=tail)
    return {
        "lag_drift": drift,
        "tf_gain": " ".join("{}:{:.3f}".format(c, tf[c][0]) for c in sorted(tf)),
        "coherence": " ".join("{}:{:.4f}".format(c, tf[c][1]) for c in sorted(tf)),
        "coh_min": min(v[1] for v in tf.values()) if tf else 0.0,
        "lag": lag, "seconds": n / RATE,
        "wave_corr": float(np.corrcoef(a, b)[0, 1]),
        "env_corr": float(np.corrcoef(ea, eb)[0, 1]),
        "gain": float(np.sqrt((b ** 2).mean() / (a ** 2).mean())),
        "spec_cos": float((sa * sb).sum() / np.sqrt((sa ** 2).sum() * (sb ** 2).sum())),
        "band_corr": float(np.corrcoef(da, db)[0, 1]),
        "band_dev_mid": float(np.abs(delta[mid]).max()),
        "band_dev_all": float(np.abs(delta).max()),
        "worst_band_hz": float(centre[np.argmax(np.abs(delta))]),
    }


def square_wave_spc(path):
    """A 500 Hz square wave: one looping BRR block of eight +7 and eight -7
    nibbles at shift 12, played at pitch $0400, a quarter of the sample
    rate. The voice volume is kept low ($30) so that libgme's output gain
    cannot clip it; at full volume it does."""
    ram = bytearray(0x10000)
    ram[0x0300:0x0304] = struct.pack("<HH", 0x0400, 0x0400)
    ram[0x0400:0x0409] = bytes([0xC3]) + b"\x77" * 4 + b"\x99" * 4
    prog = dsp_program(voice_writes(0, pitch=0x0400, dir_page=0x03, vol=0x30))
    ram[PROGRAM_ADDR:PROGRAM_ADDR + len(prog)] = prog
    with open(path, "wb") as f:
        f.write(raw_spc(ram, PROGRAM_ADDR, "500 Hz square"))


# Songs 6 and 22 are ordinary five- and seven-voice loops; 2 is the long
# eight-voice one; 30 and 31 are the two that fall furthest behind the tempo
# formula, so they test whether libgme loses the same ticks.
VLC_SONGS = [6, 22, 2, 30, 31]

VLC_COLS = ["file", "vlc", "seconds", "lag", "lag_drift", "env_corr", "wave_corr",
            "spec_cos", "band_corr", "band_dev_mid", "band_dev_all",
            "worst_band_hz", "gain", "coh_min", "tf_gain", "coherence"]


def check_vlc(rom, out, songs, seconds):
    if not os.path.exists(VLC):
        print("vlc: {} is not installed; skipped".format(VLC))
        return 0
    ram, _ = base_ram(rom)
    items = []
    tone = os.path.join(out, "tone_500hz.spc")
    square_wave_spc(tone)
    items.append(("tone_500hz", tone))
    for n in songs:
        spc, _, _ = render_audio.expected_song_spc(rom, ram, n)
        path = os.path.join(out, "vlc_song_{:02d}.spc".format(n))
        with open(path, "wb") as f:
            f.write(spc)
        items.append(("song_{:02d}".format(n), path))

    rows = []
    for name, spc in items:
        theirs_path = os.path.join(out, name + "_vlc.wav")
        mine_path = os.path.join(out, name + "_spcrender.wav")
        got, how = vlc_transcode(spc, theirs_path, seconds,
                                 os.path.join(out, name + "_vlc.log"))
        render_audio.run_renderer([spc, "-o", mine_path, "--seconds",
                                   str(seconds + 5), "--fade", "0"])
        row = {"file": name, "vlc": how}
        if got is None:
            row["vlc"] = how + ", no output"
        else:
            mine = read_wav(mine_path).sum(1)
            theirs = read_wav(theirs_path).sum(1)
            if not theirs.any():
                row["vlc"] = how + ", silent"
            else:
                row.update(compare_audio(mine, theirs))
        rows.append(row)
        for p in (theirs_path, mine_path):
            if os.path.exists(p):
                os.remove(p)

    def fmt(v):
        return "{:.5f}".format(v) if isinstance(v, float) else str(v)

    path = os.path.join(out, "vlc.tsv")
    with open(path, "w") as f:
        f.write("\t".join(VLC_COLS) + "\n")
        for r in rows:
            f.write("\t".join(fmt(r.get(c, "-")) for c in VLC_COLS) + "\n")
    for r in rows:
        if "env_corr" not in r:
            print("vlc: {:<11s} {}".format(r["file"], r["vlc"]))
            continue
        print("vlc: {:<11s} {:5.1f} s, lag {:+d} (drift over the clip {:+d}): envelope corr {:.5f}, "
              "waveform corr {:.4f}, spectrogram cosine {:.4f}, band-level "
              "corr {:.4f} (worst {:.1f} dB at {:.0f} Hz; {:.1f} dB within "
              "200 Hz-4 kHz), libgme/spcrender level {:.3f}".format(
                  r["file"], r["seconds"], r["lag"], r["lag_drift"], r["env_corr"],
                  r["wave_corr"], r["spec_cos"], r["band_corr"],
                  r["band_dev_all"], r["worst_band_hz"], r["band_dev_mid"],
                  r["gain"]))
        print("     libgme/spcrender gain by octave: {}".format(r["tf_gain"]))
        print("     coherence by octave:             {}".format(r["coherence"]))
    print("     wrote {}".format(path))
    return 0


def _ints(text):
    return [int(x, 0) for x in text.split(",") if x.strip()]


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("check", nargs="?", default="all",
                    choices=("all", "brr", "kon", "vlc"))
    ap.add_argument("--out", default="build/spc/check")
    ap.add_argument("--songs", type=_ints,
                    help="comma-separated song numbers (kon: default all 33; "
                         "vlc: default 6,22,2,30,31)")
    ap.add_argument("--sfx", type=_ints,
                    help="kon: comma-separated effect ids (default all 125; "
                         "pass an empty string for none)")
    ap.add_argument("--vlc-seconds", type=int, default=40,
                    help="how much of each file VLC decodes (default 40)")
    args = ap.parse_args()

    try:
        rom = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    os.makedirs(args.out, exist_ok=True)
    try:
        render_audio.ensure_renderer()
        bad = 0
        if args.check in ("all", "brr"):
            bad += check_brr(rom, args.out)
        if args.check in ("all", "kon"):
            songs = args.songs if args.songs is not None else list(range(SONG_COUNT))
            effects = (args.sfx if args.sfx is not None
                       else list(range(1, nspc.SFX_ID_MAX + 1)))
            bad += check_kon(rom, args.out, songs, effects)
        if args.check in ("all", "vlc"):
            check_vlc(rom, args.out, args.songs if args.songs is not None
                      and args.check == "vlc" else VLC_SONGS, args.vlc_seconds)
    except (render_audio.RenderError, ValueError) as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
