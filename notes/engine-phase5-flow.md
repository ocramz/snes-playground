# Engine phase 5: the flow systems

> Promoted 2026-11-14 (engine phase 8): the facts below are in the subsystem docs (physics.md, flow.md, tiles.md, animation.md, audio.md, emulation.md, web-demo.md); the mapping, deviations, unported and unconfirmed lists are in docs/engine.md. This note is kept as the session's record.

Date: 2026-11-14 (session 4). Plan: `plans/port_v1_koota_phaser4.md` item 5,
"The flow systems (aim, spin, meter, launch, still count, camera, pose),
against `flow_web_*.json` and the end-to-end input scripts". The shot guide
came along because the aim camera looks at its end.

## Result

Hole 1 now plays headlessly from its shot set-up, driven by the stepper's own
input scripts with no seed and no pokes.

- **`test/trace-script.test.ts`: all 13 recorded shots pass.**
  - Each run gives the game's exact launch: aim, elevation, velocity and spin.
  - After the launch, every one of the game's distinct ball states follows,
    with zero catch-ups. That is 195-409 states per shot, up to the lost
    ball's freeze.
- **`test/flow.test.ts`: 64 checks over web_flow, web_ui, web_fly and
  web_fly_spin.**
  - Discrete fields match within ±2 frames: the state, facing, angle, aim,
    elevation, side, top/back, meter, over, airborne, the ball's cell, and
    Kirby's kx/ky.
  - The camera is within ±2 px in x and ±8 px in y; on web_flow it is within
    1 px on nearly every frame.
  - The guide's end is within 1 px on at least 95% of the targets the game
    wrote; the fly shots, the lost ball, its reset and the next set-up are
    covered too.
- **`test/flow-units.test.ts`: 14 tests.**
  - The projection is bit-exact on over 100 rolling frames.
  - The facing is correct for every aim of the web_flow sweep.
  - The aim snap, the aim target and the guide's ends are pinned to the
    game's values.
- **Full suite: 176 tests.** `tsc --noEmit` is clean, `vite build` is clean,
  and `make engine-test` is green.

## What was built

| Engine artefact | Original |
|---|---|
| `traits/shot.ts` (world singleton) | the shot driver's globals: `$D9B4/$D9B6`, `$6AD6/$6AD8`, `$6ADE`, `$6AE0`, `$6B50/$6B52`, `$D9B8/$D9BA`, `$6B5C/$6B62/$6B60`, `$6B3A/$6B3E`, `$6ADC`, `$6B54/$6B58`, `$6AE2-$6AEC`, `$6B44/$6B46`, `$6B6C-$6B72`, `$6ACE`, `$6ADA`, `$6AC2` |
| `traits/flow.ts` `HoleFlow` | the hole loop `$80:F278-$80:F3D1`: its blocking waits become phases |
| `traits/camera.ts` | `$38AC/$38AE`, `$38C2-$38C8`, `$39D6`, `$6AAA/$6AAC`, `$6AB0` |
| `traits/guide.ts` | the guide's ends `$6B0C-$6B2A` / `$6AFA/$6B00` and the dots `$B746+` |
| `traits/pose.ts` `Pose`, `BallScreen` | `$D7D4/$D7C4/$D7CC`, `$6A6E`; `$DA56-$DA64` |
| `projection.ts` | `$81:A4C6` (bit for bit) |
| `sim/facing.ts` | `$81:BB4A` + `$81:BCA0` |
| `sim/aim.ts` | the d-pad `$81:B555-$81:B6C2`, `$80:A594`, `$82:AFB0`, the snap `$80:C902`, the nearest enemy `$82:8E41` |
| `sim/camera.ts` | the pan `$81:BA8A`, the shot view `$81:BE9A`, the locked follow `$80:BA35` (`$80:BAB4`, `$80:BB42`) |
| `sim/guide.ts` | the guide driver `$81:A9B8` and its end `$81:AD97` |
| `systems/pad.ts` | the NMI's `$0067/$006B` |
| `systems/hole-flow.ts` | `$80:F73B`, `$80:C4FF`, `$80:C5F1`, the shot's end at `$80:F37A`, the lost ball |
| `systems/aim.ts` | the aim loop `$81:A680-$81:A80A`, `$81:A956` |
| `systems/panel.ts` | the shot thread `$81:BE91-$81:C0EC`; the roll's pose `$82:C815-$82:C84E` |
| `systems/camera.ts` | the roll loop's presentation `$81:A121`, the pans |
| `systems/pose.ts` | the hop's script return, the squash `$81:8C95-$81:8CD2`, the bounce pose `$82:CE07` |
| `schedule.ts` | the frame, and the stall runner moved into its prologue |
| `actions.ts` `startCourse`/`startHole` | the hole's start (phase 6 adds its entities) |
| `ball-step.ts`: arming after the step, `$82:DB20` | `$82:CDFF` / `$82:D588` |

