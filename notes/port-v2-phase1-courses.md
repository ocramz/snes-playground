# port_v2 phase 1: every 1P course in the engine

Date: 2026-11-15. Plan: `plans/port_v2_rest_of_game.md` §8 step 1, "generalise
the hole loading per course". The session plan is in
`~/.claude/plans/let-s-do-phase-1-goofy-plum.md`.

Scope, decided with the user:
- ROM holes 0-63 (courses 1-8) exported and offered in the menu;
- per-hole songs, per-species enemy idle clips (measured), per-course palettes and their cycles;
- the hazard frame tables by spawn tile, the boost panels' hum, object 111's second colour cycle.

## Step 0: measurements

Every run below is `build/snesstep/release/snesstep` through
`tools/snesstep/inputs/play_hole1.txt`, the hole picked by pokes at 2050, as
`tools/snesstep/holes.py` does.

### The course slot `$6A5C` must be poked too

`--poke 2050:$7E:6A5A=<course>` alone leaves `$6A5C` at 0:
- `--watch-write '$7E:6A5C-$7E:6A5D'` on course 3 hole 2 shows the map's
  cursor loop writing it at `$81:C965`, then `$81:FB91` resetting it to 0 at
  frame 1180, long before the poke;
- the snapshot at 2300 reads `$6A5A` = 2 and `$6A5C` = 0.

Every run that picks the course on the map has `$6A5C` = 2 × course. That holds across every
`wram.bin` under `build/emu/autoplay/{game,game2,game4,extra}` for courses
0-15, and in `two_player` for course 16. The poked runs (`course2`, `c8h8`,
`h13`, `h37`, `h63`, and every `holes.py` run) have 0.

So **the poked runs play course 1's song list and course 1's ripple
colours** (`$84:84AF`[`$6A5C`]), whatever course they load:
- `build/emu/holes/screens/` and `build/sprites/emu` were recorded that way;
- the BG3 scenery and the per-course BG palettes are indexed by `$6A5A`, so they are right in those runs.

The tools below poke `$6A5C` = 2 × course as well.

### 1. The hole songs

Log `--log-pc '$80:C999'` (the `JML $80:B4AC` with the request in A), with
`$6A5C` poked. Holes 4, 5 and 8 of courses 2-8, at frames 2168-2198:

| course | hole 4 | hole 5 | hole 8 |
|---|---|---|---|
| 2 | 6 | 6 | 13 |
| 3 | 11 | 11 | 13 |
| 4 | 14 | 14 | 13 |
| 5 | 10 | 8 | 13 |
| 6 | 9 | 9 | 13 |
| 7 | 11 | 6 | 13 |
| 8 | 12 | 12 | 13 |

Each song is requested twice, about 13 frames apart, as on course 1. Without the `$6A5C`
poke every one of these is course 1's (11, 7, 13).

**The whole game.** `build/emu/autoplay/game` was replayed for 186000 frames
with `--log-pc '$80:C999'`. There the courses are picked on the map, with no `$6A5C` poke.
Its 64 holes request exactly the lists of the plan's table:
- 11 11 11 11 7 7 7 13;
- 6×7 13; 11×7 13; 14×7 13;
- 10 10 10 10 8 8 8 13;
- 9×7 13;
- 10 10 11 11 6 6 6 13;
- 12×7 13.

The first request of each hole is at frames 2169, 4009 … 108364.

### 2. The BG palette in play: the exporter is wrong outside course 1

The new tool `tools/check_hole_palette.py` compares the snapshot's
`cgram_post.bin` at 2300 with `coursemap.hole_palette`. Before the fix:
- the BG palettes 2, 3, 5 and 7 differ on every course but 1 (55-71 colours a hole);
- on course 1, only colours 54 and 118 differ, apart from BG3.

`--log-pc '$80:90C8'` (`sub_cgram_partial`: A bytes, X source in bank `$98`,
Y the CGRAM index) and `--watch-write '$7E:0400-$7E:04FF'` (the CGRAM
staging buffer) give the load order at the hole's start:

1. `$80:D36B`: `MVN` of `$98:C000` to `$0400`, all 512 bytes (frame 2155).
2. `$82:BC91` → `$80:D2FE`: the scenery, `$80:D517`[`$6A5A` & 7], **`$28`
   bytes = 20 colours** to CGRAM 0. `coursemap.BG3_PALETTE_COLOURS` = 40
   read it as 40 colours.
