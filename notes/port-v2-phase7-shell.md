# port_v2 phase 7: the shell

Date: 2026-11-16. Plan: `plans/port_v2_rest_of_game.md` §8 step 7. The
session plan is `~/.claude/plans/let-s-do-phase-7-polished-flamingo.md`.

The scope was decided with the user:
- five pieces, in order, each read, ported and traced before the next:
  1. the aim's other inputs (Start, B, Y, L/R, B in the spin stage) and
     the score panel's rule;
  2. the per-hole RESULT card and the hole in one's night;
  3. the save;
  4. the course loop (map, intro, course result, ranking, medal award,
     GAME OVER / CONTINUE);
  5. the front (logo, title and its menu, the members list);
- the members list is ported, but NAME ENTRY (the drawing pad) is skipped:
  a new member's drawing is blank;
- the save is the engine's own JSON, checked against the game through a
  decoder of the stepper's `sram.bin`.

This note keeps the read and the measurements, piece by piece.

## The top level, read

`$80:F0E2` (`sub_game_flow`) is one line of native code. Its menus leave it
through setjmp/longjmp:
- `$80:841A` saves a context at the address in A and returns 0;
- `$80:843E` with X = that address returns there again, nonzero.

The three targets are `$16D9` (`$80:F0FF`, the title), `$16CF` (`$80:F113`,
RESTART, MAP SELECT's) and `$16E3` (`$80:F1E7`, COURSE SELECT: the map). The
pause menu's items longjmp to them (below).

## Piece 1: the aim's other inputs and the score panel

### The read

`$81:A680`-`$81:A80A`, the aim iteration, in order:

| step | the game | does |
|---|---|---|
| `$81:BCB6` | SELECT (`$006B` bit `$2000`) | the mid-course card `$83:C8DD` (piece 2) |
| `$81:A683` | `$EA7E` set | `$81:BDAD` (the pause menu), then the pose |
| `$81:A691` | `$6B38` ≠ 0 | one less; the B part is skipped |
| `$81:A69B` | B held, or `$EA80` | `$83:B214` (the preset); with Y also held the look starts (`$6AAE`, `$6ABA`); the release (`$81:A6DA`): `$80:E060` (the panel object goes), `INC $691A`, `$EA80` = 0 |
| `$81:A6E7` | Y held | `$6AC2` = 90; with the look on and the d-pad: `$81:B9A2`; else with the d-pad the look starts and the score panel hides; Y alone shows it (`$81:A737`) |
| `$81:A73E` | Y released | the panel hides if shown, idle ≠ 0 and the look on; the look on: `$81:BA8A` pans back to `$6AAA`/`$6AAC`, and on arrival (`$6AB0`) `$6ABA` = `$6AAE` = 0 |
| `$81:A771` | Start pressed | `$83:AFA7` opens the pause menu |
| `$81:A780` | A pressed | the panel hides, sfx `$34`, pose 4: the shot |
| `$81:A7A5` | otherwise | `$81:B555` (the d-pad, L/R), the facing on a change |
| `$81:A7B5` | | `$81:BA8A`, the pan toward the aim's target |
| `$81:A7BF` | the idle timer | with no look and no change: `$6AC2` − 1, at 0 `$83:AEEB` shows the panel; else `$6AC2` = 90 and the panel hides |
| `$81:A7E6` | | pose 5 while L/R is pressed or the d-pad held, else 4 |
| `$81:A807`, `$81:A80A` | | `$81:A956` (the guide), `$81:B908` (the look's arrows) |

The aim loop's head `$81:A619` clears `$6AAE`, `$6ABA`, `$EA80`, `$EA7E`, sets
`$6AC2` = 90, and starts the look if Y is already held (`$81:A672`).

**The pause menu.** `$83:AFA7`: `$83:AF96` (the panel hides silently), `$EA7E`
= 1, palette set `$0A`, the window and its text (`$83:AFE4`; `$83:B052` with
`$ED9B`, MAP SELECT's) through `$83:B33D`, `$6AC4` = 0. `$81:BDAD`, while it
is open:
- B or Start closes it: `$6AC2` = 90, `$691A` = 1, palette set 9, `$83:B326`;
- Up/Down move `$6AC4` within 0-2 (`$81:BE4F`, the glyph `$3C40` at
  `$81:BE74`'s cells, `$3C1F` at the old one);
- A: item 0 closes it, 1 longjmps to `$16E3`, 2 to `$16D9`.
No sound is requested. The hole goes on: the threads, Kirby's pose and the
guide run (web_pause: state 5/4 with the d-pad in the menu).

**The spin preset, `$83:B214`.** Its first frame: `$EA80` = 1, `$6B5C` =
`$6B62` = 0, the meter `$FFFF`, object `$10` (the panel) at
(`$83:B322`[player] = `$24`, `$BF`), the score panel hidden. Every frame:
`$6AC2` = 90, `$691A` = 0. Left/Right step `$D9B8` (0-12), Up/Down `$D9BA`
(0-12) only while `$D9B6` ≠ 0; each step marks `$6AE0`, so the guide is
drawn again with the spin. `$6B5C` repeats a held direction: a step, then
one each time it counts to 12. Then `$6B50`/`$6B52` = `$D9B8`/`$D9BA`. The
spin stage's start (`$81:BF41`) keeps the side and resets the top/back to 6.

**The look.** `$81:B9A2` moves `$38AC`/`$38AE` by `$80:DD07`/`$DD09` = (6, 3)
a frame inside the bounds `$81:B8EB` sets at the load: x in [−32, `$8B98`],
y in [0, `$8B9A` + `$E0`] (signed tests). `$8B98` is the header's word 4 × 8
(`$82:B1FA`). `$81:B908` blinks the arrows: `$6ABA` bit 2 for 20 frames,
off for 10 (`$6ABC` = 19 / 9); its first frame stores 2 (an `AND #2` drops
bit 0). While shown, an arrow per way the camera can still move, OAM frames
`$8F07` (up, (`$80`, 8)), `$8F11` (right, (`$E8`, `$50`)), `$8EE9` (down,
(`$80`, `$A0`)), `$8EF3` (left, (`$18`, `$50`)).

**L/R.** `$81:B6C3`: the byte `$81:B729`[aim] (360 bytes), its low nibble (L)
or high nibble (R) × 45 is the aim.

**The cancel.** In the spin stage's loop (`$81:BFB5`): `$D9B8` = `$6B50`; B
pressed → `$81:C089`: pose 7, object `$1A`, a wait of `$22`, the shot
thread's `$531C` = `$FFFF`, the panel object gone, `$6B54`/`$6B58` latched,
`$81:BA0B`. `$80:F340`'s `BMI` then runs `$80:F321`: `$80:C5F1` and
`$81:A619`, with no turn load and no stroke. `$81:BF44` set `$6B38` = 20 at
the stage's start; a normal set-up clears it (`$80:F313`), so it acts only
after a cancel: the aim skips B for 20 iterations.

**The score panel.** `$83:AEEB` shows it (`$EA7C` = 1, `$691A` = 1, BG3 rows
from `$7E:E2DC`, a static HDMA window `$83:AF1B`), unless `$69A0` is set
(DEMO PLAY: the panel never shows there). `$83:AF82` hides it (`$691A` = 1),
`$83:AF96` hides it silently (`$691A` = 0). `$691A` gates the HUD thread
`$84:98EC` (the tomato queue). Its 1P sites, from the stepper's log of the
three routines on web_flow, web_hole, web_tomatoes and web_fly:

| | site | frame |
|---|---|---|
| shown | the aim's idle timer `$81:A7D1`, Y alone `$81:A737` | |
| shown | the HUD thread taking a tomato entry (`$84:9928` → `$83:AF44`) and applying it (`$84:9943`) | |
| hidden | the HUD thread, 90 iterations after the last change (`$84:9993`) | |
| hidden | the aim's change or look `$81:A7E2`, `$81:A724`, `$81:A74D`; A `$81:A78D`; the preset `$83:B24B` | |
| shown | the lost ball `$80:F830` (E), `$80:F850` (E + 33) | web_fly 3498, 3531 |
| hidden | the reset `$80:F5AA` (E + 79) | 3577 |
| shown | the respawn's life part `$80:F8C5` (R + 31), each refill step `$80:F8F0` | 3608, 3648 … |
| hidden | the turn top after the respawn (`$83:9589`'s end) | 3912 |
| shown | out of tomatoes `$82:E24B` (O + 19), `$80:F85C` (O + 222), `$80:F86B` (O + 252), each refill step | web_tomatoes 3625, 3828, 3858 |
| hidden | `$80:F8C0` (O + 448) | 4054 |
| shown | the hole-out `$80:F634` (C + 35, after song 25's handshake), the bonus `$80:F6A6` (C + 94) | web_hole 3956, 4015 |
| silent | the star warp `$83:C76F` (C + 287) | 4208 |
| cleared | the hole's load `$80:C1B2`; `$691A` = 1 when the HUD object starts (`$84:9896`) | |

The cup's reveal: the HUD thread took the take's entry before the
decompression's lag (web_flow: shown at 3246; the +1 still lands at 3270).

### The scripts

`tools/snesstep/inputs/web_{pause,pause_quit,look,bspin,lr,cancel,idle}.txt`,
hole 1 from `play_hole1`'s route (`GAME_OFFSET` 2332). `trace_flow.py` gains
`panel`, `pause`, `pcur`, `preset`, `prep`, `gside`, `gtb`, `look`, `lookl`,
`idle`, `hudon`, `lock` and `bright` (`$007E`), and the scene requests
(`$80:CABC`) in `iters_<name>.json`.

- web_pause: the menu at 2500, the cursor 1, 2, 2 (clamped), 1, B at 2740;
  B held one more frame starts the preset at 2741, its release at 2742.
- web_look: the camera +6/+3 a frame; the arrows' flags 2 → 6 → 2 …; the
  pan back from 2540 arrives at 2573.
- web_bspin: the preset's steps 2510, 2525 (the repeat, plus the fly guide's
  lag of 5); the top/back 7, 8, 9 every 15 frames; the spin stage resets
  the top/back to 6 at 2756.
- web_lr: 45, 90, 45, 0, 315, 270; from 271 L gives 315, R 270; from 266 R
  gives 225.
- web_cancel: B at 2560 (pose 7), the head at 2596 (`$6AC2` = 90), the first
  iteration at 2598, the lockout 19 … 0 to 2617.

### The engine

- `core/traits/aim-ui.ts`: `AimUi` (`$EA7E`, `$6AC4`, `$EA80`, `$6AAE`,
  `$6ABA`/`$6ABC`, `$6B38`, whether the iteration panned, the pause's
  longjmp) and `ScorePanel` (`$EA7C`, `$691A`); `lookBounds`.
- `core/systems/aim-ui.ts`: the panel's three routines, the pause menu, the
  preset, the look's scroll and arrows, the head.
- `core/systems/aim.ts`: `updateAim` in the game's order; `update-camera`
  pans only when the iteration did (`AimUi.pan`). `sim/aim.ts` `aimPad`
  snaps with `tables.json` `aimSnap`.
- The cancel: the `Cancel` phase (`systems/panel.ts`, `hole-flow.ts`): the
  latch at C + 34, then the set-up's third frame at C + 37.
- The panel's sites in `hole-flow.ts` (the lost ball, the respawn, out of
  tomatoes, the hole-out) and `counters.ts` (the HUD thread, gated by
  `$691A`).
- `CourseData.mapWidth` (`$8B98`).
- The view: the HUD shows exactly when `ScorePanel.shown`; the pause window
  and the look's arrows (`features/hud/aim-ui-view.ts`, pictures from
  `export_web.py` `build_pause`/`build_look_arrows`); the preset's panel
  (`panel-layout.ts`, its own palette's pictures in `ui.json` `preset`). The
  pause's COURSE SELECT and QUIT end the course and go to the menu until
  the shell's map and title exist.

Tests: `test/aim-buttons.test.ts` (the seven scripts: every watched word
±2 frames, the camera within 2/8 px); `flow.test.ts` adds `panel` and
`hudon` on its eight runs; `test/e2e/pause.mjs`. 836 tests pass.

## Piece 2: the per-hole RESULT card, SELECT's card, the night

### The read

**The card, `$83:D3ED`**, after every hole-out but the course's last
(`$6A62` = 0). It requests no scene: from the blank that ends the hole-out
(web_card 4330) it builds the screen in place: TM `$15` (BG1, BG3, OBJ), BG1
one of `$80:D618`(1)'s maps (the card's window, in the course's palette), BG3
the hole's scenery kept, palette set `$10`, tilesets 9 and `$0A`.
- `$83:CEF9` → `$83:CFF7`: one number object `$8C` per hole played, at
  `$83:CD82`[k] (x) and the high byte of the word at `$83:CD93` + 2k (y); a
  1 gets the star variant (`$83:D015` INY); the total (`$D7E0`) at `$83:CD92`
  / `$83:CDA4`. `$83:D081` turns a number into BCD and spawns `$8C`.
- Object `$8C` draws 8 × 16 digits, tiles `$80`-`$88` over `$90`-`$98` for
  1-9 in OBJ palette 0 (top tile at (x − 4, y − 8), tens 9 px left); the 1's
  star is tile `$05` in palette 2 at (x − 34, y − 4) (build/emu/card_hio, a
  hole in one's card left up). The digits appear some frames after the build
  (none at build + 29; at build + 70 they are up). Cell `$89`/`$99` is not
  a plain 0: unconfirmed.
- Objects `$82`, `$88`/`$89` (Kirby on the warp star, flying from the
  screen's centre `$ECBB`/`$ECBD` = (128, 128)) and `$83` (twinkles).
- The timeline (web_card): the blank at 4330 (= C + 410); brightness 1 at
  4344 to 15 at 4358; `$83:D48C` then waits each frame for A, B or Start held
  (`$004F,X AND #$9080`); A at 4560: 14 at 4561 to 0 at 4575, the blank at
  4576; the music stops (`$80:B5D6`); the next hole's load at 4640. No sound
  request.
- The window's colours are the course's: every course's window differs over
  the whole box (the whole game's autoplay run, its first hole's cards at
  3909, 17269, 30775, 44374, 57625, 71532, 85141, 99175 + 29).

**SELECT's card**, `$81:BCB6` at the top of every aim iteration (SELECT
pressed, outside MAP SELECT's `$ED9B`): fade out, `$83:AF96`, `$83:C8DD`
(the YOUR card of the holes finished, `$83:CFB6`(`$6A5E`), and the BEST card
of the course's best record, `$70:1958`'s first index: a saved record, or
for an index ≥ `$19` a built-in one from `$81:CAB7`), a fade in while
`$80:B600` slides the cards, SELECT again, fade out, the hole's graphics
back, the fade in with the hole's song again (`$80:C967`). web_select: SELECT
at 2500 → 14 … 0, the blank at 2516, 1 at 2531 … 15 at 2545; SELECT at 2700
→ the blank at 2716; 1 at 2726 with the song, 15 at 2740. The BEST card's
slots are YOUR's 120 px left.

**The night**, `$83:D2BF` in a hole in one: `$6A2E` = 1, palette set `$11`
(the scenery's alternate colours, `$80:D527`[course & 7]) and `$80:D82B`(1)
(the course's alternate list `$80:D8AB`[`$6A5A`]). Computed from those
tables, hole 1's night agrees with c1n's recorded CGRAM on every BG entry but
113 and 127 (the glow's and the outline's cycles, caught mid-cycle).

### The engine

- `HoleFlow` phase `Card` (core/systems/hole-flow.ts `resultCard`): the
  timeline above, `Screen` (core/traits/screen.ts: `$007E` and the blank)
  for the fades, then HoleOver for the host's `nextHole`. The last hole goes
  to HoleOver as before (the course clear is piece 4's).
- SELECT's card: `AimUi.cardAt`/`cardPress`, `scorecard` in
  systems/aim-ui.ts, blocking the aim iteration.
- The view: `features/card/` draws the hole's scenery, the course's window
  (`card_window_<n>.png`, the drawing blanked), the digits
  (`card_digits.png`) at the ROM's slots, SELECT's BEST window
  (`card_best.png`, course 1's colours) and the fade veil. Not drawn: the
  flying star with Kirby, the digits' pop-in, the built-in members' faces.
- The exporter: `export_web.py --only card` (`build_card`, from the whole
  game's autoplay run, a hole in one's card and web_select); the night for
  every hole (`coursemap.hole_cgram(night=True)`).

Tests: `test/card.test.ts` (web_card: the brightness from the card to the
next hole, the card word, the panel), `aim-buttons.test.ts` adds web_select
(the brightness, the panel, the pose, the idle timer).

## Piece 3: the save

### The read

- A fresh save (`$81:C436`-`$81:C47A`): `$70:1B3C` = 1, the members' serials
  0, `$70:1938` cleared, every ranking record `$4444`.
- NEW MEMBER (`$81:FA49`): at most 5 (`$70:1B38`); the first slot whose
  `$70:0010` is `$9999`; its drawing (48 words at `$70:002E` +
  `$81:F1C9`[m]) cleared; NAME ENTRY `$81:E0E1`; then cleared 0, serial =
  `$1B3C` (+ 1), the checksum, `$1B38` + 1.
- `$83:9845` (the map): a flag bit of `$70:001A`[m] set once (bit 0 normal,
  bit 1 extra in the saves: the map's first visit).
- `$81:C52D` after the intro: rounds + 1, below 1000.
- `$81:C666` at the last hole-out: above (Piece 3's facts in the session
  plan); the cleared count: equal to the course → + 1; reaching 8 sets
  cleared 8 and bit 2 (if not set); reaching 16 sets bit 3 and the count
  stays 15.
- `$81:C8C6`, the ranking: compared with the 25th saved record (score, then
  rounds; an empty `$4444` always loses); the 24 best saved + the new one
  (order id `$19`) + the 5 built-ins (ids `$28`-`$2C`, members 5-9) are
  sorted by score, rounds, id (`$81:C9A9`); the members' records are written
  back in order, each id byte set to its new index; `$70:1958` + 30 c gets
  the merged order; `$EC4D` the new record's place.
- The medal: `$81:C735` + 4 c, [bronze, silver, gold, 0]; the medal is how
  many are ≥ the score.

### The engine

`core/save.ts` (the JSON and its rules: `emptySave`, `newMember`,
`setMemberFlag`, `beginCourse`, `finishCourse`, `medalFor`, `insertRanking`,
`rankingView`, `builtinRecords`), `core/traits/save.ts` (`Save`: the data,
a version, the member, the last result). `startCourse` counts the round,
the last hole's card write runs `finishCourse`. `Session.course` is `$6A5A`
(-1: no save). The host: `features/save/save-store.ts` (localStorage
`kdc-engine-save-v1`; `?save=fresh`, `?nosave`). The dev menu plays ROM
courses as member 0 (made if absent) until the members list exists.

`tools/sram.py` decodes `sram.bin` into the JSON; `tables.json` gains
`medalThresholds` and `rankingBuiltins`.

Tests: `test/save.test.ts`: the five autoplay saves (course1, game, game2,
game4, extra) replayed through the rules from an empty save equal the
game's, members and rankings; the thresholds; the ranking's order, ties and
25th place.

## Where this stopped

Pieces 1-3 are done, with the suite green (856 tests, 47 files) and the e2e
pages passing (`pause.mjs` new). Pieces 4 and 5 are not started in code.

What the read found about them, for the next session:
- The course's end is a chain of animated screens, each driven by objects of
  banks `$84`/`$85` (the whole game's run, course 1: `$83:C787` at 13283
  with song 19 and Kirby's dance sounds; `$83:C9FF` at 13834, the tally with
  sfx `$44` every 18 frames per hole; scene 8 at 14117 with songs 0, 1, 15;
  the ranking, scene 4, at 15318 with song 5; the map at 15399; the intro at
  15750). autoplay presses A every 20 frames, so its run shows the shortest
  path through them: their natural timing needs scripts that wait.
- The map: the course `$D7BE` from 0 to the member's next (`$D7BC`), Up/Down
  step it with object `$A7`'s move and `$D7C0`'s scroll, A or Start plays it,
  B goes back to the members list.
- The intro: `$86:FC95`, the parade `$82:B497` by `$86:FE75`[`$6A5C`], song
  `$93`, ended by the parade or A/B/X/Y/Start.
- The medal award `$83:F985`: song, fade in, A or Start.
- GAME OVER `$83:D856`: CONTINUE goes to the map (`$80:F486` → `$80:F1E7`),
  not to the course again; GAME END to the title.
- The lives carry from course to course (`$80:C036` sets 2 for a new game,
  `$80:C0A1` puts back `$D7F8` after COURSE SELECT).

Two ways to bring those screens in: port each screen's objects (exact, long),
or record each as a replay like the hole's cutscenes (`trace_cutscene.py`,
`features/cutscene`), with the core holding the screen's timeline, input and
save rules. The session plan's design (a `Shell` world singleton over
`HoleFlow`, a persistent runner scene) still holds for either.
