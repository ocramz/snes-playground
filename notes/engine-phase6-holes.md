# Engine phase 6: enemies, the cup, holing, the counters, the hole and course loop

> Promoted 2026-11-14 (engine phase 8): the facts below are in the subsystem docs (physics.md, flow.md, tiles.md, animation.md, audio.md, emulation.md, web-demo.md); the mapping, deviations, unported and unconfirmed lists are in docs/engine.md. This note is kept as the session's record.

Date: 2026-11-14 (session 5). Plan: `plans/port_v1_koota_phaser4.md` item 6,
"Enemies, cup, holing, hazards, tomatoes, strokes and lives; the hole and
course loop on the test courses". The session plan is in
`~/.claude/plans/let-s-do-phase-6-resilient-planet.md`.

## Result

Hole 1 now plays out headlessly, frame-exact, through two shots, both
takes, the cup's reveal, the sink and the hole-out, with no seed and no
pokes. The same holds for a run that spends all four tomatoes, and for the
fly shots' lost ball through its life and its refill. The hazards are
ported in full and match five recordings: every ball state, every sound,
and the actors' states.

- **`test/events.test.ts`**: every sound request of the game's main loop and
  physics matches an engine event on the same iteration with the same id.
  - It reads the stepper's own log of `$80:B542` / `$80:B4AC` calls.
  - Seven runs: web_flow, web_curve, web_ui, web_fly, web_fly_spin, web_hole
    and web_tomatoes.
  - That is about 230 requests in all: the aim ticks, the panel, the launch,
    the bounces, the takes, the cup, every tomato change, the lost ball's
    song, sfx and life, the refill, the sink, the hole-out songs, the tired
    and asleep paths.
- **`test/flow.test.ts`**: six runs (web_flow to 3530, web_curve, web_ui,
  web_fly, web_fly_spin, web_hole to the RESULT card, web_tomatoes to the
  fifth set-up) on the phase-5 fields, plus the tomatoes, lives, strokes,
  stars, holed, the card and the tomato queue's ring indices.
- **`test/trace-script.test.ts`**: 15 scripts. Every distinct ball state
  matches, with 0 catch-ups, through web_hole's sink.
- **`test/stalls.test.ts`**: the reveal's edges are frame-exact on web_flow
  and web_curve. So are web_fly's landing and step hit-stops.
- **`test/reveal.test.ts`**: the reveal's stages on course 1's holes 1-4
  (the autoplay replay): on-screen 8/39/100; hole 3 with a 30-frame pan
  38/68/129/158. Hole 4 is exact but for one lag frame of the game's.
- **`test/hole-entities.test.ts`**:
  - the actor sweep equals the exporter's lists on all 8 course-1 holes;
  - hole 1's list is in ROM order;
  - the takes, the owners, the cup, layer 2's `$08`, the target.
- **`test/trace-hazards.test.ts`**: five recorded hazard scenarios
  (§ Hazards). From the poke on, every distinct ball state matches and
  every sound request matches its iteration, through the bounces, the
  throws and the tomato changes.
- **`test/hazard-actors.test.ts`**: the actors' state sequences against the
  recorded thread slots, from the set-up to the poke and through each
  window. **`test/hazards.test.ts`**: the fixed box `$A2`, the auto-tiling,
  `$05` and the actors' programs on t7.
- **`test/courses.test.ts`**, **`test/hole-flow.test.ts`**: the eight test
  courses (coverage, validation), and the loop on them:
  - a hole in one;
  - an ordinary hole-out;
  - a lost ball;
  - the tomatoes running out;
  - GAME OVER and CONTINUE;
  - all eight holes to CourseDone;
  - pause.

## What was built

