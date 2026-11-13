#!/usr/bin/env python3
"""Sprite sheets from emulator snapshots: every frame as it was on screen.

tools/objsheets.py works out statically which tiles each object uploads, and
has to flag what it cannot prove. A snapshot from tools/snesstep (see
docs/emulation.md) removes the guessing: it holds the live WRAM, VRAM and
CGRAM of one frame, so for every object alive in it the game's own state
says which frame it is showing, and the PPU memory says what that frame
looks like.

Read per snapshot:

* thread objects, 64 slots at `$7E:4E1C` (type, `$FFFF` = free): frame
  table `$5E1C`, index `$5D9C` (negative = hidden), draw routine `$519C`.
  The default draw routines `$80:E55A` / `$80:E5A2` read table[index];
  any other draw routine is taken to hold a frame list in `$5E1C` when the
  word parses as one (tools/frametabs.py `classify_obj2`);
* script-driven objects, 16 slots: table `$0B9E,X` / bank `$0BBE,X`, index
  `$0B7E,X` (negative = hidden).

A frame pointer below `$2000` is read from the snapshot's WRAM: with
DBR = `$89` such an address is the low-WRAM mirror, and `tbl_frames_in_wram
$89:C833` points there because actor type 73 builds its part lists at run
time (`$7E:120F` up). Those are drawn like any other list.

Each live (object, frame) is drawn with the snapshot's OBJ page (name base
and gap from OBSEL) and the snapshot's CGRAM. Identical pictures are kept
once. Output, under `--out` (default build/sprites/emu):

    obj_NNN.png / .json     every distinct frame thread object type NNN was
                            seen showing, with the frames it was seen in
    script_TTTT.png / .json the same for a script-driven object, keyed by
                            its frame table
    index.tsv               one row per sheet

Nothing here is inferred from code: a frame is in a sheet only because the
game had it on screen.

    python3 tools/emusheets.py build/emu/hole1/f0*          # many snapshots
    python3 tools/emusheets.py build/emu/*/f* --out build/sprites/emu

`--cache FILE` keeps what was seen between invocations, so a long batch can
feed one run's snapshots at a time and delete them afterwards
(tools/snesstep/holes.py does this).
"""

import argparse
import json
import os
import pickle
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import frametabs  # noqa: E402
import objsheets  # noqa: E402
import sprites  # noqa: E402
from lorom import fmt_snes, snes_to_file  # noqa: E402
from romcheck import RomError, load_rom  # noqa: E402
from tiles import snes_color  # noqa: E402

FRAME_BANK = 0x89
THREAD_SLOTS = 64
F_TYPE, F_DRAW, F_INDEX, F_TABLE = 0x4E1C, 0x519C, 0x5D9C, 0x5E1C
F_X, F_Y = 0x5F1C, 0x5F9C
DEFAULT_DRAW = (0xE55A, 0xE5A2)
SCRIPT_SLOTS = 16
S_INDEX, S_TABLE, S_BANK = 0x0B7E, 0x0B9E, 0x0BBE
TILE = 32


def w16(buf, addr):
    return buf[addr] | (buf[addr + 1] << 8)


def load_snapshot(path):
    """WRAM as the frame's logic left it, with VRAM and CGRAM as they are
    once the following NMI has made its uploads (`*_post.bin`, written by
    tools/snesstep alongside every vblank snapshot). That pairing is what
    the screen shows: the game sets a frame index during its logic and the
    NMI then uploads the frame's tiles, so the plain `vram.bin` of a vblank
    snapshot is one upload behind the index and draws the previous frame's
    art under the new layout. Older snapshots without the files fall back
    to the plain ones.
    """
    def raw(name):
        post = os.path.join(path, name.replace(".bin", "_post.bin"))
        if name != "wram.bin" and os.path.exists(post):
            name = os.path.basename(post)
        with open(os.path.join(path, name), "rb") as f:
            return f.read()
    with open(os.path.join(path, "regs.json")) as f:
        regs = json.load(f)
    return {"path": path, "frame": regs.get("frame"), "wram": raw("wram.bin"),
            "vram": raw("vram.bin"), "cgram": raw("cgram.bin"),
            "obsel": regs["ppu"]["obsel"]}


