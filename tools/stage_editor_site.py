#!/usr/bin/env python3
"""Stage the level editor's public files (docs/editor.md "The site").

Copies from build/engine what editor.html loads, and nothing else:

- rules/tables.json, the physics (and the solver's) tables;
- the top-level assets the manifest lists (sprites, objects, ui, hud, card,
  pause and look pictures, the font, the cutscenes, the course art's
  exemplar patches), except the songs a level never plays;
- every sound effect, and the songs of LEVEL_SONGS, ogg and mp3;
- holes/000/layer_bg3.png, course 1's scenery behind the holes without
  bitmaps;
- audio.json and manifest.json rewritten to list only those (the manifest's
  courses: course 1 with hole 0 alone, which is what makes the preload load
  the scenery; the editor's page offers no ROM course).

So the ROM's 64 holes, rom-test/ and the other fixtures stay out. The result
is still derived from the ROM: it is for the user to publish or not.

    python3 tools/stage_editor_site.py --src build/engine --out build/editor-site-public
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

# The songs a level made in the editor requests (engine/src/game/features/audio/
# event-table.ts `song`, less the ROM holes' own 6-14): its hole song 11
# (HOLE_SONG, course 1's), the fall's 17 and 18 (systems/camera.ts), the
# hole-out's 24, 25 and 26 (systems/hole-flow.ts). engine/test/level-site.test.ts
# checks this list against the event table.
LEVEL_SONGS = [11, 17, 18, 24, 25, 26]


def twins(name):
    """A sound's file and its other format (the preload asks for both)."""
    stem = name.rsplit(".", 1)[0]
    return [f"{stem}.ogg", f"{stem}.mp3"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", default="build/engine", help="the engine's derived files (make engine-assets)")
    ap.add_argument("--out", default="build/editor-site-public", help="the staging directory (replaced)")
    a = ap.parse_args()
    src = Path(a.src)
    out = Path(a.out)
    assets = src / "assets"
    for need in (src / "rules/tables.json", assets / "manifest.json", assets / "audio.json"):
        if not need.exists():
            sys.exit(f"missing {need}: run make engine-assets (and make {src}/rules/tables.json)")
    if out.exists():
        if not (out / "assets").exists() and any(out.iterdir()):
            sys.exit(f"{out} exists and does not look like a staging directory; not replacing it")
        shutil.rmtree(out)
    (out / "rules").mkdir(parents=True)
    (out / "assets/holes/000").mkdir(parents=True)
    shutil.copy2(src / "rules/tables.json", out / "rules/tables.json")

    manifest = json.loads((assets / "manifest.json").read_text())
    audio = json.loads((assets / "audio.json").read_text())

    sounds = set()
    songs = {}
    for n in LEVEL_SONGS:
        entry = audio["songs"].get(str(n))
        if entry is None:
            sys.exit(f"audio.json has no song {n}")
        songs[str(n)] = entry
        sounds.update(twins(entry["file"]))
    for f in audio["sfx"].values():
        sounds.update(twins(f))
    every_sound = set()
    for entry in audio["songs"].values():
        every_sound.update(twins(entry["file"]))
    if "music" in audio:
        every_sound.update(twins(audio["music"]["file"]))
    for f in audio["sfx"].values():
        every_sound.update(twins(f))

    kept = []
    for name in manifest["files"]:
        if name == "holes":
            continue
        if name in every_sound and name not in sounds:
            continue  # a song a level never plays
        if not (assets / name).is_file():
            continue
        shutil.copy2(assets / name, out / "assets" / name)
        kept.append(name)
    for name in sorted(sounds):
        if name not in kept and (assets / name).is_file():
            shutil.copy2(assets / name, out / "assets" / name)
            kept.append(name)
    shutil.copy2(assets / "holes/000/layer_bg3.png", out / "assets/holes/000/layer_bg3.png")

    trimmed_audio = dict(audio)
    trimmed_audio["songs"] = songs
    if "music" in audio and not set(twins(audio["music"]["file"])) <= sounds:
        del trimmed_audio["music"]
    (out / "assets/audio.json").write_text(json.dumps(trimmed_audio, indent=1))
    if "audio.json" not in kept:
        kept.append("audio.json")

    course1 = next((c for c in manifest.get("courses", []) if any(h["index"] == 0 for h in c["holes"])), None)
    trimmed = dict(manifest)
    trimmed["files"] = sorted(kept) + ["holes"]
    trimmed["courses"] = [{**course1, "holes": [h for h in course1["holes"] if h["index"] == 0]}] if course1 else []
    trimmed["about"] = "the level editor's files (tools/stage_editor_site.py): no ROM hole but hole 0's scenery"
    (out / "assets/manifest.json").write_text(json.dumps(trimmed, indent=1))

    total = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    count = sum(1 for p in out.rglob("*") if p.is_file())
    print(f"staged {count} files, {total / 1e6:.1f} MB, in {out}")


if __name__ == "__main__":
    main()
