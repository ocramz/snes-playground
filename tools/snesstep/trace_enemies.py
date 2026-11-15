#!/usr/bin/env python3
"""Every enemy species' idle animation, recorded from the game.

Every enemy is object type 73 (actor $0049). Its species is the layer-2 tile
- $40, with $50-$52 folded onto $4D-$4F (`$82:B646`), stored in the thread
slot's `$591C`. Each species has its own frame lists (`$85:9220`[species]
into `$89:C833`, built in a fixed WRAM block per species by `$82:B769`) and
its own per-frame code (`$85:9238`[species]), so its idle animation -- the
pictures and how long each shows -- is its own. Only `$4C`'s was measured
before (tools/export_web_sprites.py, from c1n).

For each species, this runs tools/snesstep through `inputs/play_hole1.txt`
on the first hole that has it (0-63 first), the hole picked by pokes at
2050 as tools/snesstep/holes.py does (with the course slot `$6A5C` too),
and snapshots every frame of an idle window: the ball is not touched before
2800. Each type-73 slot of that species is drawn every frame
(tools/emusheets.py: the part list in WRAM, the OBJ tiles and colours after
the NMI's upload), and its run of pictures gives the clip:
- where the sequence repeats ($40, $4A-$4E: `periodic`), its shortest
  period, each picture's frames the most common run length over the
  repeats (the game's lag frames stretch a run by two now and then);
- where it does not (the ability species $41-$49, $4F and the roulette $57,
  whose per-frame code `$85:952C` does not repeat over the window), the
  whole recorded run, looped. All the slots of one species move in step:
  they draw the species' one WRAM block.

Where the species also stands on a hole of another course, that hole is
run too and its pictures compared pixel by pixel: reported, not modelled.

    python3 tools/snesstep/trace_enemies.py              # every species
    python3 tools/snesstep/trace_enemies.py --species 4C,48

Output: build/sprites/enemies/species.json and one PNG per picture
(`<tile>_<n>.png`), with each picture's origin: the object's position, as
the emulated sheets have it (tools/objsheets.py `sheet`). A species' entry:
its pictures, and `frames`, the clip as [picture, frames] pairs.
"""

import argparse
import collections
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
TOOLS = os.path.dirname(HERE)
sys.path.insert(0, TOOLS)

import emusheets  # noqa: E402
import objsheets  # noqa: E402
import sprites  # noqa: E402
from coursemap import _layer2_values  # noqa: E402
from romcheck import load_rom  # noqa: E402

BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
SCRIPT = os.path.join(HERE, "inputs", "play_hole1.txt")
OUT = os.path.join(ROOT, "build", "sprites", "enemies")
POKE_FRAME = 2050
START, END = 2170, 2570          # the hole in play, the ball still (A at 2800)
ENEMY_TYPE = 73
F_SPECIES = 0x591C
HOLES = list(range(64)) + list(range(64, 180)) + list(range(192, 244))
SPECIES = list(range(0x10)) + [0x17]


def species_of(tile):
    if 0x50 <= tile <= 0x52:
        tile -= 3
    if 0x40 <= tile <= 0x4F or tile == 0x57:
        return tile - 0x40
    return None


def holes_by_species(d):
    """species -> the hole indices that have it, in HOLES order."""
    out = collections.defaultdict(list)
    for index in HOLES:
        for v in sorted(_layer2_values(d, index)):
            sp = species_of(v)
            if sp is not None and index not in out[sp]:
                out[sp].append(index)
    return out


def run_hole(index, out):
    course, hole = divmod(index, 8)
    if os.path.isdir(out):
        shutil.rmtree(out)
    subprocess.run(
        [BIN, "--frames", str(END + 1), "--input", SCRIPT,
         "--poke", "{}:$7E:6A5A={:04X}".format(POKE_FRAME, course),
         "--poke", "{}:$7E:6A5C={:04X}".format(POKE_FRAME, 2 * course),
         "--poke", "{}:$7E:6A5E={:04X}".format(POKE_FRAME, hole),
         "--snap-at", ",".join(str(f) for f in range(START, END)),
         "--no-dsp", "--quiet", "--out", out],
        check=True, capture_output=True)


