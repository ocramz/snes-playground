#!/usr/bin/env python3
"""Play courses, or the whole game, with the game's own rules deciding
every outcome.

The cup of a hole is not course data: the last enemy left becomes it
(`$82:8AEE`, `$82:8B5C`; docs/physics.md). So holing out means taking
every other enemy and then rolling into the cup, and the game's cup check
(`$82:AFE9`, then `$82:AE2E` sets the holed flag `$7E:DA4A`) is what
declares it. This driver supplies only the aiming. It runs tools/snesstep
in short segments from a save state and, between them, reads WRAM and
moves the ball.

* Each segment presses A every 20 frames. That takes the shots and
  confirms the screens between holes.
* The targets are the game's own enemy list (`$7E:69DE`, owner `$539C`
  still 2). The ball is moved by writing the per-player ball block
  (`$7E:D8AA`/`$D8AE` for x fraction and cell, `$D8B2`/`$D8B6` for y,
  `$D8BA`/`$D8BE` for height, `$D8A6` airborne). The work copy at
  `$7E:D9F0` is refilled from that block every frame, so writing the work
  copy does nothing.
* Once the cup exists (`$7E:69FE`), the ball is put on its cell at fraction
  `$8000`, grounded and still. The game holes it.
* On the final stage (King Dedede's hit points `$7E:ED2D` non-zero), the
  ball is dropped on him.
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
    python3 tools/snesstep/autoplay.py --frames 135000 --out build/emu/autoplay/game
    python3 tools/snesstep/autoplay.py --resume build/emu/autoplay/game --frames 200000 --out DIR
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
ROLLING_STATES = {13, 14, 15, 16, 17, 18, 12}


def w16(w, a):
    return w[a] | (w[a + 1] << 8)


def mash_input(path, until, boot="play_hole1.txt", mash_from=3400, pad2=False):
    lines = [l for l in open(os.path.join(HERE, "inputs", boot))
             if l.strip() and not l.startswith("#")]
    with open(path, "w") as f:
        f.writelines(lines)
        for fr in range(mash_from, until, 20):
            f.write("{} A 2\n".format(fr))
            if pad2:
                # Player 2 shoots with pad 2.
                f.write("{} 2:A 2\n".format(fr + 10))


def for_player(pokes, px):
    """Move ball-block pokes to another player's copy.

    The per-player block `$7E:D87A`-`$D96E` interleaves the players: each
    field is a word per player, so player 2's copy is 2 bytes on
    (`$82:F030` loads it with X = `$7E:1803`, 0 or 2).
    """
    if not px:
        return pokes
    out = []
    for p in pokes:
        if p.startswith("--"):
            out.append(p)
            continue
        fr, rest = p.split(":", 1)
        addr, val = rest.split("=")
        a = int(addr.split(":")[1], 16)
        if 0xD87A <= a <= 0xD96F:
            a += px
        out.append("{}:$7E:{:04X}={}".format(fr, a, val))
    return out


def enemy_list(w):
    """The hole's enemies as the game keeps them.

    `$7E:69DE` lists actor records (index x 2) until a negative entry;
    `$B4F8,e` is the record's thread slot, `$B538,e`/`$B578,e` its spawn
    cell, and the slot's `$539C` its owner: 2 while nobody has hit it, else
    the player (`$1809`) who did. `sub_count_enemies_left $82:8ACE` counts
    the 2s. Returns [(entry, slot, owner, cell_x, cell_y, screen_x, screen_y)].
    """
    out = []
    for i in range(32):
        e = w16(w, 0x69DE + 2 * i)
        if e & 0x8000:
            break
        slot = w16(w, 0xB4F8 + e)
        if slot & 0x8000 or slot >= 0x80:
            continue
        out.append((e, slot, w16(w, 0x539C + slot), w16(w, 0xB538 + e),
                    w16(w, 0xB578 + e), w16(w, 0x5F1C + slot), w16(w, 0x5F9C + slot)))
    return out


_HEIGHTS = None


def enemy_height(w, slot):
    """An enemy's height above the ground, in height steps.

    `$82:8990` takes the slot's `$5B1C` (height steps) through the height
    tables `$88:8000` (low words) and `$88:80C8` (high). An airborne
    ball counts as a hit only between that height - `$2D41` (half a step)
    and + `$5A82` (one step) above the ground under it.
    """
    global _HEIGHTS
    if _HEIGHTS is None:
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        from romcheck import load_rom
        rom = load_rom()
        lo, hi = 0x040000, 0x0400C8          # $88:8000, $88:80C8
        _HEIGHTS = [((rom[hi + 2 * i] | rom[hi + 2 * i + 1] << 8) << 16 |
                     rom[lo + 2 * i] | rom[lo + 2 * i + 1] << 8) / 65536.0 / STEP
                    for i in range(100)]
    i = w16(w, 0x5B1C + slot)
    return _HEIGHTS[i] if i < len(_HEIGHTS) else 0.0


def boss_pokes(frame, w):
    """Drop the ball on King Dedede.

    The final stage runs `$87:E767` instead of the normal hole loop, and
    Dedede's hit points are `$7E:ED2D` (24 at the start, `$87:E6B4`). `$87:EEEE` counts a hit while `$ED07` is set and the ball
    is inside his box: y within -0.625/+0.8125 cell of `$ED35`:`$ED33`, x
    within 0.875 of `$ED31`:`$ED2F`, and below his height `$ED39`:`$ED37`
    plus `$1_D000`. The damage (`$ED49`) grows with the ball's height
    above the ground (`$87:EF88`): under `$0_4000` none, then 2, 4, 6. So
    the ball is put over him, still, at his height + `$1_C000`: 6 points.
    """
    x = w16(w, 0xED31) + w16(w, 0xED2F) / 65536.0
    y = w16(w, 0xED35) + w16(w, 0xED33) / 65536.0
    z = ((w16(w, 0xED39) << 16) | w16(w, 0xED37)) + 0x1C000
    return ball_pokes(frame, x, y, stop=True) + [
        "--poke", "{}:$7E:D8BA={:04X}".format(frame, z & 0xFFFF),
        "--poke", "{}:$7E:D8BE={:04X}".format(frame, (z >> 16) & 0xFFFF),
        "--poke", "{}:$7E:D8A6=0001".format(frame),
        "--poke", "{}:$7E:D882=0000".format(frame)]


def enemies_left(w):
    return sum(1 for o in enemy_list(w) if o[2] == 2)


def cup_cell(w):
    """The cup's cell, or None before it exists.

    When one enemy is left, `$82:8AEE` stores its slot in `$7E:69FE` and its
    record in `$7E:6A0A`, and `$82:8B5C` turns it into the cup: special tile
    `$08` in the layer-2 grid `$7E:8390` at its cell.
    """
    if w16(w, 0x69FE) & 0x8000:
        return None
    e = w16(w, 0x6A0A)
    x, y = w16(w, 0xB538 + e), w16(w, 0xB578 + e)
    width = w16(w, 0x8B92)
    if not width or w[0x8390 + y * width + x] != 0x08:
        return None
    return x, y


DIRECTIONS = ((1, 0), (0, 1), (-1, 0), (0, -1))
STUCK = 300
WAIT = 120


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
    """({cell: elevation}, [actor cells]) for a hole, from build/courses.

    The "elevation" is the surface height at the cell's centre, in height
    steps, minus one (a flat cell of elevation e has its surface at e + 1
    steps), so that ramps get their real height: the enemy at (21, 2) of
    course 8 hole 8 sits on a ramp whose centre is half a step below its
    elevation + 1, enough to put a ball aimed from the elevation outside
    the enemy's height window.
    """
    import glob
    paths = glob.glob(os.path.join(ROOT, "build", "courses",
                                   "{:03d}_*".format(index), "geometry.json"))
    if not paths:
        return {}, []
    with open(paths[0]) as f:
        g = json.load(f)
    elev = {(c["x"], c["y"]): (sum(c["surface_steps"]) / 4.0 - 1
                                if c.get("surface_steps") else c["elevation"])
            for c in g["cells"]}
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
    z = int(int(STEP * 65536) * (elevation + 1 + steps))
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
    ap.add_argument("--resume", metavar="DIR",
                    help="continue a finished run in DIR (its state.bin, pokes.txt "
                         "and last segment) instead of booting")
    ap.add_argument("--extra", action="store_true",
                    help="play the extra game: boot through the menus with "
                         "inputs/play_extra.txt from a save that has finished "
                         "the normal game (--sram)")
    ap.add_argument("--two-player", action="store_true",
                    help="play a 2-player game (inputs/two_player.txt, course "
                         "Whispy Woods), steering whichever player's ball rolls")
    ap.add_argument("--sram", default=None,
                    help="battery RAM at power-on (default with --extra: "
                         "build/emu/autoplay/game/sram.bin)")
    args = ap.parse_args()
    if args.extra and not args.sram:
        args.sram = os.path.join(ROOT, "build", "emu", "autoplay", "game", "sram.bin")
    sram = ["--sram", os.path.abspath(args.sram)] if args.sram else []
    out = args.out or os.path.join(ROOT, "build", "emu", "autoplay",
                                   "extra" if args.extra else
                                   "two_player" if args.two_player else
                                   "course{}".format(args.course + 1))
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(os.path.join(out, "screens"))
    seg = os.path.join(out, "seg")
    state = os.path.join(out, "state.bin")
    inp = os.path.join(out, "input.txt")
    if args.two_player:
        start = 1750
        mash_input(inp, args.frames + 100, "two_player.txt", 1900, pad2=True)
        course_pokes = []
    elif args.extra:
        # The menus pick the course; the extra map starts on the first
        # course not yet cleared. No course poke.
        start = 2300
        mash_input(inp, args.frames + 100, "play_extra.txt", 2400)
        course_pokes = []
    else:
        start = START
        mash_input(inp, args.frames + 100)
        course_pokes = ["--poke", "{}:$7E:6A5A={:04X}".format(START, args.course),
                        "--poke", "{}:$7E:6A5E={:04X}".format(START, args.hole)]
    with open(os.path.join(out, "run.json"), "w") as f:
        json.dump({"sram": sram[1] if sram else None, "extra": args.extra,
                   "two_player": args.two_player}, f)

    if args.resume:
        # The earlier run's last segment snapshot is frame end - 1.
        last = sorted(n for n in os.listdir(os.path.join(args.resume, "seg"))
                      if n.startswith("f"))[-1]
        frame = int(last[1:7]) + 1
        shutil.copy(os.path.join(args.resume, "state.bin"), state)
        with open(os.path.join(args.resume, "pokes.txt")) as f:
            prefix = [l.strip() for l in f if l.strip()]
    else:
        # Boot to the course intro and pick the course.
        subprocess.run([BIN, "--frames", str(start + 1), "--input", inp] +
                       course_pokes + sram +
                       ["--save-state", state, "--no-dsp", "--quiet", "--out", seg],
                       check=True)
        frame = start + 1
    visited = set()
    elev, actor_cells = {}, []
    tries = {}
    left_seen = None
    last_pos, last_rolling, still_since = None, None, frame
    placed = None                # (frame, x, y) of the last enemy approach
    boss_hole = None             # hole index of the final stage, once seen
    log = []
    pokes = []
    all_pokes = list(course_pokes)
    if args.resume:
        all_pokes = []
        for p in prefix:
            all_pokes += ["--poke", p]
    hole_seen = None
    seg_len = SEG
    px = 0                       # the player whose ball it is, x 2
    while frame < args.frames:
        end = frame + seg_len
        pokes = for_player(pokes, px)
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
            left_seen = None
            placed = None
            elev, actor_cells = load_course(hole)
            log.append({"frame": frame, "event": "hole", "index": hole})
            print("frame {}: hole index {}".format(frame, hole), flush=True)
        px = w16(w, 0x1803) & 2
        st = w16(w, 0xD7D4 + px)
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
        hp = w16(w, 0xED2D)
        if hp:
            boss_hole = hole
        if hole == boss_hole:
            # The final stage. Its enemy list is the last hole's, stale.
            if not hp:
                continue
            pokes += boss_pokes(frame, w)
            if hp != left_seen:
                left_seen = hp
                log.append({"frame": frame, "event": "boss hp", "hp": hp})
                print("frame {}: Dedede HP {}".format(frame, hp), flush=True)
            continue
        c = calibrate(w)
        enemies = enemy_list(w)
        left = sum(1 for o in enemies if o[2] == 2)
        if left != left_seen:
            left_seen = left
            log.append({"frame": frame, "event": "enemies left", "count": left})
            print("frame {}: {} enemies left".format(frame, left), flush=True)
        cup = cup_cell(w)
        if w16(w, 0xDA4A):
            # Holed: the ball is sinking into the cup ($82:AE2E). Moving it
            # now would lift it out again, which on a cup lower than the
            # placement height (course 4 hole 4) stopped the hole-out for
            # good.
            continue
        if cup is not None:
            # The game's own cup cell. Its centre is fraction $8000 (cell +
            # 0.5): the depth profile at $88:8990 peaks there (emulated: on
            # hole 1, $8000 holes a ball set down still; $0000, $2000 and
            # $C000 do not). While the cup appears the physics is frozen and
            # the player block is overwritten from the work copy, so the
            # placement is simply repeated each segment until it takes.
            x, y = cup[0] + 0.5, cup[1] + 0.5
            e = elev.get(cup, 0)
            z = int(int(STEP * 65536) * (e + 1))
            pokes += ball_pokes(frame, x, y, stop=True) + [
                "--poke", "{}:$7E:D8BA={:04X}".format(frame, z & 0xFFFF),
                "--poke", "{}:$7E:D8BE={:04X}".format(frame, (z >> 16) & 0xFFFF),
                "--poke", "{}:$7E:D8A6=0000".format(frame),
                "--poke", "{}:$7E:D882=0000".format(frame)]
            log.append({"frame": frame, "event": "to cup", "cell": list(cup)})
            print("frame {}: ball -> cup at {}".format(frame, cup), flush=True)
            continue
        # Give an approach time to play out. When the game lags (course 8
        # hole 8 runs the physics only every few frames), a 10-frame
        # segment can pass with the ball not yet moved, and placing it
        # again would restart the approach for ever. So wait until it has
        # left its starting point, or WAIT frames have gone by.
        if placed is not None and frame - placed[0] < WAIT and \
                abs(pos[0] - placed[1]) + abs(pos[1] - placed[2]) < 0.3:
            continue
        # The last enemy left becomes the cup, so only the others are hit.
        alive = [o for o in enemies if o[2] == 2]
        if len(alive) <= 1:
            continue
        targets = [o for o in alive if o[0] not in visited]
        if not targets:
            visited = set()
            targets = alive
        e_idx, slot, _, ax, ay, sx, sy = targets[0]
        visited.add(e_idx)
        n = tries[(hole, e_idx)] = tries.get((hole, e_idx), 0) + 1
        # Walking enemies leave their spawn cell, so the live position is
        # used. A hovering one's screen y includes its altitude, which the
        # projection reads as another cell; screen x = 32 (x + y) does not
        # depend on height, so when x + y still matches the spawn cell the
        # enemy is taken to be over it.
        x, y = to_cell(w, sx, sy, c, elev)
        if abs((ax + ay) - (x + y)) < 0.75 or x < 0 or y < 0 or \
                (elev and (int(x), int(y)) not in elev):
            x, y = float(ax), float(ay)
        e = elev.get((int(x), int(y)), 0)
        # The enemy tile's handler ($82:8967) hits only a ball in the
        # middle half of the cell (fractions $4000-$BFFF), once: $6A68,X
        # latches on a hit and is cleared only when the ball is seen in
        # the cell outside that zone ($82:8A21). So the ball comes in from
        # 0.4 cell short of the centre, outside the zone, moving inward;
        # placed inside the zone straight from another enemy's, it is never
        # counted. Airborne, it must also be within the enemy's height
        # window (enemy_height), so it comes in half a step above the
        # enemy's height: the course 5 hole 6 pit enemies hover 4 steps
        # up and are missed at 0-2 (emulated). Retries go round the four
        # sides (on a one-cell-wide path only along it works), then try a
        # quarter step lower and higher.
        dx, dy = DIRECTIONS[(n - 1) % 4]
        steps = enemy_height(w, slot) + (0.5, 0.25, 0.75)[((n - 1) // 4) % 3]
        placed = (frame, x + 0.5 - 0.4 * dx, y + 0.5 - 0.4 * dy)
        pokes += ball_pokes(frame, x + 0.5 - 0.4 * dx, y + 0.5 - 0.4 * dy) + \
            air_pokes(frame, e, steps=steps, dx=dx, dy=dy)
        log.append({"frame": frame, "event": "to enemy", "entry": e_idx,
                    "type": w16(w, 0x4E1C + slot), "cell": [x, y], "steps": steps})
        print("frame {}: ball -> enemy {:02X} at ({:.2f}, {:.2f}), {:.2f} up".format(
            frame, e_idx, x, y, steps), flush=True)
    with open(os.path.join(out, "pokes.txt"), "w") as f:
        for i in range(0, len(all_pokes), 2):
            f.write(all_pokes[i + 1] + "\n")
    # Replay everything in one run and keep each screen the game set up.
    shots = os.path.join(out, "replay")
    subprocess.run([BIN, "--frames", str(args.frames), "--input", inp] + sram + [
                    "--snap-scenes", "--scene-settle", "20", "--log-pc", "$80:CABC",
                    "--no-dsp", "--quiet", "--out", shots,
                    "--pokes", os.path.join(out, "pokes.txt"),
                    # The save as the run leaves it (cleared courses, medals,
                    # ranking), for screens that need progress.
                    "--save-sram", os.path.join(out, "sram.bin")], check=True)
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
