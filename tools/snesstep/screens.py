#!/usr/bin/env python3
"""Batch: run every input script and snapshot each screen the game sets up.

A screen change is detected by the game's own call to
sub_scene_screen_setup $80:CABC (A = scene number, docs/scenes.md). For each
call snesstep waits until the display has been at full brightness for a few
frames, then snapshots (`--snap-scenes`). Screens that do not go through
$80:CABC (menus drawn over the title, the name-entry pad) are caught by the
fixed `--snap-at` frames listed below.

    python3 tools/snesstep/screens.py            # all scripts
    python3 tools/snesstep/screens.py play_hole1 # one
    python3 tools/snesstep/screens.py --no-render

Output: build/emu/screens/<script>/sceneNN_cMMM/fFFFFFF/ (snapshot dirs),
build/emu/screens/<script>/fFFFFFF/ (fixed frames), and
build/emu/screens/index.tsv listing every snapshot with its scene number,
the frame the scene was requested, and the routine that requested it. Each
snapshot is also rendered to <dir>.png, with its whole BG tilemaps, sprite
layer and OBJ tile page in <dir>_layers/ (tools/ppu_render.py --layers).

build/screens/ then gets one named copy of each screen: `<name>.png` and
`<name>_layers/`, the reusable art of every screen the scripts reach.
"""

import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, "tools", "snesstep")
TARGET = os.path.join(ROOT, "build", "snesstep")
BIN = os.path.join(TARGET, "release", "snesstep")
OUT = os.path.join(ROOT, "build", "emu", "screens")

# The screens the scripts reach, by snapshot, with a name for each. The
# names come from looking at the renders; the scene numbers from $80:CABC.
NAMED = [
    ("nintendo_logo", "attract/scene16_c001/f000039"),
    ("title", "attract/scene01_c002/f000298"),
    ("title_menu", "title_menu/f000449"),
    ("name_entry", "play_hole1/f001000"),
    ("course_map", "play_hole1/scene05_c004/f001262"),
    ("course_intro", "play_hole1/scene11_c005/f001600"),
    ("hole_in_play", "play_hole1/f003100"),
    ("attract_demo", "attract/f002400"),
    ("demoplay_select", "demo_play/scene13_c003/f000599"),
    ("two_player_course_select", "two_player/scene06_c003/f000681"),
    ("two_player_handicap", "two_player/scene12_c004/f000809"),
    ("pause_menu", "pause_menu/f002450"),
    ("title_menu_unlocked", "map_select/f000530"),
    ("map_select", "map_select/f001200"),
    ("sound_room", "sound_room/f000750"),
    ("dance_select", "dance/f000700"),
    ("dance", "dance/f001110"),
    ("ranking", "ranking/f001100"),
    ("ranking_result_card", "ranking/f001300"),
    # port_v2 phase 7: the aim's other inputs
    ("look_arrows", "web_look/f002455"),        # Y: the look's four arrows
    ("spin_preset", "web_bspin/f002620"),       # B held: the panel's preset
]

# The title menu's hidden items (MAP SELECT, SOUND ROOM, DANCE SELECT) are
# gated on the medal flags that sub_medal_flags $81:C7AF computes from the
# save. The save left by playing the extra game to the end (autoplay.py
# --extra) earns all three. Without it, the flags are set right after
# sub_medal_flags returns ($83:B720): a steer, not play.
EXTRA_SRAM = os.path.join(ROOT, "build", "emu", "autoplay", "extra", "sram.bin")
FLAG_POKES = []
for _a in ("EAA9", "EAAB", "EAAD", "EAAF", "EAB1", "EAB3"):
    FLAG_POKES += ["--poke-at-pc", "$83:B720,$7E:{}=0001".format(_a)]
MEDAL_FLAGS = ["MEDALS"]        # resolved in run_script
# A save with course 1 cleared, written by tools/snesstep/autoplay.py.
COURSE1_SRAM = os.path.join(ROOT, "build", "emu", "autoplay", "course1", "sram.bin")

# script name -> (frames to run, extra fixed snapshot frames[, extra args])
SCRIPTS = {
    "attract": (4400, [1800, 2400]),
    "title_menu": (600, [449, 470, 500]),
    "play_hole1": (3400, [819, 1000, 1099, 2900, 3100, 3300]),
    "demo_play": (1800, [1000, 1300]),
    "two_player": (2400, [1000, 1800, 2200]),
    "pause_menu": (2800, [2450, 2520]),
    "map_select": (1300, [530, 600, 1200], MEDAL_FLAGS),
    "sound_room": (900, [750], MEDAL_FLAGS),
    "dance": (1800, [640, 700, 780] + list(range(870, 1700, 60)), MEDAL_FLAGS),
    "ranking": (2000, [930, 1100, 1300, 1400], ["--sram", COURSE1_SRAM]),
    "web_look": (2460, [2455]),
    "web_bspin": (2622, [2620]),
}


def build():
    env = dict(os.environ, CARGO_TARGET_DIR=TARGET)
    cmd = ["cargo", "build", "--release", "--offline", "--manifest-path",
           os.path.join(HERE, "Cargo.toml")]
    proc = subprocess.run(cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          universal_newlines=True)
    if proc.returncode != 0:
        sys.exit("cargo build failed:\n" + proc.stderr)


