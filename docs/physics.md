# Ball physics, enemies and the cup

How a shot moves the ball, how a hole is finished, and how
tools/snesstep/autoplay.py plays whole courses with the game's own rules
deciding every outcome. Facts marked *emulated* were measured with
tools/snesstep ([emulation.md](emulation.md)); the rest is read from code.
The terrain the ball rolls on is [terrain.md](terrain.md).

## The ball's state

One work copy for the player whose turn it is, at `$7E:D9C6`-`$DA6E`,
filled from a per-player block (`$D87A`-`$D96E`: each field is one word
per player, every 4 bytes; X = `$1803`, 0 or 2) by `$82:F030`-`$82:F10D` at the start of each frame and
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
| `$DA38` | | gravity, `$FFC0` (`tbl_ball_gravity $80:DB6D`[0]), added to the vertical velocity each airborne frame |
| `$DA3A` | | rolling friction, from `tbl_roll_friction $80:DC49` (`$0C00` on flat ground) |
| `$DA3C`, `$DA3E` | | bounce factors, Q15: horizontal 0.98 (`$7D6F`), vertical 0.65 (`$5332`) |
| `$DA4A` | `$D956` | **holed** (1), then 2 once the hole-out has run |
| `$DA58`, `$DA5C` | | the ball's projected screen position |

The x/y/height triple is the one `sub_terrain_probe $81:9479` reads
([terrain.md](terrain.md)), so a ball position is directly a terrain query.

## One frame

Every routine below takes and returns 16-bit A and X/Y (`REP #$30`) unless
noted, and runs with DBR = `$7E` and D = `$1E00`, so `$BC` is `$1EBC`.

In short:
* a rolling ball loses `$DA3A`/65536 cell per frame² of speed along its
  heading (friction), and gains slope acceleration downhill;
* an airborne ball has gravity `$FFC0` and about 1/256 air drag;
* a landing reflects the velocity in the surface normal, then keeps 0.98
  of the horizontal speed and 0.65 of the vertical;
* spin is a one-off kick at a fly shot's first bounce, or a curve for a
  grounder until it first lands.

### The two steps, in full

`sub_ball_physics_step $81:801C` (JSL) first clears the event flags
`$DA4E`/`$DA50`/`$DA52`. `$81:8751` then copies the 32 bytes `$D9EC`-`$DA0B`
to `$DA0C`-`$DA2B`, the previous-frame state: position, cell, probe result,
ground height. `$D9DA` is set to `$FFFF`. Then it branches on the airborne
flag `$D9EC`.

**Airborne** (`$81:803D`):

1. `$81:8805` adds the velocity to x, y and z. Then comes **air drag** on
   vx and vy (`$81:885C`), skipped in mode `$0A`:
   `v -= (|v| + $80) >> 8` toward zero, about v x 255/256 a frame. vz has
   no drag. *Emulated*: vx 1024 → 1020, 2217 → 2208.
2. `$81:8E60` sets the heading. `$DA48` (frames in the air) is incremented.
   Then the terrain probe runs, and `$81:87FB`.
3. **`$DA3C` ← `$DA30`, `$DA3E` ← `$DA32`**, every airborne frame. A
   friction tile's override (tiles.md) therefore lasts only for the landing
   it is dispatched on.
4. If z is negative, the step ends in `$81:89AA` (JML): a fall off the
   course below `-$11_0000`, otherwise gravity only. No edge or landing
   test runs that frame.
5. `sub_edge_crossing $81:9001` checks whether the ball crossed a cell
   edge this frame (below).
6. A **wall flag** was crossed (`$D9E6` ≥ 0), and z is less than `$2D41`
   (half a step) above the ground the ball came from (`$DA26`/`$DA28`):
   this is a wall bounce, `$81:88AF` → `sub_wall_bounce $81:9390`. A wall is
   therefore half a step tall, and a ball higher than that flies over it.
7. Otherwise `$D9E6` is set to `$FFFF`. If a **step up** was crossed
   (`$DA4C` > 0) and z is below the new ground, the ball hits the step:
   `$81:88C4`.
8. Otherwise the ball takes the **landing dispatch** on the layer-2 byte
   (`$81:811B`, tiles.md). The default handler `$81:8905` does nothing but
   gravity while z ≥ ground, and **bounces** when z < ground.

docs/physics.md describes the `$2D41` margin as the general landing test.
It is not: it only applies after a wall flag has been crossed (step 6).

**Rolling** (`$81:80B5`):

1. `$81:89C2` integrates x and y, and sets z to the previous ground.
2. The heading (`$81:8E60`), the probe, then `$81:87FB`.
3. The class index `$6A72` = mode x 8 + `tbl_friction_class $81:8C12`[surface
   code], where the surface code `$DA04` comes from the probe. Shapes
   `$08`-`$0B` are forced to code 9. The class is:

   | surface code | class |
   |---|---|
   | 0 (flat) | 0 |
   | 1-4 (ramps) | 2 |
   | 5-8 (diagonals) | 4 |
   | 9 | 6 |

   `$DA3A` = `tbl_roll_friction $80:DC49`[`$6A72`].