3. `$83:AA24`: `$98:CE48`, 12 colours to CGRAM 20 (BG3 palettes 5-7, the HUD).
4. `$82:BC9C` → `$80:D82B`[`$6A2E`]: the per-course list.
   - Entry 0 (`$80:D839`) takes `$80:DA0D` if `$ED5B` is set, else `$80:D869`[`$6A5A`].
   - The list is run by `$80:90E7`: words (bytes, source, CGRAM index) … `$FF`.
   - Every course's list has 5 runs: 8 colours to `$27`, 13 to `$32`, 8 to `$51`, 9 to `$61` and 13 to `$72`.
   - Course 1's list is at `$80:D8ED` → `$98:DF64`, and each course adds `$120`.
   - It equals `$98:C000` except colours 54 and 118 (`$51D2` instead of 0).
   - `$80:D869` (34 words): courses 0-7 `D8ED` … `D9CD`; 8-13 repeat 0-5; 14-15 `D9ED`; 16-29 repeat; 30-31 `D9ED`; then `DA0D DA2D`.
   - Entry 1 (`$80:D851`, when `$6A2E` is set) is the alternate: `$DB4D` with `$ED5B`, else another table. Not modelled.

That model (C000, then 2, 3 and 4) equals the snapshot's CGRAM 0-127 on
holes 0-7, 9, 12, 17, 20, 25, 33, 41, 49, 57 and 63, except the entries an
object cycles (below).

### The palette cycles in play

These were inventoried with `--watch-write '$7E:0400-$7E:04FF'` from 2190 to 2700 on hole 2 of every course,
with the writers' hooks read from `$80:E3A3`, where A = `$509C`,X.

| object | spawned by | colours | sets | step |
|---|---|---|---|---|
| 111 `$84:8160` | always | 127 (pal 7 c15) | the outline walk `$98:D3E6` | 3 frames (ported) |
| 111, hook `$84:81B7` (writes at `$84:81E6`) | always | 113 (pal 7 c1) | `$98:D4C8` = `0019 18D7 253B 295E`, order 1 2 3 2 1 0 | **6 frames** |
| 112 `$84:876C` | `$82:BCD7`: any `$30-$3B` | 65-68 (pal 4 c1-4) | `$98:C200 C208 C210 C218` in that order (C200 = the base) | **4 frames** |
| 113 `$84:8293` | `$82:BCD7`: any `$60-$6F`, no boost | 65-71 (pal 4 c1-7) | `$84:84AF`[`$6A5C`] + 0, `$0E`, 0, `$1C` | 8 frames (ported) |
| 114 `$84:8258` | `$82:BD29`: any `$B0-$B9`, no snap | 107-111 (pal 6 c11-15) | `$98:DCDA DCE4 DCEE DCD0` (`$84:828B`, from phase 1) | **8 frames** |
| 115 `$84:8253` | `$82:BD29`: any `$18-$1B` | 107-111 | the same | **4 frames** |
| 116-118 `$84:8586/85FB/864C` | `$82:BC59`: the counts of `$58/$59`, `$5A/$5B`, `$5C/$5D` | 118: pal 4 or 5 c12-15, 2 sets every 4 frames (`$84:869D`) | `$D57A`/`$D58A` by `$69CA` | not ported (the `$58-$5D` tiles) |
| `$84:CF31` (scenery) | courses 2 and 5 | BG3 1, 2, 5, 6, 11, 15, 19 | — | not ported |
| `$84:D072` (scenery) | course 8 | BG3 9-11 | `$98:C630`, +6 … | not ported |

