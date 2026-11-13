#!/usr/bin/env python3
"""Play courses to the end, with the game's own rules deciding every outcome.

The cup of a hole is not course data: it is object type 74, spawned where
the last enemy is defeated (actor `$004A`; docs/tiles.md). So holing out
means clearing every enemy and then rolling into the cup, and the game's
cup check (`$82:AFE9` depth profile, `$82:AE2E` sets the holed flag
`$7E:DA4A`) is what declares it. This driver supplies only the aiming: it
runs tools/snesstep in short segments from a save state and, between them,
reads WRAM and moves the rolling ball.

* Each segment presses A every 20 frames, which takes shots and confirms
  the screens between holes.
* While the ball rolls, it is moved onto the next live enemy -- a thread
  object of an actor type other than 72 (static blocks) and 74 (the cup) --
  by writing the per-player ball block (`$7E:D8AA`/`$D8AE` x fraction and
  cell, `$D8B2`/`$D8B6` y). The work copy at `$7E:D9F0` is refilled from
  that block every frame, so writing the work copy does nothing.
* Once a type-74 object exists, the ball is put on it with its velocity
  (`$7E:D87A`, `$D87E`) zeroed, and the game's own check holes it out.
* The lives counter `$7E:D7F4` is held at 5, because a slow hole otherwise
  ends in GAME OVER (scene 9). That is the one poke that is not aiming.

Thread objects hold screen-space coordinates; the ball's are cell units.
Fitted from the ball's own projection (`$DA58`, `$DA5C`, which `$81:A221`
turns into Kirby's sprite position) over four holes, residuals under 1.5
pixels:

    $DA58 = 32 (x + y)          $DA5C = 16 (y - x) + 16 z / 0.35355 + C

with z the ball height (a height step is `$5A82` = 0.35355 in 16.16) and C
a per-hole constant. A thread object's screen position is
($DA58, $8B9A - $DA5C) in the same space. The driver takes C from the ball
each segment, and solves for a target's cell using the course grid's
elevation there (ground height = (elevation + 1) steps).

The emulator is deterministic, so the decisions are recorded as a list of
pokes (`<out>/pokes.txt`) and the whole run is then replayed in one go with
`--snap-scenes`: every scene the game sets up is snapshotted and rendered
to `<out>/screens/`, so a full course captures the score card, course
results and whatever follows.

    python3 tools/snesstep/autoplay.py --course 0          # course 1, 8 holes
    python3 tools/snesstep/autoplay.py --course 0 --frames 60000
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
BIN = os.path.join(ROOT, "build", "snesstep", "release", "snesstep")
START = 2050                 # course intro up; hole not yet started
SEG = 10
ENEMY_SKIP = {72, 74}
ACTOR_TYPES = {72, 73, 74, 76, 77, 81, 82, 83}
ROLLING_STATES = {13, 14, 15, 16, 17, 18, 12}


def w16(w, a):
    return w[a] | (w[a + 1] << 8)


def mash_input(path, until):
    lines = [l for l in open(os.path.join(HERE, "inputs", "play_hole1.txt"))
             if l.strip() and not l.startswith("#")]
    with open(path, "w") as f:
        f.writelines(lines)
        for fr in range(3400, until, 20):
            f.write("{} A 2\n".format(fr))


def objects(w):
    out = []
    for s in range(64):
        t = w16(w, 0x4E1C + 2 * s)
        if t in ACTOR_TYPES:
            out.append((s, t, w16(w, 0x5F1C + 2 * s), w16(w, 0x5F9C + 2 * s),
                        w16(w, 0x5E1C + 2 * s)))
    return out


DIRECTIONS = ((1, 0), (0, 1), (-1, 0), (0, -1))
MAX_TRIES = 12
STUCK = 300


STEP = 23170 / 65536.0          # one height step in 16.16 world z


def ball_xyz(w):
    x = w16(w, 0xD9F2) + w16(w, 0xD9F0) / 65536.0
    y = w16(w, 0xD9F6) + w16(w, 0xD9F4) / 65536.0
    z = (w16(w, 0xD9FA) << 16) | w16(w, 0xD9F8)
    z = (z - (1 << 32) if z >> 31 else z) / 65536.0
    return x, y, z


def calibrate(w):
    """C in $DA5C = 16 (y - x) + 16 z / STEP + C, from the ball now."""
    x, y, z = ball_xyz(w)
    return w16(w, 0xDA5C) - 16 * (y - x) - 16 * z / STEP


def load_course(index):
    """({cell: elevation}, [actor cells]) for a hole, from build/courses."""
    import glob
    paths = glob.glob(os.path.join(ROOT, "build", "courses",
                                   "{:03d}_*".format(index), "geometry.json"))
    if not paths:
        return {}, []
    with open(paths[0]) as f:
        g = json.load(f)
    elev = {(c["x"], c["y"]): c["elevation"] for c in g["cells"]}
    actors = [(c["x"], c["y"], c["actor"]) for c in g["cells"]
              if c.get("actor") and c["actor"] not in (72, 74)]
    return elev, actors


def to_cell(w, sx, sy, c, elev):
    """Cell coordinates of a thread object at screen (sx, sy).

    Every course cell's corner is projected at the cell's own elevation and
    the nearest one wins; inverting directly needs the elevation of the
    cell being solved for, which a high platform makes ambiguous.
    """
    base = w16(w, 0x8B9A)
    if not elev:
        s = sx / 32.0
        d = (base - sy - c - 16) / 16.0
        return (s - d) / 2.0, (s + d) / 2.0
    best = None
    for (cx, cy), e in elev.items():
        px = 32 * (cx + cy)
        py = base - (16 * (cy - cx) + 16 * (e + 1) + c)
        dist = (px - sx) ** 2 + (py - sy) ** 2
        if best is None or dist < best[0]:
            best = (dist, e)
    # The nearest cell only settles the height; the position is solved
    # exactly, since enemies that move stand between cells.
    s = sx / 32.0
    d = (base - sy - c - 16 * (best[1] + 1)) / 16.0
    return (s - d) / 2.0, (s + d) / 2.0


def ball_pokes(frame, x, y, stop=False):
    xi, yi = int(x), int(y)
    xf, yf = int((x - xi) * 65536) & 0xFFFF, int((y - yi) * 65536) & 0xFFFF
    p = ["--poke", "{}:$7E:D8AE={:04X}".format(frame, xi),
         "--poke", "{}:$7E:D8AA={:04X}".format(frame, xf),
         "--poke", "{}:$7E:D8B6={:04X}".format(frame, yi),
         "--poke", "{}:$7E:D8B2={:04X}".format(frame, yf)]
    if stop:
        p += ["--poke", "{}:$7E:D87A=0000".format(frame),
              "--poke", "{}:$7E:D87E=0000".format(frame)]
    return p


def air_pokes(frame, elevation, steps=1, dx=1, dy=0):
    """Ball airborne `steps` above the ground of a cell, moving along (dx, dy)."""
    z = int(STEP * 65536) * (elevation + 1 + steps)
    return ["--poke", "{}:$7E:D8BA={:04X}".format(frame, z & 0xFFFF),
            "--poke", "{}:$7E:D8BE={:04X}".format(frame, (z >> 16) & 0xFFFF),
            "--poke", "{}:$7E:D8A6=0001".format(frame),
            "--poke", "{}:$7E:D87A={:04X}".format(frame, (0x2000 * dx) & 0xFFFF),
            "--poke", "{}:$7E:D87E={:04X}".format(frame, (0x2000 * dy) & 0xFFFF),
            "--poke", "{}:$7E:D882=0000".format(frame)]


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--course", type=int, default=0)
    ap.add_argument("--hole", type=int, default=0,
                    help="start on this hole of the course (0-7)")
    ap.add_argument("--frames", type=int, default=40000)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()
    out = args.out or os.path.join(ROOT, "build", "emu", "autoplay",
                                   "course{}".format(args.course + 1))
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, "screens"))
    seg = os.path.join(out, "seg")
    state = os.path.join(out, "state.bin")
    inp = os.path.join(out, "input.txt")
    mash_input(inp, args.frames + 100)

    # Boot to the course intro and pick the course.
    subprocess.run([BIN, "--frames", str(START + 1), "--input", inp,
                    "--poke", "{}:$7E:6A5A={:04X}".format(START, args.course),
                    "--poke", "{}:$7E:6A5E={:04X}".format(START, args.hole),
                    "--save-state", state, "--no-dsp", "--quiet", "--out", seg],
                   check=True)
    frame = START + 1
    visited = set()
    elev, actor_cells = {}, []
    first_table, tries = {}, {}
    last_pos, last_rolling, still_since = None, None, START
    log = []
    pokes = []
    all_pokes = ["--poke", "{}:$7E:6A5A={:04X}".format(START, args.course),
                 "--poke", "{}:$7E:6A5E={:04X}".format(START, args.hole)]
    hole_seen = None
    seg_len = SEG
    while frame < args.frames:
        end = frame + seg_len
        shutil.rmtree(seg, ignore_errors=True)
        subprocess.run([BIN, "--load-state", state, "--save-state", state,
                        "--frames", str(end), "--input", inp, "--snap-at", str(end - 1),
                        "--no-dsp", "--quiet", "--out", seg] + pokes, check=True)
        all_pokes.extend(pokes)
        pokes = []
        snap = os.path.join(seg, "f{:06d}".format(end - 1))
        frame = end
        # Keep the lives counter up: at 0 the main flow takes the game-over
        # path ($80:F387). This changes how many attempts the driver gets,
        # not how anything plays. Recorded with the other pokes.
        pokes.append("--poke")
        pokes.append("{}:$7E:D7F4=0005".format(frame))
        if not os.path.isdir(snap):
            continue
        with open(os.path.join(snap, "wram.bin"), "rb") as f:
            w = f.read()
        hole = w16(w, 0xABB6) // 3
        if hole != hole_seen:
            hole_seen = hole
            visited = set()
            elev, actor_cells = load_course(hole)
            log.append({"frame": frame, "event": "hole", "index": hole})
            print("frame {}: hole index {}".format(frame, hole), flush=True)
        st = w16(w, 0xD7D4)
        # Rescue: a ball placed in the air next to a wall can lodge there,
        # airborne and still, and the hole never moves on. If it sits
        # outside a rolling state at one position for STUCK frames, put it
        # back where it last rolled, on the ground and stopped.
        pos = ball_xyz(w)
        if st in ROLLING_STATES:
            last_rolling, still_since = pos, frame
        elif last_pos is None or abs(pos[0] - last_pos[0]) + abs(pos[1] - last_pos[1]) > 0.01:
            still_since = frame
        elif frame - still_since > STUCK and last_rolling is not None:
            x, y, _ = last_rolling
            pokes += ball_pokes(frame, x, y, stop=True) + [
                "--poke", "{}:$7E:D8A6=0000".format(frame),
                "--poke", "{}:$7E:D882=0000".format(frame)]
            log.append({"frame": frame, "event": "rescue", "cell": [x, y]})
            still_since = frame
        last_pos = pos
        # Short segments only while there is a ball to steer.
        seg_len = SEG if st in ROLLING_STATES else 3 * SEG
        if st not in ROLLING_STATES:
            continue
        objs = objects(w)
        c = calibrate(w)
        cup = [o for o in objs if o[1] == 74]
        if cup:
            x, y = to_cell(w, cup[0][2], cup[0][3], c, elev)
            x, y = x + 0.5, y + 0.5
            if x < 0 or y < 0:
                continue
            # On the ground at the cup cell's height and not airborne: the
            # cup check wants the ball no higher than the ground plus a
            # margin, and an approach to an enemy leaves it in the air.
            e = elev.get((int(x), int(y)), 0)
            z = int(STEP * 65536) * (e + 1)
            pokes += ball_pokes(frame, x, y, stop=True) + [
                "--poke", "{}:$7E:D8BA={:04X}".format(frame, z & 0xFFFF),
                "--poke", "{}:$7E:D8BE={:04X}".format(frame, (z >> 16) & 0xFFFF),
                "--poke", "{}:$7E:D8A6=0000".format(frame),
                "--poke", "{}:$7E:D882=0000".format(frame)]
            log.append({"frame": frame, "event": "to cup", "cell": [x, y]})
            print("frame {}: ball -> cup at ({:.2f}, {:.2f})".format(frame, x, y),
                  flush=True)
            continue
        # A defeated enemy keeps its slot and type but changes frame table
        # (type 73: $89:C833 alive -> $89:C865, the star). So an enemy is
        # alive while its table is the one it was first seen with.
        for o in objs:
            first_table.setdefault((hole, o[0]), o[4])
        # One not beaten in MAX_TRIES approaches from all sides is taken to
        # be invulnerable (an obstacle enemy); the cup does not wait for it.
        alive = [o for o in objs if o[1] not in ENEMY_SKIP
                 and o[4] == first_table[(hole, o[0])]
                 and tries.get((hole, o[0]), 0) < MAX_TRIES]
        # Type 73 is the course enemy; the other actor types (76, 77, 81-83)
        # include obstacles and devices that never react to a hit, so they
        # are tried only once every 73 is beaten or given up on.
        if any(o[1] == 73 for o in alive):
            alive = [o for o in alive if o[1] == 73]
        targets = [o for o in alive if o[0] not in visited]
        if not targets:
            visited = set()
            continue
        s, t, sx, sy, _ = targets[0]
        visited.add(s)
        tries[(hole, s)] = tries.get((hole, s), 0) + 1
        x, y = to_cell(w, sx, sy, c, elev)
        # A flying enemy's screen y includes its altitude, which the
        # projection reads as a different cell. Screen x does not depend on
        # height, so x + y is exact: if a course actor cell has that x + y,
        # the enemy is hovering over its spawn cell and that cell is used.
        for ax, ay, _ in actor_cells:
            if abs((ax + ay) - (x + y)) < 0.75:
                x, y = float(ax), float(ay)
                break
        if x < 0 or y < 0 or (elev and (int(x), int(y)) not in elev):
            # Off the grid: fall back to the nearest course cell that
            # spawns this actor type.
            same = [(abs(ax + ay - (x + y)), ax, ay) for ax, ay, a in actor_cells
                    if a == t]
            if same:
                _, ax, ay = min(same)
                x, y = float(ax), float(ay)
        if x < 0 or y < 0 or (elev and (int(x), int(y)) not in elev):
            log.append({"frame": frame, "event": "off grid", "type": t,
                        "cell": [x, y]})
            continue
        # Coordinates are the cell corner. Come in from a quarter cell
        # short of the centre along +x, airborne one height step above the
        # ground: that hits ground enemies and hovering ones alike, where a
        # ball placed on the ground misses the hoverers (emulated, course 2
        # hole 1) and one placed inside an enemy hits nothing.
        e = elev.get((int(x), int(y)), 0)
        # Some enemies are hit only from some sides (one on a one-cell-wide
        # path only along it), so each retry comes in from the next side.
        dx, dy = DIRECTIONS[(tries[(hole, s)] - 1) % 4]
        pokes += ball_pokes(frame, x + 0.5 - 0.25 * dx, y + 0.5 - 0.25 * dy) + \
            air_pokes(frame, e, dx=dx, dy=dy)
        log.append({"frame": frame, "event": "to enemy", "type": t, "cell": [x, y]})
        print("frame {}: ball -> type {} at ({:.2f}, {:.2f})".format(frame, t, x, y),
              flush=True)
    with open(os.path.join(out, "pokes.txt"), "w") as f:
        for i in range(0, len(all_pokes), 2):
            f.write(all_pokes[i + 1] + "\n")
    # Replay everything in one run and keep each screen the game set up.
    shots = os.path.join(out, "replay")
    subprocess.run([BIN, "--frames", str(args.frames), "--input", inp,
                    "--snap-scenes", "--scene-settle", "20", "--log-pc", "$80:CABC",
                    "--no-dsp", "--quiet", "--out", shots] + all_pokes, check=True)
    scenes = []
    for name in sorted(os.listdir(shots)):
        if not name.startswith("scene") or not os.path.isdir(os.path.join(shots, name)):
            continue
        for sub in sorted(os.listdir(os.path.join(shots, name))):
            src = os.path.join(shots, name, sub)
            dst = os.path.join(out, "screens", "{}_{}.png".format(name, sub))
            subprocess.run([sys.executable, os.path.join(ROOT, "tools", "ppu_render.py"),
                            src, "-o", dst, "--layers", dst[:-4] + "_layers"],
                           capture_output=True)
            scenes.append({"scene": int(name[5:7]), "dir": src})
    with open(os.path.join(out, "log.json"), "w") as f:
        json.dump({"events": log, "scenes": scenes}, f, indent=1)
    print("{} pokes, {} scene snapshots; wrote {}".format(
        len(all_pokes) // 2, len(scenes), out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