4. `sub_edge_crossing $81:9001`.
5. One of:
   * a wall flag: `$81:8A03` → `sub_wall_bounce`;
   * a step up: `sub_step_bounce $81:93D1`;
   * a step down: `loc_launch $81:8B78`, and the ball becomes airborne;
   * no edge event: the **on-hit dispatch** on the layer-2 byte
     (`$81:8436`). Its default `$81:8A56` is the rolling step proper: the
     button modifiers, friction, slope acceleration and curve.

`$81:8D52` is a bare RTL. The step ends with `JSR $9BE5` (sound and effects,
not read).

### Heading

`sub_ball_heading $81:8E60` (JSL) sets the heading
`$D9DA = sub_atan2_deg $80:A4C1(vx, vy)`, in **degrees 0-359**. 0 is +x and
90 is +y. *Emulated*: 180 while vx < 0 and vy = 0. While the ball is still,
`$D9DA` keeps the last heading `$D9E2`. `$D9E0` = `tbl_deg_to_dir32
$81:8E98`[deg] (361 bytes, round(deg x 32 / 360) mod 32) and `$D9DE` = that
/ 2, the 32- and 16-direction forms that the sprite code reads.

The trigonometry is `tbl_sin_deg $80:A5A2`, Q15, 450 words (0-449°), so
`$80:A656` = sin + 90° is the cosine. `sub_cos_deg $80:A4B3` and
`sub_sin_deg $80:A4BA` index it. *Emulated / dumped*: sin 90° = `$7FFF`,
sin 45° = `$5A82`.

### Rolling friction

In `$81:8A81`-`$81:8B55`, per axis, with θ = `$D9DA`:

    P  = (cos θ x $DA3A x 2) >> 16          ($80:A378, 16x16 signed)
    fx = (P + $80) >> 8               if cos θ ≥ 0   (round)
       = (P - $80) >> 8, signed       if cos θ < 0   (floor: one unit more)
    vx = vx - fx, clamped at 0 (friction never reverses the ball)

vy is treated the same way with sin θ. On flat ground in mode 0, `$DA3A` =
`$0C00`, a deceleration of 12/65536 cell per frame². The rounding is not
symmetric: a ball moving toward −x or −y loses 13 a frame, not 12.
*Emulated*: Δvx = −12 moving +x and +13 moving −x on flat ground; +9
moving −x on a ramp (`$07B0` would be 7.7).

**`tbl_roll_friction $80:DC49`** and **`tbl_ball_gravity $80:DB6D`** are
both 22 modes x 4 classes (flat, ramp, diagonal, shapes `$08`-`$0B`), one
word each:

| mode `$D9C8` | gravity (slope) | friction | demo that sets it (*emulated*) |
|---|---|---|---|
| 0 normal | `FFC0 FF7A FF7A FF7A` | `0C00 07B0 07B0 07B0` | |
| 1 | `FF7A FF7A FF7A FE00` | `7800 2800 3400 7600` | DEMOPLAY entry 10 |
| 2 | `FF7A ...` | `4000 1800 1C00 1800` | 11 |
| 3 | `0000 ...` | `0000 ...` | 12 |
| 4 | `FF7A ...` | `2C00 07B0 07B0 07B0` | 13 |
| 5 | `FFA2 ...` | `0866 0562 0562 0562` | 14 |
| 6 | `0000 ...` | `0000 ...` | 15 |
| 7 | as mode 0 | as mode 0 | 16 |
| 8 | as mode 0 | as mode 0 | 17 |
| 9 | `FF7A FF69 FF69 FF69` | `0A00 07B0 07B0 07B0` | 18 |
| 10 | `0000 ...` | `0000 ...` | 19 |
| 11-21 | as mode 0, except 16: `FF7A FF7A FF7A FE00` / `7800 2200 3400 0C00` | | |

* DEMOPLAY SELECT entries 10-19 set `$D9C8` = 1-10 in order (*emulated*).
  The help strings at `$88:E439`+ run Stone, Parasol, Fireball, Needle,
  Tornado, Wheel, Spark, Hi-Jump, Freeze, UFO. So mode 1 is Stone ("will
  stop suddenly", friction `$7800`) and mode 10 is UFO. The pairing of the
  other modes with these names follows that order, which is the most
  likely reading, but it is **unconfirmed** for each mode.
* Mode `$0A` skips the air drag, the landing reflection and the whole
  rolling step.
* `tbl_ball_gravity`[0] = `$FFC0` is also the airborne gravity: `$80:C710`
  copies it to `$DA38`. The other entries are used only by the slope
  acceleration (next section).

### Slope acceleration

Right after friction, in `$81:8AE1`-`$81:8B71`. The surface code c is
`$DA04` (terrain.md: 1-4 ramps rising with +y, −x, −y, +x; 5-8 the
diagonals), and g = `tbl_ball_gravity`[`$6A72`]:

    vx += sub_mul_q15(g, tbl_slope_accel_x $81:9E85[c])     (A x X >> 15, floor)
    vy += sub_mul_q15(g, tbl_slope_accel_y $81:9E97[c])

| c | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| `$9E85` (x) | 0 | 0 | `$D7C8` | 0 | `$2838` | `$D7C8` | `$D7C8` | `$2838` | `$2838` |
| `$9E97` (y) | 0 | `$2838` | 0 | `$D7C8` | 0 | `$2838` | `$D7C8` | `$D7C8` | `$2838` |

`$2838` = 0.3142 = sin α cos α for a slope of tan α = 0.35355, one height
step (`$5A82`) per cell. That is the horizontal part of gravity along the
slope. With g = `$FF7A` (−134) the acceleration is floor(−42.1) = −43 a
frame toward downhill.

The diagonals use the same 0.3142 on both axes. That is not the exact
projection for their slope, which would be 0.283 per axis.

*Emulated*: a still ball put on hole 1's ramp cell (11,3) (shape `$07`,
code 4):
* vx goes 0 → −43 on the first frame, then −34 a frame (−43 plus 9 of
  friction), for 44 frames down the ramp;
