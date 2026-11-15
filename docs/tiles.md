# Special tiles

Course grid layer 2 (`$7E:8390`, one byte per cell) is the special-tile layer:
hazards, friction changes, boost panels, enemies, and the per-hole marked
cell. This is what makes one patch of floor behave differently from another;
the *shape* of the floor is layer 1, written up in [terrain.md](terrain.md).

Reproduce everything below with `python3 tools/terrain.py --tiles`, and see
one hole's tiles with `--index N --legend`.

## Two tile layouts per course

Layer 2 is the *only* layer that distinguishes the two halves of the hole
table. The 232 populated slots are **116 terrain geometries, each stored
twice at index `i` and `i+64`**, with the same name: indices 0-63 and 64-127
are `MAP00`-`MAP77`, and 128-179 and 192-243 are `MAP80`-`MAPE3`. Between a
pair, **layers 1, 3 and 4 are byte-identical and only layer 2 differs** — the
same course furnished with a different set of hazards and enemies.

So counts here are over **hole slots**, not geometries. The 20 `MAPC0`-`MAPE3`
second copies carry a 16-byte stub layer 2 (a lone `$0C`) instead of a grid,
leaving **212 slots with a real tile layout and 7,947 non-zero cells**.

## The dispatcher

There is no interpretation of the byte at all — it is a jump table index.
`$81:811B (0x00811B)` is called with the layer-2 value of the cell the ball
just landed on:

```
$811B  CMP #$0100 / BCS $811E     ; trap: the value must fit in a byte
       STA $BC
       ASL A / CLC / ADC $BC      ; value * 3
       TAX
       LDA $81:8136,X / STA $BC   ; a 3-byte long pointer
       LDA $81:8137,X / STA $BD
       JML [$1EBC]                ; D = $1E00, so this is [$BC]
```

So **`$81:8136 (0x008136)` is a 256-entry table of 3-byte long pointers**, one
per possible tile value. A second, identical mechanism at
`$81:8436 (0x008436)` uses the table at `$81:8451 (0x008451)` when the ball
hits the cell from the side rather than landing on it.

The two tables **group the 256 values identically** — same 40 groups — but
point at different handlers, so every tile type has a distinct "landed on" and
"hit from the side" behaviour. Only 14 of the 256 entries are the same pointer
in both.

Call sites, both in the physics step `$81:801C`:

```
$80A2  LDA $DA0A / JSL $81:811B    ; landed on the cell
$8100  LDA $DA0A / JSL $81:8436    ; ran into it sideways
```

`$7E:DA0A` is the layer-2 byte under the ball, filled in by
`sub_terrain_probe` at `$81:94F0`.

## What the groups do

112 of the 256 values fall through to `$81:8905` (land) / `$81:8A56` (hit),
which is the ordinary "no special behaviour" path. The rest:

| values | on land | what it does |
|---|---|---|
| `$20-$24` | `$82:8F77` | **friction override** |
| `$04` | `$82:8EFB` | friction override, second variant |
| `$30-$3B` | `$82:9DB3`+ | **boost panel**, four directions |
| `$10-$13` | `$82:A7DD` | **kicker**: landing speed becomes a directional impulse |
| `$14-$17` | `$82:A6C7`, `$82:A70B` | **arrow panel**: turns the ball to the arrow's direction, N/E/S/W, at the same speed |
| `$70-$7B` | `$82:9FD1`+ | toggled directional impulse, two magnitudes |
| `$18-$1B` | `$82:A5B1` | snaps Z to the surface and zeroes vz |
| `$80-$8F`, `$98-$A1` | `$82:98F8` | **hazard**: the bumper track's shape, then a cube test against the riding bumpers (object 76) |
| `$90-$97` | `$82:9653` | hazard: the bobbing bumper's box (object 77) |
| `$05` | `$82:A55E` | hazard: at or under the surface, every frame; the ball is thrown along its heading |
| `$A2` | `$82:9858` | hazard: a bumper box at a fixed height (no course has it; the load makes it of an isolated track tile) |
| `$AC-$AE` | `$82:86B9` | hazard: the volcanoes (objects 81-83), the cone after restoring the previous position, the base while one erupts |
| `$40-$52`, `$57` | `$82:8967` | **spawns an actor** |
| `$02` | `$82:94D3` | solid object standing 3 height steps tall |
| `$28-$2D` | `$82:8FF1` | **the play-area outline**, a wall: see below |
| `$60-$6F` | `$82:80F6` | **water**, a surface overlay with enter/leave tracking: see "Not established" |
| `$08` | `$82:AD8E` | **the cup**: holes the ball (docs/physics.md). In no course's data, because it is written at run time into the cell of the last enemy left, which becomes the cup |
| `$B0-$B9` | `$82:A980`, `$82:A9DB` | **warp panels**, in pairs: the ball goes to the other one and leaves it along its arrow |
| `$1C`, `$1D`, `$58-$5D` | various | not established |

