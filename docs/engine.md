# The engine: the 1-player loop on Koota × Phaser 4

`engine/` reimplements the game's playable 1-player loop. The game's state and rules are an ECS world in [Koota](https://github.com/pmndrs/koota) 0.6.6. Phaser 4.2.1 is only the platform: it draws, plays sounds and reads the keyboard, and a thin bridge is the only code that touches both. The architecture follows `reference/koota_phaser4.md` and the plan `plans/port_v1_koota_phaser4.md`. The working notes of phases 4-7 are `notes/engine-phase{4,5,6,7}-*.md`.

What it plays:
- course 1's eight holes, with the course bitmaps, sprites, panel, font and sounds exported from the ROM;
- eight small test holes written for the engine (`engine/courses/`);
- random holes, generated from a seed and checked winnable with the engine's own physics (`random.html`, "Random holes" below).

The holes without ROM bitmaps are drawn with exemplar patches of the ROM's course art ("Random holes": the styled terrain).

A hole runs from the star's fly-in to the fly-out, with every turn, take, reveal, tomato, life and hole-out in between, then the course card, GAME OVER and CONTINUE.

How it is checked: the core is compared frame by frame with the headless stepper's recordings of the real game ([emulation.md](emulation.md)), and the shot panel pixel by pixel with the game's own sprites. The facts the port settled about the game are in the subsystem docs: [physics.md](physics.md), [flow.md](flow.md), [tiles.md](tiles.md), [animation.md](animation.md), [audio.md](audio.md), [emulation.md](emulation.md) and [web-demo.md](web-demo.md). This doc is about the port: how the game maps onto the engine, where the engine deviates from the game, and what is left.

`web/` (the earlier one-hole demo, [web-demo.md](web-demo.md)) was not used as a source.

## Running it

```bash
make engine-assets        # build/engine/assets: the ROM's sprites, panel, HUD, font, audio,
                          # cutscenes, objects and course 1's holes (needs the stepper's outputs)
make engine-test          # the vitest suite (ROM-derived tests skip without build/engine)
make engine-traces        # re-record the trace fixtures into build/engine/rom-test (stepper runs)
make engine               # npm ci + vite build -> engine/dist
cd engine && npm run dev  # http://127.0.0.1:5174/
make engine-e2e           # browser smoke tests (index.html, random.html), against the running dev server
make engine-random        # the dev server, opening random.html: a course of random holes
python3 tools/check_web_ui.py --target engine   # the shot panel, pixel for pixel (dev server up)
```

URL flags:

| flag | does |
|---|---|
| `?nointro` | skip the fly-in; the host plays the hole's song itself |
| `?hole=N` | start the chosen course at hole N |
| `?debug` | exposes `window.__engine`: `phase()`, `frame()`, `scroll()`, `kirby()`, `depths()`, `warp()`, `step(pad, n)`, `freeze()`, `isolatePanel()`, `hitNextEnemy()`, `putOnCup(lift)`, `placeBall(p)`, `freeEnemies()`. Key D toggles the procedural terrain over a ROM hole or a styled one. On `random.html`, `window.__random`: the seed, the difficulty, and each hole's JSON, par and plan |
| `?seed=N` | `random.html`: the course's seed (else a fresh one, written back to the URL) |
| `?difficulty=` | `random.html`: `easy`, `normal` (the default) or `hard` |

| key | pad |
|---|---|
| arrows | the d-pad |
| Z or Space | A |
| X | Y |
| C | B |
| Enter | Start (and the menus) |
| Q / W | L / R |
| Esc or P | pause (also on losing focus) |

## Layout and the dependency rules

```
engine/
  courses/            the test holes (*.course.json; README.md is the format)
  index.html random.html  the two pages: main.ts (the course menu), random.ts (random holes)
  src/core/           imports koota only
    fixed.ts rules.ts terrain.ts projection.ts course-data.ts occlusion.ts sweep.ts
    gen/              the random holes: layouts, placement, features, the shot simulator and solver
    sim/              kernels: pure functions over the ball's work copy, one per routine
    traits/           state: world singletons, the ball, the hole's entities
    systems/          the frame's systems; schedule.ts orders them
    actions.ts events.ts world.ts
  src/game/
    bridge/           host frame, input, view binding, the presentation systems
    features/         one folder per domain: views, layout, audio, the cutscene
    assets/           keys, schemas, atlas conversion, course sets
    scenes/           Boot, Preload, Menu (or RandomMenu), Hole, Hud, Result
    boot-game.ts      the world, the host and the Phaser game, shared by both pages
  test/               vitest (node); test/e2e: Playwright scripts
```

The rules (reference §3), checked statically by `test/no-phaser-in-core.test.ts`:
- **Core imports Koota only.** No file under `src/core` imports `phaser`.
- **The view reads traits and calls actions.** Nothing under `src/game` imports `core/systems` or `core/sim`. Views read core's traits; scenes call core's actions and run its schedule (`runCoreFrame`).
- **The pure half of the bridge imports nothing from Phaser**, so the node tests run it:
  - `bridge/{tick-time, frame-loop, history, placement}`;
  - `features/{catalog-data, kirby/pose-clips, kirby/sprite-rules, layers/layer-depth, audio/event-table, cutscene/replay, cutscene/director, shot-panel/panel-layout, shot-panel/panel-state, guide/guide-dots, hud/hud-state, text/encoding, enemies/cup-mask, warp/warp-frames, layers/styled}`;
  - `assets/schema`, `config`.
- **There is no global world.** `boot-game.ts` creates it with `createGameWorld()` and passes it in the scenes' data (`game/host.ts`).

## The event model

One rule for the whole codebase (plans "The event model"):

| kind | in the game | in the engine | lives | read by |
|---|---|---|---|---|
| state | WRAM: the player block `$D87A`-`$D96E`, `$D7F0`, `$D82A`, the owner `$539C`, … | traits, tags, relations | persistent | systems, views |
| fact | per-frame flags `$DA4E/50/52`, the probe `$D9FC`-`$DA0A`, the edges `$D9E4/E6`, `$DA4C`, the step's branch | fields of the AoS `BallWork` (the work copy `$D9C6`-`$DA6E`), reset in `begin-ball-step` | one ball step, across a stall | later systems of the step |
| event | every sound or song request, and the presentation spawns | an entity with `Event {kind, frame, seq, romSfx, subject}` (`core/events.ts`) | until drained | the bridge, the tests |

The rules that go with it:
- Systems never read events; they read state and facts.
- Only systems emit (`emit`, `emitEvent`). Kernels never do, so the shot guide runs the same kernels silently.
- `drainEvents` returns the events in `seq` order and destroys them. The bridge drains once per host frame, the headless harness once per core frame.
- Anything that persists on screen (the tee, the cup's ring, a taken enemy's star) is a state entity with `Visual`, not an event.

## The frame

`runCoreFrame(world)` (`core/schedule.ts`) is one main-loop iteration of the game. While `IsPaused` is on the world it does nothing. Otherwise it runs:

| # | system | the game's routine | file |
|---|---|---|---|
| 1 | advance-frame | the frame counter | `schedule.ts` |
| 2 | latch-pad | the NMI's `$0067/$006B` | `systems/pad.ts` |
| 3 | tick-stall | `$81:8C95` (hit-stops), `$82:8B5C` (the reveal), the guide's and the APU's lag | `schedule.ts`, `traits/stall.ts` |
| 4 | update-hole-flow | the hole loop `$80:F278`-`$80:F48C` as phases | `systems/hole-flow.ts` |
| 5 | setup-shot | `$80:F73B`, `$80:C4FF`, `$80:C5F1` | `systems/hole-flow.ts` |
| 6 | update-aim | the aim loop `$81:A680`-`$81:A80A`, the d-pad `$81:B555`, the facing `$81:BB4A` | `systems/aim.ts`, `sim/aim.ts`, `sim/facing.ts` |
| 7 | update-shot-guide | `$81:A956` → `$81:A9B8` | `systems/aim.ts`, `sim/guide.ts` |
| 8 | update-spin-stage | the shot thread `$81:BE91`-`$81:BFCC` | `systems/panel.ts` |
| 9 | update-power-meter | `$81:BFDC`-`$81:C032` | `systems/panel.ts` |
| 10 | launch-ball | `$81:C035`-, `$81:C2E6`, `$81:C1D5`, the roll's start `$82:BFBC` | `systems/panel.ts`, `sim/shot.ts` |
| | **the ball step**, in Rolling (`BALL_STEP`, `systems/ball-step.ts`) | | |
| 11 | load-ball-work | `$82:F030`: the block → the work copy | |
| 12 | begin-ball-step | `$81:801C`'s prologue, `$81:8751` | |
| 13 | move-probe-edges | `$81:8805` / `$81:89C2`, drag `$81:885C`, the fall `$81:89AA`, `$81:8E60`, the probe `$81:9479`, `$81:87FB`, `$81:9001` | `sim/move.ts`, `sim/reflect.ts`, `sim/probe.ts`, `sim/edges.ts` |
| 14 | select-outcome | `$81:8069`-`$81:811A` / `$81:80F4`-`$81:811A`: wall, step, drop or dispatch | |
| 15 | bounce-off-wall | `$81:9390` | `sim/wall-step.ts` |
| 16 | hit-step | `$81:93D1` (via `$81:88C4` / `$81:8A19`) | `sim/wall-step.ts` |
| 17 | drop-off-edge | `$81:8B78` | `sim/wall-step.ts` |
| 18 | dispatch-tile | `$81:811B` / `$81:8436` and the tile handlers | `sim/dispatch.ts`, `sim/outline.ts`, `sim/cup.ts`, `sim/enemy.ts`, `sim/hazards.ts` |
| 19 | take-enemy | `$82:8A2E`, `$82:8A98`; the reveal `$82:8B5C` | `systems/take.ts`, `systems/reveal.ts` |
| 20 | warp | `$82:AA02`, inside the warp panels' handlers: the move to the other panel, the turn to its arrow; the step blocks for the warp | `systems/warp.ts`, `sim/warp.ts` |
| 21 | dispatch-landing | `$81:8905`'s first half (the hit-stop splits it) | `sim/landing.ts` |
| 22 | finish-landing-or-roll | `$81:895B`-`$81:89A9` / `$81:8A56` | `sim/landing.ts`, `sim/roll.ts` |
| 23 | emit-step-effects | the tail `$81:9BE5`: facts become events | |
| 24 | arm-shot-modifier | `$82:DA51`, `$82:DB20` (from `$82:CDFF`) | |
| 25 | store-ball-work | `$82:F1E3` | |
| 26 | count-still-frames | `$81:A5CD` | `sim/still.ts` |
| 27 | hazard-reaction | `$82:C0A8` → `$82:DB9A` | `systems/hazard-reaction.ts` |
| | **after the step** | | |
| 28 | detect-ball-out | `$D956`, `$D9D2`, the hazards | `systems/hole-flow.ts` |
| 29 | update-camera | the pans `$81:BA8A`, the follow `$80:BA35`, the roll loop's `$81:A121` | `systems/camera.ts`, `sim/camera.ts` |
| 30 | update-ball-sprite | the roll loop's `$82:F4FD`: Kirby's OAM priority `$D96A`, behind the course over a gap (table 10) or below z 0 | `systems/ball-sprite.ts`, `sim/priority.ts` |
| 31 | update-pose | the hop's return, the squash `$81:8C95`-`$81:8CD2`, the bounce pose `$82:CE07` | `systems/pose.ts` |
| 32 | the thread tick | the scheduler in `$80:8F78`: the HUD's tomato queue `$84:98EC` → `$83:ABDD`, the hazard actors `$80:E0C0` | `systems/counters.ts`, `systems/actors.ts`, `sim/actors.ts` |

The ball step's order is the game's. It differs from the plan's in two places:
- the A/Y arming (the plan's item 12) runs after the physics, together with the bonus, as the Kirby state code does;
- the hazard reaction is an addition.

Systems 12-22, except take-enemy and warp, are marked `kernel`. The shot guide runs them on a cloned work copy with no buttons, no stalls and no events (`runKernelStep`).

**The stall runner** stands for the game's main loop being blocked inside one routine (`traits/stall.ts`). While a stall is active, a frame runs only that stall's own list:

| kind | the game | own list | the threads run |
|---|---|---|---|
| `hitStop` / `stepStop` | `$81:8C95` waits 4 (a landing, `$81:8C79`) or 2 (a step hit, `$81:8C48`) frames inside the step | the squash pose; the pad ORed into a latch | yes |
| `cupReveal` | `$82:8B5C`, the last enemy becomes the cup inside the step | `tickReveal` (`systems/reveal.ts`) | yes |
| `takeWait` | `$82:8A83`'s 4 frames after an ability enemy's take | — | yes |
| `warp` | `$82:AA02`, a warp panel takes the ball to the other one inside the step | `tickWarp` (`systems/warp.ts`) | yes |
| `guideLag` | the aim loop's guide simulation outlasts the frame | — | no |
| `apuLag` | a song request blocks in the APU handshake `$80:B70A` | — | no |

A stall of N frames requested in frame F idles frames F+1 to F+N−1, and the suspended step resumes at `resumeAt` in F+N. A guide or APU lag's last frame is an ordinary frame instead.

## Traits

World singletons (`world.add` at creation, `core/world.ts`):

| trait | fields | the game | file |
|---|---|---|---|
| `Time` | frame | the frame counter | `traits/time.ts` |
| `Pad` | raw, held, pressed, prev, stallLatch, stallPressed (SNES bit layout) | `$0067/$006B`, `$6A7C/$6A7E` | `traits/pad.ts` |
| `Session` (AoS) | the rules, the course list, the hole index, the hole's kernel context | — | `traits/session.ts` |
| `IsPaused` | tag | — (`pause` / `resume`) | `traits/session.ts` |
| `Course` (AoS) | w, h, shape, elev, walls, layer2 (written at run time: the cup), the tee, originY, screenBase, the enemy cells | `$6B90`, `$8390`, `$7390`, layer 4, `$8B9A`/`$8B9E` | `traits/course.ts` |
| `HoleFlow` | phase, since, prev, holeInOne, length, next | the hole loop's position | `traits/flow.ts` |
| `Shot` | aim, elevation, kind, hold, side, top/back, their timers, meter, power, the latched selectors, the target | `$D9B4/B6`, `$6AD6/D8`, `$6ADE`, `$6B50/52/5E`, `$6B3A/3E`, `$6ADC`, `$6B54/58`, `$6B6C`-`$6B72`, … | `traits/shot.ts` |
| `Camera` | x, y, wanted and reached lag, mode, target, arrived | `$38AC/AE`, `$38C2`-`$38C8`, `$39D6`, `$6AAA/AC`, `$6AB0` | `traits/camera.ts` |
| `Guide` (AoS) | the dots, the ends, steps, version, pendingFrame | `$B746`+, `$6B0C`-`$6B2A` | `traits/guide.ts` |
| `Stall` | kind, framesLeft, resumeAt, variant, sfx, the suspended step's route | — | `traits/stall.ts` |
| `Reveal` | stage, t, total, the cup's cell, the saved camera, the pan target, onScreen, hoverFrames, panned | `$38B4/B6`, `$ECBB/BD` | `traits/reveal.ts` |
| `Warp` | stage, t, the two cells, the pan target, where Kirby went in, hidden | `$DA58/$DA5C`, `$0B7E/$0B82`, `$6A48` | `traits/warp.ts` |
| `Hazards` (AoS) | the actors' run state, object 76's list, the cell index | `$B6BA`, `$ABB8`, the thread slots | `traits/hazards.ts` |
| `Career` (AoS) | lives, the card | `$D7F4`, `$D80A` | `traits/counters.ts` |
| `TomatoQueue` (AoS) | the ring, the pending change, the timer, the HUD's shown flag, hold | `$68FA`, `$68F4` | `traits/counters.ts` |

The player's ball, spawned by `startHole` with `Visual {kind: 'ball'}`:
- the block, SoA: `BallPos`, `BallVel`, `BallAir`, `BallSpin`, `BallMode` (always 0), `BallHoled`, `BallHeading`;
- persistent, SoA: `StillCount` (`$D9BE/C0`), `Modifier` (`$DA76/78/7A`), `Tomatoes` (`$D7F0`), `Strokes` (`$D82A`), `Stars` (`$6A10`), `StockedAbility` (`$D852`);
- `Pose` (`$D7D4`, `$D7C4`, `$D7CC`, `$6A6E`), the semantic state only, never a clip;
- `BallScreen` (`$DA56`-`$DA64`);
- `BallSprite` (`$D96A`): Kirby's OAM priority, 3 except behind the course (1 or 2);
- `BallWork` (AoS): the work copy with its facts.

The hole's entities, spawned from the load-time sweep (`sweep.ts`, `$82:B320`; `traits/hole.ts`):
- the root `IsHole` + `HoleInfo`; every other hole entity carries `InHole(root)` with `autoDestroy: 'orphan'`;
- `IsTee`; `IsPillar`; `IsHazardActor` + `ActorType`;
- the enemies, `IsEnemy` + `EnemyKind` + `Hover` + `Cell`, with `TakenBy(player)` (exclusive, `$539C`) once taken;
- `IsCup`, added to the last free enemy (`$B4B8` = 8).

`Visual {kind}` is the semantic kind a view draws: `ball`, `tee`, `enemy`, `star`, `cup`, `pillar`, `hazard`. The bridge adds one view-only trait, `Ref`, which holds the entity's view.

## The hole flow and the actions

`HoleFlow.phase` turns each blocking wait of the game's hole loop into a phase with a timer. Each phase's measured frames are in [flow.md](flow.md):

| phase | the game | next |
|---|---|---|
| Idle | no hole running | `startCourse` / `startHole` |
| ShotSetup | `$80:F73B`, `$80:C4FF`, `$80:C5F1` (3 frames) | Aim |
| Aim | `$81:A680`-`$81:A80A` | A → PanToShot |
| PanToShot | `$81:BE91`: the pan to the shot view | arrived → Spin (the curl) |
| Spin | `$81:BF07`-`$81:BFCC` | A → Power |
| Power | `$81:BFDC`-`$81:C032` | the latch or the auto-fire → LaunchDelay |
| LaunchDelay | `$81:C035`- | R + 24 → Rolling |
| Rolling | the roll loop `$82:C052`-; the reveal's stall | the shot over → RollEnd |
| RollEnd | `$82:C172`: until the HUD's tomatoes hide | holed → HoleOut; lost → BallLost; else SettleWait |
| SettleWait | `$80:F39F` + the turn top | ShotSetup, Tired, or OutOfTomatoes |
| Tired | `$80:C79A` | ShotSetup |
| OutOfTomatoes | `$82:E1EE` + `$80:F85C` | ShotSetup on the same hole, or GameOver |
| BallLost | `$80:F830` | Respawn, or GameOver |
| Respawn | `$83:9589`, `$80:F8C5`, `$80:F8DA` | ShotSetup |
| HoleOut | `$80:F48C`: the pan, the card, the songs, the 1UP | HoleOver |
| HoleOver | the RESULT card `$83:D3ED` | `nextHole` |
| GameOver | scene 9 (`$83:D856`) | `continueGame` / `endGame` |
| CourseDone | after the last hole | `endGame` |

The actions (`core/actions.ts`) are the only way in from outside:
- `startCourse(world, rules, courses)`, `startHole(world, i)`, `nextHole` (null after the last hole);
- `continueGame`, `endGame`, `pause`, `resume`;
- `placeBall` (the poke equivalent, for the tests and `?debug`).

`startHole` destroys the previous hole's root, spawns the new one and puts the flow at ShotSetup.

Course data comes from two places (`core/course-data.ts`):
- `fromRomCourse(course.json)` reads an exported ROM hole; the Preload scene and the test fixtures share it;
- `fromAuthoredCourse` reads the test holes' own format, validated: one tee on flat ground, at least two enemies, no ability enemy, no actor on a gap, warps in pairs.

Either way the course carries Kirby's occlusion table, table 10 (`core/occlusion.ts`). A ROM hole has the game's own, exported as course.json's `occlusion`. An authored hole gets the one `buildOcclusion` makes from its shape layer.

## The bridge and the view

**The host frame** (`HoleScene.update`, `bridge/frame-loop.ts`):
1. `FrameClock` accumulates real time at 60.0988 Hz and yields N ≤ 4 core frames. On a longer stall it drops the backlog.
2. For each core frame:
   - the cutscene director may hold the core (the intro, below);
   - otherwise `capture-input` writes `Pad.raw` and `runCoreFrame` runs;
   - `CoreHistory` samples what the view needs from past frames (phase starts, the meter).
3. Once: `drainEvents`, plus the cutscene's own cues, then the presentation.
4. The flow's hand-offs:
   - HoleOver: the scene restarts on the next hole;
   - GameOver and CourseDone: the Result scene;
   - Idle: the menu.

**The presentation** (`bridge/schedule.ts`), in order:

| system | does |
|---|---|
| bind-views | `Visual` without `Ref` → a view from the catalog; `Removed(Visual)` → release; a changed kind (enemy → star or cup) → rebind |
| sync-transforms | each view placed: the ball at `BallScreen`, the actors at their cell corner and `actorGround` (`bridge/placement.ts`, the core's `project`) |
| sync-depth | the depth bands: BG3 0, back 10, front 12, decals 20, guide 25, actors 100 + y × 10⁻⁵, cutscene sprites 900, panel 1100, fade 2000. Every sprite of play is OAM priority 3, over both course layers, except Kirby behind the course: `BallSprite.prio` 1 puts him at 5 (under both layers), 2 at 11.5 (under the front one; `features/kirby/sprite-rules.ts`) |
| sync-camera | the scroll from `Camera` (`scrollOf`), or the replay's camera during a cutscene |
| sync-layers | the outline's colour walk (`$98:D3E6` from `tables.json`), the water's ripple on holes 7 and 8 (`layers.json` `ripple`: `$84:8533`, sets A B A C of `$98:E030`, 8 frames each), the night swap |
| sync-guide | the guide's dots and cone, in the Aim phase only |
| sync-pose | Kirby's clip from `Pose` |
| sync-cup-mask | the cup's near rim over Kirby while object 75 is up: Kirby cut off below it, the ring raised over him (`features/enemies/cup-mask.ts`) |
| sync-warp | objects 63 and 64 from `Warp` (`features/warp`) |
| sync-panel | the shot panel from `panel-state` |
| sync-cutscene | the replay's sprites and fade |
| play-feedback | the events → effects and music (the event table below) |

**The views** (`features/view-catalog.ts`; pictures from `features/catalog-data.ts`):

| kind | view | pictures |
|---|---|---|
| ball | `KirbyView` | the atlas's Kirby clips by `poseClip(state, facing, angle, variant, tomatoes, air)`; the `shadow` frame under an airborne ball, but not in the cup, over a gap or below z 0 (`$81:A23E`); under the course's layers at priority 1 or 2; off while `Warp.hidden`; cut off below the cup's rim (`cupmask`, object 75's shape) |
| enemy / star | `EnemyView` | `enemy_idle`, then `star`; the hover lift |
| cup | `CupView` | the hover drop, `cup_open` and the ring `cupring` from `Reveal.stage` |
| tee | `TeeView` | `tee` (the pad, object 108) |
| pillar | `PillarView` | `tree` |
| hazard | `HazardView` | the `objects` atlas by actor type, direction and frame; a marker if a sheet is missing |
| (course) | `LayersView` | the exported bitmaps, with the water's ripple overlays shown by phase; the procedural terrain for test holes and `?debug` |
| (guide, panel, cutscene) | `GuideView`, `PanelView`, `CutsceneView` | `ui.json`'s pictures; `cutscenes.json`'s |
| (warp) | `WarpView` | the `objects` atlas: object 63 where Kirby went in, 64 where he comes out, frame by frame as web_warp recorded them (`features/warp/warp-frames.ts`) |

**The scenes** (`game/scenes/`):
- Boot and Preload. Preload loads `tables.json`, the atlases, `ui`, the HUD, the font, the audio, the cutscenes and course 1's eight holes. It turns the atlases into textures with custom pivots and into global animations. A clip's looping tail becomes a second animation, chained.
- Menu: course 1 or the test holes.
- Hole: the only simulation host.
- Hud: runs in parallel and reads the world.
- Result: the course card; GAME OVER with CONTINUE.

**The cutscenes** (`features/cutscene/`) are a replay of one recorded run ([web-demo.md](web-demo.md) "The intro and the hole-out (measured with the stepper)"), drawn by a sprite pool relative to two anchors, the tee pad and the cup's ring. The director ties them to core:
- **The intro** holds the core for its first 164 frames. `startHole` has spawned the hole, so the course and the enemies show. The set-up then runs under the intro's last frames: the recording's game frame 2333 is core's first set-up frame.
- **A hole-out** starts on the frame the ball has sunk, as the recording's index 2. It follows core's HoleOut:
  - until the camera reaches the cup (C = `HoleFlow.since` + `length`), the index is f − H;
  - from C on, it is 29 + f − C.

  Core's songs and HoleOver then land on the recording's own indices (the `director` test).
- **The cues.** The replay plays the intro's song and effects and the hole-outs' `$1D`, `$67`, `$3E` and `$2D`. The cues core already emits are dropped: the hole-out songs and `$21`.

## The event table

Every kind core emits, from `features/audio/event-table.ts`, which `test/event-table.test.ts` checks against `audio.json` and against what the test courses and 12 stepper scripts emit. The ids are effect numbers in hex, except for `song`, where it is the song number in decimal (request `$7E` + n; 0 stops the music).

| kind | ids | the game's site | emitted in | the view |
|---|---|---|---|---|
| aim-tick | `$53` | `$81:A98B`, after the guide | `systems/aim.ts`, `schedule.ts` | effect |
| aim-confirm | `$34` | `$81:A791`, A in the aim | `systems/aim.ts` | effect |
| spin-side | `$46` | `$81:C16C` | `systems/panel.ts` | effect |
| spin-tb | `$42`, `$3D` | `$81:C19F` / `$81:C1A4`: top/back at 6, at 0 or 12 | `systems/panel.ts` | effect |
| power-start | `$57` | the power stage + 4 | `systems/panel.ts` | effect |
| silence | 0 | `$81:C038`, `$81:C046`, `$82:E206` | `systems/panel.ts`, `systems/hole-flow.ts` | stops the effects |
| launch | `$18`, `$19` | `$82:BFF0` (`$19` at full power) | `systems/panel.ts` | effect |
| modifier | `$26` | `$82:DA97`, A armed mid-roll | `systems/ball-step.ts` | effect |
| bounce | 1, 2, 3, 5, 6 | `$81:9BE5` by vz; `$81:9BF4` the spin streak (5, 6) | `systems/ball-step.ts` | effect |
| step | 4 | a step hit | `systems/ball-step.ts` | effect |
| wall | 7 | `$82:91E6`, the outline wall | `sim/outline.ts` → the tail | effect |
| tile | `$1A`, `$5F`, `$60`, `$6F`, `$11`, `$7C`, `$0C` | the tail: friction, rough, `$05`, snaps, a cone, an arrow panel (`$82:A7D6`) | `sim/dispatch.ts`, `sim/hazards.ts` → the tail | effect |
| pillar | `$71` | `$82:956C` / `$82:95F8` | `systems/ball-step.ts` | effect |
| hazard | `$6F` | `$82:9C9D`, a bumper | `systems/ball-step.ts` | effect |
| hazard-hit | — | `$82:EED8`, object `$2F` | `systems/ball-step.ts` | nothing (not drawn) |
| thrown | `$7B` | `$82:DB9A` code `$0F`, a volcano | `systems/hazard-reaction.ts` | effect |
| enemy-taken | `$4F`, `$50` | `$82:8A92` / `$82:8A79` (an ability enemy) | `systems/take.ts` | effect |
| cup-reveal | `$1C` | `$82:8D49`, the ring stage | `systems/reveal.ts` | effect |
| warp | `$76`, `$77` | `$82:AABC` the ball goes in, `$82:AB7C` it comes out | `systems/warp.ts` | effect |
| holed-in | — | `$82:AD13`, object 75 over the cup | `systems/ball-step.ts` | the cup's rim mask, 2 frames on (`bridge/sync-cup-mask.ts`) |
| holed | `$21` | `$82:AEF5`[mode], the sink's end | `systems/ball-step.ts` | effect |
| music-mute | — | the sink's end: the music's volume 0 (`$80:B5F4`) | `systems/ball-step.ts` | music gain 0 |
| tomato-gain | `$52` | `$83:AC07`, the HUD queue | `systems/counters.ts` | effect |
| tomato-loss | `$10` | `$83:AC18`, the HUD queue | `systems/counters.ts` | effect |
| ball-lost | `$54` | `$80:F848` | `systems/hole-flow.ts` | effect |
| life-lost | `$0B` | `$80:F8D0` / `$80:F876` | `systems/counters.ts` | effect |
| life-object | `$77` | `$80:F89B`, object `$40` | `systems/hole-flow.ts` | effect |
| game-over | — | `$80:F387` / `$80:F3B5` | `systems/hole-flow.ts` | nothing (the Result scene follows the phase) |
| song | 0, 11, 17, 18, 24, 25, 26 | `$80:B4AC` | `systems/hole-flow.ts`, `systems/camera.ts` (the fall) | the music: its own source node with the loop points; 0 stops |
| cue | 29, 45, 47, 62, 98, 100, 103 | `cutscenes.json`'s cues | the bridge (`cutscene/director.ts`) | effect |

`test/events.test.ts` checks the timing: every request the game makes from its main loop and physics matches an engine event in the same iteration with the same id. It covers seven recorded runs, about 230 requests. `trace-hazards.test.ts`, `trace-terrain.test.ts` and `trace-warp.test.ts` do the same for the poked scenarios.

## The assets

`make engine-assets` runs the web demo's exporter into `build/engine/assets` (`tools/export_web.py --only font,hud,sprites,ui,audio,objects`, then `course,layers` per hole, then `tools/terrain_style.py`, then `manifest`). The rules and the test fixtures go to `build/engine/rules` and `build/engine/rom-test`. Vite serves `build/engine` as the public directory.

| asset | ROM source | exporter step | output | engine consumer |
|---|---|---|---|---|
| physics constants and tables | the ROM tables, each with its `$bank:addr` (the outline walk `$98:D3E6` included) | `tables` | `rules/tables.json` | `RomRules` (`core/rules.ts`) |
| Kirby's clips | the `$87` script engine plus live captures (`tools/kirbyanim.py --clips`; [animation.md](animation.md)) | `sprites` | `sprites.png/json` frames and clips | Preload's `addAtlasFrames` / `addAtlasClips`; `KirbyView` |
| enemy, star, cup, tee pad, tree, shadow, guide | live VRAM/CGRAM of the c1n replay; snapshots for the guide (`export_web_sprites.py`, `emusheets.py`) | `sprites` | the same atlas | the views |
| the hazard actors 76, 77, 81-83; the warp's 63 and 64 | `build/sprites/emu/obj_NNN`, emulated sheets ([graphics.md](graphics.md) "From live state") | `objects` | `objects.png/json`: frames `oNNN_K_II` and their tables | `HazardView`, `WarpView` |
| the cup's rim, object 75 | its sheet from the c1n replay (`build/web-sprites/obj_075`) | `sprites` | the atlas frame `cupmask` (only its shape is used) | `sync-cup-mask` |
| the intro and the hole-outs | an every-frame trace of c1n (`tools/snesstep/trace_cutscene.py`) | `sprites` (`build_cutscenes`) | `cutscenes.json` + atlas frames `cs_*` | `features/cutscene` |
| course bitmaps | bank `$88` course tables + BG3 scenery; on a water hole the tiles `$91:ED29` and the ripple's colours `$98:E030` ([courses.md](courses.md) "Per-hole surface graphics") | `layers` (`--hole N`) | `holes/NN/layer_*.png`, the outline masks, the night set, the ripple overlays `layer_{back,front}_ripple{1,2}.png`, `layers.json`, `course.json` | `LayersView`, `fromRomCourse` |
| the shot panel | the game's OAM while the panel is up (`tools/export_web_ui.py`) | `ui` | `ui.png/json`, with the measured timing | `PanelView` |
| the score panel | stepper screen snapshots | `hud` | `hud_panel.png`, `hud_tomato.png`, `hud.json` (the slots) | the Hud scene |
| the font | `gfx_course_font $90:FBBC` ([text.md](text.md)) | `font` | `font.png` | `features/text` (a RetroFont) |
| music and effects | N-SPC sequences + BRR samples, rendered (`tools/render_audio.py`; [audio.md](audio.md)) | `audio` (`tools/web_audio_map.json`) | `audio.json`, ogg + mp3 | `AudioPlayer` |
| the course art's exemplar patches | tables 8 and 9 of the 92 plain geometries, the tile page and palette `$98:C000` (`tools/terrain_style.py`) | — | `terrain_style.png/json` | Preload (`host.assets.terrainStyle`), `features/layers/styled.ts` |

What the audio is not: the effects were rendered over song 0's tempo, but in play they are clocked by the running song (12 of 33 songs differ). The driver's dropped ticks under load are not modelled, and the 1.30× level difference against libgme is not corrected ([audio.md](audio.md) "Known deviations").

The asset caveats:
- **The night palette** is a recorded 68-colour CGRAM swap of course 1. Where the game loads it from was never traced. The engine has it for hole 1 only, and on the other holes HOLE IN ONE plays without it (plans risk 10).
- **Every enemy draws hole 1's pictures.** Only actor `$49` → type 73 is a "match" in `build/sprites/emu/actors.tsv`, and the other actor ids are "weak" (plans risk 9). Objects 77 and 81-83 draw their first frame table on every course, unconfirmed beyond the scenarios.
- **The cutscenes are one run's recording, c1n.** A trace of `course1` draws other enemy pictures in the hole-outs, which is why `make distclean` keeps c1n (plans risk 11).

## Random holes

`random.html` (`make engine-random`, or `npm run random` in `engine/`) plays a course of 8 holes generated from a seed. The plan is `plans/random_holes.md`. The generator is pure core (`src/core/gen/`), so the node tests run it, and the page shows what it made with the course art's own pictures.

**The generator** (`gen/generate.ts`). `generateCourse(rules, seed, 8, {difficulty})` derives one seed per hole. Each hole is built in four steps, then solved:

1. `layout.ts` lays out the terrain, legal by construction:
   - square slots of flat ground (4 or 5 cells) on a lattice, one cell of gutter between them;
   - a self-avoiding walk of 3-6 slots from the tee's, plus at most one branch.
   - The gutter between consecutive slots is either:
     - flat, when they are level;
     - a row of ramps at the upper elevation falling toward the lower one, for one step (`$04`/`$05`/`$06`/`$07` fall N/E/S/W);
     - a deliberate step-down, downhill only.
   - A step up of two or more never happens.
   - Unused gutters are gaps, so ramp sides open onto gaps, as in the ROM's courses ([terrain.md](terrain.md)).
   - Slots of 5 may get a hill, a hollow (the stamps of `tools/engine_courses.py`) or a mound in their middle.
   - The rim is fenced with layer-4 walls, each kept with the difficulty's odds.
   - `HoleGrid.unintendedSteps` must find no non-flush edge besides the step-downs.
2. `place.ts` puts the tee on `$01` in the first slot, then 2-5 ability-0 enemies on `$01` cells, two cells apart, the path's ends first. The enemies are `$40 $4A-$4C`, and the hovering `$4D $4E $50 $51` from normal up.
3. `features.ts` adds special tiles, only from ported groups and where the ROM puts them ([tiles.md](tiles.md)):
   - rough `$04`;
   - friction `$20-$23` on their ramps, `$24` on flat;
   - boosts `$30-$33` before a door, `$34/36/38/3A` uphill on their ramps;
   - kickers, arrows (toward a door), snaps, trees `$02`;
   - one warp pair `$B0-$B3` whose arrows point at ground.
4. `fromAuthoredCourse` validates the hole, as it does the test holes.

**The solver** (`gen/shot-sim.ts`, `gen/solve.ts`). A hole is kept only if a plan wins it.

- **The shot.** `simulateShot` plays one shot silently on a work copy:
  - the kernel entries of `BALL_STEP`, the guide's `runKernelStep`;
  - the play context (`presentation` unset, so enemies, the cup and every tile act);
  - the set-up's resets and the launch (`shotPower`, `shotSpin`, `launchVelocity`);
  - the warp's move through a hook `runKernelStep` now takes at the non-kernel `warp` entry's place;
  - `countStill` to the rest.

  It is exact: `test/gen-sim.test.ts` replays the same shots through the whole world on the test holes, and the rest positions are equal. A step costs about 0.8 µs in node.
- **The search** is best-first over (rest cell, taken mask, tomatoes): the fewest enemies left first, then the fewest shots, then the nearest free enemy.
  - A state is expanded from its own exact work copy, so a plan replays exactly.
  - Shots per state:
    - at each free enemy and 2° either side, grounders at four meters, or fly shots for a hovering one;
    - a fan of 16 aims × 3 meters and 8 fly shots;
    - with one enemy left and within 8 cells: slower shots at it, with `$08` written into the solver's own layer 2, which must hole.
  - Every shot costs a tomato and every take gives one back, up to 4. A state at 0 is dropped.
  - Lost balls and shots that run through the cup's cell after it appeared are never part of a plan.
  - **Par** is the plan's length. It must fall in the difficulty's window: easy 2-4, normal 3-6, hard 3-8.
  - Budget: 3000 shots or 80 states, else the next attempt seed (`attemptSeed`).
  - Measured over 30 seeds each: 97 % of easy, 93 % of normal and 73 % of hard layouts solve, in 85-160 ms on average.
  - `test/gen.test.ts` replays three plans through the whole world shot by shot, and they hole out.
- **The page.** `src/random.ts` boots the same game with `RandomMenuScene` registered as the menu.
  - It generates in slices of about 10 ms a frame. In the e2e browser, from the canvas to the course being ready (asset loading included), seed 42 (normal) took 1.0 s and seed 777 (hard) 1.8 s.
  - It shows the pars, and keeps the seed and the difficulty in the URL.
  - Enter plays, N draws a new seed, Up/Down change the difficulty.
  - The Result card shows each hole's par next to its strokes.
  - `GEN_VERSION` (1) is in the course's label, because a seed's holes change when the generator or the physics does.

**The styled terrain** (`features/layers/styled.ts`; `tools/terrain_style.py`). Holes without ROM bitmaps, both these and the test holes, are drawn with the ROM's own course art. The art is regular:
- cells sit exactly on the 8×8 tile grid;
- every clean interior flat cell of the 116 geometries is the same BG1 block (tiles `$020`/`$021` with flips, palette 7);
- every hole shares one 848-tile page and palette;
- floor markings are BG2 overlays.

`terrain_style.py` composes each plain hole's BG layers and takes, per pixel, the commonest colour over many instances. It cuts:
- a cell's surface per terrain shape (all 26 shapes the ROM uses; 93-100 % of instances agree, except `$1A` at 60 %);
- the markings per (tile, shape), from a single instance where that is all there is;
- the E and N step faces (top, middle and bottom steps).

`rasterTerrain` paints back to front by x − y:
- each cell's four quadrant triangles at core's `surfaceZ`, from its patch at the same offset from the cell's left vertex;
- the faces from the face patches;
- the layer-4 walls as the ROM draws them: a 2-pixel line along the edge in the play area's outline colour, as on MAP13's rim. They go into an outline mask, which `LayersView` tints with the outline walk.

Course 1's BG3 scenery is shown behind. Redrawing course 1's eight holes from their grids matches the exported layers on 98, 97, 97, 94, 96, 93, 90 and 88 % of the pixels (`test/styled.test.ts`). Holes 7 and 8 are water holes, which the patches leave out, and the outline tiles are not drawn.

What the random holes leave out:
- **The hazard actors.** The solver cannot run them, since moving bumpers depend on time spent aiming, and `$05` and the volcanoes act in a non-kernel system.
- the outline tiles `$28-$2D`, water, the toggles, ability enemies and `$57`;
- warp lists other than one pair.
- **Markings with no ROM instance draw as plain ground:** snap `$19` and the boosts' other ramp pairs.
- **The solver's par is a plan it found, not always the shortest.** Its shots use no spin and no A/Y.
- **Its plans replay exactly in the engine, not necessarily in the game:** the cross-cell crest `$81:980B` is not ported (below), and every hole that has a ramp falling away from flat ground meets it.

## Deviations from the game, on purpose

Core:
- **The camera is core state** (`Camera`), not a view concern: its arrival gates the curl and the reveal, and it is checked against the flow traces.
- **Facts are `BallWork` fields, not tags.** They are RAM words with partial resets that toggle mid-step and show in the traces.
- **Events are entities**, drained once per host frame.
- **The stall runner is in the frame's prologue** and resumes the suspended step mid-list. `guideLag` and `apuLag` stand for the main loop being busy; their last frame is ordinary.
- **The guide is computed at once and published a frame later.** The game writes `$6AAA` at the guide's end, inside its lag; the engine publishes the target on the next frame that runs, before the camera pans.
- **`BallWork.fellOut` separates two causes that share one bit.** It is the step's own fall below the course; `$D9D2` bit 0 is also the projection's "below zero".
- **The guide's `$6A18` is written back to the live work copy**, because the game's guide runs on the real one and `$6A18` is outside the block.
- **Kirby's pose is written at the game's sites** (the aim loop, the curl, the roll's start, the reset, the hop, the squash, the bounce), not derived from scratch each frame.
- **The coefficients `$DA30`-`$DA46` live in the work copy only.** The block round-trips them in the game; one ball needs no copy.
- **The outline wall's sound 7 goes through the step's tail** (`tailSfx`), where the game plays it inline: same frame, same id.
- **`placeBall` can re-probe**, so a placed ball has current probe fields. The game's block carries them at `$D8C2`-`$D8DE`, and a poke that skips them makes the first step read the old ground.
- **A warp's turn is made before its stall.** The game turns the ball to the destination's arrow (`$82:ECFC`, `$82:AC4C`) after the warp's frames; the engine does it with the move, since nothing reads the velocity in between (the work copy is not stored while the step blocks).
- **A warp list of 1, 3 or 4** is not played: the game's random pick (`$82:ABC6`, `$80:87DD`) is not ported, no ROM hole has one, and the test holes' validation rejects it.
- **The hole's song** is `HOLE_SONG` = song 11 (course 1's `$89`) on every hole. The game picks it per hole from `$80:C967`'s table: course 1's holes 5-7 play song 7 and hole 8 song 13 ([audio.md](audio.md)). Those two songs are not exported, and the intro replay's song cue is the recording's (song 11).

The bridge:
- **The cutscenes are a bridge-only replay** (the user's choice, 2026-11-14). The plan had one entity per recorded object, but the recording has no object identity, only up to 27 OAM slots a frame. So `replay.ts` and a sprite pool draw it, and its cues join the drained events before `play-feedback`.
- **The intro holds the core** for 164 frames, because core's hole starts at ShotSetup. The user's pause is still the `pause` action, and it freezes the intro too.
- **The hole's song is the intro's cue.** `startHole` emits none; with `?nointro` the host plays it.
- **The shot panel and the score panel are derived in the view**, from `HoleFlow`, `Shot` and a per-core-frame history; core has no panel flags.
  - The shot panel's age counts from the curl plus 26 (web_ui's A → curl), and the picture lags one frame (the snapshot rule).
  - The score panel hides while the shot panel is up and during cutscenes. That is the web demo's rule; the game's is not known.
- **`sync-pose` dirty-checks the clip** instead of tracking `Changed(Pose)`: core writes `Pose` several times a frame, some of them through `updateEach`, which Koota does not flag.
- **A clip's `next` is ignored**, because it names a state and core sets that state itself.
- **The music plays on its own `AudioBufferSourceNode`**, with the loop points; Phaser's WebAudioSound has no loop region.
- **The score panel has no slot for the enemies left**, so they are not drawn. The lives sit in the blanked portrait box.
- **The course's front layer (BG*.1) is under every sprite but a hidden Kirby.**
  - Every sprite of play is OAM priority 3, over both BG layers (the OAM of web_hole0 from 2185 on: Kirby, the trees, the enemies, the tee, the cup).
  - Only the intro's first frames, before 2185, use priority 2, under the front layer, while the screen is black or fading in. The engine does not model that.
  - Kirby alone drops to 1 or 2 behind the course (`$82:F4FD`, [graphics.md](graphics.md) "Kirby behind the course"). The view gives him a depth under the layers then.
- **Behind the course, Kirby's OAM queue is not modelled.** The game also puts him in queue 9, after every other sprite (`$DA6C` = 9). Under the course layers he is already under every other sprite of play, so the engine has nothing to add.
- **On the fall's first frame the priority waits for the APU's lag.** The song request blocks the loop before `$82:F4FD` runs, so web_fly stores the 1 at 3256 and not at 3252. `update-ball-sprite` skips the frame that began the lag, and the lag's last frame computes it.
- **Table 10 for holes the ROM has none for.** Authored holes (and generated ones) get the table `buildOcclusion` makes (`core/occlusion.ts`, [courses.md](courses.md) "Table 10").
  - Its rule picks the ROM's cell, or no record, for 99.76 % of the gap positions of the 232 holes.
  - Its records are all priority 1; the ROM's priority-2 records (1,286 of those positions) are not reproduced.
  - A column past the directory (xc + yc ≥ w + h, far off the near side) has no record in the engine. The game reads past the table there.
- **The cup's rim (object 75) is drawn as a cut and an order**, not as a sprite mask. In the game it is a priority-0 sprite: lower in OAM than Kirby, so where it is opaque Kirby gives way to the course behind it. From the frame it appears, the ring is also over Kirby (web_hole 3896-3909, every frame). The engine raises the ring over Kirby and crops Kirby from the mask's third row down. Its top two rows are the ring's opening, and the ring covers the rest of them. That is the same picture while Kirby, 24 px wide, sits inside the 32 px mask. The engine stops when Kirby is hidden; the game keeps the object until 3303 (3654 in a hole in one), but nothing the engine draws is under it by then.

## Verification

`make engine-test` runs 37 vitest files in node. The ROM-derived ones skip when `build/engine` is missing. The recordings they compare with are the stepper's runs of the input scripts in `tools/snesstep/inputs/`, made by `make engine-traces` (`npm run traces`) into `build/engine/rom-test/`.

| test | checks |
|---|---|
| `fixed`, `rules`, `terrain`, `fixtures` | the fixed-point and trig maths; `tables.json`; the surface against `terrain_golden.json` |
| `kernels` | single routines against the numbers emulated in physics.md |
| `trace-shots` | 11 shots seeded at the launch: every ball state frame-exact to the lost ball's reset |
| `trace-script` | 15 scripts end to end, no seed and no pokes: the game's exact launch, then every distinct ball state with no catch-up (195-409 per shot), through web_hole's sink |
| `flow`, `flow-units` | web_flow, web_curve, web_ui, web_fly, web_fly_spin, web_hole and web_tomatoes against the per-frame flow traces. The discrete fields are within ±2 frames (the state, facing, angle, aim, elevation, selectors, meter, over, the counters, the card, Kirby's priority `$D96A`). The camera is within ±2 px in x and ±8 in y; the guide's end within 1 px on 95 % of the targets. The projection is bit-exact |
| `events` | every sound request of seven runs, on its iteration |
| `stalls`, `reveal` | the hit-stops and the reveal's edges, frame-exact; the reveal's stages on course 1's holes 1-4 |
| `hole-entities`, `hazards`, `hazard-actors`, `trace-hazards` | the sweep on all 8 holes; the five hazard scenarios (ball states, sounds, the actors' state sequences); `$A2` and the auto-tiling on t7 |
| `trace-warp` | two poked scenarios on course 1 hole 4 (`web_warp`, `web_warp_fly`): the warp `$B4` → `$B5` rolled onto and landed on; ball states and sounds, the stall's frames, Kirby's sprite and the camera's pan every frame from the warp's start |
| `trace-terrain` | three poked scenarios on course 1 holes 2 and 3 (`web_arrow`, `web_ramps`, `web_step`): the arrow panel's turn, the in-cell crest, flush ramp edges along ±y, a step hit by the N edge and its hit-stop; ball states and sounds (`test/scenarios.ts`, shared with `trace-hazards`) |
| `courses`, `hole-flow` | the test holes' validation and coverage; on them: a hole in one, a hole-out, a lost ball, out of tomatoes, t6's warp pair, GAME OVER and CONTINUE, all 8 holes to CourseDone, pause |
| `assets`, `view-catalog`, `event-table` | every clip's frames exist; every name a view draws exists (the rim's `cupmask`, the warp's objects); the water holes' ripple (holes 7 and 8 only); every sound id has a file; nothing is emitted outside the event table |
| `cup-mask-warp` | the rim mask's first frame and cut; objects 63 and 64's pictures and lives |
| `occlusion` | table 10 as exported; `$82:F4FD`'s branches on hole 1 and web_fly's fall; the builder against the ROM's tables (99 % at least); Kirby's depths and the shadow's test |
| `determinism` | host frames of 1, 2, 3 and mixed core frames give the same world and the same events (web_hole on hole 1; a pad policy on t1) |
| `frame-clock`, `cutscene`, `director`, `panel-state` | the 60.0988 Hz clock; the replay against the recording, sprite by sprite, and the anchors; the director's timing against core on web_hole; the panel's ages, closings, blink and meter lags on web_ui |
| `gen`, `gen-sim` | the random holes: 200 layouts per difficulty valid and flush but for their step-downs, actors on `$01`, only ported tiles; a seed always gives the same hole and plan; plans within the par windows; three plans replayed through the world hole out; the shot simulator's rests equal the world's on the test holes, and its speed |
| `styled` | the styled terrain: deterministic, a flat cell is the `$020/$021` block, the walls go to the outline mask, and course 1 redrawn from its grids matches its exported art (see "Random holes") |
| `no-phaser-in-core` | the dependency rules above |

In the browser:
- `npm run e2e` runs `test/e2e/smoke.mjs` and `test/e2e/random.mjs` (Playwright with the cached Chromium). `random.mjs` generates seed 42's course, checks that a reload gives the same holes, plays a shot on hole 1, and saves screenshots to `build/engine-test/random/`. `smoke.mjs` boots course 1 and plays a shot. It checks that there is no page error, console error or failed request, that the ball's view moves, and that the tee and the cup draw under Kirby.
- `python3 tools/check_web_ui.py --target engine` renders the panel for 20 recorded states. All 20 are pixel-identical to the game's OAM sprites.

The harness's conventions:
- **`GAME_OFFSET` = 2332**: engine frame f is game frame f + 2332. It is pinned on web_flow's set-up, and every script starts hole 1 with `2100 A`.
- **A stamp below scanline 112 belongs to the previous iteration** ([emulation.md](emulation.md) "Frames, iterations and snapshots").
- **The trace comparison aligns distinct states**, allowing the game's lag bursts, and the hazard actors are aligned to the recording before each poke.
- **Koota keeps at most 16 worlds per process**, so the tests destroy their worlds in `afterEach`.
- **Koota 0.6.6 hangs creating a tracking query** (`Removed`, `Changed`) over a trait on a generation's last bit, 2^30. Its loop `for (bit = 1; bit <= mask; bit <<= 1)` overflows to −2^31, then 0. A trait takes the next bit when a world first sees it, so `createGameWorld` registers `Visual`, the one tracked trait, first. The `Warp` singleton had pushed it to 2^30, and the hole scene hung in `primeBindings`. `hole-entities.test.ts` checks the bit.

## Not ported, or approximated

The physics:
- `$81:980B`'s crest branches across cells: the eight per-crossing quadrant samples fall through to "no crest", which is exact for flat and same-shape crossings. The game launches the ball rolling from a flat cell onto a ramp that falls away from it. Two recordings show it: web_haz98 at 2497, and web_ramps' first draft at 2473 (course 1 hole 2, the flat (4,15) onto the `$06` ramp). The engine rolls on instead. The in-cell branch (no edge crossed) is ported and recorded: web_arrow at 2541.
- The toggle tiles `$70`-`$7B`: their direction map at `$88:9190` is not exported.
- The overlay `$60`-`$6F`'s enter/leave tracking `$82:80F6` (its `$D9EE` flag is ported).
- The snap gate `$82:A692` and the snaps' exact clamps (stubbed).
- The tiles `$58`-`$5D` ([tiles.md](tiles.md) "Not established"). The warps `$B0`-`$B9` are ported, except the random pick among 3 or 4.
- The pillar's mode-7 branch `$82:EE9A`, and the hazards' mode-7 destroy.
- The rough tiles' `$80:A453` arithmetic: ported, but no trace exercises it.
- `$68F0` outside the fly shot's first bounce.
- The game's lag frames: the engine has no cycle counts, so course 1 hole 4's reveal and the volcano holes are a few frames off where the game lags.

The flow:
- Kind 1 (Down after a grounder: an 80-step guide with its own gap end, `$81:AAF3`) is approximated as kind 0 with 80 steps.
- The guide's lag is measured, not modelled: shorter rolling guides and the full fly guide are unverified.
- The APU's lag is measured on the fall's song only.
- In the aim stage, B, Y, Start, L/R and the idle timer `$6AC2` are not ported.
- The hover drop's length (`$82:8CE8`[h] + 8) is unmeasured, and the view draws it linear.

The presentation:
- Objects not drawn, for want of pictures or a trace:
  - the curl stand-in `$1A`, the full-power object `$16`, the spin streak 25;
  - the hop object `$78`, the outline-wall effect `$47`, the hazard flash `$2F`;
  - the ring stage's 78/97/79, `$BE` (the `fall_asleep` clip stands in), `$40` after the out-of-tomatoes sleep (the warp's 64 is drawn), 110;
  - the eruption's projectiles (object 84);
  - the score panel's toggles and the portrait's face, the tee changing colour during the curl, the fly shot's shrinking dot tiles.
- The guide's dots march in four steps of 5 frames toward the next point; the game's order of the march is not traced.
- The outline pulse starts at the hole's first frame; its phase in the game is not known.
- The water's ripple starts at phase A on the hole's first frame. Object 113 starts it at the load, so the phase is not known either, and the game's lag frames, which stretch a step (10 frames once in a recording), are not modelled. The ripple's other variants are not ported: the splash while the ball sinks, the freeze while `$69CA` is set, and the `$6A2E`/`$ED5B` tables ([courses.md](courses.md)).
- The shadow has one picture. The game's frame is the surface code (`$D996` = `$DA04`, `$81:A23E`), so its shape follows the slope.
- The procedural terrain is a picture of the data the physics runs on (quadrant planes, slope shading, tile groups by colour, walls and outline as lines), not the game's art.

## Deferred

- Copy abilities: the modes 1-21 (`$D9C8`), the swallow, the ability's use. An ability enemy's take is ported (`$50`, the 4 frames, the stocked id); the roulette `$57` counts as none; the test holes reject ability enemies.
- Two players: the `$1803` block, the follow's catch-up states, stolen stars (`$82:8B0F`), ball-to-ball hits, the 2P HUD, the asleep turn-skip.
- King Dedede, the course result's medals, the map (the plan's stretch goal), the scoreboard, player names, the menus, SRAM.
- Courses 2-8 of the ROM: their bitmaps export, but their hole songs (`$80:C967`'s other lists), enemy kinds and night palettes are not wired up.

## Unconfirmed

The plan's risks, and their state now:

| # | risk | state |
|---|---|---|
| 1 | a settle skips gravity | settled: `$81:896B` returns before the gravity tail ([physics.md](physics.md)) |
| 2 | trace records are bursts | handled: the harness aligns states and carries the scanline |
| 3 | the reveal's length | settled: 100 frames plus the pans (physics.md "Enemies and the cup") |
| 4 | the A/Y bonus on walls | settled in code: the outline wall sets `$DA52`, which `$82:DB20` tests, and web_a135 matches |
| 5 | the crest, pillars, boost gates | the pillar and the boost gates are ported from the disassembly, the gates exercised only on the test holes; the crest's in-cell branch is recorded (web_arrow), its cross-cell branches are not ported (above) |
| 6 | the spin stage's pause | settled: 6 frames, which is twice the 3-frame step |
| 7 | Koota's copy-on-get and change tracking | handled: SoA writes go through `set` or `updateEach`; `Course.layer2` is marked `changed` |
| 8 | the hole songs per course | settled in the ROM, not yet in the engine: `$80:C967`'s table ([audio.md](audio.md)) |
| 9 | enemy kinds beyond hole 1 | open: hole 1's pictures everywhere |
| 10 | the night palette | open: course 1 hole 1 only |
| 11 | the cutscene is one recording | open: c1n kept |

Frames measured on one run only:
- objects 63 and 64's pictures frame by frame (web_warp), and the cup's rim mask's life (web_hole's sink, c1n's hole-outs);
- the hole-in-one's 1UP at C + 386 and its bonus tomato at C + 445 (c1n);
- the tomato's blink start;
- the fly guide's lag beyond web_ui and web_fly.

Read from code but not seen in a run:
- `$6A8C`, the reveal's hold on objects 76 and 77;
- the −y step clamp ([physics.md](physics.md) "Cell edges, walls and steps");
- state 40's arm on a volcano (`$D78C` = 3).