* back on the flat it decelerates by 13 a frame;
* the writes come from `$81:8AFF` (slope) and `$81:8ADE` (friction) only.

### The bounce

`$81:8905` (the default landing handler, reached by JML from `$81:811B`,
ends in RTL):

1. If `$6A7A` ≠ 0, it counts to 3 and skips the bounce. This is a short
   lock-out after a ramp launch (`$81:980B` sets it).
2. If z ≥ ground (`$DA06`/`$DA08`), gravity only.
3. **Landing** (`loc_bounce $81:891B`): z = ground.
4. Unless mode `$0A`, **`sub_reflect_surface $81:9444`** with A = surface
   code `$DA04` (below).
5. `$DA4E` = 1, the "bounced" event.
6. In modes 0 and 7 only:
   * `$81:8C79`, the hit-stop;
   * **`sub_spin_impulse $81:8CE2`**.
7. `$D9D0` = 0: spin is spent at the first landing, whichever kind it was.
8. If `$DA48` (frames since the last bounce) < `dat_bounce_min_frames
   $80:DCFD` = `$0010`, the ball **comes to rest vertically**: `$D9EC` = 0,
   vz = 0, and it rolls from here.
9. Otherwise (`$81:8975`) the velocities are damped through `sub_mul_q15s
   $81:9793`, a sign-magnitude Q15 multiply that rounds toward 0:
   * vx, vy x= `$DA3C`;
   * vz x= `$DA3E`;
   * `$DA48` = 0.
10. `$81:899F`: vz += `$DA38`.

**`sub_reflect_surface $81:9444`** (JSL, A = matrix index) loads a 3 x 3
Q15 matrix M from `tbl_reflect_matrix $81:9ED9`, at offset
`tbl_reflect_index $81:9EB9`[A] (A x 18). It loads M symmetrically: only
6 of the 9 words are read. **`sub_reflect $81:8DAF`** (JSR; JSL entry
`$81:8DAB`) then sets v ← M v. Each product goes through `sub_mul_q15
$81:97A9` (signed A x X >> 15, floor), and zero matrix entries are skipped.
The vz column is used only while the ball is airborne.

Every matrix is a Householder reflection I − 2nnᵀ about the surface
normal n:

| index | surface | n | M (diagonal, off-diagonal) |
|---|---|---|---|
| 0 | flat | (0, 0, 1) | diag(1, 1, −1): vz = −vz |
| 1 | ramp rising +y | (0, −1/3, 2√2/3) | yy `$638D` 0.778, yz `$5070` 0.628, zz `$9C73` −0.778 |
| 2 | ramp rising −x | (1/3, 0, 2√2/3) | xx 0.778, xz `$AF90` −0.628, zz −0.778 |
| 3 | ramp rising −y | (0, 1/3, 2√2/3) | yy 0.778, yz −0.628, zz −0.778 |
| 4 | ramp rising +x | (−1/3, 0, 2√2/3) | xx 0.778, xz +0.628, zz −0.778 |
| 5-8 | diagonals | (±0.316, ±0.316, 0.894) | xx = yy `$6665` 0.8, xy ±`$1996` 0.2, xz/yz ±`$4867` 0.566, zz `$B334` −0.6 |
| 9, 11 | wall, N or S edge | | diag(1, −1, 1): vy = −vy |
| 10, 12 | wall, E or W edge | | diag(−1, 1, 1): vx = −vx |

n has a slope of 1/(2√2) = 0.35355 for the ramps: one height step per
cell, the same constant as the screen projection. The index table has 16
entries, but only 0-12 are reachable (surface codes 0-8, and 9 + edge
0-3). Entries 13-15 point into the code that follows.

So a bounce **reflects the velocity in the true surface normal, then
scales the horizontal part by 0.98 and the vertical part by 0.65**, in
world axes, not along the normal. A ball dropped onto a ramp leaves
downhill.

*Emulated*:
* **Flat.** Dropped from 2 steps with vx = `$0400` on hole 1, it lands
  with vz = −1728 and leaves with vz = −1728 → 1727 (`$8001`, floor)
  x 0.65 = 1122, − 64 = 1058; vx 912 → 892.
* **Following bounces.** At frames 3090, 3125 and 3147. The fourth comes
  13 frames after the third, under the 16-frame limit, and the ball
  settles: `$81:896B`, airborne 0, vz 0.