def read_tsv(path):
    with open(path) as f:
        rows = [line.rstrip("\n").split("\t") for line in f]
    return rows[0], rows[1:]


def run_script(name, render):
    frames, fixed = SCRIPTS[name][:2]
    extra = SCRIPTS[name][2] if len(SCRIPTS[name]) > 2 else []
    if "--sram" in extra and not os.path.exists(extra[extra.index("--sram") + 1]):
        print("{}: skipped, no save (run tools/snesstep/autoplay.py --course 0)".format(name))
        return []
    if extra == MEDAL_FLAGS:
        extra = ["--sram", EXTRA_SRAM] if os.path.exists(EXTRA_SRAM) else FLAG_POKES
        print("{}: hidden menu items from {}".format(
            name, "the extra-game save" if extra[0] == "--sram" else "flag pokes"))
    out = os.path.join(OUT, name)
    os.makedirs(out, exist_ok=True)
    cmd = [BIN, "--frames", str(frames), "--out", out,
           "--input", os.path.join(HERE, "inputs", name + ".txt"),
           "--snap-scenes", "--log-pc", "$80:CABC", "--log-pc", "$80:B4AC", "--quiet",
           # Executed instructions, which tools/coverage.py counts as code.
           "--coverage", os.path.join(ROOT, "build", "emu", "cov", name + ".tsv")]
    os.makedirs(os.path.join(ROOT, "build", "emu", "cov"), exist_ok=True)
    if fixed:
        cmd += ["--snap-at", ",".join(str(f) for f in fixed)]
    subprocess.run(cmd + extra, check=True)

    # Who asked for each scene: the JSL return address logged at $80:CABC.
    _, pcrows = read_tsv(os.path.join(out, "pclog.tsv"))
    callers = [r[12] for r in pcrows if r[3] == "$80:CABC"]
    _, snaps = read_tsv(os.path.join(out, "snapshots.tsv"))
    rows = []
    for d, reason in snaps:
        fields = dict(kv.split("=") for kv in reason.split()[1:] if "=" in kv)
        call = int(fields["call"]) if "call" in fields else 0
        rows.append({
            "script": name,
            "dir": os.path.relpath(d if os.path.isabs(d) else os.path.join(ROOT, d), ROOT),
            "event": reason.split()[0],
            "scene": fields.get("scene", "-"),
            "call_frame": fields.get("call_frame", "-"),
            "frame": os.path.basename(d).lstrip("f").split("_")[0].lstrip("0") or "0",
            "caller": callers[call - 1] if 0 < call <= len(callers) else "-",
        })
    if render and os.path.exists(os.path.join(ROOT, "tools", "ppu_render.py")):
        for r in rows:
            d = os.path.join(ROOT, r["dir"])
            subprocess.run([sys.executable, os.path.join(ROOT, "tools", "ppu_render.py"), d,
                            "-o", d + ".png", "--layers", d + "_layers"],
                           check=False, stdout=subprocess.DEVNULL)
    return rows


def gallery():
    """Copy each named screen and its layers to build/screens/."""
    import shutil
    dest = os.path.join(ROOT, "build", "screens")
    os.makedirs(dest, exist_ok=True)
    n = 0
    for name, rel in NAMED:
        src = os.path.join(OUT, rel)
        if not os.path.exists(src + ".png"):
            continue
        shutil.copy(src + ".png", os.path.join(dest, name + ".png"))
        if os.path.isdir(src + "_layers"):
            shutil.rmtree(os.path.join(dest, name + "_layers"), ignore_errors=True)
            shutil.copytree(src + "_layers", os.path.join(dest, name + "_layers"))
        n += 1
    print("gallery: {} screens -> {}".format(n, os.path.relpath(dest, ROOT)))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("scripts", nargs="*", help="subset of: " + " ".join(SCRIPTS))
    ap.add_argument("--no-render", action="store_true")
    a = ap.parse_args()
    names = a.scripts or list(SCRIPTS)
    for n in names:
        if n not in SCRIPTS:
            sys.exit("unknown script {}".format(n))
    os.chdir(ROOT)
    build()
    allrows = []
    for n in names:
        rows = run_script(n, not a.no_render)
        allrows += rows
        print("{:12s} {} snapshots, scenes {}".format(
            n, len(rows), sorted({r["scene"] for r in rows if r["scene"] != "-"}, key=int)))
    cols = ["script", "event", "scene", "call_frame", "frame", "caller", "dir"]
    # A subset run keeps the other scripts' rows.
    index = os.path.join(OUT, "index.tsv")
    if a.scripts and os.path.exists(index):
        head, old = read_tsv(index)
        if head == cols:
            allrows = [dict(zip(cols, r)) for r in old if r[0] not in names] + allrows
    with open(index, "w") as f:
        f.write("\t".join(cols) + "\n")
        for r in allrows:
            f.write("\t".join(str(r[c]) for c in cols) + "\n")
    scenes = sorted({r["scene"] for r in allrows if r["scene"] != "-"}, key=int)
    print("distinct scenes reached: {} -> {}".format(len(scenes), " ".join(scenes)))
    print("index: " + os.path.relpath(os.path.join(OUT, "index.tsv"), ROOT))
    if not a.no_render:
        gallery()


if __name__ == "__main__":
    main()
