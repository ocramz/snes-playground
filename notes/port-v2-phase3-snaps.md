# port_v2 phase 3: the snap panels `$18-$1B`

Date: 2026-11-15. Plan: `plans/port_v2_rest_of_game.md` §8 step 3. The
session plan is in `~/.claude/plans/let-s-do-phase-3-groovy-owl.md`.

Scope, decided with the user: the gate `$82:A692` and the pushes, exact and
traced, plus the star trail the game draws behind the ball on a panel
(objects 61 and 62). The results are in docs/tiles.md "Snap panels",
docs/animation.md "The helpers in RAM" and "Objects 61 and 62", and
docs/engine.md; this note keeps the measurements.

## The read

The handlers came from `tools/dis65816.py '$82:A5B1' --length 0x116 --m16
--x16`. The thread-object side came from `$80:E67F` (the helper copy, 12
`MVN`s), `$80:E861` (`JSR $1104`), `$80:E96C`-`$80:EAB9` (the moving draw
and the polar step) and `$80:E55A`/`$80:E5E2`. Object 61's code is at
`$85:CF2D`-`$CFE0`. Object 62's dispatch is `$85:CFF2`, and its 64 scripts
are at `$85:D027`-`$E08D`, decoded by `tools/export_web.py`'s
`snap_star_scripts`, which checks every byte's form.

Two things in the read were not obvious:
- **`$19` skips its store at the cap.** `$82:A668 LDA #$2000 / BRA $A681`
  jumps over `$82:A67E STA $D9D4`, the store the other three entries reach.
  web_snap_east confirms it (below).
- **The stars move in their draw routine.** No per-frame handler moves them.
  `$80:E96C` = `JSL $80:E97C` (the velocity) + `JML $80:E55A` (integrate,
  then draw).

## The scenarios

The scenarios are poked as `web_boost` is (`tools/snesstep/inputs/web_snap*.txt`
and `.pokes`). The hole is picked at 2050 with `$6A5A`/`$6A5E`/`$6A5C` = 2 ×
course. The A presses are web_hazad's (2360/2437/2444), and the ball's block
is poked at 2468.

| script | hole | the poke | offset |
|---|---|---|---|
| web_snap | 54 (course 7 hole 7, `$6A5C` = `$0C`) | (5,23) yf `$4000`, z `$B504`, vy −`$400` | 2338 |
| web_snap_land | 54 | (5,22) yf `$C000`, z `$F504` (`$B504` + `$4000`), air 1, vy −`$200` | 2338 |
| web_snap_back | 29 (course 4 hole 6, `$6A5C` = 6) | (6,11) yf `$8000`, z `$1_0F86`, vy −`$600` | 2340 |
| web_snap_fast | 29 | (6,9) yf `$8000`, z `$1_0F86`, vy +`$1E00` | 2340 |
| web_snap_east | 62 (course 8 hole 7, `$6A5C` = `$0E`) | (2,4) xf `$A000`, z `$1_0F86`, vx +`$1C00` | 2342 |

**Offsets.** The offset is the first set-up `aim` record in the flow trace,
minus 2. The same rule gives web_flow 2334 → 2332, web_boost 2340 → 2338
and web_hazad 2339 → 2337. With `$6A5C` poked, hole 54 sets up one frame
later than web_hazad, which leaves `$6A5C` at 0.