* **Ramp.** Dropped still onto the ramp cell (11,3) (code 4) with
  vz = −2112:
  * vx = 0.628 x −2112 = −1328, x 0.98 = −1301;
  * vz = −0.778 x −2112 = 1642, x 0.65 = 1067, − 64 = 1003.
  The ball bounced away downhill (−x).

**Hit-stop.** `$81:8C79` (on landing): if `$6A70` = 0 and |vz| ≥ `$0900`,
Kirby's animation state `$D7D4` becomes `$0C`, and `$81:8C95` calls
`$80:8F78` Y = 4 times. That routine waits a frame and ORs the pad into
`$6A7C`/`$6A7E`. The physics therefore stops for 4 frames, after which the
state goes to `$0E` (unless it was `$0D`). `$81:8C48` does the same for
2 frames on a step hit, when |vx| + |vy| ≥ `$0300` and the edge is 0 or 1.
*Emulated*: a fly shot landing with vz = −3901 is reflected at frame 3114
and damped at 3118.

### Cell edges, walls and steps

**`sub_edge_crossing $81:9001`** (JSL) returns A = `$DA4C`. It compares
the cell this frame with the previous one (`$DA12`/`$DA16`):

* Off the course (both shapes 0) it returns 0 at once. No edge crossed
  also returns 0.
* `$6A78` = the direction of motion: 0 = −y, 1 = +x, 2 = +y, 3 = −x. 4-7
  are the four diagonal crossings, resolved by a cross product (`$81:9286`)
  into the edge crossed first.
* The edge index used below, `$48`, is the edge of the **new** cell the
  ball entered by, in N/E/S/W order with N = −y. Moving +y enters by N (0).
* `sub_edge_step_height $81:925E` gives the new cell's surface at that edge
  minus the old cell's at the opposite edge, in half steps. This is
  **`$DA4C`**: > 0 a step up, < 0 a drop, 0 nothing. When it is non-zero,
  `$D9E4` = the edge.
* `sub_edge_wall_flags $81:92AC` sets **`$D9E6`** = the edge when the
  layer-4 wall bit for it is set, and `$D9E8` from `$81:92D0`.

**`sub_wall_bounce $81:9390`** (JSL): `$81:87B2` restores x, y and the
probe fields from the previous frame, then `sub_reflect_surface`(9 +
`$D9E6`). A wall bounce is a pure reflection with no loss. Read from code
only: no layer-4 wall was hit in the runs below.

**`sub_step_bounce $81:93D1`** (JSL), for running into a terrain step:

1. Restore the previous position.
2. Put the ball against the edge. The fraction on the crossing axis
   becomes `$FFFF` or `$0000` (jump table `$81:93E2` by `$D9E4`).
3. Reflect with matrix 9 + `$D9E4`.
4. Scale the component normal to the edge by `$DA40` (default `$5332`,
   0.65). `$81:9EA9`/`$81:9EB1` are per-edge masks (`$3FFF` = scale this
   axis).

The caller also clears the spin and sets `$6A6C` = 4. In the air
(`$81:88C4`) it scales vz by `$DA42` (`$6665`, 0.80). In modes 0 and 7 it
also runs the hit-stop.

*Emulated* on hole index 2: rolling +y from (2,7) (elevation 1) into (2,8)
(elevation 4), `$81:93D1` at frame 3072:
* y is clamped to 7 + `$FFFF`;
* vy 2952 → −2952 x 0.65 = −1919;
* vx 738 → 737 is untouched.

**`loc_launch $81:8B78`** (a step down; also `$81:8B7B` with A = a surface
code, from the ramp-crest test `$81:980B`): the ball leaves the ground.

    vz = (vx x tbl_launch_x $81:9E61[c] + vy x tbl_launch_y $81:9E73[c]) >> 16
    c = the old surface code $DA24;  entries 0 or ±$5A82, so vz = ±0.354 v

* In mode 5 with `$D762` ≠ 0, vz = vz x `$B4` / 256.
* If the new surface code is non-zero and the old shape is not in the
  `$10`-`$1F` family, vz is halved (arithmetic shift).
* `$D9EC` = 1.

*Emulated* on a 2-step drop from (5,8) to (5,7) on hole index 2, a flat
cell: `$DA4C` = −4 half steps, vz = 0, airborne, then a fall under
gravity. The ramp-edge cases (a non-zero vz) are read from code only.

`$81:980B` decides when crossing a ramp's crest throws the ball. It is
read only in part: it has per-crossing-type jump tables at `$81:983B`, and
`$81:9B45` is a per-shape flag. **Unconfirmed.**

### The shot: power, elevation, launch

Hold Up in the aiming stage for a **fly shot**. Down returns to a
**grounder**: `$81:B5F9`/`$81:B661` on the held pad, states in `$6AD6`.
The game's help text calls the two kinds "fly shot" and "grounder".

* A fly shot sets the **elevation `$D9B6` = 60** (`$3C`, degrees) at
  `$81:B656`.
* A grounder sets 0 (`$81:B6BC`).
* Hi-Jump relaunches at 65 (`$82:CC4F`), along the current heading
  (*emulated*: DEMOPLAY entry 17).

The power meter `$6B3A` counts up to `$6B3C` and back. A stops it, and
**`sub_shot_power $81:C2E6`** turns it into the power:

    P = $6ADC = (dat_power_scale $80:DD03 [$1300] x tbl_power[$6B3A]) >> 14
    tbl_power = $88:A670 (grounder) or $88:A6F0 (fly shot), 64 words each

