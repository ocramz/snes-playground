# port_v2 phase 6: the switches `$5A-$5D` and the swirls `$70-$7B`

Date: 2026-11-15. Plan: `plans/port_v2_rest_of_game.md` §8 step 6. The
session plan is in `~/.claude/plans/let-s-do-phase-6-linear-pony.md`.

The scope was decided with the user:
- `$5A`/`$5B`, the swirls `$70-$7B` and `$5C`/`$5D`, exact and traced, with
  their presentation: the switches' tiles and colours, object 127's tiles,
  and the water's dissolve.
- `$58`/`$59` and the 2P branches are left for step 9. `$58` occurs only on
  the 2P holes 132-143 and 196-207, and `$59` on no hole.

The results are in:
- docs/tiles.md "Swirls", "The toggles' switch" and "The water switch";
- docs/courses.md "The switches' objects";
- docs/animation.md (objects 117, 118 and 127);
- docs/engine.md.

This note keeps the read and the measurements.

## The read

`tools/dis65816.py '$82:9EF9' --length 0x660 --m16 --x16` covers every
handler. The other routines read:
- `$82:BBAE` and `$82:BC59`, the load;
- `$80:D7B5`, the switches' tiles;
- `$80:9120`, `$80:9208` and `$80:9304`, the dissolve;
- objects 116-118 at `$84:8586`-`$84:86C7`;
- object 127 at `$84:DB6A`-`$84:DC41`, with its lists `$84:DC42`/`DC4D`/`DC58`;
- object 113's hook `$84:8533`.

The 1P holes are:

| hole | tiles | at the load |
|---|---|---|
| 7 (course 1 hole 8) | `$5C` (4,10) | water on |
| 10 (2 h3) | `$5B` (10,9), 7 × `$75` | `$6A2A` = 1 |
| 19 (3 h4) | `$5B`, `$74`, `$75` | 1 |
| 23 (3 h8) | `$5D` (10,6) | water off |
| 25 (4 h2) | `$5A` (8,6), 3 × `$74` | `$6A2A` = 0 |
| 26 (4 h3) | `$5B`, 3 × `$74` | 1 |
| 43 (6 h4) | `$5B`, `$74`, `$75` | 1 |

The read held two surprises.

**The swirls' push goes round the centre.** `$82:A111` takes the heading
of the ball from the cell's centre (`$80:A4C1` of xf^`$8000`, yf^`$8000`).
It pushes by (−sin, cos) of that heading, which is the heading turned 90
degrees, scaled by the Manhattan distance |dx| + |dy| (`$80:A367`). Bit 0
of the tile picks the way round. The tiles.md entry "toggled directional
impulse" was wrong about this.

**The hit side's magnitude is the disc's byte.** `$82:9F5D` keeps the
magnitude (`$80:DDED` or `$DDF1`) in `$B6`, and the disc test `$82:A086`
overwrites `$B6` with its bitmap byte (`$82:A0C7`). The handler reloads
`$B6`, so a ball rolling through is pushed with $FF in the disc's
interior, less on its rim. The strong and the weak tiles push alike.
- Found by the trace: web_sw_toggle_roll's first push was −2, where the
  constant gives −630.
- Measured with `--log-pc '$82:A111'` (A = 7, then $FF on every frame).
- The land side keeps its magnitude in `$00`, which the disc test does not
  touch, so `$80:DDEF`/`$DDF3` act there.

Smaller points:
- **Strictly below.** The swirls' and the switch's land sides test z <
  ground (`CMP` then `BCS`). The water switch's and `$58`'s test ground ≥ z.
- **Windows.** The switch's gate `$82:A1FD` is [`$4000`, `$BFFF`] (a signed
  `SBC`/`BMI`). The water switch's `$82:A540` is [`$4800`, `$B800`). `$58`'s
  `$82:A385` is [`$4800`, `$B7FF`).
- **The modes.**
  - Land: 3 and 6 are immune and 5 halves.
  - Hit: 3, 6 and `$0A` are immune and 5 halves.
  - After a hit push, modes 1, 2, 4 and `$10` RTL, with no roll that step.
  - All of this is ported as read; untraced.