The disassembly read for this phase is in `build/engine/disasm/flow-*.txt`.

## Facts settled (docs candidates)

Each fact is pinned by the tests above. The source is given as disassembly
(dis.), stepper watch, or trace.

**The d-pad turn ($81:B555, dis.).**
- A held direction turns the aim 1° on the first call.
- Then nothing happens until the hold counter `$6ADE` reaches 15.
- From then on it turns 3° per call. Right lowers the aim, Left raises it.
- The measured "held 17 frames → 3° every 3 frames" is this counter plus the
  guide's lag. Each change re-runs the guide, and the aim loop's next
  iteration comes 3 frames later. In web_flow every aim value lands on the
  game's frame.
- Up (held) chooses the fly shot through the kind state `$6AD6` (0 → 2);
  Down (pressed) chooses the grounder.
- L/R snap by 45° through the table `$81:B729`. This is not ported, since
  the keyboard has no shoulder buttons.

**The aim loop ($81:A680-$81:A80A, dis.).**
- On an A press: sfx `$34`, then the loop returns.
- Otherwise each iteration runs, in order:
  1. the d-pad;
  2. the facing, when the aim changed;
  3. a pan toward the guide's end (the target the last guide wrote);
  4. pose 5 while a direction is held, else 4;
  5. `$81:A956`: on a change, sfx `$53` (the tick) and the guide again with
     `$6ACE` = 1.
- In a fly shot, after 16 quiet iterations the full guide runs with
  `$6ACE` = `$6ACC` = 3.
- The values are set at `$83:DFC0` (stepper watch): `$6ACC` = 3,
  `$6B3C` = 63, `$6B5E` = 3.

**The guide ($81:A9B8-$81:AE35, dis.).**
- It runs at the meter's top from the aim's origin. The spin comes from
  `$D9B8/$D9BA`.
- The step limit by kind (`$81:AA3E`) is 40, 80 or 496.
- A rolling guide ends after 40 steps, or when the airborne flag changes. If
  it drops into a gap, the end goes on the crossed edge.
- A fly guide records an end at each landing until `$6ACE` ends. If the ball
  settles, it rolls 40 more steps.
- **The camera's target is always end 0 ($81:AE26).**
- **The guide has its own tile table, `$81:B455`.** Only the outline
  (`$28-$2D`) and the overlay (`$60-$6F`) exist for it; pillars, enemies,
  the cup and every other tile are plain ground. That explains the old
  "the rest run into the pillar" mismatch in docs/web-demo.md.
- The guide's own step `$81:AF82` is not ported. The engine runs the
  BALL_STEP kernels with that tile table instead. Every end of the traced
  sweeps matches.

**The aim target at each set-up.**
- `$82:8E41` (dis., stepper watch): the free enemy nearest the ball, by the
  squared distance of the 8.8 positions; ties go to the first in the list.
  From hole 1's tee, (8,3) and (6,5) tie and (8,3) wins.
- After the reveal, `$82:8B5C` writes the cup's centre. Stepper watch at
  3245: (6:$8C00, 5:$7800).
- `$80:C902` snaps the direction with thresholds 23/68/…/338. This runs at
  every set-up, the first one included.

**The shot thread ($81:BE91, dis. + traces).** Frames are counted from the
press that starts each stage:
- **Pan to the shot view.**
  - The first pan is at A+4.
  - The view is Kirby + `$81:C0F0/$81:C0F8`, by the aim's quarter.
  - The curl (state 6) comes on the frame after a pan finds the camera
    already there (`$6AB0`).