**`sub_launch_velocity $81:BA0B`** (JSL; entry `$81:BA0E` with A = the
power, used by Hi-Jump with `$11A9`). φ = `$D9B4` is the aim in degrees,
and ε = `$D9B6`, or 0 when `$6AD8` ≠ 0:

    vz = P sin ε,   h = P cos ε,   vx = h cos φ,   vy = h sin φ     (Q15 products)

*Emulated*: a grounder with P = `$1104` launches at vx = `$1102`. A fly
shot with P = `$1156` launches at vx = 2217, vz = 3843 (4438 cos 60°,
4438 sin 60°).

### Spin

The spin stage comes between aiming and power (`$81:BF07`-`$81:BFCC`). Two
selectors, each 0-12 with 6 = none:

* **side**, `$6B50`. Left and Right move it one step per 8 frames
  (`$81:C12E`). It is copied to `$D9B8` every frame so the guide can show
  it.
* **top/back**, `$6B52`. It starts at 6 and moves **by itself**, in a fly
  shot only: one step every `$6B5E` frames, 6 → 0 → 12 → 0 …. It turns
  round at 0 and 12, and pauses twice as long at 0, 6 and 12, with sound
  `$3D`, or `$42` at 6 (`$81:C170`).
  The A press that ends the stage latches it.

*Emulated*: the run below steps it every 3 frames (6 at 2869, 0 at 2885,
back up from 2891). A at 2887, 2909 and 2927 latched 0, 6 and 11. In a
grounder it stays 6.

After the power, **`sub_shot_spin $81:C1D5`** (JSR) computes the spin.
It is also run for the guide, at `$81:A9FB`, from `$D9B8`/`$D9BA`.

    s = $6B50 (side), t = $6B52 (top/back), P = $6ADC, φ = $D9B4
    $D9CC = $D9CE = $D9D0 = 0

    grounder ($D9B6 = 0):
      $D9CC = ($4000 x tbl_curve $80:DD24[s]) >> 8   = 64 x {42,35,...,0,...,-42}
      $D9CE = (P x tbl_spin_ground_tb $80:DD17[t]) >> 8   (t is always 6 here: 0)
      $D9D0 = $D9CC | $D9CE

    fly shot ($D9B6 ≠ 0):
      K = 2 x (P/2 + P/4 + dat_fly_spin_base $80:DD05 [$04AD])
      T = tbl_spin_fly_tb $80:DD33[t] x K >> 8     DD33 = 120,100,80,60,40,20,0,-16,-32,-64,-96,-128,-160
      S = tbl_spin_fly_side $80:DD4D[s] x K >> 8   DD4D = -60,-50,...,0,...,50,60
      (c, n) = the high bytes of the Q15 cos φ and sin φ, about 128 cos φ and 128 sin φ
      $D9CC = T c/256 + S n/256
      $D9CE = T n/256 − S c/256
      $D9D0 = number of non-zero parts

They are saved per player at `$D866`/`$D86A`/`$D86E`,X (X = `$1803`).

*Emulated*, P = `$1156` (K = 9050), φ = 0:

| run | latched | spin |
|---|---|---|
| fly, t = 0 | `$6B52` 0 | `$D9CC` = `$0838` (2104) |
| fly, t = 11 | `$6B52` 11 | `$D9CC` = `$F73B` (−2245) |
| fly, Left held | s = 2 | `$D9CE` = `$02C3` (707) |
| grounder, Left held | s = 2 | `$D9CC` = `$0700` (1792) |
| grounder, Right held | s = 10 | `$D9CC` = `$F900` |

#### Fly shot: an impulse at the first bounce

**`sub_spin_impulse $81:8CE2`** (JSL; landing, modes 0 and 7):

    if $D9B6 ≠ 0 and $D9D0 ≠ 0:
        if $6AC0 ≠ 0: JSR $9B61          (spawns a spin effect object, type $29/$2B; unconfirmed)
        vx += $D9CC;  vy += $D9CE;  $D9CC = $D9CE = $D9D0 = 0

The impulse is added after the reflection and before the damping, so it
is also damped by 0.98. Positive t (top) pushes along the shot and
negative t (back) against it. s < 6 (Left) pushes toward +y for a shot
along +x, the same turn as a grounder's curve. With the projection in
physics.md (screen y up = +y − x), that is a turn to the player's left.
`$81:9001`'s step hits and many tile handlers clear the spin earlier.

*Emulated*, three fly shots identical except for the latched t, first
landing at the same point:

| t | vx after the reflection | after the impulse and x 0.98 |
|---|---|---|
| 6 (none) | 1374 | 1346 |
| 0 (top) | 1374 + 2104 = 3478 | 3408 |
| 11 (back) | 1374 − 2245 = −871 | −853: the ball bounces back toward the tee |

With side spin s = 2: vy 0 + 707 → 692.

#### Grounder: a curve while rolling

**`loc_roll_curve $81:8D17`** ends the rolling step (JML, RTL):

    if $D9B6 = 0 and $D9D0 ≠ 0 and $D9CC ≠ 0:
        vx += ((~$D9CC) x vy) >> 16          ($80:A378; ~ω = −ω−1)
        vy += ($D9CC x vx) >> 16             (using the new vx)