def obj_tiles(snap):
    """{tile number 0-511: 32 bytes} of the OBJ page OBSEL selects."""
    obsel = snap["obsel"]
    base = (obsel & 7) << 13
    gap = ((obsel >> 3) & 3) << 12
    out = {}
    v = snap["vram"]
    for t in range(512):
        word = base + (t & 0xFF) * 16
        if t & 0x100:
            word += 0x1000 + gap
        word &= 0x7FFF
        out[t] = bytes(v[2 * word:2 * word + TILE])
    return out


def obj_palettes(cgram):
    return [[snes_color(cgram[0x100 + p * 32 + 2 * i] |
                        (cgram[0x100 + p * 32 + 2 * i + 1] << 8))
             for i in range(16)] for p in range(8)]


WRAM_LIMIT = 0x2000


def wram_parts(wram, addr):
    """Drawable parts of a part list built in low WRAM, or None."""
    parts, _ = sprites.parse_frame(wram, addr, follow=False)
    real = [p for p in parts if "control" not in p]
    if not real or not real[-1]["last"]:
        return None
    if any(p["raw"][4] & frametabs.PART_FLAG_SPARE for p in real):
        return None
    return real


def valid(rom, wram, addr):
    if addr < WRAM_LIMIT:
        return wram_parts(wram, addr) is not None
    return addr >= 0x8000 and bool(frametabs.frame_ok(rom, FRAME_BANK, addr))


def frame_word(rom, table, index):
    off = snes_to_file(FRAME_BANK, (table + 2 * index) & 0xFFFF)
    return rom[off] | (rom[off + 1] << 8)