The shot guide does not use these two tables. It has its own, `$81:B455`, in
which only the outline `$28-$2D` and the overlay `$60-$6F` act; every other
value, the pillar, the enemies and the cup included, is plain ground
([physics.md](physics.md) "The shot guide").

### Friction — `$20-$24`

`$82:8FA4` overwrites three coefficient slots in the active object:

```
if state == $0A: return
$DA3A = $80:DD7D                                  ; $0800 = 0.0625
if tile == $24: $DA3C = $80:DD7F (0.9799), $DA3E = $80:DD81 (0.9000)
else:           $DA3C = $80:DD83 (0.9990)
                $DA3E = $80:DD85 (0.9990), or $80:DD87 (0.8000) in state 6
```

The defaults these replace are `$DA3C` = `$7D6F` (0.98, from `$80:DD0F`)
and `$DA3E` = `$5332` (0.65, from `$80:DD11`). Both are copied back from
`$DA30`/`$DA32` on every airborne frame, so an override lasts only for the
landing it was dispatched on (*emulated*, docs/physics.md). `$DA3C` and `$DA3E` are the Q15 factors the landing code at
`$81:8975` applies on every bounce — **vx and vy are both scaled by `$DA3C`,
vz by `$DA3E`**, through the fixed-point multiply `$81:9793`:

```
$8975  LDA $D9D4 / LDX $DA3C / JSL $81:9793 / STA $D9D4    ; vx *= $DA3C
$8982  LDA $D9D6 / LDX $DA3C / JSL $81:9793 / STA $D9D6    ; vy *= $DA3C
$898F  LDA $D9D8 / LDX $DA3E / ...                         ; vz *= $DA3E
```

So raising `$DA3C` from 0.98 to 0.999 makes the ball keep almost all of its
horizontal speed on each bounce — a slippery or fast surface. `$24` is
deliberately less extreme than `$20-$23`.

### Boost panels — `$30-$3B`

Four handlers, each adding a fixed delta to one velocity component:

| handler | values | effect | direction |
|---|---|---|---|
| `$82:9DB3` | `$30 $35 $38` | `vy += $82:9CB7` = −512 | N |
| `$82:9DD7` | `$31 $37 $3A` | `vx += $82:9CB5` = +512 | E |
| `$82:9DFB` | `$32 $34 $39` | `vy += $82:9CB5` = +512 | S |
| `$82:9E1F` | `$33 $36 $3B` | `vx += $82:9CB7` = −512 | W |

The direction order is the same N/E/S/W used by the terrain edge table. Each
handler is gated by three tests (`$82:9E76`, `$9E85`, `$9E9A`) before it
applies the delta.

`$30-$33` sit on flat cells. `$34`, `$36`, `$38`, `$3A` sit **only on ramp
shapes** — `$34` on `$04`, `$36` on `$05`, `$38` on `$06`, `$3A` on `$07` —
and in every case the boost direction is the *uphill* direction of the ramp
it sits on. They are the panels that push you up a slope.

Those four are the landing handlers. Rolling onto a panel takes the hit
dispatch's four (`$81:8451`), read 2026-11-15:

| handler | panel | straight when | launch | otherwise |
|---|---|---|---|---|
| `$82:9CBF` | N | \|vx\| < `$82:9CBD` = 128 | vx = 0, vy = −1023 | vy += `$82:9CB3` = −64 |
| `$82:9CFC` | E | \|vy\| < 128 | vy = 0, vx = +1023 | vx += `$82:9CB1` = +64 |
| `$82:9D39` | S | \|vx\| < 128 | vx = 0, vy = +1023 | vy += +64 |
| `$82:9D76` | W | \|vy\| < 128 | vy = 0, vx = −1023 | vx += −64 |