This rotates the velocity by ω = `$D9CC` / 65536 radians each frame, in a
semi-implicit form that keeps the speed. That is at most 2688/65536 =
0.041 rad = 2.35° a frame. The radius is |v| / ω; for a full-power
grounder with s = 2 it is about 2.4 cells.

The curve lasts **until the first landing** (`$895F` clears `$D9D0`) or a
step hit. Friction and slope run before it each frame, and bounces off
walls do not stop it.

`$D9CE` for a grounder is always 0, because t never moves. The only code
that would use it, a decay at `$81:8D53`-`$81:8DA9` (|`$D9CE`| shrinks by
|`$D9CE`|/64 + 1 a frame, and the spin is cleared under `$40`), has **no
caller**: no JSL, JSR, JML or pointer to it was found.

*Emulated*, grounders with P = `$1104` along +x:
* With s = 2 (ω = 1792): the first rolling frame has vy 0 → 118
  (1792 x 4342 / 65536); the next has vx 4342 → 4326 (12 friction, 4
  curve) and vy 236. The writes come from `$81:8D3A`/`$81:8D4E`, and the
  ball rolls a loop to +y.
* s = 10 mirrors it (vy −119, −237, ...).
* s = 6 runs straight.

### Buttons while the ball moves

`$82:DA51`, from the Kirby state code at `$82:CDFF`, handles presses after
the shot, and `$82:DB20` applies them.

Pressing **A** or **Y** (`$006B` & `$4080`) arms a modifier:
* `$DA76` = 0 for A, 2 for Y;
* `$DA7A` = 15 frames in the air, 3 on the ground;
* `$DA78` = 22.

The modifier acts in two places:

* **At the next bounce or wall/step hit** within the window (`$DA4E` |
  `$DA50` | `$DA52`), vx, vy and vz each get v x k / 256 added, with
  k = `$82:DB75`[`$DA76`]: +39 for A (x 1.152), −25 for Y (x 0.902).
* **While rolling** (`$81:8A68`), as long as `$DA7A` ≠ 0:
  * A skips friction and slope;
  * Y adds `$1100` to the friction.

*Emulated*, both on top of an otherwise identical shot:

| press | bounce (no press: vx 1346, vz 2470) | rolling |
|---|---|---|
| A | vx 1551, vz 2846 | vx held for 3 frames |
| Y | vx 1214, vz 2228 | −29 a frame for 3 frames, then 1 frame with no friction |

### The shot guide

`$81:A9B8` (JSL, from the aiming loop `$81:A619`) runs a second copy of
the step on the work copy to predict the path: `$81:AF82`-`$81:B44B`, with
`$6AC6` = the kind of point. It uses the same reflection, friction, slope,
spin and edge routines, but its own integrator and no button modifiers.
The real step then overwrites the work copy from the player block the next
frame. Read from code only; what it draws is **unconfirmed**.

### More of the ball's WRAM

| work copy | what |
|---|---|
| `$D9B4` | aim φ, degrees |
| `$D9B6` | elevation ε, degrees: 0 grounder, 60 fly shot, 65 Hi-Jump. Also "is a fly shot" for the spin code |
| `$D9B8`, `$D9BA` | side and top/back selectors for the guide, reset to 6 |
| `$D9BE` | shot over: \|vx\| + \|vy\| < `$DA46` (1) for 30 frames, counted in `$D9C0` (`$81:A5CD`). *Emulated* |
| `$D9C8` | ball mode, 0 normal, 1-10 the copy abilities; selects the table rows |
| `$D9CC`, `$D9CE` | fly shot: spin impulse x, y. Grounder: `$D9CC` = curve rate ω |
| `$D9D0` | spin pending |
| `$D9DA` | heading, degrees; `$D9DE`/`$D9E0` 16/32 directions; `$D9E2` the last heading while moving |
| `$D9E4` | edge of a step crossed (N/E/S/W = 0-3, N = −y), else `$FFFF` |
| `$D9E6` | edge of a wall flag crossed, else `$FFFF` |
| `$D9EC` | airborne |
| `$DA04` | surface code under the ball, 0-8 (probe) |
| `$DA0C`-`$DA2B` | the previous frame's `$D9EC`-`$DA0B` |
| `$DA30`, `$DA32` | sources for `$DA3C`/`$DA3E` while airborne: `$7D6F`, `$5332` |
| `$DA34`, `$DA36` | sources for `$DA40`/`$DA42` |
| `$DA38` | gravity `$FFC0` |
| `$DA3A` | rolling friction (`tbl_roll_friction`) |
| `$DA3C`, `$DA3E` | bounce factors, Q15: horizontal 0.98, vertical 0.65 |
| `$DA40`, `$DA42` | step-hit factors: normal component 0.65, vz 0.80 |
| `$DA46` | rest speed, 1 |
| `$DA48` | frames since the last bounce |
| `$DA4C` | step height at an edge crossed this frame, half steps |
| `$DA4E`, `$DA50`, `$DA52` | this frame: bounced, hit a step, hit a wall |
| `$DA76`, `$DA78`, `$DA7A` | button modifier kind, window, timer |
| `$6A72` | mode x 8 + class x 2, index into both mode tables |
| `$6ADC` | shot power P |
| `$6B3A` | power meter |
| `$6B50`, `$6B52` | spin selectors during the stage |