- **Spin stage.**
  - The panel shows the meter as `$FFFF` at curl+39, and 0 at curl+41.
  - The selectors start at curl+42. From curl+43, A ends the stage.
  - Side moves 1 step per 8 frames, with sfx `$46` (not `$42`).
  - Top/back moves 1 step per 3 frames and pauses 6 frames at 0/6/12, with
    sfx `$3D`, or `$42` at 6.
- **Power stage.** Sfx `$57` at +4. From +5, A is tested before the meter
  moves; the meter fires by itself at 0.
- **Launch.**
  - Power and spin at +1 from the latch.
  - The roll starts at +22 (`$82:BFBC`): the follow's lag is the view's
    offset, and the sfx is `$18`, or `$19` at full power.
  - The first physics step is at +24.

**The roll's pose ($82:C815-$82:C84E, dis. + traces).**
- The pose is picked from the latched selectors `$6B54/$6B58`: 14, 16
  (distance 3) or 15 (4 and more).
- web_fly latches top/back at 3, which gives 16; web_fly_spin and web_ui
  give 15.

**The follow ($80:BA35-$80:BB8A, dis.).**
- The wanted lag is −24 × Kirby's motion. It is formed with ROL pairs, the
  integer word is clamped to `$70`/`$60`, and the sign-magnitude is
  negated.
- The lag eases by (|e| >> 5) + 1 on both axes.
- The follow stops once `$D9D2` bit 0 is set.

**The projection ($81:A4C6, dis.).**
- `$8B9A` = header word 5 × 8 (456) and `$8B9E` = header word 7 (232),
  read at `$82:B1E8-$82:B209`.
- The ROL pairs wrap the bits shifted out back into the fraction.
- z goes through the mode-7 multiplier by `$2D42` = `$5A82`/2.
- Kirby's fractions are 0 until the first roll frame, because the turn
  load `$80:F73B` writes only the integers. That is why the follow's first
  x step is small.
- The old `fromRomCourse` read `header[3]` (5472) for `originY`; it now uses
  word 7.

**The fall (dis., stepper `--log-pc` and `--trace`).**
- The projection sets `$D9D2` bit 0 when z drops below 0 (`$81:A516`).
- On the first such frame, `$81:A121`:
  - requests song `$90` (18) at `$81:A175`;
  - blocks about 3 frames in the APU port handshake `$80:B70A`. Both fly
    traces show a gap from record 3252 to 3256.
- After that:
  - the follow stops;
  - `$6A88` counts 240 frames to "shot over" (or less if z < −$18_0000);
  - the hole loop's lost path puts the ball back at the shot's origin
    81 frames after "over", with the block's airborne flag at 1;
  - the next set-up comes 334 frames after that;
  - the retake reloads the shot's own elevation, because `$80:F3A6` is
    skipped.
- The phase-4 "BallLost 174 frames" was the stretch from the step's
  `$81:89B2` freeze to the reset.

**The A/Y arming ($82:DA51, dis.).**
- It runs after the step (`$82:CDFF`/`$82:D588`) on the same frame's
  `$006B`.
- The window `$DA78` is `$16` = 22. Phase 4 had `$78`, which is the type of
  the object it spawns.
- Y plays no sound and sets no pose. A sets the hop pose only when grounded,
  or in the air with no spin.
- The speed limit drops the arming.
- `$82:DB20` (the bounce bonus) is now ported. It runs while the countdown's
  timer is non-zero, or on the arming frame.
- An airborne bounce sets pose 14 unless Kirby is hopping (`$82:CE24`).

**The hit-stop pad ($81:8CAB-$81:8CDE, dis.).**
- The stall ORs both held and pressed over its frames and hands them back.
- A press during a hit-stop is therefore not lost. This corrects
  phase 4's note.

**`$80:C60A`'s pose 4** is stored through an X that the calls before it
leave. No state change shows in any flow trace; the first aim iteration
sets 4 or 5.

## A phase-4 bug the guide exposed

**The outline wall's cross-cell branch ($82:903D-$82:9067).**
- The ROM computes the move code from current − previous cell, and checks
  the line-touch table with the *current* tile.
- The phase-4 port had the difference reversed and used the previous tile.
- No phase-4 trace crossed the outline between two cells. The guide at aim
  214 does (web_flow 2563), and the fix makes its end match the game's.

## Unported, approximated, deferred