| Engine artefact | Original |
|---|---|
| `traits/session.ts` `Session`, `IsPaused` | (the module global `loaded` of phase 5) |
| `traits/hole.ts` | the hole root; `InHole`; `IsEnemy`/`EnemyKind`/`Hover` (`$69DE`, `$531C`, `$5B1C`); `TakenBy` (`$539C`); `IsCup` (`$B4B8` = 8); `IsTee`; `IsPillar`; `IsHazardActor`/`ActorType` |
| `traits/counters.ts` | `Tomatoes` `$D7F0`, `Strokes` `$D82A`, `Stars` `$6A10`, `StockedAbility` `$D852`, `Career` (`$D7F4`, `$D80A`), `TomatoQueue` (`$68FA` ring, `$68F4` the HUD shown) |
| `traits/visual.ts` | the semantic kinds: ball, tee, enemy, star, cup, pillar, hazard |
| `sweep.ts` | `$82:B320` (the sweep, `$82:BDBC`), `$82:B5BF` (the enemy list), `$82:B44B` (an actor's Z) |
| `systems/take.ts` | `$82:8A2E`, `$82:8A98`, `$82:8B41`, `$82:8ACE`/`$82:8AEE` |
| `systems/reveal.ts` | `$82:8B5C` and its stages `$82:8BDD`, `$82:8D5A`, `$82:8C4F`, `$82:8CF0`, `$82:8C1C`, `$82:8C27` |
| `systems/counters.ts` | `$83:ABC5`/`$83:ABAD` (push), the HUD thread `$84:98EC` -> `$83:ABDD`, `$83:ABEC`, the lives |
| `systems/hole-flow.ts` | the turn top `$80:F278`, the roll's end `$82:C172`, `$80:F37A` and its three paths, `$80:C79A` (tired), `$82:E1EE` + `$80:F85C` (out of tomatoes), `$80:F830` + `$83:9589` (lost), `$80:F48C` (holed), `$83:C8A0`, `$83:D4F6`, `$80:F5E5`, `$83:D2AB`, `$83:C745` |
| `sim/cup.ts` (rewritten) | `$82:AD8E`, `$82:AD36`, `$82:B048`, `$82:AE2B`, `$82:AE61`, `$82:AF09`, `$82:AF51` |
| `sim/enemy.ts` (fixed) | `$82:8963`, `$82:8967`, `$82:8990` |
| `sim/dispatch.ts`: the pillar (fixed) | `$82:94D3`, `$82:957C`, `$82:95A6`, `$82:95FD`; `$81:88F9`, `$81:8A47` |
| `course-data.ts` `fromAuthoredCourse`, `enemyCells` | the test courses' format (`engine/courses/README.md`) |
| `actions.ts` | `startCourse`, `startHole`, `nextHole`, `continueGame`, `endGame`, `pause`, `resume`, `placeBall` |
| `tools/export_web.py` tables | `actorIds` `$82:BDBC`, `enemyAbility` `$82:B6EB`, `enemyHover` `$82:B703`, `actorGround` `$82:B477`, `holedSfx` `$82:AEF5`, `spinBounceSfx` `$84:89D0` |
| `tools/snesstep/trace_flow.py` | more watched words; the sound log `sounds_<name>.json`; `.pokes` files |
| `tools/snesstep/trace_ball.py` | each record's scanline `ln`; longer runs; `.pokes` files |
| `tools/snesstep/trace_actors.py` (new) | the thread slots of chosen object types, per frame |
| `tools/snesstep/inputs/web_hole.txt`, `web_tomatoes.txt` (new) | designed with the engine, recorded: the game decides |
| `tools/engine_courses.py`, `engine/courses/t*.course.json` (new) | the eight test holes |
| `sim/actors.ts` | `$82:BA87` (the auto-tiling), objects 76 `$84:DED6`/`$84:DF75`, 77 `$84:DD9D`/`$84:DDC7`, 81-83 `$84:E166`/`$84:E4BB`/`$84:E539`/`$84:E1B4` |
| `sim/hazards.ts` | `$82:98F8`/`$82:9940` (+ `$82:997E`, `$82:9A29`, `$82:9A49`, `$82:9ABF`, `$82:E701`, `$82:9B3B`, `$82:E7B0`, `$82:E6C1`), `$82:9653`/`$82:9693` and `$82:9858`/`$82:987B` (+ `$82:96BA`, `$82:97B4`, `$82:9728`, `$82:EF23`, `$82:EF9B`, `$82:9813`), `$82:86B9`/`$82:8656` (+ `$82:87C9`, `$82:888C`, `$82:88F1`, `$82:EDE9`, `$82:874E`), `$82:A55E`/`$82:A576`, the penalty `$82:9C8D` |
| `systems/actors.ts`, `systems/hazard-reaction.ts` | the scheduler's tick for the actors (`$80:E0C0`); `$B6BA`, `$ABB8`; the reactions `$82:DB9A` |
| `tools/export_web.py` hazard tables | `trackMask`, `trackDeadEnd`, `trackSpeed`, `trackTurn`, `bobPhases` `$84:DE0F`, `bobHeight` `$82:967B`, `volcanoPoked` `$84:E1F5`, `hazardShape` `$82:9A9D`, `hazardDisc` `$88:A470`, `bumpPushX`/`Y`, `bumpSignGate`, `bumpHeadingGate`, `reflectDeg` |
| `tools/snesstep/inputs/web_haz80`, `web_haz98`, `web_haz94`, `web_hazad`, `web_hazac` (`.txt` + `.pokes`, new) | the hazard scenarios |

## Facts settled (docs candidates)

Each is pinned by a test above. The source is the disassembly (dis.), the
stepper's logs, or a recorded trace.

**Frames are the main loop's iterations.**
- The roll loop routinely runs past the vblank, so a store or sound request
  in the first lines of frame F belongs to the iteration of F − 1.
- Every recording now carries the scanline: `ln` in the ball traces, the line
  column in the sound logs. The tests convert with a threshold of line 112.
- With that, every event lines up on one convention. The phase-5 "32 frames
  to the set-up" was 33 iterations once the stamps were read this way.

**The roll's end waits for the HUD (`$82:C172`, dis. + web_tomatoes).**
- After the shot is over, the roll loop runs frames until `$68F4` (the HUD's
  tomato display) is clear.
- The display hides 89 iterations after the last tomato change (`$84:9990`).
- So the loop exits at max(over + 2, hidden + 1): web_flow 3473 → 3475;
  web_tomatoes 2529 → 2567 (hidden at 2566).
- Everything after the roll counts from that exit:
  - the set-up at +31;
  - the out-of-tomatoes test at +30;
  - the lost ball's tomatoes → 0 at +30, sfx `$54` at +33, the reset at +79;
  - the hole-out's pan at +1.

**The tomato queue (`$83:ABC5`, `$83:ABAD`, `$84:98EC`, `$83:ABDD`; dis. +
traces).**
- Every push lands 20 iterations later: the launch's push at 2982 lands at
  3002, a take's at 3067 lands at 3087.
- The HUD thread takes the next entry **in the tick that applies the one
  before** (`$84:9955`: timer 20, back to state 1). So queued changes land
  20 iterations apart (web_haz98: the roll's −1 at 2474, the bumper's at
  2494). The engine first waited one more tick; no earlier run had two
  entries queued.
- A +1 is stored only below 5, and plays sfx `$52`; a −1 floors at 0, and
  plays `$10`.
- The cup reveal holds the thread for 5 frames (web_flow 3245 → 3270).

**Lives and tomatoes (dis.).**
- A new game has 2 spare lives (`$80:C058`). A tomato cap of 4.
- **A lost ball sets the tomatoes to 0** (`$80:F83B`). At the next turn top a
  life is lost (`$80:F8D0`) and the tomatoes refill: 8 × (10 frames, +1),
  `$80:F8DA` (web_fly 3528, 3638, 3648-3678).
- **Running out of tomatoes does not end the hole.**
  - `$82:E1EE`: sfx 0; pose 3, song `$8F` (+15); Kirby falls asleep until
    object `$BE` is done (+212, the hole's song again).
  - Then a life (+282), object `$40` with sfx `$77` (+312), the refill
    (+348 …), and the next set-up on the same hole, the ball where it lies
    (+449). Measured on web_tomatoes 3606-4055.
- With no life left either path is GAME OVER (`$80:F387`, `$80:F3B5`).
- CONTINUE gives 2 lives and starts the course again (`$80:F486`, `$80:C0C5`).
- **The tired pose** (`$80:C79A`, at the turn top when tomatoes < 3):
  - it comes after the turn's load (the elevation's `$FFFF`);
  - the pan toward Kirby, until it arrives;
  - pose 11;
  - wait 80, plus 36 at one tomato;
  - then `$80:C4FF` (web_tomatoes 2863/2873/2953, 3217/3227/3343).
- Strokes: 1 at the hole's start, +1 per set-up, capped at 99. The card holds
  `$D82A` − 1. A hole in one is `$D82A` = 2: +1 life, capped at 99.

**The take and the cup (dis. + web_flow/web_hole).**
- The actor sweep runs rows from the top and **each row from its last column**
  (`$82:B35D` DEX). So hole 1's enemy list is (8,3), (8,5), (6,5).
- The hover heights: `$82:B703[tile − $4D]` for `$4D`-`$52`, {3, 1, 3, 4, 2, 4}.
- The hit test's airborne window is measured from **the ground under the
  ball** (`$DA06`): ground + H − `$2D41` to ground + H + `$5A82`. Phase 4 had
  it absolute.
- Tiles `$4D`-`$52` on the rolling path go to `$82:8963` = `JML $81:8A56`: a
  rolling ball never tests a hovering enemy.
- The take plays sfx `$4F`, or `$50` plus 4 frames for an ability enemy. It
  sets the owner, stars + 1, and queues tomato +1 (`$8B41`).
- When one enemy is left, the reveal (`$82:8B5C`):
  - it clears the latch `$6A68`;
  - the target `$6B6C-$6B76` becomes (x, `$8C00`; y, `$7800`; the cell's Z);
  - tile `$08` goes into layer 2;
  - then its stages: **lead 8** (to the pan stage), **the pan to the cup**
    (only if the enemy is off screen; a frame then a pan, until arrived),
    **the hover drop**, **the ring** (`$1C` at +31, object 97's flag at +92;
    both a frame sooner after a pan), **the pan back** to the saved camera;
  - the on-screen test uses the enemy's draw position, in bitmap
    coordinates, minus the scroll (`$82:8D5A`; holes 1-4 agree).
- **Risk 3 is settled:** the reveal lasts 100 frames plus the pans (course 1
  hole 3: 158).

**The cup's handlers (dis. + web_hole).**
- `$82:B048` gates nothing: it is the ring object's latch (it shares `$6A68`).
  Phase 4's middle-half and height checks were not in the ROM.
- The rolling side: depth 0 → the roll; the centre, or a rim at `|v|` ≥
  `$0300` → airborne with vz 0 and the gravity tail; otherwise the pull
  `$82:AF51` (with a heading update).
- The landing side: the hole-out when z ≤ ground' + `$4000`; on the wall below
  ground', `$82:AF09` + `$82:AF51`, then z = ground'.
- **The sink `$82:AE61` never moves z** (the step's move does). It adds
  gravity to vz, keeps z from going below 0, and ends when the recorded
  ground' ≥ z: holed 2, Kirby's state 1, the music's volume 0 (`$80:B5F4`),
  sfx `$82:AEF5[mode]` = `$21`.
- web_hole sinks for 14 frames (3894-3908). Phase 4's port ended the sink at
  once (a compare the wrong way round).
- The sink's end also sets the shot over (`$81:A612`), so the roll ends from
  the still count.

**The hole-out (dis. + web_hole + c1n).**
- After the roll's end, `$83:C8A0` pans toward the cup's projection
  (`$ECBB`, `$ECBD + $12`) until it arrives. The card is written on that
  frame C (web_hole 3911-3921).
- From C, on web_hole and c1n alike:
  - song 25 at +31;
  - the bonus tomato at +94;
  - song 24 at +147;
  - the blank before the RESULT card at +410.
- In one (c1n): song 0 at +31, song 26 at +58, the 1UP at +386, song 24 at
  +498, the end at +760.
- The star warp's rise moves the world camera (4196-4260). That is the
  cutscene's camera track, not core's.

**Smaller ones.**
- The roll pose of a grounder is always 14 (`$82:C808`: `$6AD8` set).
- The panel's initial state (the meter 0, top/back 6) comes at curl + 30
  (`$81:BF30` yields `$1D`). That shows on a second shot (web_hole 3697).
- **The aim tick `$53` comes after the guide** (`$81:A977` → `$81:A98B`), on
  the lag's last frame. A fly shot's full guide (`$81:A9AC`) has the same
  tick, and lags 8 frames, not 5 (web_fly and web_ui 2620 → 2627).
- The fly shot's spin streak (object 25) sets `$68F0` from the spin
  (`$84:89D0`). The first bounce then plays `$68F0` + 4 (web_fly 3109: sfx 6),
  `$81:9BF4`.
- The meter's latch requests sfx 0 twice (`$81:C038`, `$81:C046`).
- Song events carry the song's number (the request byte − `$7E`).

## Corrections to the docs (applied 2026-11-14, backed by the hazard traces)

- docs/tiles.md: the tile table's hazard rows, and "Hazards". `$83:ABC5`
  queues a tomato −1; the hazards are bumpers that bounce the ball and cost
  a tomato, not "the same consequence as a bottomless gap". `$82:C092` never
  called it: the fall's two pushes (`$82:C085` → `$82:C18D`) need `$17FF`,
  which is clear in 1P (web_fly's `$68F8`). The out-of-bounds path is
  `$80:F830` (tomatoes → 0, then a life).
- docs/web-demo.md: "Ball lost" → the game's tomatoes 0, a life, the refill
  (the demo itself is unchanged).
- symbols.tsv: `$83:ABC5` is `sub_tomato_queue_dec`, not `sub_ball_lost`;
  `sub_tile_hazard`'s note.

## Unported, approximated, deferred

- **The game's lag frames** are not modelled: the engine has no cycle counts.
  Course 1 hole 4's reveal shows one; the volcano holes show several per
  eruption.
- The hover drop's length (`$82:8CE8[h]` + 8) is not measured.
- The hole-in-one path's offsets come from c1n's recording only: the 1UP's
  life at +386 and the bonus at +445 are unconfirmed frames.
- Copy abilities: an ability enemy's take is ported (sfx `$50`, the 4 frames,
  the stocked id), but the ability is never used. The roulette `$57` is
  treated as none. Test courses reject both.
- 2P: the steal `$82:8B0F`, the 2P HUD (`$83:AD71`/`$83:AE8C`), the asleep
  turn-skip of 2P.
- The RESULT card (`$83:D3ED`) is HoleOver: the core waits for `nextHole`. The
  course result, the medals and the map are out of scope.
- Presentation spawns are left to phase 7: objects 74, 75, 78, 79, 93, 97,
  110, `$BE`, `$40`, the star warp, the 1UP.

## The test courses

`tools/engine_courses.py` lays out the eight holes, and
`engine/courses/README.md` gives the format. The validator rejects:
- a tee not on flat ground, or a second tee;
- fewer than two enemies, or an ability enemy;
- an actor on a gap.

The coverage test checks that every shape `$00-$1B` and every ported tile
group is somewhere in the eight. `test/course-driver.ts` plays them the
autoplay way: weak shots, then the ball put onto the enemies and the cup.

## Hazards

Ported in full from the disassembly and checked against five recordings
(user decision: "Port fully, with a trace"). They are bumpers: a hit bounces
the ball, queues a tomato −1 and plays sfx `$6F`. None of them loses the
ball.

**The scenarios** (`tools/snesstep/inputs/web_haz*`). Each picks its hole with
the `$6A5A`/`$6A5E` pokes at 2050 (as `tools/snesstep/holes.py` does), shoots
weakly from the tee, and pokes the ball's block at the roll's first frame
(the power press + 24).

| scenario | hole | the hazard | what the game did |
|---|---|---|---|
| web_haz80 | 3 (course 1 hole 4) | the isolated `$80` at (8,18), auto-tiled to `$A2`, rolled into; then the `$05` row | the box bounces it back (2485, `$6F`); `$05` at (8,20) throws it, vy `$473`, vz `$880` (2523) |
| web_haz98 | 4 (course 1 hole 5) | object 76 riding its track (`$84`, `$98`, `$98`), flown into | the cube test and the 3-D exchange: v (−2976, −992, −512) → (−1847, −2027, −486) at iteration 2464 |
| web_haz94 | 11 (course 2 hole 4) | object 77 on `$94` at (1,24), rolled into while low | the reflect: vx −1788 → +1145 (2474) |
| web_hazad | 54 (course 7 hole 7) | object 82's base at (5,14) while it spews | the throw: vy −`$500`, vz `$800`, sfx `$7B`, Kirby's state 40 (2477); then the cones of 82 and 83 |
| web_hazac | 54 | object 81's cone at (5,16), flown into inside its height window | the reflect by side, sfx `$7C` (2484) |

web_haz98's window ends at 2496. At 2497 the ball rolls from the flat (6,13)
onto the `$07` ramp at (5,13), westward, and the game launches it. That is
the unported crossing branch of `$81:980B` (plans risk 5), not a hazard.
It is the first recording to show that branch on a flat → ramp crossing.

**Facts settled (dis. + the scenarios).**
- **The auto-tiling** (`$82:BA87`, at the hole's load) rewrites the track
  tiles `$80-$A1` of layer 2 in place, row by row. A tile whose sides do not
  all connect becomes the dead end of the side that does (`$82:BB82`), or
  `$A2` when none does. So hole 3's isolated `$80` is a fixed box.
- **Object 76** moves `$0400` (1/64 cell) a tick along its track. It turns
  at each cell centre by `$84:E051[tile][dir]`, and flips frames 0/1 every 9
  ticks. Its Z is the ground under it. On `$A2` it has no mover.
- **Object 77** steps through `$84:DE0F`'s 22 entries, 9 ticks each; tiles
  `$94-$97` start at step 10. The box's height is `$82:967B[frame]`,
  `$3B00`-`$BA20`. Only frames 0-2 are under the cube's half-size `$58E0`,
  so a rolling ball passes under a raised bumper. The two-axes case
  (`$6A24`, `$82:9813`) is a box coming down on a ball that is under it.
- **The volcanoes 81-83** chain idle segments (frames 0, 1, 2, 1; 8 ticks
  each) with eruption tests:
  - 81 never erupts;
  - 82: 128, E, 192, E, 64, E, 64, E;
  - 83: 64, E, 64, E, 128, E, 32, E.

  An eruption (`$84:E539`) is state 1 for 54 + 42 ticks, then state 2 (the
  spew, 12 × 8 ticks). A test is skipped (192 idle ticks) while the ball
  rests in the cell's middle. A cone hit pokes the volcano: 32 frames of
  `$84:E1F5`, unless it is erupting.
- **The handlers' maths is exact** on all five: the shape bitmap and the
  cube, `$82:9B3B`'s push and minimum, `$82:E7B0`'s exchange, the reflects
  `$82:E6C1` and `$82:EDE9`, `$82:EF23`/`$82:EF9B`'s minimums, the cone's
  window and diamond, the restore, and the reactions `$82:DB9A` (`$14`:
  state 49; `$13`: the throw along the heading, `$474`, vz `$880`; `$0F`:
  `$500`, vz `$800`, state 40, sfx `$7B`).
- **The scheduler and the frames.** The game's lag frames drop scheduler
  ticks. A tick can straddle a frame, so a recorded slot can show the
  thread's new frame with the mover's old position (web_haz98 2357, 2368).
  The hole's intro ticks object 76's thread while its mover stands
  (2190-2191). That leaves its frame's phase an odd number of ticks off any
  straight run from the spawn; a loop of the track is 256 ticks, so a loop
  cannot fix it. The tests therefore align the actors to the recording
  right before each poke (`flow-harness.ts` `alignActor`), and compare state
  sequences, not frames.
- **The sounds across lag.** The volcano holes lag 4-7 frames over a window,
  which the engine does not model. `trace-hazards.test.ts` carries each
  request's iteration to the engine's frame through the last matched ball
  state.

**Unported, approximated, unconfirmed.**
- The eruption's projectiles (object 84 and its seven children). Their sfx
  `$39` (`$84:E848`, every 12 frames while one spews) is a thread object's,
  not core's. Whether a projectile can touch the ball is unmeasured. None
  did in web_hazad's or web_hazac's windows (all ball states match).
- The hazards' mode-7 destroy (with the modes).
- `$6A8C`, the cup reveal's hold on objects 76 and 77, is from the
  disassembly only; no recording has a reveal on a hazard hole.
- The `$A2` handlers are in no ROM hole. They are checked only on t7, and
  share the box code with `$9653`, which web_haz94 does check.