### Not yet known

* Which mode is which copy ability, beyond the order of the demos and
  help strings.
* `$81:980B`, the rules for leaving the ground over a ramp crest.
* The landing lock-out counter `$6A7A`.
* `$81:9BE5`, the step's tail.
* `$D9E8` / `$81:92D0`.
* `$DA44` (`$00A0`, `$80:DCFF`): written at set-up, no reader found in
  the step.
* A layer-4 wall bounce has not been seen in a run.
* What the shot guide draws.

### How these were measured

All from `play_hole1.txt` (blank SRAM → course 1 hole 1). Two save states
cut the time: frame 2690, before the aiming stage ends, and 2780. Input
lines replace the script's from 2700 on: `2800 A`, `2840 A`, then A at
T (spin) and T + 60 (power).

| run | input / pokes | what it shows |
|---|---|---|
| grounder, no spin | T = 2900 | friction 12 / 13 |
| grounder, curve | `2870 LEFT 29` or `RIGHT 29`, T = 2900 | s = 2 / 10, the curve |
| fly shot | `2700 UP 4`, T = 2887 / 2909 / 2927 | t = 0 / 6 / 11; launch; spin impulse |
| fly, side | `2700 UP 4`, `2872 LEFT 30`, T = 2909 | side impulse |
| buttons | fly + `3105 A` or `3105 Y`; grounder + `3000 A` or `3000 Y` | the x 1.152 / x 0.902 bounce, the rolling modifier |
| slope | pokes at 3060: `$D8AE`=`000B`, `$D8AA`=`8000`, `$D8B6`=`0003`, `$D8B2`=`8000`, `$D8BE`=`0000`, `$D8BA`=`87C3`, `$D87A`=`$D87E`=`$D882`=`$D8A6`=0 | slope acceleration |
| flat drop | at 3060: cell (6, 4.5), z = `$B504`, vx = `$0400`, `$D8A6` = 1 | the bounce, settling |
| ramp drop | at 3060: cell (11.5, 3.5), z = `$1_0F86`, still, `$D8A6` = 1 | the reflection matrix |
| step / drop | course 0 hole 2 (`2050:$7E:6A5E=0002`); at 3060 the ball at (2.5, 7.5), vy = `$0C00`; or at (5.5, 8.5), z = `$1_C48A`, vy = `$F400` | step bounce, launch |

Each run logged `--watch-write '$7E:D9D4-$7E:D9D9'` (and z, `$D9EC`,
`$DA04`, the spin fields). The writing PC of every change gives each
term's source directly.

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

## The extra game and two players

`autoplay.py --extra` plays the extra game. It boots from the save the
whole game leaves (`build/emu/autoplay/game/sram.bin`) through the menus
(`inputs/play_extra.txt`): 1PLAY GAME → PLAY EXTRA COURSE (offered once
`$7E:EAAB` is set) → member 1 → the "EXTRA 1" map. The extra courses are
hole indices 64-127, with the same enemy and cup rules.

*Emulated*, one run of 150,000 frames, 5 minutes:
* all 64 extra holes;
* the EXTRA medal award ("a gold medal for all EXTRA courses") at frame
  111,823;
* Dedede from 112,628, beaten by about 126,000;
* the same ending (scene 18 at 127,460) and credits (scene 19 at 127,896).

The save then has `$70:0010` = `$0F`, `$70:001A` = `$0F`, and medal value 3
on all sixteen courses. On the title menu all six items are offered,
SOUND ROOM and DANCE SELECT included.

`autoplay.py --two-player` plays a 2-player game (`inputs/two_player.txt`,
course Whispy Woods, hole indices 128-135). The per-player ball block
interleaves the players: each field is one word per player, and
`$82:F030` loads it with X = `$7E:1803` (0 for player 1, 2 for player 2,
the one whose turn it is). Kirby's animation state follows the same
pattern (`$D7D4` / `$D7D6`). Player 2 shoots with pad 2, which the stepper
reads from `2:`-prefixed input buttons. The driver steers whichever
player's ball is rolling.

*Emulated*: the 8 holes in 12,600 frames.
* Enemies hit on player 1's turns go to player 1 (`$539C` = 0, star count
  `$6A10`), and the cup comes after.
* After the eighth hole, a per-hole star scorecard ("WHISPY WOODS COURSE",
  PLAYER 1 / PLAYER 2) is drawn over the hole scene.
* Then comes the 2-player result on the course-result stage (scene 8):
  PLAYER 1 40 WIN, PLAYER 2 0 LOSE.
* Then 2P COURSE SELECT (scene 6) and the handicap screen (scene 12)
  again.

The driver happens to take every enemy on player 1's first shot of each
hole, so player 2 never scores.

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

The extra game halves the damage (`$87:878E`, when `$7E:EAB9` is set).
*Emulated*: the extra game's Dedede, also hole index 184, takes eight hits
of 3. When the hit points reach 0,
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

## Details settled by the web port