- **The guide's lag is measured, not modelled.** The game's next aim
  iteration comes 1 + ceil(steps / 20) frames later for a rolling guide (3
  for 40 steps, every auto-repeat step of web_flow), and 5 frames later
  for a fly guide (web_ui 2600/2605). Shorter rolling guides and the full
  fly guide are unverified.
- **The APU handshake's lag** (4 frames) is measured on the fall song only.
  Other song requests (the hole song, the hole-out songs) probably lag the
  same way; phase 6 and 7.
- **Kind 1** (Down after a grounder: an 80-step guide with its own gap end,
  `$81:AAF3`) is approximated as kind 0 with 80 steps.
- **Not ported in the aim loop:**
  - B (the overview, `$83:B214`; panel cancel `$81:C089` with the unroll
    pose 7 and a retake);
  - Y (look around, `$81:B9A2`; the score panel);
  - Start (`$83:AFA7`);
  - L/R;
  - the idle timer `$6AC2` (recorded only).
- **Presentation spawns are left to the bridge (phase 7):**
  - the curl stand-in (type `$1A`), the "1" (`$12`) and the panel (`$10`);
  - the meter object (`$18`), the full-power object (`$16`) and the kick
    effect (`$19`);
  - the hop object (`$78`) and the outline-wall effect (`$47`);
  - the score-panel toggles `$83:AF82/$83:AEEB`.
- **Events emitted, with their sfx or song ids:**
  - `aim-confirm` `$34`, `aim-tick` `$53`;
  - `spin-side` `$46`, `spin-tb` `$3D`/`$42`;
  - `power-start` `$57`;
  - `launch` `$18`/`$19`;
  - `modifier` `$26`;
  - `song` 18 (the fall).

  `tools/web_audio_map.json` renders none of 70 (`$46`), 83 (`$53`),
  87 (`$57`) or 25 (`$19`) yet; phase 7 adds them. Its descriptions of 52,
  61 and 66 are corrected.
- **The aim target is the course's enemy list as placed.** Phase 6 tracks
  takes and the cup. Until then web_flow is compared only up to its cup
  reveal at 3245.
- **2P:** the follow's states 0/1 (the stepped catch-up `$80:B9CE`) and the
  other player's turn.

## Deviations (for docs/engine.md)

- **The stall runner lives in the frame's prologue.** Its kinds:
  - `hitStop` and `stepStop` resume the ball step mid-list;
  - `guideLag` and `apuLag` stand for the original's main loop being busy
    (the guide's simulation, the APU handshake), and their last frame is an
    ordinary one;
  - `cupReveal` is phase 6.
- **The guide's result is published on a later frame.** The ROM writes
  `$6AAA` at the guide's end, inside the lag. The engine computes the guide
  at once and publishes the target on the next frame that runs, before the
  camera pans.
- **`BallWork.fellOut` separates two causes that share one bit.** It marks
  the step's own fall-below-course; `$D9D2` bit 0 is also the projection's
  "below zero" flag.
- **The guide's `$6A18` is written back to the live work copy.** The ROM's
  guide runs on the real work copy, and `$6A18` is outside the block.
- **Kirby's pose is written at the ROM's sites.** That is the aim loop, the
  curl, the roll start, the reset, and `update-pose` (the hop, the squash,
  the bounce). It is not derived from scratch each frame.

## Harness notes

- `GAME_OFFSET` = 2332: engine frame f is game frame f + 2332, pinned on
  web_flow's set-up (`$80:C4FF` writes the aim at 2334, the set-up's
  second frame). Every script starts hole 1 with `2100 A`, so the same
  offset holds for all.
- `test/flow-harness.ts` records the same names as trace_flow.py.
- `npm run traces` now also records the flow of web_fly and web_fly_spin
  (4400 frames, through the lost ball and the next set-up).
- trace-shots (seeded) injects its presses one record earlier (3021/3201)
  because the arming now runs after the step, as the ROM's does.

## For phase 6

- The aim target after the cup appears (`$82:8B5C` writes `$6B6C-$6B72`),
  and the takes (`$539C` owner 2 → free).
- The cup reveal's stall (web_flow 3245→3345), so that web_flow's second
  shot (aim 180 at 3507) and the rest of its trace can be compared.
- The tomato count (`$D7F0`, −1 at `$83:ABC5` at the roll's start), the
  tired pose 11, strokes `$D82A` (now `HoleFlow.shots`), lives.
- HoleDone (the hole-out `$82:AD13`).