- **The water switch's two records are the same bytes**
  (`$94:E5BB` = `$94:E7BB`), so only object 118's colours show its state.
  The toggles' switch's differ in 24 bytes (`$94:E1BB` set, `$94:E2BB` clear).
- **Object 127 animates the whole floor on hole 10.** Its 14 tiles at VRAM
  `$3000` are tiles `$300-$30D`, palette 7. Hole 10 draws all 134 of its
  checkerboard cells with them (`--snap-at` 2496-2508, `ppu_render.py`).
  Hole 25 draws 60 of its cells with them. So while the swirls are on, the
  floor's squares turn. Holes 19, 26 and 43 use them too.
- **`$58`/`$59`** (`$82:A25D` land, `$82:A2F5` hit), read but not ported:
  - a cup-like cell: the window `$A385`, `$6A32` "in", and 3 uses in `$6A3A`;
  - a fall into it at vz ≥ `$FDC0`, or in modes 2 or `$0A`;
  - `$82:A335` flips `$6A2E` (the alternate palette tables) with a sequence:
    sfx `$6A`, `$80:CBF9` 2, 10 frames, object 101 at (`$F8`, `$90`), a wait
    for `$6A30`, tileset 1, palette set `$14`, 16 frames;
  - `$82:BC59` sets `$6A2E` for `$59` without `$58` and spawns object 116.

## The scenarios

`tools/snesstep/inputs/web_sw_*.txt` + `.pokes`, made as web_snap's were:
- the hole is picked at 2050 (`$6A5A`/`$6A5C`/`$6A5E`);
- A is pressed at 2360/2437/2444;
- the ball's block is poked at 2468;
- the offset is the first set-up `aim` minus 2.

The z pokes are `heightZ(elev + 1)`: (7,6) of hole 26 at elevation 4 is
`$1_C48A`.

| script | hole | offset | what the game did |
|---|---|---|---|
| web_sw_switch_roll | 10 | 2333 | swirled across (12,9) and (11,9); the flip at 2522 (line 248, `$6A2A` 1 → 0), `$6B` from `$82:A199`; the latch cleared at 2543 (xf < `$4000`) |
| web_sw_switch_land | 25 | 2337 | landed inside the gate at 2486, the flip (0 → 1) and `$6B` from `$82:A1E5`, then the landing's hit-stop (2486-2490); the latch cleared in the air at 2506 |
| web_sw_toggle_roll | 10 | 2333 | north through (11,9) at xf `$7000`: −2, −64, −125, … in x (the byte, below) |
| web_sw_toggle_land | 10 | 2333 | landed in (12,13) at 2482: (245, 0) → (456, −274), the strong land push (4912), then the hit side's |
| web_sw_toggle_pull | 26 | 2337 | east through (7,6): the `$74` turns it the other way |
| web_sw_toggle_off | 25 | 2337 | north through (7,8) with `$6A2A` = 0: straight |
| web_sw_water_drain | 7 | 2338 | rolled into the window at 2527: `$69CA` = 1, sounds `$6A` and `$4A` (lines 249, 250); the step's store resumes at iteration 2591; then down through the dry pond (2-5, 13-16) |
| web_sw_water_fill | 23 | 2339 | a landing at vz −4544 at 2478: `$D7D4` = 12 and `$6A70` = 1 (no hit-stop), `$69CA` = 0, `$6A` and `$4B`; the store resumes at 2542; Kirby stays squashed until the water's 14 at 2606; the ball sinks in (8,6) at 2593 |

A mid-roll poke was tried and dropped. A second poke at 2640 in
web_sw_switch_roll left the block half overwritten: the cells were poked,
but the fractions and velocities were the step's. The store that ends
iteration F lands after the vblank poke of F.

### The block

`iters_web_sw_water_drain.json` shows the frame helper `$80:8F78` called
once a frame, 2528-2591. These are the 64 one-frame waits of `$80:8FB6`.
The first call comes at line 91, after `$80:9120`'s buffer copy. The
step's rest and the store run in iteration 2591 = 2527 + 64, and the
main loop's own call follows at 2592. During the block:
- the threads run;
- object 118 is reset at 2528, line 125 (the first helper call);
- object 113's ripple stops;
- the HUD's icon goes on;
- the camera and Kirby's projection do not move.