The TypeScript port ([web-demo.md](web-demo.md)) reproduces eleven recorded
shots integer-exact, which pinned down several things the sections above leave
open. All of these are from the disassembly and confirmed by those traces.

* **Order of a frame.** The A / Y arming and its countdown (`$82:DA51`) run
  *before* the physics step; the bonus on a bounce (`$82:DB20`) runs after it.
  An A press on the ground arms `$DA7A` = 3: the step on the press frame and the
  two after skip friction and slope, the fourth applies them (the
  "vx held for 3 frames"). Y adds `$1100` to the friction for those three and
  skips it on the frame the timer reads 0 (the "1 frame with no friction").
  The press is dropped when `|vx| + |vy| >= $3001` or `|vz| >= $3801`.
* **Friction.** `P = ((cosθ × μ) × 2) >> 16` as a 16-bit word; for cos ≥ 0
  `fx = ((P + $80) >> 8) & $FF`, otherwise `fx = ((P + $FF80) >> 8) | $FF00`.
  The 16-bit subtraction then clamps at zero from either side. The slope term
  uses the high word of `g × slope_x` (`$81:97A9`, floor).
* **Heading.** `sub_atan2_deg $80:A4C1` is table-driven: the ratio of the
  smaller to the larger magnitude, as 0-255 through the hardware divider
  (`$80:A546`; a normalising shift when the larger is ≥ 256), indexes the
  arctangent table at `$80:A928`, which gives degrees 0-45; the quadrant is added
  from the signs. Port: `web/src/sim/trig.ts`.
* **Launch.** `vz = P sin ε`, `h = P cos ε`, `vx = h cos φ`, `vy = h sin φ`, each
  a Q15 product; the horizontal ones are sign-magnitude (`$81:BA63`, a negative
  product is rounded as `−((|p|−1) >> 15)`). `P = ($1300 × tbl[meter]) >> 14`.
* **Spin** (`$81:C1D5`). The top/back and side terms use `$80:A342`, a 16 × 8
  signed multiply whose result is bits 8-23 of the product; the multiplier is
  the **high byte** of the Q15 cosine or sine. The side term's second axis uses
  the negated cosine word, whose high byte is `$80` (−128), not −127; that is why
  Left gives `$D9CE` = 707. The doc's 2104, −2245, 707 and 1792 all follow.
* **Step down.** `loc_launch $81:8B78`: `vz = hi(vx × launch_x) + hi(vy × launch_y)`
  (each the high word of the exact 32-bit product, summed as 16-bit), halved
  (arithmetic) when the new surface code is non-zero and the old shape is not in
  the `$10-$1F` family.
* **Edge crossing, two axes at once.** The ROM goes through the neighbour the
  path crossed first, checks the step to it (and its wall flag on the way out),
  and only then the step to the final cell. A non-zero first step ends it.
* **Wall bounce versus outline wall.** `$81:9390` (layer-4 flag) restores x, y
  and the probe fields; the outline wall (`$82:9019`, tiles `$28-$2D`) restores
  x, y **and z** (`$82:ECD7`). See [tiles.md](tiles.md).
* **The cup.** `sub_cup_depth` also *lowers the ground* by the depth it returns
  (`$DA06/$DA08`), so a ball rolling over the dish follows its surface and one
  landing in it bounces off the lowered surface. At depth `$5000` the hole-out
  test is `z ≤ ground' + $4000` where `ground'` is the lowered ground, i.e. the
  ball is `$1000` below the original surface. On the rim a fast ball (`|vx|+|vy|
  ≥ $0300`) or the centre drops the rolling ball into the air with `vz = 0`; a
  slow one on the rim is pulled to the centre (`vx += (−(x−½) × $0600) >> 15`).
* **Aim and meter** (stepper): a press turns the aim 1°; held 17 frames, 3° every
  3 frames; the power meter counts 0 → 63 → 0 one step a frame; the top/back
  selector steps every 3 frames (`$6B5E` = 3) and pauses 6 frames at 0, 6 and 12;
  the last A to the first physics step is 23 frames.
* **The shot guide** is the same step run from Kirby at **full power** (meter 63),
  with the aim and elevation chosen, for 40 steps if the shot rolls and until the
  first landing if it flies; its end, projected, is where the aim stage's camera
  looks (`$6AAA/$6AAC`, written at `$81:AE29`). 105 of 110 aim angles match to a
  pixel (the rest run into the pillar). The guide is not a different integrator in
  any way that showed. See [web-demo.md](web-demo.md).
* **The shot flow has three presses, not four.** After the A that confirms the
  aim the game curls Kirby, opens the panel and waits (about 70 frames) before the
  spin stage answers; the "second A" of the script above did nothing. The power
  meter starts 5 frames after the A that leaves the spin stage, and if it is not
  pressed the shot goes by itself when the meter is back at 0.
* **Camera and facing**: `$38AC/$38AE` is the world camera (`$80:BF4D` turns it
  into the scroll), moved by `$81:BA8A` in the aim stage and in the pan to the shot
  view, by `$80:B961` during the roll; Kirby's facing and shot angle come from the
  aim through the table at `$81:8E98` (`$81:BB4A`, `$81:BCA0`). Details in
  [web-demo.md](web-demo.md) and [animation.md](animation.md).
