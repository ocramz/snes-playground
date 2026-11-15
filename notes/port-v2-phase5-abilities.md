# port_v2 phase 5: the copy abilities

Date: 2026-11-15. Plan: `plans/port_v2_rest_of_game.md` §8 step 5. The
session plan is in `~/.claude/plans/let-s-do-phase-5-indexed-music.md`.

Scope, decided with the user:
- all ten abilities and the machinery they share;
- the presentation full and traced: the transformation, Kirby's ability
  poses and their switch variables, the sounds, every effect object as a
  thread object, the HUD's ability display;
- the references: DEMOPLAY demos 10-19 replayed on holes 160-169, poked
  1P scenarios for the branches the demos miss, and one real take-and-use
  on course 1.
- The 2P-only parts stay for step 9.

This note keeps the measurements. The results go to docs/ as they settle.

## The demos

### The records

`$83:DB2D` reads a long pointer from `$88:C880`[`$ED5D` x 4] (`$ED5D` = row
x 5 + column of DEMOPLAY SELECT's cursor, `$82:F709`). `$83:DA41` copies
the record's words to the addresses of the list `$83:DA7C` (20 of them,
`$FFFF`-ended; X steps with Y, so word i goes to address i):

| word | address | what |
|---|---|---|
| 0 | `$17FF` | 2P (0 in all 20) |
| 1, 2 | `$6A5A`, `$6A5E` | the course and the hole |
| 3, 4 | `$0079`, `$007B` | the random state |
| 5 | `$6A58` | (0 in all) |
| 6, 7 | `$DA90`, `$DA92` | the stocks carried into the hole (0 in all) |
| 8, 9 | `$D7F4`, `$D7F6` | the lives (2; demo 9 and 13: 0) |
| 10, 11 | `$D7F0`, `$D7F2` | the tomatoes (4) |
| 12, 13 | `$D7E0`, `$D7E2` | (demo 10: 3, else 0; not read) |
| 14-19 | `$ECFB`-`$ED05` | (0 in all) |

