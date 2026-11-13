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

The cup is not in the course data: **the last enemy left becomes the
cup.** The game keeps its own count:

* `ram_enemy_list $7E:69DE` lists the hole's enemies as actor-record
  offsets (index x 2), ended by a negative word. Each record, written by
  `sub_spawn_actor $82:B3AF`, has its thread slot in `$B4F8,e` and its
  spawn cell in `$B538,e` / `$B578,e`.
* The slot field `$539C` is the enemy's **owner**: 2 until a ball hits it,
  then the player (`$1809`) who did. `loc_enemy_taken $82:8A98` stores it
  and adds one to that player's star count `$6A10,X`.
* `sub_count_enemies_left $82:8ACE` counts the owners still at 2. When
  one is left after a hit, `sub_find_last_enemy $82:8AEE` stores its slot
  in `$7E:69FE` and its record in `$7E:6A0A`, and
  `sub_last_enemy_to_cup $82:8B5C` turns it into the cup:
  * it sets the record's kind `$B4B8` to 8;
  * it writes tile `$08` into the layer-2 grid `$7E:8390` at the record's
    cell (y x width + x, the width being `$7E:8B92`);
  * it pans the camera there and spawns object type 74 (actor `$004A`,
    `$82:8D03`) over it.
* `$69FE` and `$6A0A` are `$FFFF` until then (reset per hole at
  `$80:C185`).

*Emulated* on hole 1, from a snapshot after each hit:
* the list has three entries, all owner 2;
* hitting (8,3) sets its owner to 0, and the star count goes to 1;
* hitting (8,5) does the same, and at once `$69FE` points at the third
  enemy, its kind is 8, and tile `$08` is at its cell (6,5);
* the ball holes there.

Tile `$08` in the layer-2 dispatch, whose handler `$82:AD8E` holds the
holing code, never occurs in a course because it only appears at run time.
In 2-player games a hit can also take an enemy from the other player
(`$82:8B0F` moves the star between `$6A10` and `$6A12`).

Holing out is decided in `$82:AD8E`-`$82:AE5D`:

1. `$82:AFE9` looks the ball's position within its cell up in a depth
   profile at `$88:8990` and returns the depth; `$5000` is the centre.
   The fractions are folded (a negative one is complemented), and the
   centre is at fraction `$8000`. *Emulated*: a ball set down still at
   (6, 5) + `$8000` on hole 1 holes, and the same ball at `$0000`,
   `$2000` or `$C000` does not;
2. if the depth is `$5000` and the ball's height is at or below the ground
   plus `$82:AEF3`, `$82:AE2E` sets `$DA4A` = 1, clears the velocities and
   runs the hole-out;
3. the main flow (`$80:F37A`) sees the player's copy `$D956` and takes the
   holed path at `$80:F48C`.

Forcing that branch with a poke instead deadlocks two frames later
(emulation.md); letting `$82:AE2E` set the flag runs the whole sequence.

**The hit rule.** Enemy tiles (`$40`-`$52`, `$57`) share the layer-2
handler `$82:8967`, which runs from the landing dispatch while the ball is
airborne over the cell. `$82:8990` decides:

* the ball must be in the middle half of the cell: both fractions in
  `$4000`-`$BFFF`;
* a ball on the ground counts. An airborne one counts only within a
  height window around the enemy, measured from the ground under the ball
  (`$DA06`): from H - `$2D41` (half a step) up to H + `$5A82` (one step).
  H is the enemy's hover height: the slot's `$5B1C`, in height steps,
  converted to 16.16 through `tbl_height_z_lo`/`_hi` (`$88:8000`,
  `$88:80C8`). Ground enemies have 0; the pit enemies of course 5 hole 6
  have 4;
* a hit latches `$6A68,X`, and the latch clears only when the handler sees
  the ball in the cell but outside the middle half (`$82:8A21`). So one
  pass through counts once, and a ball moved straight from the middle of
  one enemy cell into another's is not counted;
* the hit itself, `$82:8A2E`, finds the enemy through the cell's actor
  index (`$ABB8`, by the ball's cell `$D9FC`). If the enemy is still
  untaken it goes to `loc_enemy_taken`.

*Emulated*: on course 5 hole 6 a ball crossing the pit enemy at (2,19) one,
two or zero steps up runs the handler every frame but never reaches
`$82:8A2E`. The same ball at 4.5 steps takes the enemy at once.

What a taken enemy looks like: a type-73 enemy keeps its slot and type,
and its frame table changes from `$89:C833` (part lists built in WRAM) to
`$89:C865`, the star it leaves. Actor types 77 and 83 (course 2 hole 4)
are not in the enemy list, and the cup appears without them.

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
screens between holes). Everything it aims at comes from the game's own
state:

* **targets**: the entries of `ram_enemy_list` whose owner is still 2,
  except the last one, which becomes the cup;
* **where**: the enemy's live screen position projected to a cell (see
  above), or its spawn cell `$B538`/`$B578` when the enemy hovers over it;
* **how**: the ball comes in airborne, 0.4 cell short of the centre and
  moving inward at `$2000` per frame, half a step above the enemy's own
  height. Heights are measured from the surface at the cell's centre
  (a ramp's is half a step below its elevation + 1). Retries go round the
  four sides, then a quarter step lower and higher;
* **lag**: course 8 hole 8 runs the physics only every few frames, so
  after an approach the driver waits until the ball has left its starting
  point, or up to 120 frames, before placing it again;
* **the cup**: once `$69FE` is set and tile `$08` is in the grid, the ball
  is put on the cup cell at fraction `$8000`, grounded and still. Nothing
  is touched once `$DA4A` is set: the ball has to sink on its own;
* **King Dedede**: on the final stage (his hit points `$7E:ED2D` non-zero)
  the ball is dropped on him instead (below);
* **lives**: `$7E:D7F4` is held at 5;
* **lodged ball**: a ball that sits still and airborne for 300 frames is
  put back where it last rolled.

While the cup appears, the physics is frozen and the player block is
written back from the work copy, so a placement made then is lost. The
driver simply repeats it each segment.

Taking the enemies, the cup's appearance and holing out are the game's
own; the driver only moves the ball. Its decisions are recorded as pokes
(`<out>/pokes.txt`, read back with `--pokes`) and replayed in one run.
That run snapshots every screen and saves the battery RAM
(`<out>/sram.bin`) for screens that need progress.

Course 1 played to the end reaches these screens, which no other run does:
* HOLE IN ONE and the 1UP;
* the star warp;
* the per-hole RESULT card;
* the course result (scene 8, "BEST SCORE / YOUR SCORE");
* the course ranking table (scene 4);
* the map advancing to course 2.

A slow hole without the lives poke runs `$7E:D7F4` down to 0 and reaches
GAME OVER and the CONTINUE / GAME END menu (scene 9).

**How far it gets** (*emulated*, from a new game): **the whole game.**

* All 64 holes of the eight courses, with a gold medal on every course.
* The medal award (scene 15) after course 8.
* The final stage: King Dedede beaten in four hits.
* The ending (scene 18) and the credits (scene 19), ending on END at
  about frame 127,500.

One run from boot, 185,000 frames, took 5.5 minutes:
* course 1 is done by frame 15,800;
* the award comes at frame 111,945;
* the fight begins at 113,521, and the hit points go 24 → 18 → 12 → 6 → 0
  by about 119,400;
* the ending is at 119,979 and the credits at 120,415.

tools/snesstep/ending.py then snapshots the award, the fight, the ending
and the whole credits from the recorded run.

## King Dedede

After the eighth course, `$80:F20E` sends a 1-player game with
`ram_courses_cleared` = 8 to `sub_final_stage $87:E767`. This is a hole
loop of its own. `$7E:ED2D` holds Dedede's hit points, 24 at the start
(`$87:E6B4`).

`sub_dedede_hit_test $87:EEEE` counts a hit when all of these hold:
* `$ED07` is set;
* the ball is inside his box: y within -0.625 / +0.8125 cell of
  `$ED35`:`$ED33`, x within 0.875 cell of `$ED31`:`$ED2F`;
* the ball is lower than his height `$ED39`:`$ED37` plus `$1_D000`.

The damage depends on how high above the ground the ball is when it hits,
through `$87:EF88`:

| height above the ground | damage |
|---|---|
| under `$0_4000` | 0 |
| under `$1_0000` | 2 |
| under `$1_6000` | 4 |
| under `$1_D000` | 6 |

The extra game halves the damage (`$87:878E`). When the hit points reach 0,
`$87:E7ED` branches to `$87:E86D`, and the ending follows:
* scene 18 (`$87:F028`), Dedede over the clouds;
* scene 19 (`$84:FB26`), the credits drawn in stars, ending on END.

The driver puts the ball over him, still, at his height + `$1_C000`: 6
points a hit. *Emulated*: hit points 24 → 18 → 12 → 6 → 0.

Without the Dedede mode, the stage ended in GAME OVER, then CONTINUE, then
the map, over and over, even with the lives held at 5. `$87:88C2` clears
the lives counter itself; the condition it tests (`$87:8B9B`) is
**unconfirmed**.

```bash
python3 tools/snesstep/autoplay.py --course 0            # course 1, then on
python3 tools/snesstep/autoplay.py --course 4 --hole 5 --frames 6000   # one hole
python3 tools/snesstep/autoplay.py --frames 135000 --out build/emu/autoplay/game
python3 tools/snesstep/ending.py build/emu/autoplay/game
```