What the ball traces show (`trace_ball.py`):
- **web_snap.** vy −647 at 2497. Then −1402, −2157, … in steps of −755 (−768
  and the friction's +13), to −7442. The next sum is floored: −`$2000` + 13 =
  −8179 at 2507. Out of the window (yf < `$2800`) it slows by 13 a frame. At
  2511 it takes the `$41` at (5,21), sfx `$50`, which the latch cleared by
  the gate allows. Then comes the reveal: the ball's block is not written in
  2512-2515.
- **web_snap_land.** It falls at vy −466 and lands at 2493 with z = `$B504`,
  vz 0 and air 0. vy goes to −1223, which is −466, the air drag (−464), the
  push (−1232), then the friction 9.
- **web_snap_back.** −1146 → −365 → 391 → 1147 (2505-2508). Then it leaves
  the window south, at yf `$E232`.
- **web_snap_fast.** 7620 → 8180 (`$2000` − 12) at 2479, and 8180 on every
  frame in the window (2479-2484).
- **web_snap_east.** 7120 → 7876 at 2473 (stored). Then 7864, 7852, … (the
  store skipped, the friction alone) until it leaves the panel at 2480.
- Hole 29 lags 7 frames after the poke (2470-2476: no step, no camera). The
  distinct-state alignment absorbs it.

### The guide's `$DA3A`

The engine first missed web_snap_land's landing frame by 4: vy −1219 against
the game's −1223.

`--watch-write '$7E:DA3A-$7E:DA3B'` over the run shows three writes:
- `$80:C695` writes `$0C00` at the set-up (2340);
- `$81:B24C` writes `$07B0` at 2343, the guide's rolling step;
- nothing more until `$81:80ED` (the real rolling step's class index) at
  2493, after the landing.

The airborne path never sets `$DA3A`. So the landing frame's roll ran with
the guide's `$07B0`, friction 9, where the engine had `$0C00`, friction 13.

The guide's own rule is `$81:B23A`: X = 0 when the surface code `$DA04` is
0, else 2; `$6A72` = X; `$DA3A` = `$80:DC49`,X. `sim/guide.ts` now returns
both from its last rolling step, and `systems/aim.ts` writes them back, as
it does `$6A18`. No other path rolls on a landing frame, so nothing else
changed: all 466 tests passed as before.

The `$0C00` at 2340 is `$80:C688`, which every shot's set-up calls
(`$80:C50E`, inside `$80:C4FF`): all the coefficients to their resting
values, in the work copy and both players' blocks. The engine had them only
at the hole's start (`startHole`'s fresh work copy). `systems/hole-flow.ts`
now resets them at each set-up, so a guide that never rolls (a fly shot's)
leaves `$0C00`, as in the game. Also `emptyWork`'s `stepSrcX` ($DA34, no
reader) is `$80:DD13` = `$5332`, not `$3FFF`.

## The stars

`trace_actors.py web_snap* --types 61,62 --frames 2700`. The tool now also
records each slot's exit: the write that sets `$4E1C` to `$FFFF` while it
held a requested type.

- **web_snap.**
  - Object 61 is spawned at 2497, on scanline 250 of the step's iteration.
  - The first burst is at 2498, lines 34-40: the same iteration's
    scheduler, through the extra pass.
  - The second burst is at 2506, 8 ticks later. None at 2514: the ball is on
    the enemy's cell.
  - 61 exits at 2522, after no push since 2507.
  - The stars are freed at 2518 and 2526, 20 ticks drawn each.
- **web_snap_land.** 61 spawns at 2492 and exits at 2509. Bursts at 2493
  and 2501.
- **web_snap_back.** 61 spawns at 2505 and exits at 2522. One burst, at 2514:
  at 2506 vy was still −365, and `$1A` wants vy ≥ 0.
- **web_snap_fast.** 61 spawns at 2478 and exits at 2495. Burst at 2479.
  A second 61 at 2610 is beyond the window (the ball came back after the
  bumpers).
- **web_snap_east.** 61 spawns at 2472 and exits at 2489. Burst at 2473.

**The comparison** (`engine/test/snap-stars.test.ts`). It replays every
engine star alone from its burst and takes its state twice a tick, after
the thread and after the draw.

A tick can straddle a frame of the recording. During the reveal, web_snap's
burst-0 variant 2 was recorded at (911, 166) with frame 4 already set: the
thread had run, but not yet the draw. Taken once a tick, the engine had
(911, 166, 3) then (912, 167, 4). Taken twice, the game's run is a
subsequence of the engine's, for every star of the five scenarios.

**The depth** was checked against stepper snapshots of web_snap at
2502-2508 (`--snap-at`, `tools/ppu_render.py`), next to the browser at the
same moments:
- the stars near Kirby are behind his outline in both;
- the engine draws them just behind his sort (`snap-star-frames.ts`).

## Other findings

- **The reveal on course 7 hole 7.** web_snap's HUD tomato after the
  reveal is game 2535 against engine 2531, carried through the ball states.
  It is the reveal's lag, as course 1 hole 4's. The two hole-54 windows end
  before it (to 2530 and 2522).
- **The random holes.** Only the hard preset places snaps: 17 of its first
  30 holes. Over 30 seeds the solve rates are unchanged: 29, 28 and 20 of
  30, and 12, 11 and 6 of seeds 1-12.
- **`obj_061.json`** (emusheets) is not object 61's picture. Object 61 never
  sets `$519C`, and `emusheets.live_frames` does not skip a draw routine of
  0. Its frame came from a stale `$5E1C` (`$89:B2DD`). The objects atlas
  takes 62 only.

## Result

- `make engine-test`: 38 files, 495 tests.
- `make engine-traces` re-records everything, the new fixtures included.
- `npm run e2e` passes.
- In the browser, a shot on course 7 hole 7 poked onto the panel:
  - the ball speeds up along the arrow;
  - `$11` plays once;
  - the stars rise behind Kirby in fours.

Not done:
- the stars' OAM queue (they draw behind Kirby, the order against other
  sprites unchecked);
- `$DA74` read at the star's draw (the engine uses Kirby's priority of the
  same frame).
