#!/usr/bin/env python3
"""Frame-by-frame record of hole 1's intro and hole-out, for the web demo.

Replays `build/emu/autoplay/c1n` (course 1 played by tools/snesstep/autoplay.py,
the same run the demo's sprites are cut from) with a snapshot at every frame of
three windows and writes what the game drew in them. The windows are that run's
frames; today's autoplay.py writes `course1` instead, whose trace differs in the
enemies' pictures during the hole-out (docs/web-demo.md), so c1n is kept:

    intro      Kirby flies in on the warp star and jumps onto the tee
               (the hole is loaded at 2061; the aim stage starts at 2338)
    outroHio   the hole-out of that run: holed at 3121 in one stroke, so the
               HOLE IN ONE banner, fireworks and 1UP come before the star exit
    outro      the same hole-out with the shot counter `$7E:D82A` poked to 3
               at frame 3150: `$83:D2AB` compares it with 2 (the counter is 1
               when the hole starts, `$80:C1DC`, and +1 at each shot set-up,
               `$80:C50B`), so the game takes its ordinary path

Per frame: every live thread object (type, position, the picture it showed),
the scroll `$0086/$0088`, INIDISP, which BG palette was up, and the effects and
songs requested (`--log-pc` on `sub_spc_sfx_trigger $80:B542` and
`sub_spc_play_song $80:B4AC`, the id in A).

Thread-object positions are in **screen** pixels for every type that takes part
(checked against OAM: the warp star 105 lands at (128, 112), the tee's screen
position under the scroll (192, 152); the trail sparkles 106 sit where their
OAM entries are, plus their origin). Pictures are drawn exactly as
tools/emusheets.py draws them (the frame's part list over the frame's OBJ
tiles and palettes) and kept once per distinct image. A slot without a draw
routine (`$519C` = 0) is skipped: it shows nothing.

    python3 tools/snesstep/trace_cutscene.py            # about a minute
    python3 tools/snesstep/trace_cutscene.py --keep     # keep the snapshots
    python3 tools/snesstep/trace_cutscene.py --replay build/emu/autoplay/course1 \
        --out build/x                                   # another run, elsewhere

Output: build/web-test/cutscene_hole0.json and build/web-test/cutscene_pics/
(the snapshots go to build/emu/cutscene_hole0/<window>/, CHUNK frames at a
time, and are removed as they are read unless --keep).
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.dirname(HERE))

import emusheets as E  # noqa: E402
import objsheets  # noqa: E402
import sprites  # noqa: E402
from romcheck import load_rom  # noqa: E402

BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
REPLAY = os.path.join(ROOT, "build", "emu", "autoplay", "c1n")
RUN_DIR = os.path.join(ROOT, "build", "emu", "cutscene_hole0")
OUT_DIR = os.path.join(ROOT, "build", "web-test")

WINDOWS = {
    # name: (first frame, last frame, extra stepper args)
    "intro": (2150, 2345, []),
    "outroHio": (3115, 3960, []),
    "outro": (3115, 3620, ["--poke", "3150:$7E:D82A=0003"]),
}
SFX_PC, SONG_PC = "$80:B542", "$80:B4AC"


def s16(v):
    return v - 65536 if v >= 32768 else v


CHUNK = 48   # frames of snapshots held on disk at a time (~280 KB each)


def run(name, first, last, extra, replay):
    out = os.path.join(RUN_DIR, name)
    if os.path.isdir(out):
        shutil.rmtree(out)
    snaps = ",".join(str(f) for f in range(first, last + 1))
    cmd = [BIN, "--frames", str(max(last + 1, 3962)),
           "--input", os.path.join(replay, "input.txt"),
           "--pokes", os.path.join(replay, "pokes.txt"),
           "--snap-at", snaps, "--log-pc", SFX_PC, "--log-pc", SONG_PC,
           "--no-dsp", "--quiet", "--out", out] + extra
    subprocess.run(cmd, check=True)
    return out


def cues(run_dir, first, last):
    """[[frame, 'sfx' | 'song', id]] requested in the window."""
    out = []
    with open(os.path.join(run_dir, "pclog.tsv")) as f:
        next(f)
        for line in f:
            c = line.rstrip("\n").split("\t")
            fr, pc, a = int(c[0]), c[3], int(c[4], 16)
            if first <= fr <= last:
                if pc == SFX_PC:
                    out.append([fr, "sfx", a & 0xFF])
                elif pc == SONG_PC:
                    out.append([fr, "song", a & 0xFF])
    return out


class Pictures(object):
    """Distinct object pictures, saved as PNGs with their origin."""

    def __init__(self, out):
        self.out = out
        self.by_hash = {}
        self.meta = {}
        if os.path.isdir(out):
            shutil.rmtree(out)
        os.makedirs(out)

    def add(self, typ, parts, tiles, pals):
        box = sprites.frame_bbox(parts)
        img = objsheets.draw(parts, tiles, pals, box)
        if img.getbbox() is None:
            return None
        h = hashlib.sha1(img.tobytes() + repr(box).encode()).hexdigest()[:12]
        key = self.by_hash.get(h)
        if key is None:
            key = "t{:03d}_{:03d}".format(typ, sum(1 for k in self.meta if k.startswith("t{:03d}_".format(typ))))
            self.by_hash[h] = key
            img.save(os.path.join(self.out, key + ".png"))
            # the object's position is at -box[0], -box[1] inside the picture
            self.meta[key] = {"file": key + ".png", "ox": -box[0], "oy": -box[1],
                              "w": img.width, "h": img.height}
        return key


def objects(rom, snap, pics):
    """Every drawn thread object: [type, slot, x, y, picture]."""
    wram = snap["wram"]
    tiles = E.obj_tiles(snap)
    pals = E.obj_palettes(snap["cgram"])
    out = []
    for slot in range(E.THREAD_SLOTS):
        y = 2 * slot
        typ = E.w16(wram, E.F_TYPE + y)
        if typ == 0xFFFF:
            continue
        index = E.w16(wram, E.F_INDEX + y)
        table = E.w16(wram, E.F_TABLE + y)
        draw = E.w16(wram, E.F_DRAW + y)
        # no draw routine: the slot shows nothing (type 109's sparkles in the intro and
        # 17/130/131 after the 1UP have a frame table but are never on screen)
        if table < 0x8000 or draw == 0:
            continue
        if draw in E.DEFAULT_DRAW:
            if index & 0x8000:
                continue
            addr = E.frame_word(rom, table, index)
        else:
            kind = E.frametabs.classify_obj2(rom, table)
            if kind is None:
                continue
            if kind[0] == "list":
                addr = table
            else:
                if index & 0x8000:
                    continue
                addr = E.frame_word(rom, table, index)
        if addr in (0, 0xFFFF) or not E.valid(rom, wram, addr):
            continue
        if addr < E.WRAM_LIMIT:
            parts = E.wram_parts(wram, addr)
        else:
            parts = objsheets.frame_parts(rom, addr)
        if not parts:
            continue
        sub = {t: tiles[t] for t in objsheets.tiles_of(parts)}
        key = pics.add(typ, parts, sub, pals)
        if key is None:
            continue
        out.append([typ, slot, s16(E.w16(wram, E.F_X + y)), s16(E.w16(wram, E.F_Y + y)), key])
    return out


def window(rom, name, first, last, extra, pics, palettes, keep, replay):
    """Replays the run once per chunk of frames so that only CHUNK snapshots
    exist at a time (the replay itself takes about a second)."""
    frames = []
    found = []
    for a in range(first, last + 1, CHUNK):
        b = min(last, a + CHUNK - 1)
        for attempt in range(3):
            try:
                run_dir = run(name, a, b, extra, replay)
            except subprocess.CalledProcessError:
                continue
            got = frames_of(rom, a, b, run_dir, pics, palettes)
            if not found:
                found = cues(run_dir, first, last)
            if not keep:
                shutil.rmtree(run_dir)
            if len(got) == b - a + 1:
                break
        else:
            raise SystemExit("{}: frames {}-{} were not all captured (disk full?)".format(name, a, b))
        frames += got
    return {"first": first, "last": last, "frames": frames, "cues": found}


def frames_of(rom, first, last, run_dir, pics, palettes):
    frames = []
    for fr in range(first, last + 1):
        path = os.path.join(run_dir, "f{:06d}".format(fr))
        if not os.path.exists(os.path.join(path, "regs.json")):
            continue
        snap = E.load_snapshot(path)
        with open(os.path.join(path, "regs.json")) as f:
            regs = json.load(f)
        wram = snap["wram"]
        bg = snap["cgram"][:256].hex()        # BG palettes 0-7
        if bg not in palettes:
            palettes.append(bg)
        frames.append({
            "f": fr,
            "scroll": [s16(E.w16(wram, 0x86)), s16(E.w16(wram, 0x88))],
            "inidisp": regs["ppu"]["inidisp"],
            "pal": palettes.index(bg),
            "state": E.w16(wram, 0xD7D4),
            "objs": objects(rom, snap, pics),
        })
    return frames


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keep", action="store_true", help="keep the snapshots")
    ap.add_argument("--only", choices=sorted(WINDOWS), action="append")
    ap.add_argument("--replay", default=REPLAY,
                    help="the autoplay run to replay (default {})".format(os.path.relpath(REPLAY, ROOT)))
    ap.add_argument("--out", default=OUT_DIR,
                    help="where cutscene_hole0.json and cutscene_pics/ go (default {})".format(
                        os.path.relpath(OUT_DIR, ROOT)))
    args = ap.parse_args()
    if not os.path.exists(BIN):
        print("build the stepper first (docs/tooling.md)", file=sys.stderr)
        return 1
    if not os.path.exists(os.path.join(args.replay, "pokes.txt")):
        print("run `python3 tools/snesstep/autoplay.py --course 0` first "
              "(expected {})".format(args.replay), file=sys.stderr)
        return 1
    rom = load_rom()
    pics = Pictures(os.path.join(args.out, "cutscene_pics"))
    palettes = []
    result = {"about": __doc__.strip().split("\n")[0], "source": os.path.relpath(args.replay, ROOT),
              "windows": {}}
    for name in (args.only or list(WINDOWS)):
        first, last, extra = WINDOWS[name]
        result["windows"][name] = window(rom, name, first, last, extra, pics, palettes, args.keep,
                                         args.replay)
        w = result["windows"][name]
        print("{}: {} frames, {} cues".format(name, len(w["frames"]), len(w["cues"])))
    result["palettes"] = palettes
    result["pictures"] = pics.meta
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "cutscene_hole0.json")
    with open(path, "w") as f:
        json.dump(result, f, separators=(",", ":"))
    print("{} pictures -> {}".format(len(pics.meta), path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