- Gated first by the mode (`$82:9E85`) and the panel's fraction test
  (`$82:9E9A`). Failing either, `$6A28` = 0 and the roll goes on.
- A straight hit launches only if the panel's own component is under
  `$82:9CB9` = 1024 (`$82:9E43` / `$82:9E48`, X = the direction's sign). It
  then also clears `$D9D0` and sets `$6A28` to the launch speed, and the
  handler returns (`RTL`): no roll that step, only `$81:8D52` and the tail.
  `$6A28` is object 112's switch for its hum ([courses.md](courses.md) "The
  palette cycles").
- Otherwise (not straight, or too fast) the push goes to the panel's own
  component with the panel's sign, the coefficients reset (`$82:9EE3`),
  `$6A28` = 0, and the roll goes on (`$81:8A56`). The landing handlers also
  clear `$6A28` on every exit.
- The handler runs every frame the ball rolls on the panel, so a ball
  entering askew gets the push first and, once the panel's friction has
  brought the other component under 128, the launch.

*Emulated*: web_boost (straight in) and web_boost_side (askew: the push at
2499, the launch a few frames later) on course 3 hole 2, the engine's
trace-terrain scenarios. The engine had ported the hit handlers with S and
W's axes swapped, the push on the other component and the sign from the
ball; both scenarios fail on that code.

### Arrow panels — `$14-$17`

The arrows on the floor. They redirect the ball and do not speed it up.
`$14` points N, `$15` E, `$16` S, `$17` W. There are 98 cells of `$14`/`$16` in 50 hole slots and 72 of
`$15`/`$17` in 41 (`tools/terrain.py --tiles`),
on course 1 at hole 2 (`$16` at (2,14)), hole 3 (`$16`, `$17`), hole 5 and
hole 6. Read from `build/engine/disasm/handlers.txt` and
`tools/dis65816.py '$82:ECFC'`:

| handler | tiles | gate | then |
|---|---|---|---|
| `$82:A6C7` (land) | `$14`, `$16` | at or under the surface; x in [`$4800`, `$B7FF`), y in [`$2800`, `$DFFF`); `$80:DE4D`[mode] ≠ 0 | `JML $81:8905` |
| `$82:A70B` (land) | `$15`, `$17` | the same with x and y swapped | `JML $81:8905` |
| `$82:A74F` (hit) | `$14`, `$16` | x in [`$6000`, `$9FFF`), y in [`$2800`, `$DFFF`); `$80:DE79`[mode] ≠ 0 | `JML $81:8A56` |
| `$82:A783` (hit) | `$15`, `$17` | the same with x and y swapped | `JML $81:8A56` |

Outside the position window the enemy/pillar latch `$6A68` is cleared. Both mode tables are 2 in mode 0.
Inside it, `$82:A7B7` acts once per pass (the latch):

1. `$82:ECFC`(A = tile − `$14`) rotates (vx, vy) by (target − `$D9DA`)
   through `$82:ED3B` → `$82:ED4C` (the rotation the pillar's push uses).
   The targets come from its jump table `$82:ED06`: 270, 0, 90, 180 for
   N, E, S, W.
2. It zeroes the cross axis: vx for N/S (`$82:ED1E`), vy for E/W
   (`$82:ED33`). Then `$81:8E60`.
3. It clears the spin `$D9CC`-`$D9D0` and sets `$6A6C` = `$0C`, the sound the step's tail plays.

*Emulated* (`tools/snesstep/inputs/web_arrow`, the engine's
`test/trace-terrain.test.ts`): rolling at (−356, 2904), heading 97, into
course 1 hole 2's `$16`, the ball leaves at (0, 2914). The speed is kept
(friction takes the rest), and sound `$0C` is requested in the same
iteration (2480).

The shot guide's table `$81:B455` treats the arrows as plain ground.

### Warp panels — `$B0-$B9`

Pairs of panels: a ball that lands or rolls onto one is taken out and put
down on the other, and leaves it along that panel's arrow. Course 1 has a
pair on hole 4 (index 3: `$B4` at (4,22), `$B5` at (4,18)), hole 6 (`$B2`
(2,3), `$B0` (3,8)) and hole 8 (`$B2` (4,5), `$B0` (6,10)). Every warp list
in the ROM's 212 tile layouts is a pair (`build/courses/*/geometry.json`,
read 2026-11-14). Read with `tools/dis65816.py '$82:A980'` and `'$82:AC4C'`:

**The lists.** At load the sweep's handler for a tile with no actor
(`$82:BD5C`, from `$82:B320`) appends each warp's (column, row) to one of
four lists, in the sweep's order (rows from the top, each from its last
column). `$82:B38D` terminates each with `$FFFF`:

| tiles | x list | y list |
|---|---|---|
| `$B0-$B3` | `$7E:B6FC` | `$7E:B706` |
| `$B4-$B7` | `$7E:B70E` | `$7E:B718` |
| `$B8` | `$7E:B720` | `$7E:B72A` |
| `$B9` | `$7E:B732` | `$7E:B73C` |

**The handlers.**

| handler | gate | then |
|---|---|---|
| `$82:A980` (land) | the window; mode ≠ `$0A`; at or under the surface (`$DA08:$DA06` ≥ `$D9FA:$D9F8`); the latch | in mode 0 with \|vz\| ≥ `$900`: `$6A6E` = `$DA04` and Kirby's state `$0C` (the squash); the warp; `JML $81:8905` |
| `$82:A9DB` (hit) | the window; mode ≠ `$0A`; the latch | the warp; `JML $81:8A56` |

- The window is `$82:AC74`: both fractions in [`$2800`, `$E000`).
  Outside it the latch `$6A42` (per player) is cleared. The latch is set on
  the warp and is also cleared by tile `$00`'s handlers (`$81:88F9`,
  `$81:8A47`), so a ball warps once per visit.

**The warp, `$82:AA02`.** It runs inside the ball step, and the step blocks
until it is over:

1. `$82:AA6F` finds the ball's cell in its list. With two entries the
   destination is the other (`EOR #2` on the word index). With 1, 3 or 4,
   `$82:ABC6` picks at random (`$80:87DD`, rows of `$82:AC0C`). With 1 it
   never finds an index and hangs; no hole has such a list.
2. The ball moves to the destination's centre (both fractions `$8000`) and
   is re-probed (`$81:9479`). The probe's tile is now the destination's.
3. `INC $6A48`. The player's own threads (`$85:8177`, `$85:822B`) suspend
   themselves on it through `$82:AC94`. Then sound `$76` and
   `$80:8FB6` with 10.
4. Kirby's sprite goes off (`$0B7E`/`$0B82` = `$FFFF`) and z = the ground.
   Object 63 takes his place, and Kirby's projection is computed at the
   destination (`$81:A4C6`, `$81:A430`). The camera's lags `$38C2-$38C8`
   are zeroed. The frames then run until object 63 raises `$699C`
   (`$85:CEAB`).
5. A frame, then a pan (`$81:BA8A`) toward the projection, repeated until a
   pan finds the camera there.
6. Object 64 appears at the destination with sound `$77`. After 26
   frames Kirby's sprite comes back. In 1-player there are 20 more frames.