def slot_parts(rom, wram, slot):
    """The parts type 73's slot draws this frame (emusheets.live_frames, one slot)."""
    y = 2 * slot
    index = emusheets.w16(wram, emusheets.F_INDEX + y)
    table = emusheets.w16(wram, emusheets.F_TABLE + y)
    if table < 0x8000 or index & 0x8000:
        return None
    addr = emusheets.frame_word(rom, table, index)
    if addr in (0, 0xFFFF):
        return None
    if addr < emusheets.WRAM_LIMIT:
        return emusheets.wram_parts(wram, addr)
    return objsheets.frame_parts(rom, addr)


def record(rom, run_dir):
    """{slot: (species, [picture key or None per frame])}, {key: Frame}."""
    seqs = {}
    pictures = {}
    for f in range(START, END):
        path = os.path.join(run_dir, "f{:06d}".format(f))
        if not os.path.isfile(os.path.join(path, "regs.json")):
            continue
        snap = emusheets.load_snapshot(path)
        wram = snap["wram"]
        tiles = emusheets.obj_tiles(snap)
        pals = emusheets.obj_palettes(snap["cgram"])
        for slot in range(emusheets.THREAD_SLOTS):
            if emusheets.w16(wram, emusheets.F_TYPE + 2 * slot) != ENEMY_TYPE:
                continue
            sp = emusheets.w16(wram, F_SPECIES + 2 * slot)
            parts = slot_parts(rom, wram, slot)
            key = None
            if parts:
                used = {t: tiles[t] for t in objsheets.tiles_of(parts)}
                used_pals = sorted(set(p["palette"] for p in parts))
                key = (tuple(p["raw"] for p in parts), tuple(sorted(used.items())),
                       tuple(tuple(pals[p]) for p in used_pals))
                if key not in pictures:
                    fr = objsheets.Frame()
                    fr.addr, fr.parts, fr.tiles, fr.palettes = 0, parts, used, pals
                    pictures[key] = fr
            seqs.setdefault(slot, (sp, []))[1].append(key)
    return seqs, pictures


def runs(seq):
    out = []
    for k in seq:
        if out and out[-1][0] == k:
            out[-1][1] += 1
        else:
            out.append([k, 1])
    return out