### The VRAM

`tools/check_switch_gfx.py` takes `--snap-at` snapshots of the scenarios and
compares `vram_post.bin` with the model (`coursemap.hole_page`, the
dissolve's order). It finds no differences in:
- the toggles' switch's tiles at `$3280` before and after the flip;
- object 127's frame at `$3000`, by its last upload;
- the water's 44 tiles at `$1800` after 0, 1, 2, 20, 21, 40, 63 and 64
  steps, for both the drain and the fill;
- hole 23's zero fill at the load.

Step k is in the NMI after frame 2528 + k (drain). So `vram_post` of 2529
has one step.

### The colours

trace_flow.py watches CGRAM 78 (`sw117`) and 94 (`sw118`), the colours
that differ between the two sets. Object 117 writes:
- `$35BB`/`$4E7C` while `$6A2A` is set;
- `$0013`/`$2957` while it is clear, from the flip's iteration (2522 → 2523
  line 45 = iteration 2522), then every 4 frames.

Object 118 writes:
- `$38C4`/`$4927` while the water is off;
- `$6D48`/`$7230` while it is on.

## The engine

- `core/sim/switches.ts` holds the kernels. `core/systems/switches.ts`
  holds the step entry `switches` (the sounds, the squash, the
  `waterSwitch` stall of 64 frames) and the thread tick's objects 113
  (its clock), 117, 118 and 127.
- `core/traits/switches.ts` is the views' state.
- `$6A2A`, `$6A2C` and `$69CA` are in `BallWork`. `KernelCourse.waterOff`
  is gone, and its readers (the water, the guide, the probe wrapper and
  Freeze) read `w.waterOff`.
- In the exporter:
  - `coursemap.switch_state`, and `hole_page`'s `toggle`/`water`/`swirls`;
  - export_web's overlays `<stem>_{toggle,water}sw<state><set>` and
    `<stem>_swirl<list>_<frame>`;
  - on a water switch's hole, dry layers with `<stem>_water` and
    `<stem>_dissolve` (`dissolve_map`).
- `game/features/layers/switch-layers.ts` draws them. The water and the
  ripple's sets are canvases masked by `dissolve.ts`.
- The tables: `toggleDisc` (521 bytes), `swirlWaits`,
  `toggleSwitchColours`, `waterSwitchColours` and `dissolveOrder`, and the
  four magnitudes. `toggleImpulseBig`/`Small` were misnamed and are gone.
  The handler names are `switch`, `waterSwitch` and `switch58`.

The tests:
- `test/switch-scenarios.ts` (in trace-terrain): the ball states and the
  sounds of all eight.
- `test/switches.test.ts`, on the iteration clock:
  - `$6A2A`, `$6A2C` and `$69CA`, which the step writes;
  - objects 117 and 118's colours, and object 127's frames, each set to the
    game's phase at the poke (the load's phase is not reproduced);
  - `$D7D4` in the two water scenarios;
  - the block: 64 iterations, step k on F + k, the step resumed on F + 64.
- The disc and the dissolve's mask, as units.
- `test/e2e/switch.mjs`.

The result: 673 tests pass, and so do the e2e pages.

After it, the tally (the plan's appendix, with `switch58` and `roulette`
blocking) gives:

| holes | clean | blocked |
|---|---|---|
| 1P | 64 | 0 |
| extra | 64 | 0 |
| 2P | 13 | 19 |
| demos | 20 | 0 |
| 192-223 | 9 | 23 |

## Not done

- `$58`/`$59`, object 116, `$6A2E`'s tables, and the 2P branches
  (`$82:A20E`: the other ball on a swirl; `$82:A474`: the other ball's water
  state, its palette set 4).
- The phases of objects 117, 118 and 127 at the hole's start. The objects
  start at the load, and the engine starts them on its first frame.
- A dissolve over two stacked water tiles. The view has one water picture
  per layer, the topmost tile's.
- At the end of web_sw_water_drain (after 2880, the next set-up), object
  118's phase is one tick off. That is outside the ball's window and not
  traced.