Notes on the cycles:
- **Steps,** measured from the write frames (gaps, most common first, with the game's lag frames):
  - hole 17: boost 4 (70×), 5, 3; glow 6 (65×);
  - hole 12: water 8 (47×), 9;
  - hole 3: warp 8 (27×), 9, 7;
  - hole 29: snap 4 (72×).
  - Object 112's `JSL $80:E445` with A = 3 resumes 4 frames on, as the scheduler rule says. courses.md's "3 frames each" was the yield, not the step.
- **The glow on hole 0,** from 2180: 18D7 253B 295E 253B 18D7 0019 18D7 …
  - `$98:C000`[113] is `03E0`, which shows only before the first write.
- **The warps' sets**, first written at 2184 (hole 3):
  - DCDA `235A 0014 1C96 415A 69EE`;
  - then DCE4, DCEE, DCD0, …
  - `$98:C000`[107-111] (`3273 36B5 3F39 43FF 251A`) is none of them, so the exported holes with warps (course 1 holes 4, 6 and 8 among them) show colours the game never shows in play.
- **`$82:BC59`** also sets `$6A2E` (no `$58` but some `$59`), `$6A2A` (no `$5A` but some `$5B`) and `$69CA` (no `$5C` but some `$5D`). So `$6A2E`, the alternate palette tables' flag, belongs to the `$58/$59` tiles.

### 3-5. Ripple, boost, glow

The tables above cover them. The ripple on course 2 (hole 12) steps every 8 frames like course 1's.

### 6. The boost hum, `$84:87D4`

Object 112's per-frame hook (`$509C`), every frame while the object lives:

```
if $6A28 == 0: return
if $30 <= $DA0A < $3C and $D9C8 != 5:
    if counter == 0:
        $80:B5F4 A=$82      ; music volume $82 ($1003 and APU port $2142)
        $80:B542 A=$15      ; sound $15
        counter = $22
    counter -= 1            ; fires every 34 frames
else:
    $80:B5F4 A=$FF          ; full volume
    $80:B542 A=0            ; stop the effects
    $6A28 = 0; counter = 0
```

The counter is `$531C`, cleared at spawn together with `$6A28`
(`$84:8778`-`$84:877E`). `$80:B5F4` stores A in `$1003` and writes APU port
`$2142`; the hole-out uses it with 0 (audio.md).

### The boost panels' rolling handlers

The engine's port of `$82:9CBF`/`9CFC`/`9D39`/`9D76` did not match the ROM:
- S and W had their axes swapped;
- the small push went to the other component, with the ball's sign;
- the launch took the ball's sign instead of the panel's;
- it lacked the |axis| < 1024 test, the `$D9D0` clear and the handler's `RTL`.

`$6A28` was set only on the launch and never cleared. Read again and ported (docs/tiles.md "Boost panels"). Two poked scenarios on hole 17 pin it:
- **web_boost:** straight in from (4,19) at vy −`$500`, offset 2338;
- **web_boost_side:** askew, x `$4000` and vx +`$180`.

The old code fails both on the panel's first frame. Both now match frame for frame up to the crest at 2563/2564, where the game flies off the ramp (4,17) beyond the panel: the crest's unported cross-cell branch.

The random holes' hard preset solves fewer layouts with the true handlers: 20 of 30 seeds, against 22 before; easy 29 and normal 28 are unchanged. `test/gen.test.ts` now wants 6 of 12 for hard.

## Step 7: the enemy species

`tools/snesstep/trace_enemies.py` runs each species' first hole and snapshots every frame from 2170 to 2570.
- **The species field:** `$591C`,slot (hole 17's three slots: `$07` `$02` `$08`, its tiles `$47` `$42` `$48`).
- **Periodic:**
  - `$40`: 4 pictures, 128 frames;
  - `$4A`, `$4D`, `$4E`: 16 8 16 8;
  - `$4B`: 8 16 8 16;
  - `$4C`: 8 × 8 = 64. The old cut, from snapshots 3 frames apart, said 63.
- **Recorded runs, about 385 frames:** `$41`-`$49`, `$4F`, `$57`. These species change pose and pulse their colours toward gold, and the sequence does not repeat in 400 frames.
- **Every slot of a species moves in step** (they draw one WRAM block).
- **Against another course's hole,** compared by pixels, since the tile numbers depend on the VRAM slot: 13 the same. `$48` has other colours on hole 17; `$40` draws other pictures on hole 36. Not modelled.

## Result

- `make -j8 engine-assets`: 64 holes in `holes/000`-`063` (5.3 MB), 61 s on a built tree.
- `tools/check_hole_palette.py --holes 0-63`: every hole's BG colours equal the game's, except the unmodelled writers.
- `make engine-test`: 37 files, 464 tests.
- `npm run e2e`: smoke, `courses.mjs` (hole 1 of courses 1-8 by `?course=N`, its ROM index and song; a shot on course 3 hole 2) and random.
- Screenshots of courses 2, 5, 6 and 8 against `build/emu/holes/screens` agree: the course colours, the scenery and the enemy species.

Not done:
- objects 116-118's colour cycles (the `$58-$5D` tiles; course 1 hole 8 has one);
- the scenery's cycles `$84:CF31` and `$84:D072`;
- the `$6A2E` alternate tables;
- `$85:952C`'s pose and pulse as separate cycles;
- the night palette beyond hole 1.
