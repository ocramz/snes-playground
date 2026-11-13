# Ball physics, enemies and the cup

How a shot moves the ball, how a hole is finished, and how
tools/snesstep/autoplay.py plays whole courses with the game's own rules
deciding every outcome. Facts marked *emulated* were measured with
tools/snesstep ([emulation.md](emulation.md)); the rest is read from code.
The terrain the ball rolls on is [terrain.md](terrain.md).

## The ball's state

One work copy for the player whose turn it is, at `$7E:D9C6`-`$DA6E`,
filled from a per-player block (`$D87A`-`$D96E`, two players four bytes
apart, X = `$1803`) by `$82:F030`-`$82:F10D` at the start of each frame and
written back by `$82:F1E3` onward at the end (*emulated*: a write to the
work copy is undone the next frame; a write to the player block moves the
ball).

| work copy | player 1 | what |
|---|---|---|
| `$D9F2` : `$D9F0` | `$D8AE` : `$D8AA` | x: cell column : 16-bit fraction |
| `$D9F6` : `$D9F4` | `$D8B6` : `$D8B2` | y: cell row : fraction |
| `$D9FA` : `$D9F8` | `$D8BE` : `$D8BA` | height, 16.16; one height step is `$5A82` |
| `$D9D4`, `$D9D6` | `$D87A`, `$D87E` | x and y velocity, fractions of a cell per frame, signed |
| `$D9D8` | `$D882` | vertical velocity |
| `$DA06` / `$DA08` | | ground height under the ball, from the terrain probe |
| `$D9EC` | `$D8A6` | airborne flag |
| `$DA38` | | gravity, `$FFC0` (`$80:DB6D`), added to the vertical velocity each frame |
| `$DA3A`, `$DA3C`, `$DA3E` | | friction and damping factors |
| `$DA4A` | `$D956` | **holed** (1), then 2 once the hole-out has run |
| `$DA58`, `$DA5C` | | the ball's projected screen position |

The x/y/height triple is the one `sub_terrain_probe $81:9479` reads
([terrain.md](terrain.md)), so a ball position is directly a terrain query.

## One frame

`$81:801C` is the per-frame entry. It branches on the airborne flag:

* **Rolling** (`$81:80B5`): `$81:89C2` adds velocity to position (16-bit
  fractions with carry into the cell, sign-extended), then sets the height
  to the ground height, so a rolling ball follows the surface exactly;
  `$81:8E60`; the terrain probe; `$81:87FB`; then a friction value
  `$DA3A` is looked up in `$80:DC49` through `$81:8C12`, indexed by the
  terrain shape under the ball (`$D9FE`) and the ball mode (`$D9C8`), and
  `$81:9001` applies it. A shape in `$08`-`$0B` (the ramps) is forced to
  friction class 9.
* **Airborne** (`$81:803D`): `$81:8805`, the probe, and a landing test of
  the height against the ground (`$DA26`/`$DA28`, with a margin of
  `$2D41`): above it the flight continues (`$81:88AF`), at or below it the
  ball lands and bounces (`$81:811B`).

`$81:8980` damps the y and vertical velocities with `$81:9793`, a signed
multiply through the PPU multiplier (`$211B`/`$211C`, product at `$2134`):
v' = v x factor / 256, factors `$DA3C`/`$DA3E`. Then `$81:899F` adds gravity.
A height below `-$0011_0000` is a fall off the course (`$81:89AA`).

Not read yet: the slope acceleration (`$81:9001`, `$81:9444`,
`$81:9EB9`/`$9ED9`), the bounce (`$81:811B`), and how spin (the top/back
spin of the shot panel) enters.

## Enemies and the cup

The cup is not in the course data. It is **thread object type 74**
(actor `$004A`), spawned where the **last enemy** is defeated (*emulated*:
on hole 1, defeating the three Flamers at (8,3), (8,5) and (6,5) in that
order put the cup at (6,5)). Tile `$08` in the layer-2 dispatch, whose
handler `$82:AD8E` holds the holing code, never occurs in a course for the
same reason.