7. `STZ $6A48`, and `$82:ACAA` resumes the threads.
8. `$B0-$B7`: `$82:ECFC`(A = the destination's tile & 3) turns the
   velocity to the arrow (N E S W, as for the arrow panels: the speed is
   kept and the cross axis zeroed). Then `$82:AC4C`: unless a grounder was
   chosen (`$6AD8`), the fly impulse `$D9CC/$D9CE` is turned by `$82:AC6C`
   [arrow] − `$DA2C`. `$DA2C` is the block's `$D886`, which `$82:F1CE`
   stores from `$D9DA`: the heading the last step left. `$B8` and `$B9`
   keep the heading.

*Emulated* (`tools/snesstep/inputs/web_warp`, `web_warp_fly`; the engine's
`test/trace-warp.test.ts`). F is the warp's frame and A the arrival:

| | web_warp (rolled onto `$B4`) | web_warp_fly (landed on it) |
|---|---|---|
| F: the handler, sound `$76` | 2488 | 2479 |
| F + 10: object 63, Kirby off | 2498 | 2489 |
| F + 48: `$699C` (38 frames of object 63) | 2536 | 2527 |
| pans | 2537-2563 (27) | 2528-2553 (26) |
| A: object 64, sound `$77` | 2563 | 2553 |
| A + 26: Kirby back | 2589 | 2579 |
| A + 46: the step goes on | 2609 | 2599 |
| the ball | (4,18) centre, heading E at the speed it had (1237 → 1224 after the roll's friction) | (4,18) centre, vz −2944 and still airborne on the ground; on the next step it lands with a hit-stop and, 15 frames in the air, settles (`$81:8962`) |

Objects 63 and 64 (`trace_actors.py --types 63,64`):

- **Object 63** lives 2498-2535 at Kirby's projection where he went in. It
  shows his own picture (`$5D9C` = `$FFFF`, the frame it copied from
  `$0B1E`) for 2 frames, then table `$89:94F5`'s frames 0-10, the star
  burst.
- **Object 64** lives 2563-2589 at the destination. It shows frames 0-7,
  20 and 0 of the same table.

The shot guide's table `$81:B455` treats the warps as plain ground.

### Kicker — `$10-$13`

`$82:A7DD` fires only if the ball is at or below the surface. It scales the
landing vz through the multiply routine `$80:A342`, clamps it against
`$80:DDE3`/`$80:DDE5`, and converts the result into a vx/vy impulse whose
direction comes from the tile value. Landing harder throws you further.

### Hazards

The hazards are **bumpers**. A hit bounces the ball, costs one tomato and
plays sfx `$6F` (the shared penalty `$82:9C8D`). None of them loses the ball.
Verified against the game on five recorded scenarios, one per group
(`tools/snesstep/inputs/web_haz*`, engine `test/trace-hazards.test.ts`). From
the poke on, every ball state and every sound request matches:

| scenario | hole | the hazard | what the game did |
|---|---|---|---|
| web_haz80 | 3 (course 1 hole 4) | the lone `$80` at (8,18), auto-tiled to `$A2`, rolled into; then the `$05` row | the box bounces it back (2485, `$6F`); `$05` at (8,20) throws it, vy `$473`, vz `$880` (2523) |
| web_haz98 | 4 (course 1 hole 5) | object 76 riding its track (`$84`, `$98`, `$98`), flown into | the cube test and the 3-D exchange: v (−2976, −992, −512) → (−1847, −2027, −486) at 2464 |
| web_haz94 | 11 (course 2 hole 4) | object 77 on `$94` at (1,24), rolled into while low | the reflect: vx −1788 → +1145 (2474) |
| web_hazad | 54 (course 7 hole 7) | object 82's base at (5,14) while it spews | the throw: vy −`$500`, vz `$800`, sfx `$7B`, Kirby's state 40 (2477); then the cones of 82 and 83 |
| web_hazac | 54 | object 81's cone at (5,16), flown into inside its height window | the reflect by side, sfx `$7C` (2484) |

Each scenario picks its hole with the `$6A5A`/`$6A5E` pokes at 2050, shoots
weakly from the tee, and pokes the ball's block at the roll's first frame.
web_haz98's window ends at 2496. At 2497 the ball rolls from the flat (6,13)
onto the `$07` ramp at (5,13), heading west, and is launched: the unported
cross-cell branch of `$81:980B` ([physics.md](physics.md)), not a hazard.

- The handlers' tomato is **`$83:ABC5`**. It queues a −1 in the HUD's ring
  `$68FA`, which lands 20 iterations later with sfx `$10`. The same routine
  charges every shot at the roll's start (`$82:BFDB`).
- A ball that falls out of the world is a different path in 1P:
  `$80:F830` sets the tomatoes to 0, then the next turn costs a life
  (`$80:F8D0`) and refills them. `$82:C085` queues two −1s for it only when
  `$17FF` is set, which it is not in 1P (web_fly: the ring's write index
  `$68F8` does not move at the fall).
- At the hole's load, `$82:BA87` auto-tiles the bumper tracks (`$80-$A1`) in
  place, row by row. A tile whose sides do not all connect becomes the dead end
  of the side that does (`$82:BB82`), and one that connects on no side becomes `$A2`, the fixed box:
  course 1 hole 4's lone `$80` at (8,18) is one.
- Each handler also asks the roll loop for a reaction (`$D780`, run by
  `$82:DB9A` after the step):
  - `$14` (the bumpers): Kirby's state 49;
  - `$13` (`$05`): the ball thrown along its heading, speed `$474`, vz `$880`;
  - `$0F` (a volcano's base while it spews): thrown at `$500`, vz `$800`,
    Kirby's state 40, sfx `$7B`.
- The handlers' maths was ported in full and is exact on all five scenarios:
  - the track's shape bitmap `$82:9A9D` and the cube test against the riding
    bumpers (`$82:997E`, `$82:9ABF`, `$82:E701`);
  - `$82:9B3B`'s push and its minimum, and `$82:E7B0`'s 3-D exchange;
  - the reflects `$82:E6C1` and `$82:EDE9`;
  - `$82:EF23`/`$82:EF9B`'s minimums, and the two-axes case `$82:9813`
    (`$6A24`), a box coming down on a ball under it;
  - the cone's height window and diamond (`$88:A470`);
  - the restore of the previous position.

The actors that move, thread objects ticked by the scheduler `$80:E0C0` in
the frame helper `$80:8F78` at the end of each main-loop iteration (dis.,
and their thread slots recorded every frame with
`tools/snesstep/trace_actors.py`, the engine's `hazard-actors.test.ts`):
- **Object 76** (`$84:DED6`, `$84:DF75`) rides its track at `$0400` (1/64
  cell) a tick. At each cell centre it turns by `$84:E051`[tile][dir]. It
  flips frames 0/1 every 9 ticks, its Z is the ground under it, and on `$A2`
  it has no mover. Its four frame tables are chosen by its spawn tile, not
  its direction: `$84:DD34` stores `$84:DD55`[tile − `$80`] in `$5E1C` at
  the spawn (from `$82:BA00` for 76 and `$84:DD9D` for 77), and 76 never
  rewrites it. For 76 that is table (tile − `$80`) >> 2 (`$89:CCA7`,
  `CCAB`, `CCAF`, `CCB3`); for 77, tile & 3 (`$89:CC47`, `CC5F`, `CC77`,
  `CC8F`). The emulated sheets agree: tile `$84` (course 1 hole 5) draws
  only `CCAB`, `$80` and `$81` only `CCA7`, hole 158's `$8C`/`$8E` only
  `CCB3`; 77's `$91`/`$95` only `CC5F`, `$96` only `CC77`, and hole 156's
  `$90-$93` all four. (An earlier reading took 76's tables for its
  directions.)
- **Object 77** (`$84:DD9D`, `$84:DDC7`) steps through `$84:DE0F`'s 22
  entries, 9 ticks each; on tiles `$94-$97` it starts at step 10. The box's
  height is `$82:967B`[frame], `$3B00`-`$BA20`. Only frames 0-2 are under
  the cube's half-size `$58E0`, so a rolling ball passes under a raised
  bumper.
- **The volcanoes 81-83** (`$84:E166`, `$84:E4BB`, `$84:E539`, `$84:E1B4`)
  chain idle segments (frames 0, 1, 2, 1; 8 ticks each) with eruption tests:
  81 never erupts; 82 runs 128, E, 192, E, 64, E, 64, E; 83 runs 64, E, 64,
  E, 128, E, 32, E (E = a test).
  - An eruption (`$84:E539`) is state 1 for 54 + 42 ticks, then state 2, the
    spew, for 12 x 8 ticks.
  - A test is skipped (192 idle ticks) while the ball rests in the cell's
    middle.
  - A cone hit pokes the volcano: 32 frames of `$84:E1F5`, unless it is
    erupting.
- **The game's lag frames drop scheduler ticks**, and a tick can straddle a
  frame. So a recorded slot can show the thread's new frame with the mover's
  old position (web_haz98 2357, 2368). The hole's intro ticks object 76's
  thread while its mover stands (2190-2191), which leaves its frame phase an
  odd number of ticks off a straight run from the spawn. The tests therefore
  align the actors to the recording before each poke, and compare state
  sequences, not frames. The volcano holes lag 4-7 frames over a window.

Not measured:
- the eruption's projectiles, object 84 and its seven children, whose sound
  `$39` (`$84:E848`, every 12 frames while one spews) is the thread's. Whether
  one can touch the ball is unknown; none did in web_hazad's or web_hazac's
  windows;
- the hazards' mode-7 destroy;
- `$6A8C`, the cup reveal's hold on objects 76 and 77, which is from the
  disassembly only: no recording has a reveal on a hazard hole;
- `$A2`, which is in no ROM hole. Its handlers share the box code with
  `$9653`, which web_haz94 checks.

## The outline wall: `$28-$2D`

These six values trace the green outline on the floor, and they are a **wall**.
Each is one line through its cell (`$82:9019`, `$82:92C2`, in cell coordinates):

| tile | line | reflection |
|---|---|---|
| `$28` | x = 1/2 | vx = −vx |
| `$29` | y = 1/2 | vy = −vy |
| `$2A` | x + y = 1/2 | (vx, vy) ← (−vy, −vx) |
| `$2B` | y − x = 1/2 | (vx, vy) ← (vy, vx) |
| `$2C` | x + y = 3/2 | (vx, vy) ← (−vy, −vx) |
| `$2D` | y − x = −1/2 | (vx, vy) ← (vy, vx) |

A ball that crosses the line within a cell is reflected without loss and put
back where it was, **including its height** (`$82:ECD7`), then the probe fields
are restored (`$81:87CA`). On the ground the rest of that frame's rolling step
is skipped; in the air gravity still runs (`$82:9015` jumps to `$81:899F`). In
the air the wall only acts on a ball within `$2D41` (half a step) of the ground
(`$82:8FF1`). Verified frame by frame against the game by the web demo's traces
([web-demo.md](web-demo.md)): every side and all four diagonals of hole 1's
outline.

The engine port settled three more details (dis.; its traces and its guide's
ends):
- **`$6AC0` = 2 during play** (`$82:C027`, the shot set-up's driver), so the
  wall always takes the presentation path: restore x, y and z (`$82:ECD7`)
  and the probe fields (`$81:87CA`), and sound 7. The silent path
  (`$6AC0` = 0: x and y, the probe and the heading) is the guide's.
- On the **landing** dispatch the handler ends with the gravity tail
  (`$82:9015`, `JML $81:899F`); on the **rolling** dispatch it just ends the
  step (RTL).
- **Across two cells** (`$82:903D`-`$82:9067`), the move code is the
  current cell minus the previous one, and the line-touch table is read with
  the *current* cell's tile. The guide at aim 214 on web_flow (2563) crosses
  the outline that way, and its end matches the game's only so.

## Two values found by scanning, not dispatch

At course load, `$82:ACBF (0x012CBF)` walks the whole grid row by row looking
for layer-2 byte **`$0C`** (or `$C3`), and records its column, row, cell index
and `elevation + 1`:

```
$ACD2  LDA $8390,X / CMP #$0C / BEQ $ACF9
       CMP #$C3 / BEQ $ACF9
```

`$0C` occurs **exactly once in every one of the 212 hole slots** that has a
layer-2 grid, and always on flat ground (`layer1 == $01`). Storing
elevation + 1 is where something *rests on top of* that cell. This is the
hole's single marked position; `$C3` is accepted by the same scan but appears
in no hole.

Note `$0C` is in the *default* dispatch group, so it has no landing behaviour
— it is purely a load-time marker.

## Actors

The load-time sweep `$82:B320 (0x013320)` visits every cell, and for a
non-zero layer-2 byte looks it up in a 256-entry word table at
**`$82:BDBC (0x013DBC)`**. `$FFFF` means "no actor" and the generic handler
`$82:BD5C` runs instead; otherwise `$82:B3AF` spawns one. The sweep runs
the rows from the top and each row from its last column (`$82:B35D`, DEX),
which is the order of the enemy list ([physics.md](physics.md) "Enemies and
the cup"). Only 48 values map to an actor:

```
$02          -> $0048        $80-$8F -> $004C        $AC -> $0051
$40-$52 $57  -> $0049        $90-$97 -> $004D        $AD -> $0052
                                                     $AE -> $0053
```

**An actor id is a thread object type** (docs/animation.md). `$82:B3AF`
passes it in A, unchanged, to `sub_thread_spawn_below $80:E4B6`, with the
cell's position in X/Y; `$8000` spawns nothing and records the cell only.
So `$0048` is object type 72, `$0049` type 73, `$004C`-`$004D` types 76-77
and `$0051`-`$0053` types 81-83, and their code and sprites are those
types' (`build/sprites/objects/obj_NNN.png`, and from live state
`build/sprites/emu/obj_NNN.png`). Independently confirmed by running all
232 holes (tools/snesstep/holes.py, tools/actorids.py): types 76, 77, 81,
82 and 83 are alive in exactly the holes whose layer 2 holds the matching
actor, an overlap score of 1.000 each.

`$40-$52` and `$57` all map to the *same* actor id, so the layer-2 byte itself
must carry the subtype — the sweep stores it at `$0C` before the lookup. These
20 values occur in **all 212 hole slots**, 2 to 11 per hole (most often 3 or
4), which is the right shape for the per-hole enemies.

The subtype is the species (read 2026-11-15, `$82:B62E`-`$82:B6E3` and type
73's start `$85:9126`; notes/port-v2-phase1-courses.md):
- `$82:B646`: the species is the tile − `$40`, with `$50-$52` folded onto
  `$4D-$4F`, stored in the slot's `$591C` (checked on hole 17's three slots);
- `$82:B730`, once per species, at most 8 a hole: a VRAM slot in first-seen
  order, the species' part lists copied to a fixed WRAM block
  (`$82:B832`[species] → `$82:B802`[species], `$82:B769`) and its tile
  graphics queued (`$82:B8B6`);
- `$85:9220`[species]: its first frame list in `$89:C833`; `$85:9238`[species]:
  its per-frame code (`$932A` for `$40`, `$93AD` `$48`, `$9426` `$49`,
  `$949D` `$4C`, `$952C` for the rest).

All the enemies of one species draw the same block, so they move in step.
`tools/snesstep/trace_enemies.py` records each species' idle animation from
the game (the engine's per-species clips, docs/engine.md):
- `$40`, `$4A`-`$4E` repeat (`$4C`: 8 pictures of 8 frames);
- the ability species `$41`-`$49`, `$4F` and `$57` change pose and pulse
  their colours, and the sequence does not repeat within 400 frames.

## Correlation with the terrain layer

Some layer-2 values are locked to a layer-1 shape:

- `$61`, `$64`-`$6F` mirror the shape byte exactly — `$64` only ever appears
  on shape `$04`, `$65` on `$05`, and so on. The `$60-$6F` group is a surface
  overlay that needs the shape restated.
- `$20`-`$23` sit only on shapes `$04`-`$07`, and `$2A`-`$2D` mostly on the
  diagonal shapes `$10`-`$17`.
- Everything else sits overwhelmingly on flat ground (`$01`).

## Not established

- What the `$60-$6F` overlay *does* to the ball. It is water: a hole that
  has it loads the water's tiles and spawns object 113, which ripples
  palette 4 and plays a splash while the ball sinks (`$69DA`)
  ([courses.md](courses.md) "Per-hole surface graphics"). Kirby's state 19,
  the ball sinking, is entered on it ([animation.md](animation.md)). Its
  handler `$82:80F6` tracks entering and leaving via `$69CA`/`$69D2`-`$69DA`,
  and it appears in 45 holes with 1,807 cells, the second largest group. The
  mechanics are traced, but what the water does to a ball is not established.
- `$1C`, `$1D`, `$58-$5D`: handlers located, not read. (`$14-$17` are
  settled: the arrow panels, above; so are `$B0-$B9`, the warp panels.)
  The engine ports `$1C`/`$1D` from the disassembly as the rough family
  `$82:9342`/`$82:938E` (`engine/src/core/sim/dispatch.ts`); no trace
  exercises them. `$58-$5D` also spawn objects 116-118 at the load
  (`$82:BC59`), whose palette cycles are listed in [courses.md](courses.md).
- The `$70-$7B` family's purpose. Twelve values in four groups of three,
  gated on a toggle at `$6A2A`, two impulse magnitudes (`$80:DDEF` = 4912 and
  `$80:DDF3` = 2456). Only four are used at all: `$74` (166 cells), `$75`
  (54), `$70` (3) and `$71` (2).
- ~~The actor ids~~ -- settled: an actor id is the thread object type
  `$82:B3AF` spawns (see Actors above). ~~Which picture each of the 20
  `$0049` subtypes selects~~ -- settled: the species' own frame lists and
  per-frame code (Actors above). Open: what makes the ability species' run
  irregular (`$85:952C`), `$40`'s other pictures on hole 36, and `$48`'s
  other colours on course 3.
- (Settled: `$28-$2D` are the play-area outline wall, see "The outline wall".)