Then it skips a word, sets `$C8` = 42 (the stream's offset), `$C6` = 1,
`$C0` = 0, and `$6A5C`/`$6A60` = twice the course and the hole.

The stream is (pad, count) word pairs; a count of 0 ends it. tables.json
`demos` (directory + records) and `demoHeader` (tools/export_web.py
`demo_records`). Decoded:

| demo | hole | pairs | ticks |
|---|---|---|---|
| 0-9 | 170-179 | 15-69 | 977-2846 |
| 10 Stone | 161 | 27 | 1481 |
| 11 Parasol | 164 | 21 | 1264 |
| 12 Fireball | 168 | 11 | 547 |
| 13 Needle | 162 | 25 | 1421 |
| 14 Tornado | 167 | 23 | 1010 |
| 15 Wheel | 166 | 17 | 1266 |
| 16 Spark | 163 | 9 | 518 |
| 17 Hi-Jump | 160 | 19 | 1530 |
| 18 Freeze | 165 | 17 | 1132 |
| 19 UFO | 169 | 41 | 2182 |

None carries a stock: each demo takes its enemy on the first shot.

DEMO PLAY sets `$ED5B` = 1 at the menu (`$83:B873`, frame 520), which
selects song 27, the alternate palettes and backdrops (`$80:C967`,
`$80:D82B`, `$80:D6A8`) and the help texts (`$80:8F97` → `$82:F7EE`).

### The demo clock

`$83:DAAA` (stepper `--log-pc`, demo 10 to frame 3700):
- it is called only from `$80:8491`, in the vblank wait `$80:845F`, which
  the frame helper `$80:8F78` calls. 1760 calls of `$83:DAAA` against 1755
  of `$80:8F78`, the extra ones before the hole;
- disarmed (`$C0` = 0) it writes held `$0067` = 0 and leaves `$006B`;
- armed, it keeps `$C4` in `$CC`, counts `$C6` down and at 0 loads the next
  pair (`$83:DAE2`: a count of 0 loads 0 as the pad), then writes held =
  `$C4` and pressed = ¬`$CC` & `$C4`;
- a real A, B or START (`$5F|$61` & `$9080`) ends the demo (`$C0`, `$C2` 0).

So the stream ticks once per vblank wait: every call of the frame helper
`$80:8F78`, every frame of a nested wait on it (a hit-stop, the take's 4
frames, the transformation's 48), and the few frames that wait through the
lighter `$80:8F5B` (demo 10: 2150-2151 and 2846-2847, around the second
and third set-ups). A lag frame does not. test/trace-demos.test.ts ticks
the ROM's decoded record once per recorded `$80:845F` from the arm and
gets the game's `$0067`/`$006B` on every tick of all ten demos (the ticks
followed by a lag frame excepted, where the NMI writes the real pad
first). In demo 10 the calls stop 17 times; the long
stops (1091-1693 and 2898-3319) are the help texts: `$82:F7EE`, called
from the frame helper while `$ED5B` is set, spins on `$004E` at
`$82:F84C` until a timer or a button, with no thread, no physics and no
tick (a watch of every thread's frame index and the random state shows no
write in 1092-1690). The engine does not play them.

The arm (`$82:B2E7`, `$C0` = 1) comes right before the first aim iteration
of the hole: demo 10 at 1027 line 238, the first aim (`$81:A804` state 4)
at 1029 line 197. Demo 19 alone waits 97 iterations between them, in the
set-up loop `$80:F316` on `$697E`: type 73's hovering enemies count
themselves in at their spawn (`$85:918D`) and out once settled
(`$85:92E1`/`$92F1`).

Every demo's B press activated its ability, the trigger seeing it one
frame after the stream wrote it:

| demo | B (frame) | the trigger | the end (holed) |
|---|---|---|---|
| 10 | 2017, 2539, 3565 | 2018, 2540, 3566 | 3870 |
| 11 | 2142, 3033 | 2143, 3034 | 3339 |
| 12 | 2185 | 2186 | 2643 |
| 13 | 2061, 3110 | 2062, 3111 | 3648 |
| 14 | 1943 | 1944 | 2741 |
| 15 | 1921, 3334 | 1922, 3335 | 3699 |
| 16 | 2154 | 2155 | 2380 |
| 17 | 2003, 3607 | 2004, 3608 | 3922 |
| 18 | 1954, 3199 | 1955, 3200 | 3450 |
| 19 | 2077, 3850 | 2078, 3851 | (4358, not holed) |

The stream ends with each hole-out (`$C0` cleared 2 frames after the
ball is holed); demo 19's at 4360.

### Playing a recording back

A first harness fed the stream on the engine's iterations everywhere. It
lost the shot's A presses: between the aim's A and the curl the game lags
twice (demo 10: frames 1736-1739), which the engine models as plain
frames of the pan, so the engine's iteration count ran 2 ahead and the
spin stage's A came before the stage took presses.

The harness that works (engine/test/demo-harness.ts `playRecording`) plays
the pad the game read (trace_flow.py `pad`/`padp`, with their scanlines)
on two clocks, re-anchored at every shot:
- **set-up to launch: video frames.** The engine is frame-exact there (the
  flow tests' constant offset). Engine frame f_s + n reads the game's pad
  at frame F_s + n, f_s and F_s being the shot's first aim iteration.
- **the roll: iterations.** One physics step per roll iteration in both,
  and one frame-helper call per frame of a nested wait. The engine's
  iteration k from the roll's start reads what the game's body r_s + k
  read, r_s being the body of the shot's first trigger read (`$82:C880`).
  An engine frame is not an iteration when it idles in the guide's or the
  APU's lag, or in the cup reveal's decompression (`TomatoQueue.hold`):
  `core/demo.ts isIterationFrame`. Without the last, demos 11 and 16 ran
  3 iterations late after their take.

With it, all ten demos match up to their first activation: every ball
state in order, Kirby's states at the game's frames
(test/trace-demos.test.ts).

## The crest's edge crossings `$81:9831`

Demos 12 and 13 roll off flat ground onto a falling ramp across a cell
edge, which the port did not launch from (`$81:980B`'s crossing branches
were unported, survey §1). Read and ported (sim/roll.ts `crestTest`):

- `$6A78` (the crossing type, 0-7; 8 and up hang at `$81:9834`) picks a
  list of quadrant samples:
  - types 0-3 by (old quadrant `$DA22` x 4 + new `$DA02`) x 2 into
    `$81:985D`, `$988F`, `$98C1`, `$98F3` (16 words each; 0 where the pair
    cannot occur);
  - types 4-7 one of two lists by the corner's pick `$6A74` (the first
    when it is 0, 1, 2, 0): `$9AF5`/`$9AFF`, `$9B09`/`$9B13`,
    `$9B1D`/`$9B27`, `$9B31`/`$9B3B`.
- A list (`$81:9A0D`-`$9B44`) is words: the quadrant, and the cell by a
  selector byte (2 the old cell `$DA1C`, 4 the new `$D9FC`, 8 the corner's
  `$6A76`), ended by `$FFFF`.
- `$81:9964` walks consecutive pairs. In one cell (the selectors share a
  bit), the codes differ on a shape with the crest flag (`$81:9B45`). Across
  a boundary, `$81:9C3D`[code1 x 36 + quadrant1 x 9 + code2] is non-zero
  (`$9C23` and `$9C35` are the multiples). The first such pair launches,
  from the pair's first code (`$9A08`: `$6A7A` + 1, SEC).

tables.json `crestCross`, `crestDiag`, `crestLists`, `crestStep`.

## Found on the way: the rough `$04` and the kickers `$10-$13`

The read of the mode gates (every `$D9C8` read in banks `$80-$87`, a byte
scan: 128 hits) turned up three ports that no trace covered. Each is now
traced on its own scenario (test/trace-terrain.test.ts).

**The rough `$04`** (`$82:8EFB` land, `$82:8F30` hit, `$82:8F4E`):
- X = `$80:DDF5`/`$80:DE21`[mode] (0 or 2) is a **byte** offset into three
  2-word tables (`$80:DD71` friction, `$DD75` dampXY, `$DD79` dampZ). Mode
  0 reads `$6800`/`$6665`/`$20C4`; the engine read `[2]` of each, the
  next table's words.
- Neither side tests the mode (the engine skipped mode `$0A`).
- The land side's tail sound (`$82:8F17`): `$5F` at vz 0, none for vz in
  [`$FC00`, `$FFFF`] (`BCS $8F2C`), else `$60`. The engine played `$5F` there.
- `LDY $D9C8 / CMP #5 / LSR` at `$82:8F53` compares the friction just
  loaded, never 5: the halving never runs.
- Scenarios: web_rough_roll / _land / _soft / _hard (course 2 hole 4,
  index 11, the rough at (2,14); web_haz94's input, pokes at 2455).

**The kickers** (`$82:A7DD` land, `$82:A88C` hit):
- Land: X = 0, or 2 in mode 6 (`$DA3A` = `$0100`), again a byte offset:
  the bounds are `$80:DDE3`/`$DDE5`[X / 2] (25 / 200, or 200 / 6). The kick
  is vz x the **signed** low byte of the first (`$80:A342`; `$C8` is -56),
  read at `$389F`; at or over the second (unsigned) it is the first. The
  tile's jump (`SEC / SBC #$10 / CMP #4 / ASL`) leaves the carry clear, so
  the push is v + kick or v - kick - 1, by `$82:A843`: `$10` vy -, `$11` vx
  +, `$12` vy +, `$13` vx - (the engine had the axes and the signs of `$10`
  and `$12`-`$13` wrong, and a carry from the compare).
- Hit (`$82:A88C`, not ported before: the engine applied the landing's
  push): with the ball moving, `$82:A90F` folds the angle between the
  heading and the kicker's (`$10` 270, `$11` 0, `$12` 90, `$13` 180) to
  0-180; the push is angle x `$58` >> 8 with the friction `$1000`, or
  `$1800` and the push capped at `$70` for an angle in [`$17`, `$9D`);
  Wheel (mode 6) angle x `$18` >> 8 and `$0100`; Parasol (mode 2) adds the
  old friction. Halved when the ball runs against the kicker. Then the
  heading and the roll.
- Scenarios: web_kicker_roll / _land / _side (course 3 hole 2, index 17,
  the kicker rows 24-27; web_boost's input, pokes at 2463).

**The rolling step hit** (`$81:8A34`): in any mode but 0 and 7 it launches
the ball (`BRA $8A44` → loc_launch `$81:8B78`) instead of the 2-frame stop
(grabbed by the group-A read: web_step with the mode poked to 8 and 9
launches at 2503).

**The ability enemy's take** (`$82:8A4F`-`$8A96`): it writes the stock to
the work copy `$D9C4` and the block `$D852`, clears the latch `$D9CA`, plays
`$50`, waits 4 frames (`$80:8FB6`), clears the latch again and only then
takes the enemy (`$82:8A98`: the owner, the stars, the tomato +1, the cup).
The engine now stops the step between the two halves (`take-enemy`,
`take-enemy-finish`); the reveal no longer adds the 4 frames to its lead.
An ordinary enemy writes `$D862,Y` = `$1E` and plays `$4F`: the HUD's draw
shows the face `$93:9200` for those 30 ticks (below).

## The references

**The poked scenarios** (engine/test/ability-scenarios.ts, 11 of them): a
course hole's weak shot, the ball poked at the roll's first frame with a
stock (`$D852`) and B on the poke's frame. The game lags about 5 frames
after a poke, so their sounds are compared on the iteration clock
(Scenario `clock: 'iteration'`: a request's body, the first frame-helper
call at or after it, counted from the poke's; the engine's lag frames do
not count), ±1.

**The take-and-use** web_ab_c1 (course 1 hole 3, ROM index 2, unpoked but
the hole): shot 1 aimed 98 frames right of the set-up's 225 takes the `$48`
at (6,7) (the game 2697, the stock); a B before it, with no stock, does
nothing. Shot 2 at the set-up's aim: B at 3050, the trigger at 3051, the
relaunch; a second B (3090) is refused by the latch. Shot 3: the set-up
reset the latch (3560), the stock is kept, B again (3711). Frame-exact with
no poke (`clock: 'frame'`): ball states, the four ability words, the sounds,
Kirby's colours and the HUD's icon. A held direction in shot 2 was
dropped: the game turned the aim every 2 frames where the engine's guide
lag gave 3 (the guide's lag is the engine's estimate, docs/engine.md).

**The ability words in trace_ball.py** (`stock`/`worn`/`mode`/`latch`,
`$D852`-`$D85E`): the store writes them first (`$82:F17A`-`F18F`), before
the position words that open a burst, so a record takes them at its burst's
last block write: the block as that store left it. Two writers sit outside
a store: the trigger's `$82:C8C2`/`$C8C5` (worn and mode, after the store:
in the next record) and the hazard reaction's `$82:DBBB` (the hit code,
after the store; `$14`'s is gone by the next store, web_ab_ufo_bumper 2557).
Only `$82:F18F` writes `$D85E` besides the set-up's `$80:C541` and
`$80:C747` (a byte scan of the ROM).

## Kirby's colours (trace_flow.py `pal`, `pal3`-`pal6`, `outline`, `pal8`)

**The transformation's flash** (state 8's script, demos 10-19 and
web_ab_c1, every activation): black (`$98:CC26`, colours 2-6 0) at the
script's tick 4, set 3 at 8, black at 12; then the second set, black, the
second set at S, S + 4, S + 8: S = 36, Spark 28, the UFO 24. The second
set is set 3, Spark's first (`$98:C86E`, colour 8 `$7FFF`), Freeze's
(`$98:C916`, colours 2-7). The engine's state 8 leads the game's by a
frame: the flash runs on its script tick + 2.

**The outline** (`$84:99FA`, the HUD object's draw, every tick): `$84:9DDB`
is read as a word to wrap (`LDA $9DDB,X / BPL`), so the phase wraps when
the next byte is the `$FF`: a 41-tick cycle (demo 10: 40 → 0). The HUD
object is slot 8 in the demos (type 14 at `$4E2C`, demo 10 frame 863) and
slot 10 in a course played from the map (`$4E30`, web_ab_c1 2169):
trace_flow.py watches both (`hudo`/`hudi`, `hudo10`/`hudi10`). The phases
stop with the threads in the help texts and in the guide's lag: the colour
test puts them back where the game's are and counts the frames (under 5%).

**The ends.** The shot's end at the turn top (`$80:F445`: `$D76C` + 1, the
frost's set 3: demo 18 2512 → 2513) and the hole-out (`$80:F48C`: `$D76C`
+ 1, palette set 2 at `$80:F495`, which loads Kirby's set 3: demo 12 2645,
Fireball's last fade `$2C9A` until then). `$80:F445`'s `$D76C` + 1 also
ends Spark's and Freeze's objects at the turn's end.

**Not ported:** the power stage's glow (`$84:CBBE` → `$80:D3AD`, set 3
back at `$81:C07F`): Kirby's colours 2-6 darken and colour 7 blinks `$0018`
between the curl and the roll (demo 10 1822-1899). The colour test skips
each shot's curl-to-roll window.

## The HUD's icon (`$84:9B0F`, trace_flow.py `uploads`: `$80:8696` from bank $84)

`$6AC0` (what the icon shows for stock 0): 1 from the shot thread's start
(`$81:BE97`), 2 in the roll (`$82:C027`), 0 at the roll's end (`$80:F371`),
the turn's (`$80:F3CA`, `$F448`), the aim's head (`$81:A619`), `$81:A815`,
`$81:A9BB`, `$81:C0A2` (a byte scan). Uploads in demo 10: 1739 (`$6AC0` →
1), 1904 (→ 2: the ball), 1929 (the take), 2066 (the latch spent, at the
store after the 48 frames), 2120 (→ 0), 2152 (the set-up's latch reset), …
The descriptors (`$84:9E07`, …) are 8-byte entries `[flag][size][source,
3 bytes][VRAM word]`, `$FF`-ended: `$84:9EBC` = `$8C:CC78` → `$7A00`,
`$8C:CD78` → `$7B00`.

The UFO's countdown (`$84:A4E6`, object 49's per-frame): the UFO's picture
and the seconds left alternate (`$84:A5AC`: 30-tick halves ×12, 15 ×8, 8/7
×8), sfx `$42` with each digit (returns to `$84:A553`), held through the
cup's reveal (demo 19 2457 → 2730: the take at 2484).

## The objects (trace_actors.py over demos 10-19)

Every object of types 21, 27, 28, 30/31, 32, 33, 35, 37/38/39, 52, 65, 66
matches the game's slots (frame index, point, end) within a frame;
the followers that loop on Kirby (27, 33, 37, 66) over their first 120
frames: later a tick lost to the cup reveal's decompression shifts their
cycle by one. Object 21 sits at Kirby's point of the iteration before the
trigger's (demo 10 2017 at 2016's: `$D972`/`$D97A`, the last store's
copies). The flames (32) take Kirby's point at each 10-tick cycle's start.

**Not ported:** the overlays drawn in Kirby's OAM pass (`$6A98`-`$6AA4`):
object 49's saucer (its poses' VRAM blocks `$85:AFE6` not decoded) and
object 51's canopy (`$89:A144`/`$A165`); Kirby's frame index `$D95E` /
`$0B7E` (the parasol's 6/7, the UFO's set-up); objects 34, 42-45 (tile
`$04` dust), 44 and 60 (never seen in the demos); the 52 puff at the
parasol's end.

## The sounds of the objects and the scripts

Ported into core (they are timed with the threads): object 49's hum `$75`
every 10 ticks (`$85:AE17`), `$73` at `$D77A` = 1 (`$85:AE2A`), `$74`
wearing off (`$85:AE52`), sound 0 and `$21` 4 ticks apart once holed
(`$85:AE8C`); the countdown's `$42` (`$84:A553`); Kirby's state-29 script's
`$44` (the parasol opens, its tick 6; the script's sound op returns to
`$87:8576` for every script, so the tests take that caller with id `$44`
only). All match the demos within a frame.