def cycle(seq):
    """(pictures, durations, periodic) of the run sequence: its shortest
    period, or else every full run as recorded; None if a slot stops drawing."""
    r = runs(seq)
    inner = r[1:-1]                 # the window cuts the first and last runs
    if not inner or any(k is None for k, _ in inner):
        return None
    if len(set(k for k, _ in inner)) == 1:
        return [inner[0][0]], [max(n for _, n in inner)], True
    for p in range(1, len(inner) // 2 + 1):
        if all(inner[i][0] == inner[i + p][0] for i in range(len(inner) - p)):
            keys = [inner[j][0] for j in range(p)]
            durs = []
            for j in range(p):
                seen = collections.Counter(inner[i][1] for i in range(j, len(inner), p))
                durs.append(seen.most_common(1)[0][0])
            return keys, durs, True
    return [k for k, _ in inner], [n for _, n in inner], False


def pixels(fr):
    """A picture's look: its box and RGBA bytes (the tile numbers, which
    depend on the hole's VRAM slot, do not count)."""
    box = sprites.frame_bbox(fr.parts)
    return box, objsheets.draw(fr.parts, fr.tiles, fr.palettes, box).tobytes()


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--species", help="comma list of tiles, e.g. 4C,57 (default: every species)")
    ap.add_argument("--out", default=OUT)
    ap.add_argument("--keep", action="store_true", help="keep the snapshots")
    args = ap.parse_args()
    if not os.path.exists(BIN):
        raise SystemExit("build the stepper first: make tools")
    rom = load_rom()
    want = SPECIES if not args.species else [
        species_of(int(t, 16)) for t in args.species.split(",")]
    by = holes_by_species(rom)
    os.makedirs(args.out, exist_ok=True)
    runs_dir = os.path.join(ROOT, "build", "emu", "enemies")
    recorded = {}

    def recorded_hole(index):
        if index not in recorded:
            d = os.path.join(runs_dir, "h{:03d}".format(index))
            run_hole(index, d)
            recorded[index] = record(rom, d)
            if not args.keep:
                shutil.rmtree(d, ignore_errors=True)
        return recorded[index]

    result = {}
    for sp in want:
        tile = 0x40 + sp
        holes = by.get(sp, [])
        if not holes:
            print("${:02X}: on no hole".format(tile))
            continue
        index = holes[0]
        seqs, pictures = recorded_hole(index)
        slots = [s for s, (k, _) in sorted(seqs.items()) if k == sp]
        if not slots:
            print("${:02X}: hole {} has no slot of it".format(tile, index))
            continue
        slot = slots[0]
        found = cycle(seqs[slot][1])
        if not found:
            print("${:02X}: hole {} slot {}: the slot stops drawing in the window".format(tile, index, slot))
            continue
        keys, durs, periodic = found
        distinct = list(dict.fromkeys(keys))
        frames = [pictures[k] for k in distinct]
        box = objsheets.union_box(frames)
        entry = {"tile": "${:02X}".format(tile), "hole": index, "slot": slot,
                 "periodic": periodic, "cycle": sum(durs), "pictures": [], "frames": []}
        for i, fr in enumerate(frames):
            name = "{:02X}_{}.png".format(tile, i)
            objsheets.draw(fr.parts, fr.tiles, fr.palettes, box).save(os.path.join(args.out, name))
            entry["pictures"].append({"png": name, "ox": -box[0], "oy": -box[1]})
        entry["frames"] = [[distinct.index(k), d] for k, d in zip(keys, durs)]
        # the other slots of the species on this hole draw the same block
        entry["inStep"] = all(seqs[s][1] == seqs[slot][1] for s in slots[1:])
        other = next((h for h in holes if h // 8 != index // 8), None)
        if other is not None:
            oseqs, opics = recorded_hole(other)
            oslots = [s for s, (k, _) in sorted(oseqs.items()) if k == sp]
            if oslots:
                mine = set(pixels(pictures[k]) for k in distinct)
                theirs = set(pixels(opics[k]) for k in oseqs[oslots[0]][1] if k)
                shapes = lambda ps: set((b, bytes(px[3::4])) for b, px in ps)
                entry["compared"] = {
                    "hole": other,
                    "samePictures": theirs <= mine,
                    "sameShapes": shapes(theirs) <= shapes(mine),
                }
        result["{:02X}".format(tile)] = entry
        print("${:02X}: hole {} slot {}: {} pictures, {} runs, {} frames{}{}{}".format(
            tile, index, slot, len(distinct), len(keys), sum(durs),
            " a cycle ({})".format(" ".join(str(d) for d in durs)) if periodic else " recorded",
            "" if entry["inStep"] else "; slots NOT in step",
            "; vs hole {}: {}".format(entry["compared"]["hole"],
                                      "same" if entry["compared"]["samePictures"] else
                                      "other colours" if entry["compared"]["sameShapes"] else
                                      "other pictures") if "compared" in entry else ""))
    path = os.path.join(args.out, "species.json")
    prev = {}
    if args.species and os.path.exists(path):
        with open(path) as f:
            prev = json.load(f).get("species", {})
    prev.update(result)
    with open(path, "w") as f:
        json.dump({"about": "every enemy species' idle clip: tools/snesstep/trace_enemies.py "
                            "(frames {}-{} of play_hole1 on the first hole with it)".format(START, END),
                   "species": prev}, f, indent=1)
    print("wrote {} ({} species)".format(path, len(prev)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