def live_frames(rom, snap):
    """[(key, list address, table, index)] for every object drawn this frame."""
    wram = snap["wram"]
    out = []
    for slot in range(THREAD_SLOTS):
        y = 2 * slot
        typ = w16(wram, F_TYPE + y)
        if typ == 0xFFFF:
            continue
        index = w16(wram, F_INDEX + y)
        table = w16(wram, F_TABLE + y)
        draw = w16(wram, F_DRAW + y)
        if table < 0x8000:
            continue
        if draw in DEFAULT_DRAW:
            if index & 0x8000:
                continue
            addr = frame_word(rom, table, index)
        else:
            kind = frametabs.classify_obj2(rom, table)
            if kind is None:
                continue
            if kind[0] == "list":
                addr, index = table, None
            else:
                if index & 0x8000:
                    continue
                addr = frame_word(rom, table, index)
        if addr in (0, 0xFFFF) or not valid(rom, wram, addr):
            continue
        out.append((("obj", typ), addr, table, index))
    for slot in range(SCRIPT_SLOTS):
        x = 2 * slot
        index = w16(wram, S_INDEX + x)
        table = w16(wram, S_TABLE + x)
        bank = wram[S_BANK + x]
        if index & 0x8000 or table < 0x8000 or (bank & 0x7F) not in (0x04, 0x09):
            continue
        off = snes_to_file(0x80 | bank, (table + 2 * index) & 0xFFFF)
        addr = rom[off] | (rom[off + 1] << 8)
        if addr in (0, 0xFFFF) or not frametabs.frame_ok(rom, FRAME_BANK, addr):
            continue
        out.append((("script", (0x80 | bank) << 16 | table), addr, table, index))
    return out


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("snapshots", nargs="*", help="snapshot directories")
    ap.add_argument("--out", default="build/sprites/emu")
    ap.add_argument("--scale", type=int, default=1)
    ap.add_argument("--cache", help="merge with, and update, this pickle")
    ap.add_argument("--merge", action="append", default=[],
                    help="also read this cache (repeatable; not written)")
    ap.add_argument("--no-write", action="store_true",
                    help="update --cache only; skip the sheets")
    args = ap.parse_args()

    try:
        rom = load_rom()
    except RomError as e:
        print("error: {}".format(e), file=sys.stderr)
        return 1

    groups = {}          # key -> {picture key: Frame}
    seen_in = {}         # (key, picture key) -> [snapshot labels]
    if args.cache and os.path.exists(args.cache):
        with open(args.cache, "rb") as fh:
            groups, seen_in = pickle.load(fh)
    for extra in args.merge:
        with open(extra, "rb") as fh:
            g2, s2 = pickle.load(fh)
        for key, bucket in g2.items():
            mine = groups.setdefault(key, {})
            for pk, f in bucket.items():
                if pk in mine:
                    mine[pk].duration += f.duration
                else:
                    mine[pk] = f
        for k, v in s2.items():
            seen_in.setdefault(k, []).extend(v)
    used = 0
    keys_of = {}
    for bucket in groups.values():
        for pk, f in bucket.items():
            keys_of[id(f)] = pk
    for path in sorted(args.snapshots):
        if not os.path.isfile(os.path.join(path, "regs.json")):
            continue
        snap = load_snapshot(path)
        used += 1
        tiles = obj_tiles(snap)
        pals = obj_palettes(snap["cgram"])
        for key, addr, table, index in live_frames(rom, snap):
            if addr < WRAM_LIMIT:
                parts = wram_parts(snap["wram"], addr)
            else:
                parts = objsheets.frame_parts(rom, addr)
            if not parts:
                continue
            f = objsheets.Frame()
            f.addr, f.parts, f.table, f.index = addr, parts, table, index
            f.duration, f.site, f.flags = 1, None, ["observed"]
            f.tiles = {t: tiles[t] for t in objsheets.tiles_of(parts)}
            f.palettes = pals
            used_pals = sorted(set(pt["palette"] for pt in parts))
            # Only the frame's own tiles and palettes make it distinct: the
            # other OBJ palettes change all the time (fades, cycling) and
            # would split one picture into hundreds.
            # A WRAM list is identified by its contents, not its address:
            # the same buffer holds a different picture every frame.
            ident = addr if addr >= WRAM_LIMIT else tuple(
                p["raw"] for p in parts)
            pk = (ident, tuple(sorted(f.tiles.items())),
                  tuple(tuple(pals[p]) for p in used_pals))
            bucket = groups.setdefault(key, {})
            if pk not in bucket:
                bucket[pk] = f
            else:
                bucket[pk].duration += 1
            label = "{}/{}".format(os.path.basename(os.path.dirname(
                os.path.abspath(path))), os.path.basename(path))
            seen_in.setdefault((key, pk), []).append(label)
            keys_of[id(bucket[pk])] = pk

    if args.cache:
        with open(args.cache, "wb") as fh:
            pickle.dump((groups, seen_in), fh)
    if args.no_write:
        print("{} snapshots; cache now holds {} objects, {} pictures".format(
            used, len(groups), sum(len(b) for b in groups.values())))
        return 0
    if not os.path.isdir(args.out):
        os.makedirs(args.out)
    rows = []
    for key in sorted(groups, key=lambda k: (k[0], k[1])):
        # Pictures that differ only in colour -- a fade, a hit flash, a
        # cycling palette -- are one picture: keep the most-seen colouring
        # and count the rest.
        by_shape = {}
        for pk, f in groups[key].items():
            shape = pk[:2]
            best = by_shape.get(shape)
            if best is None:
                by_shape[shape] = [f, pk, 1, f.duration]
            else:
                best[2] += 1
                best[3] += f.duration
                if f.duration > best[0].duration:
                    best[0], best[1] = f, pk
        variants = {}
        frames = []
        for f, pk, n, total in by_shape.values():
            variants[id(f)] = (n, total)
            frames.append(f)
        frames.sort(key=lambda f: (f.table or 0, f.index or 0, f.addr
                                   if isinstance(f.addr, int) else 0))
        if key[0] == "obj":
            name = "obj_{:03d}".format(key[1])
        else:
            name = "script_{:02X}_{:04X}".format(key[1] >> 16, key[1] & 0xFFFF)
        stem = os.path.join(args.out, name)
        img, atlas = objsheets.sheet(frames, scale=args.scale)
        img.save(stem + ".png")
        for cell, f in zip(atlas["frames"], frames):
            cell["snapshots"] = sorted(set(seen_in[(key, keys_of[id(f)])]))[:8]
            cell["sightings"] = variants[id(f)][1]
            cell["colour_variants"] = variants[id(f)][0]
        with open(stem + ".json", "w") as fh:
            json.dump(atlas, fh, indent=1)
        tables = sorted(set(f.table for f in frames if f.table is not None))
        rows.append([name, len(frames), sum(variants[id(f)][1] for f in frames),
                     ",".join(fmt_snes(FRAME_BANK, t) for t in tables) or "-",
                     len(set(f.addr for f in frames))])
    path = os.path.join(args.out, "index.tsv")
    with open(path, "w") as fh:
        fh.write("sheet\tdistinct_pictures\tsightings\ttables\tdistinct_layouts\n")
        for r in rows:
            fh.write("\t".join(str(c) for c in r) + "\n")
    print("{} snapshots, {} objects seen, {} distinct pictures; wrote {}".format(
        used, len(rows), sum(r[1] for r in rows), path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