Holing out is decided in `$82:AD8E`-`$82:AE5D`:

1. `$82:AFE9` looks the ball's position within its cell up in a depth
   profile at `$88:8990` and returns the depth; `$5000` is the centre;
2. if the depth is `$5000` and the ball's height is at or below the ground
   plus `$82:AEF3`, `$82:AE2E` sets `$DA4A` = 1, clears the velocities and
   runs the hole-out;
3. the main flow (`$80:F37A`) sees the player's copy `$D956` and takes the
   holed path at `$80:F48C`.

Forcing that branch with a poke instead deadlocks two frames later
(emulation.md); letting `$82:AE2E` set the flag runs the whole sequence.

**Defeat** (*emulated*): a type-73 enemy keeps its slot and type when
beaten; its frame table changes from `$89:C833` (part lists built in WRAM)
to `$89:C865`, the star it leaves. Several things matter for a hit:

* the ball has to pass through the enemy, not appear inside it;
* enemies that hover are hit only by a ball in the air, one to two height
  steps up (course 2 hole 1); three steps is too high, and at ground level
  only the ground enemies are hit;
* on a one-cell-wide path an enemy is hit only along the path.

Actor types 77 and 83 (course 2 hole 4) did not react to the ball from any
side or height tried, and the cup appears without them: they are not
enemies in this sense. Which of the actor types are obstacles or devices
is **unconfirmed** beyond that.

## Screen projection

Fitted on four holes from the ball's own projection, residuals under 1.5
pixels (*emulated*):

    $DA58 = 32 (x + y)          $DA5C = 16 (y - x) + 16 z / 0.35355 + C

C differs per hole. Thread objects (enemies, the cup) keep their position
as ($DA58, $8B9A - $DA5C) in the same space; their coordinates are the
corner of the cell they stand on.

## Playing a course: tools/snesstep/autoplay.py

The driver runs the stepper in 10-frame segments from a save state and,
between segments, reads WRAM. It presses A every 20 frames (shots, and the
screens between holes). While the ball rolls it writes the player block to
put the ball a quarter cell short of the next live enemy's cell centre,
moving into it; once a type-74 object exists, onto the cup with zero
velocity. Defeating, the cup's appearance and holing out are the game's
own: the driver only aims. Its decisions are recorded as pokes and
replayed in one run to snapshot every screen.

Course 1 played to the end in 16,500 frames reaches screens no other run
does: HOLE IN ONE and the 1UP, the star warp, the per-hole RESULT card,
the course result (scene 8, "BEST SCORE / YOUR SCORE"), the course
ranking table (scene 4), and the map advancing to course 2. A slow hole
without the lives poke runs the lives counter `$7E:D7F4` down to 0 and
reaches GAME OVER and the CONTINUE / GAME END menu (scene 9).

The driver approaches each enemy airborne one step up, from the next of
the four sides on each retry; gives up on one after 12 tries; targets type
73 before any other actor type; holds `$7E:D7F4` at 5; puts the ball back
where it last rolled when it lodges, still and airborne, for 300 frames;
and grounds it at the cup cell's height when placing it on the cup.

**How far it gets** (*emulated*, from a new game): all 8 holes of course
1, with the course-end screens, and holes 1-5 of course 2. Course 2 hole
6 (hole index 13) is not finished: run alone, its enemies are not all
beaten in 10,000 frames, and in the whole-game run the ball was put on the
cup 191 times without holing (before the grounding fix). Each new hole so
far has needed a new rule, so the driver is a working tool for the
screens it reaches, not yet a way through the whole game.

```bash
python3 tools/snesstep/autoplay.py --course 0            # course 1, then on
python3 tools/snesstep/autoplay.py --frames 150000 --out build/emu/autoplay/game
```
