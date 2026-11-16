# The engine: the 1-player loop on Koota × Phaser 4

`engine/` reimplements the game's playable 1-player loop. The game's state and rules are an ECS world in [Koota](https://github.com/pmndrs/koota) 0.6.6. Phaser 4.2.1 is only the platform: it draws, plays sounds and reads the keyboard, and a thin bridge is the only code that touches both. The architecture follows `reference/koota_phaser4.md` and the plan `plans/port_v1_koota_phaser4.md`. The working notes of phases 4-7 are `notes/engine-phase{4,5,6,7}-*.md`.

What it plays:
- the ROM's eight 1P courses (holes 0-63), with the course bitmaps, sprites, panel, font and sounds exported from the ROM, each hole's own song and each enemy species' own pictures; the menu loads a course when it is picked;
- eight small test holes written for the engine (`engine/courses/`);
- random holes, generated from a seed and checked winnable with the engine's own physics (`random.html`, "Random holes" below).

The holes without ROM bitmaps are drawn with exemplar patches of the ROM's course art ("Random holes": the styled terrain).

A hole runs from the star's fly-in to the fly-out, with every turn, take, reveal, tomato, life and hole-out in between, then the course card, GAME OVER and CONTINUE.

How it is checked: the core is compared frame by frame with the headless stepper's recordings of the real game ([emulation.md](emulation.md)), and the shot panel pixel by pixel with the game's own sprites. The facts the port settled about the game are in the subsystem docs: [physics.md](physics.md), [flow.md](flow.md), [tiles.md](tiles.md), [animation.md](animation.md), [audio.md](audio.md), [emulation.md](emulation.md) and [web-demo.md](web-demo.md). This doc is about the port: how the game maps onto the engine, where the engine deviates from the game, and what is left.

`web/` (the earlier one-hole demo, [web-demo.md](web-demo.md)) was not used as a source.

## Running it

```bash
make -j8 engine-assets    # build/engine/assets: the ROM's sprites, panel, HUD, font, audio,
                          # cutscenes, objects, the enemy species' clips and the holes of courses
                          # 1-8 (ENGINE_HOLES), one file rule each (needs the stepper's outputs;
                          # 61 s with -j8 on a built tree, measured)
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
| `?course=N` | start ROM course N (1-8) straight from the menu |
| `?hole=N` | start the chosen course at hole N |
| `?debug` | exposes `window.__engine`: `phase()`, `hole()` (the set, the ROM index, the name, the song), `frame()`, `scroll()`, `kirby()`, `depths()`, `warp()`, `switches()` (the switches' state and their objects), `step(pad, n)`, `freeze()`, `isolatePanel()`, `hitNextEnemy()`, `putOnCup(lift)`, `placeBall(p)`, `freeEnemies()`, `aimUi()` (the pause, the preset, the look, the score panel, the aim), `flow()` (`HoleFlow` and the camera), `showCard(strokes)` (the RESULT card up now). Key D toggles the procedural terrain over a ROM hole or a styled one. On `random.html`, `window.__random`: the seed, the difficulty, and each hole's JSON, par and plan |
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
    assets/           keys, schemas, atlas conversion, course sets, the course loader
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
- **The player is reached through its handle.** Core, game and the tests find "the player" with `activePlayer(world)` (it throws outside a course) or `findActivePlayer(world)` (`core/traits/player.ts`), never with a `queryFirst` on a trait the player entity carries.

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
| 6 | update-aim | the aim loop `$81:A680`-`$81:A80A` in the game's order: SELECT's mid-course card `$81:BCB6`, the pause menu `$83:AFA7`/`$81:BDAD`, the spin preset `$83:B214`, the look `$81:B9A2`/`$81:B908`, the d-pad and L/R `$81:B555`/`$81:B6C3`, the facing `$81:BB4A`, the idle timer and the score panel `$81:A7BF` (port_v2 phase 7) | `systems/aim.ts`, `systems/aim-ui.ts`, `sim/aim.ts`, `sim/facing.ts` |
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
| 18 | dispatch-tile | `$81:811B` / `$81:8436` and the tile handlers | `sim/dispatch.ts`, `sim/outline.ts`, `sim/cup.ts`, `sim/enemy.ts`, `sim/hazards.ts`, `sim/water.ts`, `sim/switches.ts` |
| 19 | take-enemy, take-enemy-finish | `$82:8A2E`; an ability enemy's stock (`$D9C4` and the block's `$D852` at once, `$82:8A70`), its 4 frames (`takeWait`), then `$82:8A98`; the reveal `$82:8B5C` | `systems/take.ts`, `systems/reveal.ts` |
| 20 | warp | `$82:AA02`, inside the warp panels' handlers: the move to the other panel, the turn to its arrow; the step blocks for the warp | `systems/warp.ts`, `sim/warp.ts` |
| 20a | water-effects | inside the water's handlers: the splash, the bubbles, Kirby's palette (`$82:8604`), effect 0, Kirby's state 14 after a skip; then an entry's `JML $80:8F78`, one frozen frame (`waterWait`) | `systems/water-fx.ts` |
| 20b | switches | inside the switches' handlers: the toggles' switch's sound `$6B` (`$82:A195`); the water switch's `$82:A45D` (sounds `$6A` and `$4A`/`$4B`, Kirby squashed on a hard landing) and its 64-frame dissolve (`waterSwitch`) | `systems/switches.ts` |
| 21 | dispatch-landing | `$81:8905`'s first half (the hit-stop splits it) | `sim/landing.ts` |
| 22 | finish-landing-or-roll | `$81:895B`-`$81:89A9` / `$81:8A56` | `sim/landing.ts`, `sim/roll.ts` |
| 23 | emit-step-effects | the tail `$81:9BE5`: facts become events | |
| 24 | kirby-state | Kirby's state code A `$82:CDBB`: by the mode `$D9C8` the copy ability's air (`$82:CDE8`) or ground (`$82:D572`) handler, else the A/Y arming `$82:DA51`/`$82:DB20` and the bounce pose; the water drop `$82:D923` | `sim/abilities.ts`, `systems/ability.ts` |
| 25 | kirby-state-2 | state code B `$82:DE32`: a hit code in the mode (15, 19, 20 in 1P) ended; its water drop `$82:E1A7` | `sim/abilities.ts` |
| 26 | count-still-frames | `$81:A5CD` | `sim/still.ts` |
| 27 | ability-trigger | `$82:C875`: B with a stock, the gates, the latch spent, worn = mode = stock (and the block's), the transformation `$82:D9D2` (object 21, state 8, sfx `$2E`) and its 48 frames (`transform`) | `sim/abilities.ts` |
| 28 | ability-setup, ability-setup-tail | the 48 frames' end `$82:DA44` and `$82:C8D2`; the ability's setup `$82:C90A`[worn] (Parasol's 9 frames, the UFO's 24 on the ground: `abilityWait`) | `sim/abilities.ts` |
| 29 | wall-star | `$81:A406` → `$81:A2FE`: a layer-4 wall edge crossed, its star (object 70) and sfx 7 | `systems/ball-step.ts` |
| 30 | store-ball-work | `$82:F1E3` | |
| 31 | hazard-reaction | `$82:C0A8` → `$82:DB9A`: the hit code into the block's mode and worn | `systems/hazard-reaction.ts` |
| | **after the step** | | |
| 32 | detect-ball-out | `$D956`, `$D9D2`, the hazards | `systems/hole-flow.ts` |
| 33 | update-camera | the pans `$81:BA8A`, the follow `$80:BA35`, the roll loop's `$81:A121` | `systems/camera.ts`, `sim/camera.ts` |
| 34 | update-ball-sprite | the roll loop's `$82:F4FD`: Kirby's OAM priority `$D96A`, behind the course over a gap (table 10) or below z 0 | `systems/ball-sprite.ts`, `sim/priority.ts` |
| 35 | update-pose | the hop's return, the squash `$81:8C95`-`$81:8CD2`, the bounce pose `$82:CE07` | `systems/pose.ts` |
| 36 | the thread tick | the scheduler in `$80:8F78`: the HUD's tomato queue `$84:98EC` → `$83:ABDD`; the HUD's draw `$84:99FA` (Kirby's outline, the ability icon and its ground); the copy abilities' logic objects (51, the parasol `$85:B2FC`; 49, the UFO `$85:ADA0`: its zeroed speeds, its hum and phases, the icon's countdown); their drawn objects of list 4 (21, 27, 28, 30/31, 32, 33, 37/38/39, 52) and the palette objects (29, 36, 50); list 6's (35, 65, 66); Kirby's script (`$87:808E`: the stores, the transformation's flash, Freeze's set, Parasol's `$44`); the hazard actors `$80:E0C0`, object 112's hum `$84:87D4`, the snap panels' stars (objects 61 `$85:CF2D` and 62 `$85:CFE1`), the water's splashes and bubbles (objects 53-58 `$85:8E5A`-, 67 `$85:E76B`) | `systems/counters.ts`, `systems/ability.ts`, `systems/ability-fx.ts`, `sim/ability-objects.ts`, `sim/kirby-colours.ts`, `systems/pose.ts`, `systems/actors.ts`, `sim/actors.ts`, `systems/boost-hum.ts`, `systems/snap-trail.ts`, `sim/snap-stars.ts`, `systems/water-fx.ts`, `sim/water-fx.ts`, `sim/rng.ts` |

The ball step's order is the game's. It differs from the plan's in two places:
- the A/Y arming (the plan's item 12) runs after the physics, in Kirby's state code A, as the game does;
- the hazard reaction is an addition.

A thread's store of Kirby's state (`store $7E:D7D4`, a script's or object 51's) lands at the next frame's start (`Pose.pending`, `applyScriptStore`), as the scheduler runs before the step in the game's iteration.

Systems 12-22, except take-enemy, warp, water-effects and switches, are marked `kernel`. The shot guide runs them on a cloned work copy with no buttons, no stalls and no events (`runKernelStep`).

**The stall runner** stands for the game's main loop being blocked inside one routine (`traits/stall.ts`). While a stall is active, a frame runs only that stall's own list:

| kind | the game | own list | the threads run |
|---|---|---|---|
| `hitStop` / `stepStop` | `$81:8C95` waits 4 (a landing, `$81:8C79`) or 2 (a step hit, `$81:8C48`) frames inside the step | the squash pose; the pad ORed into a latch | yes |
| `cupReveal` | `$82:8B5C`, the last enemy becomes the cup inside the step | `tickReveal` (`systems/reveal.ts`) | yes |
| `takeWait` | `$82:8A83`'s 4 frames after an ability enemy's take | — | yes |
| `transform` | the transformation's 48 frames (`$82:D9D2` → `$80:8FB6`); the post-step systems run on the frame that asks for it | — | yes |
| `abilityWait` | a setup's nested wait: Parasol's 9 frames (`$82:C99E`), the UFO's 24 on the ground (`$82:CD3B`) | — | yes |
| `waterWait` | the water's entry jumps to the frame helper `$80:8F78` once inside the step (`$82:81F5` / `$82:80D0`), then returns from the handler | — | yes |
| `warp` | `$82:AA02`, a warp panel takes the ball to the other one inside the step | `tickWarp` (`systems/warp.ts`) | yes |
| `waterSwitch` | the water switch's dissolve, 64 × (`$80:8FB6` 1, `$80:9208`) inside the step (`$82:A505`-`$82:A535`) | `tickWaterSwitch` (`systems/switches.ts`): a step each frame, Kirby's palette set 3 after the 20th | yes |
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
| `AimUi` | the pause menu and its cursor, the spin preset, the look and its arrows, the lockout after a cancel, whether the iteration panned, the pause's longjmp, SELECT's card (port_v2 phase 7) | `$EA7E`, `$6AC4`, `$EA80`, `$6AAE`, `$6ABA`/`$6ABC`, `$6B38` | `traits/aim-ui.ts` |
| `ScorePanel` | the score panel shown, the HUD thread on (it gates the tomato queue) | `$EA7C`, `$691A` | `traits/aim-ui.ts` |
| `Screen` | the brightness and the forced blank, for the shell's fades (the RESULT card, SELECT's card) | `$007E`, `$007D` bit 7 | `traits/screen.ts` |
| `Save` (AoS) | the save as JSON ([save.md](save.md)), its version, the member playing, the last course's result | the battery RAM, `$EAB7`, `$EC4B` | `traits/save.ts`, `core/save.ts` |
| `TomatoQueue` (AoS) | the ring, the pending change, the timer, the HUD's shown flag, hold | `$68FA`, `$68F4` | `traits/counters.ts` |
| `BoostHum` | active (object 112 lives: the hole has a boost panel), its counter | object 112's `$531C` | `traits/boost.ts` |
| `SnapTrail` (AoS) | the live objects 61 (spawners) and 62 (stars, with their slot fields), and the flag they share | `$699A`, the thread slots | `traits/snap.ts` |
| `WaterFx` (AoS) | the live splashes (53-58) and bubble emitters (67), with their slot fields | the thread slots | `traits/water.ts` |
| `GameRng` | the random state; in a 1P hole the bubbles and the abilities' objects (Stone's dust, Fireball's smoke, Hi-Jump's trail, Spark's sparks) draw on it. Not reset per hole; the tests seed it from the recording at the set-up | `$0079`, `$007B` (`$80:87DD`) | `traits/water.ts` |
| `AbilityFx` (AoS) | Kirby's colours 2-8; the HUD's ability state (the outline's and the icon's phases, the ground's colour, the icon's picture as its upload descriptor, the face's countdown, the UFO's countdown); the palette objects 29, 36, 50 and the frost; the drawn objects; object 49's sounds. The colours and objects are reset per hole, the HUD's phases are not | `$0504`-`$0510`, the HUD object's `$5B1C`/`$551C`/`$531C`-`$569C`, `$D862`, the thread slots | `traits/ability-fx.ts` |

The player: one entity per player (`spawnPlayer`, `core/world.ts`), tagged `IsPlayer`. The one whose turn it is carries `IsActivePlayer`, which stands for `$7E:1803`: `$82:F030` loads the per-player block at X = `$1803`, 0 or 2 ([physics.md](physics.md) "The ball's state"). In 1P the first `startCourse` spawns the one player, and it is the active player from then on. It is not under the hole root, so it outlives the holes and GAME END. Everything finds it with `activePlayer` / `findActivePlayer` (`traits/player.ts`), so a 2P turn change has only to move the tag. The entity carries `Visual {kind: 'ball'}` and:
- the block, SoA: `BallPos`, `BallVel`, `BallAir`, `BallWet` (`$D872`, in the water), `BallSpin`, `BallMode` (`$D85A` ↔ `$D9C8`: the copy ability's number while one is on, or a hit code 12-21), `BallAbility` (`$D856` ↔ `$D9C6` the ability worn, `$D85E` ↔ `$D9CA` the shot's use latch), `BallHoled`, `BallHeading`;
- persistent, SoA: `StillCount` (`$D9BE/C0`), `Modifier` (`$DA76/78/7A`), `Tomatoes` (`$D7F0`), `Strokes` (`$D82A`), `Stars` (`$6A10`), `StockedAbility` (`$D852` ↔ `$D9C4`, the stock, and `carry`, `$DA90`: the stock carried into the next hole);
- `Pose` (`$D7D4`, `$D7C4`, `$D7CC`, `$6A6E`, and the ability poses' switches `$D75A`/`$D75E`), the semantic state only, never a clip; `pending` holds a thread's store until the next frame;
- `BallScreen` (`$DA56`-`$DA64`);
- `BallSprite` (`$D96A`): Kirby's OAM priority, 3 except behind the course (1 or 2);
- `KirbyPalette`: OBJ palette 0's colours 2-6 wet or dry (`$82:8604`); the colours themselves, all of 2-8, are `AbilityFx.colours`;
- `BallWork` (AoS): the work copy with its facts, and `$6A28` (`boostFlash`, a straight boost hit's speed; a global the guide writes too) and the probe tile the aim's guide left (`guideTile`, `guideLeft`), which only the hum and object 61 read. It also keeps the water's globals `$69CC`-`$69DC` (region, level, saved ground, ride, ice, skips), the block's `$D872` as loaded (`blockWet`, the guide's start) and the latched `$6B58` (`rollTB`). The switches' globals are there too (port_v2 phase 6): `$6A2A` (`toggleOn`), `$6A2C` (`switchLatch`) and `$69CA` (`waterOff`), set by `startHole` from the load's counts (`toggleOnAtLoad`, `waterOffAtLoad`, `$82:BC59`) and flipped by the switches; the water's handlers, the guide, the probe wrapper and Freeze read `waterOff` there.
- `Switches` (world): the switches' and the swirls' threads for the views: object 127's frames (`anims`), objects 117 and 118's sets (`toggle`, `water`), the water's dissolve (`dissolve`: steps done, the direction) and object 113's own clock (`rippleTicks`, held while the water is off).

The hole's entities, spawned from the load-time sweep (`sweep.ts`, `$82:B320`; `traits/hole.ts`):
- the root `IsHole` + `HoleInfo`; every other hole entity carries `InHole(root)` with `autoDestroy: 'orphan'`;
- `IsTee`; `IsPillar`; `IsHazardActor` + `ActorType`;
- the enemies, `IsEnemy` + `EnemyKind` (tile, species `$591C`, ability, list index) + `Hover` + `Cell`, with `TakenBy(player)` (exclusive, `$539C`) once taken;
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
| Cancel | B in the spin stage, `$81:C089`: the uncurl, the selectors latched at C + 34 | C + 37 → ShotSetup's third frame (no stroke) |
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
| Card | the RESULT card `$83:D3ED` (not after the course's last hole): the build in the blank, the fade in, the wait for A, B or Start held, the fade out | the press + 80 → HoleOver |
| HoleOver | the next hole's load | `nextHole` |
| GameOver | scene 9 (`$83:D856`) | `continueGame` / `endGame` |
| CourseDone | after the last hole | `endGame` |

The actions (`core/actions.ts`) are the only way in from outside:
- `startCourse(world, rules, courses)`, `startHole(world, i)`, `nextHole` (null after the last hole);
- `continueGame`, `endGame`, `pause`, `resume`;
- `placeBall` (the poke equivalent, for the tests and `?debug`).

`startHole` destroys the previous hole's root, spawns the new one and puts the flow at ShotSetup.

Course data comes from two places (`core/course-data.ts`):
- `fromRomCourse(course.json)` reads an exported ROM hole, its song included; the course loader and the test fixtures share it;
- `fromAuthoredCourse` reads the test holes' own format, validated: one tee on flat ground, at least two enemies, no ability enemy, no actor on a gap, warps in pairs.

Either way the course carries its song (`CourseData.song`: a ROM hole's `$80:C99D`[course] → [hole], from course.json; the others course 1's `HOLE_SONG`, 11), which the hole flow plays after a lost ball and when Kirby wakes (`$80:C967`), and Kirby's occlusion table, table 10 (`core/occlusion.ts`). A ROM hole has the game's own, exported as course.json's `occlusion`. An authored hole gets the one `buildOcclusion` makes from its shape layer.

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
| sync-layers | object 111's two colours: the outline's walk (`$98:D3E6`, 3 frames a step) and the glow (BG palette 7 colour 1, `$98:D4C8`, 6 frames); the BG colour cycles of `layers.json` `cycles`: the water's ripple (object 113, `$84:84AF`[course], A B A C, 8 frames), the boost panels' (112, `$98:C200`-`C218`, 4 frames), the warp or snap panels' (114 or 115, `$98:DCDA`… , 8 or 4 frames); the night swap |
| sync-guide | the guide's dots and cone, in the Aim phase only |
| sync-pose | Kirby's clip from `Pose` |
| sync-cup-mask | the cup's near rim over Kirby while object 75 is up: Kirby cut off below it, the ring raised over him (`features/enemies/cup-mask.ts`) |
| sync-warp | objects 63 and 64 from `Warp` (`features/warp`) |
| sync-snap-stars | object 62's stars from `SnapTrail` (`features/env/snap-stars-view.ts`) |
| sync-water-fx | the splashes and bubbles from `WaterFx` (`features/env/water-fx-view.ts`) |
| sync-panel | the shot panel from `panel-state` |
| sync-cutscene | the replay's sprites and fade |
| play-feedback | the events → effects and music (the event table below) |

**The views** (`features/view-catalog.ts`; pictures from `features/catalog-data.ts`):

| kind | view | pictures |
|---|---|---|
| ball | `KirbyView` | the atlas's Kirby clips by `poseClip(state, facing, angle, variant, tomatoes, air)`; the `shadow` frame under an airborne ball, but not in the cup, over a gap or below z 0 (`$81:A23E`); under the course's layers at priority 1 or 2; off while `Warp.hidden`; cut off below the cup's rim (`cupmask`, object 75's shape) |
| enemy / star | `EnemyView` | its species' `enemy_XX_idle` (`enemyClip`), then `star`; the hover lift |
| cup | `CupView` | the species' idle clip, the hover drop, `cup_open` and the ring `cupring` from `Reveal.stage` |
| tee | `TeeView` | `tee` (the pad, object 108) |
| pillar | `PillarView` | `tree` |
| hazard | `HazardView` | the `objects` atlas by actor type, direction and frame; a marker if a sheet is missing |
| (course) | `LayersView` | the exported bitmaps, with the cycles' overlays shown by phase and the outline's two masks tinted; the styled or procedural terrain for test holes, and the procedural one over any hole with `?debug` |
| (guide, panel, cutscene) | `GuideView`, `PanelView`, `CutsceneView` | `ui.json`'s pictures; `cutscenes.json`'s |
| (warp) | `WarpView` | the `objects` atlas: object 63 where Kirby went in, 64 where he comes out, frame by frame as web_warp recorded them (`features/warp/warp-frames.ts`) |
| (snap stars) | `SnapStarsView` | the `objects` atlas: object 62's five pictures at each live star's point. They draw just behind Kirby, and frames 0-2 go behind the course with him (`features/env/snap-star-frames.ts`) |
| (water) | `WaterFxView` | the `objects` atlas: objects 53-58 and 67 at their points, just in front of Kirby in his OAM queue, behind him one queue back |

**The scenes** (`game/scenes/`):
- Boot and Preload. Preload loads `tables.json`, the manifest, the atlases, `ui`, the HUD, the font, the audio, the cutscenes and course 1's BG3 scenery (`Tex.scenery`, behind the holes without bitmaps), but no hole. It turns the atlases into textures with custom pivots and into global animations. A clip's looping tail becomes a second animation, chained.
- Menu: courses 1-8 (the manifest's `courses`) or the test holes. Picking a ROM course loads its eight holes (`assets/course-loader.ts`: course.json, layers.json, then the bitmaps it lists), once; `?course=N` picks it at once.
- Hole: the only simulation host.
- Hud: runs in parallel and reads the world. It shows exactly when core's `ScorePanel.shown` (`$EA7C`) is set, the game's own rule (port_v2 phase 7).
- In the hole scene, beside the views: the pause menu's window and cursor and the look's arrows (`features/hud/aim-ui-view.ts`), the RESULT card and SELECT's card (`features/card/`), each drawn from core's state; the spin preset's panel is the shot panel's preset mode (`panel-layout.ts`).
- The save: `features/save/save-store.ts` loads core's `Save` from localStorage (`kdc-engine-save-v1`) at boot and writes it after any game step that changed it (`?save=fresh` an empty save in memory, `?nosave` read only). The dev menu plays a ROM course as member 0, made if absent; the test and random holes keep no save.
- Result: the course card; GAME OVER with CONTINUE.

**The cutscenes** (`features/cutscene/`) are a replay of one recorded run ([web-demo.md](web-demo.md) "The intro and the hole-out (measured with the stepper)"), drawn by a sprite pool relative to two anchors, the tee pad and the cup's ring. The director ties them to core:
- **The intro** holds the core for its first 164 frames. `startHole` has spawned the hole, so the course and the enemies show. The set-up then runs under the intro's last frames: the recording's game frame 2333 is core's first set-up frame.
- **A hole-out** starts on the frame the ball has sunk, as the recording's index 2. It follows core's HoleOut:
  - until the camera reaches the cup (C = `HoleFlow.since` + `length`), the index is f − H;
  - from C on, it is 29 + f − C.

  Core's songs and HoleOver then land on the recording's own indices (the `director` test).
- **The cues.** The replay plays the intro's song and effects and the hole-outs' `$1D`, `$67`, `$3E` and `$2D`. The cues core already emits are dropped: the hole-out songs and `$21`. The intro's two song cues (the hole's start `$80:C499` and `$82:B0E8`, 13 frames on) were recorded on course 1 hole 1; the director plays the hole's own song there.

## The event table

Every kind core emits, from `features/audio/event-table.ts`, which `test/event-table.test.ts` checks against `audio.json` and against what the test courses and 31 stepper scripts emit. The ids are effect numbers in hex, except for `song`, where it is the song number in decimal (request `$7E` + n; 0 stops the music).

| kind | ids | the game's site | emitted in | the view |
|---|---|---|---|---|
| aim-tick | `$53` | `$81:A98B`, after the guide | `systems/aim.ts`, `schedule.ts` | effect |
| aim-confirm | `$34` | `$81:A791`, A in the aim | `systems/aim.ts` | effect |
| spin-side | `$46` | `$81:C16C` | `systems/panel.ts` | effect |
| spin-tb | `$42`, `$3D` | `$81:C19F` / `$81:C1A4`: top/back at 6, at 0 or 12 | `systems/panel.ts` | effect |
| power-start | `$57` | the power stage + 4 | `systems/panel.ts` | effect |
| silence | 0 | `$81:C038`, `$81:C046`, `$82:E206`, `$84:8818` (the hum's end), `$82:81F1` / `$82:80CC` (into the water) | `systems/panel.ts`, `systems/hole-flow.ts`, `systems/boost-hum.ts`, `systems/water-fx.ts` | stops the effects |
| launch | `$18`, `$19` | `$82:BFF0` (`$19` at full power) | `systems/panel.ts` | effect |
| modifier | `$26` | `$82:DA97`, A armed mid-roll | `systems/ball-step.ts` | effect |
| bounce | 1, 2, 3, 5, 6 | `$81:9BE5` by vz; `$81:9BF4` the spin streak (5, 6) | `systems/ball-step.ts` | effect |
| step | 4 | a step hit | `systems/ball-step.ts` | effect |
| wall | 7 | `$82:91E6`, the outline wall | `sim/outline.ts` → the tail | effect |
| tile | `$1A`, `$5F`, `$60`, `$6F`, `$11`, `$7C`, `$0C`, `$47`, `$48`, `$49`, `$4C` | the tail: friction, rough, `$05`, snaps, a cone, an arrow panel (`$82:A7D6`); the water: Freeze `$47`, a skip, skim or bounce `$48`, in slowly or out `$49`, in fast `$4C` | `sim/dispatch.ts`, `sim/hazards.ts`, `sim/water.ts` → the tail | effect |
| pillar | `$71` | `$82:956C` / `$82:95F8` | `systems/ball-step.ts` | effect |
| hazard | `$6F` | `$82:9C9D`, a bumper | `systems/ball-step.ts` | effect |
| ability | `$2E` and the abilities' (the setups' `$69`, `$08`, `$4E`, `$70`, `$78`, `$59`, `$1B`, `$14`; `$09`, `$1A`, `$3B`, `$0E`, `$3C`, `$3A`, `$4D`, `$72`, …); the UFO's hum `$75`, `$73`, `$74`, `$21`, the countdown's `$42`, the parasol's `$44` | the trigger `$82:DA39`, the handlers, object 49 `$85:AE13`-`$AE88`, `$84:A54F`, Kirby's state-29 script | `systems/ability.ts`, `systems/ability-fx.ts`, `systems/hazard-reaction.ts` | effect |
| ability-fx | — | an ability object spawned (its type) | `systems/ability.ts` | none (the view reads `AbilityFx`) |
| palette-set | — | `$80:D2FE` (Fireball's set 5) | `systems/ability.ts` | none (the view reads `AbilityFx.colours`) |
| wall-star | 7 | `$81:A3A8`, a layer-4 wall's star | `systems/ball-step.ts` | effect |
| hazard-hit | — | `$82:EED8`, object `$2F` | `systems/ball-step.ts` | nothing (not drawn) |
| snap-trail | — | `$82:A60E`, object 61: a snap panel's pass | `systems/snap-trail.ts` (from `systems/ball-step.ts`) | nothing: the stars are drawn from `SnapTrail` |
| water-splash | — | `$82:8604`, `$82:82A3`, `$82:8303`, `$82:8515`: a splash, objects 53-57 | `systems/water-fx.ts` (from `systems/ball-step.ts`) | nothing: drawn from `WaterFx` |
| thrown | `$7B` | `$82:DB9A` code `$0F`, a volcano | `systems/hazard-reaction.ts` | effect |
| enemy-taken | `$4F`, `$50` | `$82:8A92` / `$82:8A79` (an ability enemy) | `systems/take.ts` | effect |
| cup-reveal | `$1C` | `$82:8D49`, the ring stage | `systems/reveal.ts` | effect |
| switch | `$6B`, `$6A`, `$4A`, `$4B` | `$82:A195` / `$82:A1E1` the toggles' switch flips; `$82:A470` the water switch, then `$82:A4ED` `$4A` (the water goes) or `$4B` (it comes) | `systems/switches.ts` | effect |
| warp | `$76`, `$77` | `$82:AABC` the ball goes in, `$82:AB7C` it comes out | `systems/warp.ts` | effect |
| holed-in | — | `$82:AD13`, object 75 over the cup | `systems/ball-step.ts` | the cup's rim mask, 2 frames on (`bridge/sync-cup-mask.ts`) |
| holed | `$21` | `$82:AEF5`[mode], the sink's end | `systems/ball-step.ts` | effect |
| music-mute | — | the sink's end: the music's volume 0 (`$80:B5F4`) | `systems/ball-step.ts` | music gain 0 |
| music-volume | `$82`, `$FF` (the byte, not a sound) | `$84:87F6`, `$84:8811`: object 112 lowers the music while it hums, then restores it (`$80:B5F4` → APU port `$2142`) | `systems/boost-hum.ts` | music gain byte / 255 |
| boost-hum | `$15` | `$84:87FD`: object 112's hook, every 34 frames while `$6A28` is set and the probe tile is a boost panel | `systems/boost-hum.ts` | effect |
| tomato-gain | `$52` | `$83:AC07`, the HUD queue | `systems/counters.ts` | effect |
| tomato-loss | `$10` | `$83:AC18`, the HUD queue | `systems/counters.ts` | effect |
| ball-lost | `$54` | `$80:F848` | `systems/hole-flow.ts` | effect |
| life-lost | `$0B` | `$80:F8D0` / `$80:F876` | `systems/counters.ts` | effect |
| life-object | `$77` | `$80:F89B`, object `$40` | `systems/hole-flow.ts` | effect |
| game-over | — | `$80:F387` / `$80:F3B5` | `systems/hole-flow.ts` | nothing (the Result scene follows the phase) |
| song | 0, 6-14, 17, 18, 24, 25, 26 | `$80:B4AC`; 6-14 the holes' (`$80:C967`) | `systems/hole-flow.ts`, `systems/camera.ts` (the fall), the intro's cues | the music: its own source node with the loop points; 0 stops |
| cue | 29, 45, 47, 62, 98, 100, 103 | `cutscenes.json`'s cues | the bridge (`cutscene/director.ts`) | effect |

`test/events.test.ts` checks the timing: every request the game makes from its main loop and physics matches an engine event in the same iteration with the same id. It covers seven recorded runs, about 230 requests. `trace-hazards.test.ts`, `trace-terrain.test.ts` and `trace-warp.test.ts` do the same for the poked scenarios. The objects' own requests (banks `$84`, `$85`, `$87`) are the bridge's and not compared, except object 112's hum, which core runs; the music volume's port writes are not requests.

## The assets

`make engine-assets` runs the web demo's exporter into `build/engine/assets`: `course,layers` per hole into `holes/NNN` (the ROM index, one file rule each), `tools/export_web.py --only font,hud,sprites,ui,audio,objects,card`, `tools/terrain_style.py`, then `manifest`, which lists the holes by course. The holes are `ENGINE_HOLES` (0-63 by default; the extra game is 64-127). The rules and the test fixtures go to `build/engine/rules` and `build/engine/rom-test`. Vite serves `build/engine` as the public directory.

| asset | ROM source | exporter step | output | engine consumer |
|---|---|---|---|---|
| physics constants and tables | the ROM tables, each with its `$bank:addr` (the outline walk `$98:D3E6` included) | `tables` | `rules/tables.json` | `RomRules` (`core/rules.ts`) |
| Kirby's clips | the `$87` script engine plus live captures (`tools/kirbyanim.py --clips`; [animation.md](animation.md)); each frame also drawn with the wet colours 2-6 of `$98:C796` (`png_wet`); the copy abilities' (states 8, 19-39, 50 by their switches) | `sprites` | `sprites.png/json` frames and clips; the wet twins `k_<hash>_w` | Preload's `addAtlasFrames` / `addAtlasClips`; `KirbyView` (other colours: the dry frame repainted, `kirby-recolour.ts`) |
| Kirby's colour sets, the HUD's phases and icon tables | `$98:C77A`-`$98:CC26` (set 3 dry and wet, Fireball's set 5 and its fades, Spark's, Freeze's, the flash, the UFO's and its warning), `$98:D4A8`/`$D4B8`, `$84:9DDB`/`$9D97`, `$84:9E07`, `$84:A554`/`$A584`/`$A5AC`, `$84:8AF8`-`$8BEC` | `tables` | `tables.json` `kirby*`, `outline*`, `icon*`, `hudIcon`, `ufo*` | `sim/kirby-colours.ts`, `systems/ability-fx.ts` |
| the copy abilities' objects 21, 27, 28, 31, 32, 33, 35, 37, 39, 49, 52, 65, 66 | the DEMOPLAY demos' emulated sheets (`build/sprites/emu/obj_NNN`) | `objects` | frames `oNNN_0_II` | `AbilityFxView` |
| the HUD's ability icon | each picture's 16 tiles from its upload descriptor (`$84:9E07` → `$8C:CC78` + `$200`·stock, `$93:9000`, `$93:9200`, the countdown's digits), OBJ palette 1 of web_demo12 at 2120 (`export_web_sprites.py` `build_icons`) | `hud` | `hud_ability.png` (the pictures without colour 9, and colour 9 alone in white), `hud.json` `ability` | the Hud scene (the ground tinted with `AbilityFx.hud.ground`) |
| enemy, star, cup, tee pad, tree, shadow, guide | live VRAM/CGRAM of the c1n replay; snapshots for the guide (`export_web_sprites.py`, `emusheets.py`) | `sprites` | the same atlas | the views |
| every enemy species' idle clip | every frame of an idle window on the first hole with the species (`tools/snesstep/trace_enemies.py` → `build/sprites/enemies`) | `sprites` | frames `enemy_XX_i`, clips `enemy_XX_idle` | `EnemyView`, `CupView` (`catalog-data.ts` `enemyClip`) |
| the hazards' frame tables by spawn tile | `$84:DD55` (`$84:DD34`) | `tables` | `tables.json` `hazardFrameTables` | `HazardView` (`hazardFrame`) |
| the hazard actors 76, 77, 81-83; the warp's 63 and 64; the snap panels' star 62 | `build/sprites/emu/obj_NNN`, emulated sheets ([graphics.md](graphics.md) "From live state") | `objects` | `objects.png/json`: frames `oNNN_K_II` and their tables | `HazardView`, `WarpView`, `SnapStarsView` |
| the water's objects 53-58 and 67 | `$89:94DB` and `$89:952B`'s lists drawn with a snapshot of web_water_shot (`build/emu/water_ref`, `export_web_sprites.py` `water_objects`); every frame seen on screen in emulated sheets (`holes.py --script`) | `objects` | frames `oNNN_0_II` | `WaterFxView` |
| the water's tables: the skips, the modifier's bounce, the skim's factors, the thresholds, the level's offset, the drags; the splashes' and the bubble's scripts; the bubbles' offsets and waits | `$82:8324`-`$8345`, `$82:8589`, immediates of `$82:80F6`-`$82:864D`, `$80:DD69`/`DD6B`; `$85:8E5A`-, `$85:E934`; `$85:E845`-`$E882`, `$85:EA2F` ([tiles.md](tiles.md) "Water", [animation.md](animation.md) "The water's objects") | `tables` | `tables.json` `waterSkip*`, `waterMod*`, `waterSkimMod`, the `water*` consts, `waterFx`, `bubble*` | `sim/water.ts`, `sim/water-fx.ts` |
| object 62's 64 scripts; the polar table its motion reads | `$85:CFF2` → the scripts at `$85:D027`-`$E08D`; `$80:EABA` ([animation.md](animation.md) "Objects 61 and 62") | `tables` | `tables.json` `snapStars`, `polarTrig` | `sim/snap-stars.ts` |
| the cup's rim, object 75 | its sheet from the c1n replay (`build/web-sprites/obj_075`) | `sprites` | the atlas frame `cupmask` (only its shape is used) | `sync-cup-mask` |
| the intro and the hole-outs | an every-frame trace of c1n (`tools/snesstep/trace_cutscene.py`) | `sprites` (`build_cutscenes`) | `cutscenes.json` + atlas frames `cs_*` | `features/cutscene` |
| course bitmaps | bank `$88` course tables + BG3 scenery, drawn with the CGRAM in play (`coursemap.hole_cgram`: `$98:C000`, the scenery's 20 colours, the HUD's 12, the course's list `$80:D869`; a hole in one's night: the alternate tables `$80:D527` and `$80:D8AB`, every hole); on a water hole the tiles `$91:ED29`; the cycles' sets ([courses.md](courses.md) "The palette in play", "Per-hole surface graphics") | `layers` (`--hole N`) | `holes/NNN/layer_*.png`: the outline's and the glow's masks, the night set, the cycles' overlays `layer_{back,front}_{ripple,boost,panels}<k>.png`; `layers.json` (`cycles`), `course.json` (`song`) | `LayersView`, `fromRomCourse` |
| the hole songs | `$80:C99D`[course] → [hole] (`$80:C967`) | `course` | `course.json` `song` | `CourseData.song` |
| the shot panel | the game's OAM while the panel is up (`tools/export_web_ui.py`) | `ui` | `ui.png/json`, with the measured timing | `PanelView` |
| the guide's pictures from the water | `$89:8F52`, `$89:8F6B` drawn with the aim in the pond of web_water_shot | `ui` | `ui.json` `guide.dotWet`, `guide.coneWet` | `GuideView` |
| the score panel | stepper screen snapshots | `hud` | `hud_panel.png`, `hud_tomato.png`, `hud.json` (the slots) | the Hud scene |
| the pause menu's window and cursor; the look's arrows | BG3 of `build/screens/pause_menu`; the sprites of `look_arrows` (web_look 2455, `tools/snesstep/screens.py`) | `hud` | `pause_window.png`, `pause_cursor.png`, `look_<dir>.png`; `hud.json` `pause`, `arrows` | `AimUiView` |
| the spin preset's panel | object `$10`'s OAM in its own palette (web_bspin 2620) | `ui` | `ui.json` `preset` | `PanelView` |
| the RESULT card and SELECT's card | BG1 of each course's first card in the whole game's autoplay run; object `$8C`'s digits and star from a hole in one's card; SELECT's BEST window (web_select 2600); the slots `$83:CD82`/`$83:CD93` | `card` | `card_window_<n>.png`, `card_best.png`, `card_digits.png`, `card.json` | `CardView` |
| the font | `gfx_course_font $90:FBBC` ([text.md](text.md)) | `font` | `font.png` | `features/text` (a RetroFont) |
| music and effects | N-SPC sequences + BRR samples, rendered (`tools/render_audio.py`; [audio.md](audio.md)) | `audio` (`tools/web_audio_map.json`: the hole songs 6-14, the asleep, fall and hole-out songs, 47 effects) | `audio.json`, ogg + mp3 | `AudioPlayer` |
| the course art's exemplar patches | tables 8 and 9 of the 92 plain geometries, the tile page and palette `$98:C000` (`tools/terrain_style.py`) | — | `terrain_style.png/json` | Preload (`host.assets.terrainStyle`), `features/layers/styled.ts` |

What the audio is not: the effects were rendered over song 0's tempo, but in play they are clocked by the running song (12 of 33 songs differ). The driver's dropped ticks under load are not modelled, and the 1.30× level difference against libgme is not corrected ([audio.md](audio.md) "Known deviations").

The asset caveats:
- **The night palette** is a recorded 68-colour CGRAM swap of course 1. Where the game loads it from was never traced. The engine has it for hole 1 only, and on the other holes HOLE IN ONE plays without it (plans risk 10).
- **The enemies' clips are recorded, one hole per species** (`trace_enemies.py`, frames 2170-2570 of `play_hole1`).
  - `$40` and `$4A`-`$4E` repeat: a period of 48 to 128 frames. `$4C`'s is 8 pictures of 8 frames (64; the old cut from snapshots 3 frames apart had 63).
  - The ability species `$41`-`$49`, `$4F` and the roulette `$57` move their pose and pulse their colours, and the run does not repeat within the window; their clip is the recorded run, about 385 frames, looped.
  - Against a hole of another course, 13 species draw the same pictures; `$48` has other colours on hole 17 (course 3), and `$40` other pictures on hole 36. Neither is modelled.
- **The hazards' tables** are the ROM's by spawn tile (`$84:DD55`): object 76's by tile bits 2-3 (not its direction: course 1 hole 5's `$84` bumper draws `$89:CCAB`), 77's by tile & 3; 81-83 have one.
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
  - Measured over 30 seeds each: 97 % of easy, 93 % of normal and 67 % of hard layouts solve, in 85-160 ms on average. Hard was 73 % before the boost panels' rolling handlers were ported exactly (`web_boost`, `web_boost_side`).
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

Course 1's BG3 scenery is shown behind. The patches are cut with course 1's colours on every hole (`hole_palette(course=0)`), so they are one look. Redrawing course 1's eight holes from their grids matches the exported layers on 98, 97, 97, 94, 96, 93, 90 and 88 % of the pixels (`test/styled.test.ts`). Holes 7 and 8 are water holes, which the patches leave out, and the outline tiles are not drawn.

What the random holes leave out:
- **The hazard actors.** The solver cannot run them, since moving bumpers depend on time spent aiming, and `$05` and the volcanoes act in a non-kernel system.
- the outline tiles `$28-$2D`, water, the swirls and the switches, ability enemies and `$57`;
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
- **The guide's `$6A18` is written back to the live work copy**, because the game's guide runs on the real one and `$6A18` is outside the block. So are its last rolling step's `$DA3A`/`$6A72`, which it sets by its own rule (`$81:B23A`: code 0 → class 0, else class 1). Only a snap panel's landing, which rolls on the landing frame, reads them before a real rolling step recomputes them (web_snap_land: `$07B0`).
- **Kirby's pose is written at the game's sites** (the aim loop, the curl, the roll's start, the reset, the hop, the squash, the bounce), not derived from scratch each frame.
- **The coefficients `$DA30`-`$DA46` live in the work copy only.** The block round-trips them in the game; one ball needs no copy. Every shot's set-up resets them (`$80:C4FF` → `$80:C688`, `systems/hole-flow.ts`), so the work copy's are the block's then too.
- **The outline wall's sound 7 goes through the step's tail** (`tailSfx`), where the game plays it inline: same frame, same id.
- **`placeBall` can re-probe**, so a placed ball has current probe fields. The game's block carries them at `$D8C2`-`$D8DE`, and a poke that skips them makes the first step read the old ground.
- **A warp's turn is made before its stall.** The game turns the ball to the destination's arrow (`$82:ECFC`, `$82:AC4C`) after the warp's frames; the engine does it with the move, since nothing reads the velocity in between (the work copy is not stored while the step blocks).
- **A warp list of 1, 3 or 4** is not played: the game's random pick (`$82:ABC6`, `$80:87DD`) is not ported, no ROM hole has one, and the test holes' validation rejects it.
- **The hum's music volume holds for the song playing.** `$80:B5F4` sets the driver's master volume; the engine scales the current song's gain, and a new song starts at full volume. When the game resets `$1003` is not traced.

The bridge:
- **The cutscenes are a bridge-only replay** (the user's choice, 2026-11-14). The plan had one entity per recorded object, but the recording has no object identity, only up to 27 OAM slots a frame. So `replay.ts` and a sprite pool draw it, and its cues join the drained events before `play-feedback`.
- **The intro holds the core** for 164 frames, because core's hole starts at ShotSetup. The user's pause is still the `pause` action, and it freezes the intro too.
- **The hole's song is the intro's cue.** `startHole` emits none; the director plays `CourseData.song` at the recording's two song cues, and with `?nointro` the host plays it.
- **The shot panel and the score panel are derived in the view**, from `HoleFlow`, `Shot` and a per-core-frame history; core has no panel flags.
  - The shot panel's age counts from the curl plus 26 (web_ui's A → curl), and the picture lags one frame (the snapshot rule).
  - (Until port_v2 phase 7 the score panel followed the web demo's rule; it is now core's `ScorePanel`, the game's.)
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

`make engine-test` runs 47 vitest files (856 tests) in node. The ROM-derived ones skip when `build/engine` is missing. The recordings they compare with are the stepper's runs of the input scripts in `tools/snesstep/inputs/`, made by `make engine-traces` (`npm run traces`) into `build/engine/rom-test/`.

| test | checks |
|---|---|
| `fixed`, `rules`, `terrain`, `fixtures` | the fixed-point and trig maths; `tables.json`; the surface against `terrain_golden.json` |
| `kernels` | single routines against the numbers emulated in physics.md |
| `trace-shots` | 11 shots seeded at the launch: every ball state frame-exact to the lost ball's reset |
| `trace-script` | 16 scripts end to end, no seed and no pokes (web_water_shot on course 1 hole 7): the game's exact launch, then every distinct ball state with no catch-up (195-409 per shot), through web_hole's sink |
| `flow`, `flow-units` | web_flow, web_curve, web_ui, web_fly, web_fly_spin, web_hole, web_tomatoes and web_water_shot against the per-frame flow traces. The discrete fields are within ±2 frames (the state, facing, angle, aim, elevation, selectors, meter, over, the counters, the card, Kirby's priority `$D96A`). The camera is within ±2 px in x and ±8 in y; the guide's end within 1 px on 95 % of the targets. The projection is bit-exact |
| `events` | every sound request of seven runs, on its iteration |
| `stalls`, `reveal` | the hit-stops and the reveal's edges, frame-exact; the reveal's stages on course 1's holes 1-4 |
| `hole-entities`, `hazards`, `hazard-actors`, `trace-hazards` | the sweep on all 8 holes; the one player entity, active from `startCourse` through `nextHole`, GAME END and CONTINUE; the five hazard scenarios (ball states, sounds, the actors' state sequences); `$A2` and the auto-tiling on t7 |
| `trace-warp` | two poked scenarios on course 1 hole 4 (`web_warp`, `web_warp_fly`): the warp `$B4` → `$B5` rolled onto and landed on; ball states and sounds, the stall's frames, Kirby's sprite and the camera's pan every frame from the warp's start |
| `trace-terrain` | three poked scenarios on course 1 holes 2 and 3 (`web_arrow`, `web_ramps`, `web_step`): the arrow panel's turn, the in-cell crest, flush ramp edges along ±y, a step hit by the N edge and its hit-stop; two on course 3 hole 2 (`web_boost`, `web_boost_side`): the N boost panel hit straight and askew (the small push, the launch), object 112's hum and its end; five on the snap panels (`test/snap-scenarios.ts`; course 7 hole 7, course 4 hole 6, course 8 hole 7): `web_snap` (rolled onto, to the floor `$E000`, the latch the enemy beyond shares), `web_snap_land` (landed on), `web_snap_back` (against the push), `web_snap_fast` (the cap `$2000`), `web_snap_east` (`$19`'s skipped store); eight on the water (`test/water-scenarios.ts`; course 1 hole 7): rolled in, dropped deep, a shallow corner, skims, out over the rim, two skips with top and back spin, the modifier's bounce; four on the rough `$04` and three on the kickers `$10-$13`; twelve on the copy abilities (`test/ability-scenarios.ts`): eleven poked (a stock and B at the roll's first frame: Tornado, Fireball, Wheel, the UFO into a step; Parasol off a ledge; Spark into a tree and onto a volcano; the UFO into a bumper; Needle onto a boost panel; Freeze and Stone into the pond; their sounds on the game's iterations) and web_ab_c1 unpoked (course 1 hole 3: the Hi-Jump enemy taken, used on the next two shots, a second B refused by the latch; frame-exact); eight on the switches and the swirls (`test/switch-scenarios.ts`; course 2 hole 3, course 4 holes 2 and 3, course 1 hole 8, course 3 hole 8): the `$75` and `$74` swirls rolled through and landed on and the `$74` while off, the toggles' switch rolled onto and landed on, the water switch's drain and fill with their 64-frame block; ball states, the ability's block words and sounds (`test/scenarios.ts`, shared with `trace-hazards`) |
| `trace-demos` | the DEMOPLAY demos 10-19 on holes 160-169, played from their set-ups with the pad the game read (`test/demo-harness.ts`: video frames from each shot's first aim to its launch, the game's iterations in the roll, re-anchored every shot; `core/demo.ts`): every tick of the ROM's streams (`$83:DAAA`); every ball state in order with the ability's block words (`$D852`-`$D85E`) at each, Kirby's states at the game's frames ±1, every sound request ±1, to the hole-out |
| `ability-colours` | Kirby's colours 2-8 frame by frame on the demos and web_ab_c1 (the flash, the outline's green flash, Fireball's set and fades, Spark's cycle, Freeze, the UFO's colours, light and warning, the restores; the power stage's glow skipped); the HUD's icon at every change of picture (the stock's, the face, the ball, the UFO's countdown) within 2 frames |
| `ability-objects` | the abilities' drawn objects on the demos against their recorded slots (`trace_actors.py --types 21,27,...`): each object in order, its frame index and point at each change within a frame, its end; the followers over their first 120 frames |
| `kirby-recolour` | the BGR555 → RGB conversion and a repaint |
| `water-fx` | the water's scenarios and web_water_shot: per matched ball state the block's `$D872` and Kirby's palette (the CGRAM shadow `$0504`); every splash (53-58) and bubble emitter (67) in spawn order, its states (x, y, frame) in the game's, the random state seeded at the set-up; the region at its edges, the level, the skip count, the mode branches, `$80:87DD` |
| `switches` | the switches' and the swirls' eight scenarios (`test/switch-scenarios.ts`, whose ball states and sounds are trace-terrain's) on the game's iterations from the poke: `$6A2A`, `$6A2C` and `$69CA` as the step writes them; objects 117 and 118's colours (CGRAM 78 and 94) and object 127's frames (its uploads), each set to the game's phase at the poke; Kirby's `$D7D4` through the water switch's block; the block's 64 iterations and their dissolve steps. The disc at its rim and past its last row, and the view's dissolve mask |
| `snap-stars` | objects 61 and 62 on the five snap scenarios against their recorded slots (`trace_actors.py --types 61,62`, with the slots' exits): the spawners, the bursts, each star's states (x, y, frame) in order, taken twice a tick; the polar step, a script's life, the burst's sign test |
| `courses`, `hole-flow` | the test holes' validation and coverage; on them: a hole in one, a hole-out, a lost ball, out of tomatoes, t6's warp pair, GAME OVER and CONTINUE, all 8 holes to CourseDone (the course driver holds A on each RESULT card), pause |
| `aim-buttons` | the aim's other inputs (port_v2 phase 7): web_pause, web_pause_quit, web_look, web_bspin, web_lr, web_cancel, web_idle and web_select on hole 1: the pause, its cursor, the preset and its repeat, the side and top/back, the look and its arrows, the lockout, the score panel and `$691A`, the idle timer, SELECT's card's brightness, the pose and the aim, ±2 frames; the camera within 2/8 px. flow.test's eight runs add `panel` and `hudon` |
| `card` | web_card: the RESULT card's brightness from the blank to the next hole's load, the card word, the panel |
| `save` | the save's rules against the game's battery RAM: five autoplay runs (course1, game, game2, game4, extra), decoded by `tools/sram.py`, replayed from an empty save through `newMember`, `beginCourse` and `finishCourse`: the members and the rankings equal the game's; the medals' thresholds; the ranking's order, ties and 25th place |
| `assets`, `view-catalog`, `event-table` | every clip's frames exist; every name a view draws exists (the rim's `cupmask`, the warp's objects, object 62's five pictures, every frame the water's objects show, Kirby's wet twins, the guide's pictures from the water, every species' clip, the hazards' tables by tile); the manifest's 8 courses of 8 holes; every hole's song (the 64 of `$80:C99D`'s lists); the cycles follow the tiles (ripple, boost, warp/snap panels, with their sets and steps); the glow's table; every sound id has a file; nothing is emitted outside the event table |
| `cup-mask-warp` | the rim mask's first frame and cut; objects 63 and 64's pictures and lives |
| `occlusion` | table 10 as exported; `$82:F4FD`'s branches on hole 1 and web_fly's fall; the builder against the ROM's tables (99 % at least); Kirby's depths and the shadow's test |
| `determinism` | host frames of 1, 2, 3 and mixed core frames give the same world and the same events (web_hole on hole 1; a pad policy on t1) |
| `frame-clock`, `cutscene`, `director`, `panel-state` | the 60.0988 Hz clock; the replay against the recording, sprite by sprite, and the anchors; the director's timing against core on web_hole; the panel's ages, closings, blink and meter lags on web_ui |
| `gen`, `gen-sim` | the random holes: 200 layouts per difficulty valid and flush but for their step-downs, actors on `$01`, only ported tiles; a seed always gives the same hole and plan; plans within the par windows; three plans replayed through the world hole out; the shot simulator's rests equal the world's on the test holes, and its speed |
| `styled` | the styled terrain: deterministic, a flat cell is the `$020/$021` block, the walls go to the outline mask, and course 1 redrawn from its grids matches its exported art (see "Random holes") |
| `no-phaser-in-core` | the dependency rules above, the player's handle included: no `queryFirst` on a player trait anywhere in `src/` or `test/` |

In the browser:
- `npm run e2e` runs `test/e2e/smoke.mjs`, `test/e2e/courses.mjs`, `test/e2e/random.mjs`, `test/e2e/water.mjs`, `test/e2e/ability.mjs`, `test/e2e/switch.mjs` and `test/e2e/pause.mjs` (Playwright with the cached Chromium). `pause.mjs` steps course 1 hole 1 with pads through the debug hook: the idle timer's score panel, the pause menu and its cursor, the spin preset, the look, an L snap, and QUIT back to the menu (screenshots in `build/engine-test/pause/`). `switch.mjs` plays web_sw_water_drain on course 1 hole 8 and web_sw_switch_roll on course 2 hole 3 with the ball placed as their pokes put it, checks the core's switch state at the screenshots and fails on any page error. `ability.mjs` plays web_ab_c1's input on course 1 hole 3 frame by frame, checks Kirby's clips in the transformation and the jump, and saves screenshots at the take, the transformation, the jump and the third shot's aim (`build/engine-test/ability/`). `water.mjs` plays web_water_shot's input on course 1 hole 7 frame by frame through the debug hook's `step`, with screenshots at the entry, on the bed, in the aim from the water and on the way out (`build/engine-test/water/`). `courses.mjs` boots hole 1 of each of courses 1-8 with `?course=N` (the hole's ROM index and song checked, a screenshot each in `build/engine-test/courses/`), and plays a shot on course 3 hole 2. `random.mjs` generates seed 42's course, checks that a reload gives the same holes, plays a shot on hole 1, and saves screenshots to `build/engine-test/random/`. `smoke.mjs` boots course 1 and plays a shot. It checks that there is no page error, console error or failed request, that the ball's view moves, and that the tee and the cup draw under Kirby.
- `python3 tools/check_web_ui.py --target engine` renders the panel for 20 recorded states. All 20 are pixel-identical to the game's OAM sprites.

The harness's conventions:
- **`GAME_OFFSET` = 2332**: engine frame f is game frame f + 2332. It is pinned on web_flow's set-up, and every script starts hole 1 with `2100 A`. The poked scenarios carry their hole's own offset (2338 on hole 17).
- **The demos have no offset**: `playRecording` (`test/demo-harness.ts`) re-anchors each shot on the game's recording, as above. The help texts of demo mode (`$82:F7EE`, the threads stopped) are not played; the HUD's free-running phases are put back where the game's are after them.
- **The poked ability scenarios compare their sounds on the game's iterations** (`Scenario.clock = 'iteration'`, `iters_<name>.json`), the game lagging about 5 frames after a poke; web_ab_c1 on its frames (`'frame'`).
- **A poked hole needs `$6A5C` too.** `$6A5A`/`$6A5E` pick the hole, but the course slot `$6A5C` (2 × course; the song list, the ripple's colours) is set on the map, so a poke of `$6A5A` alone plays course 1's song and ripple ([emulation.md](emulation.md)).
- **A stamp below scanline 112 belongs to the previous iteration** ([emulation.md](emulation.md) "Frames, iterations and snapshots").
- **The trace comparison aligns distinct states**, allowing the game's lag bursts, and the hazard actors are aligned to the recording before each poke.
- **Koota keeps at most 16 worlds per process**, so the tests destroy their worlds in `afterEach`.
- **Koota 0.6.6 hangs creating a tracking query** (`Removed`, `Changed`) over a trait on a generation's last bit, 2^30. Its loop `for (bit = 1; bit <= mask; bit <<= 1)` overflows to −2^31, then 0. A trait takes the next bit when a world first sees it, so `createGameWorld` registers `Visual`, the one tracked trait, first. The `Warp` singleton had pushed it to 2^30, and the hole scene hung in `primeBindings`. `hole-entities.test.ts` checks the bit.

## Not ported, or approximated

The physics:
- `$81:980B`'s crest branches across cells: the eight per-crossing quadrant samples fall through to "no crest", which is exact for flat and same-shape crossings. The game launches the ball rolling from a flat cell onto a ramp that falls away from it. Two recordings show it: web_haz98 at 2497, and web_ramps' first draft at 2473 (course 1 hole 2, the flat (4,15) onto the `$06` ramp). The engine rolls on instead. The in-cell branch (no edge crossed) is ported and recorded: web_arrow at 2541.
- `$58`/`$59`, the `$6A2E` switch (`switch58` in tables.json: plain ground). It is read (docs/tiles.md "Not established"), but it is only on the 2P holes, so it waits for step 9 with the 2P branches of the switches (`$82:A20E`, the other ball on a swirl; `$82:A474`, the other ball's water state and palette set 4).
- The copy abilities' 2P parts (step 9): the ball-to-ball hit codes 12-17 (`$82:C693`, `$80:DF29`/`$DF55`), the contact matrix `$82:C41E`, the stock swap, the roulette `$82:8DD2` (the 1P holes have no `$57`), Freeze's `$D780,X` = `$15`; a 2P code in the reaction throws.
- Player 2's wet palette (`$98:C7A4` at CGRAM `$92`) is not used.
- The water switch's dissolve draws one water picture per layer, the topmost water tile's. Where two water tiles are stacked in one layer, the lower one's pixels do not show through as the upper one's go (no 1P hole tested).
- The tiles `$58`-`$5D` ([tiles.md](tiles.md) "Not established"). The warps `$B0`-`$B9` are ported, except the random pick among 3 or 4.
- The rough tiles' `$80:A453` arithmetic: ported, but no trace exercises it.
- `$68F0` outside the fly shot's first bounce (the spin streak's end on a spin of 0 or a lost ball is ported).
- The game's lag frames: the engine has no cycle counts, so course 1 hole 4's reveal and the volcano holes are a few frames off where the game lags. So is the HUD's tomato after course 7 hole 7's reveal (web_snap: 4 frames later in the game), so the snap scenarios there end before it.

The flow:
- Kind 1 (Down after a grounder: an 80-step guide with its own gap end, `$81:AAF3`) is approximated as kind 0 with 80 steps.
- The guide's lag is measured, not modelled: shorter rolling guides and the full fly guide are unverified.
- The APU's lag is measured on the fall's song only.
- The RESULT card's warp star with Kirby (objects `$88`/`$89`) and twinkles (`$83`) are not drawn, and its numbers show from the build, where the game's pop in later. SELECT's BEST window has course 1's colours on every course, and a built-in record's face is not drawn (its PLAYER box is blank, like the members' drawings). The digit cell `$89`/`$99` (shown for a 0) is unconfirmed.
- The night's 18 OBJ colours (`$98:D406` at CGRAM `$C6`), its palette loop `$83:D3D9` and the ripple's alternate colours (`$84:84F1`) are not ported; the BG layers' night is.
- The hover drop's length (`$82:8CE8`[h] + 8) is unmeasured, and the view draws it linear.

The presentation:
- Objects not drawn, for want of pictures or a trace:
  - the curl stand-in `$1A`, the full-power object `$16`, the spin streak 25;
  - the hop object `$78`, the outline-wall effect `$47`, the hazard flash `$2F`;
  - the ring stage's 78/97/79, `$BE` (the `fall_asleep` clip stands in), `$40` after the out-of-tomatoes sleep (the warp's 64 is drawn), 110;
  - the eruption's projectiles (object 84);
  - the score panel's toggles, the tee changing colour during the curl, the fly shot's shrinking dot tiles;
  - the copy abilities' overlays drawn in Kirby's OAM pass (`$6A98`-`$6AA4`): the UFO's saucer (object 49, its poses' VRAM blocks `$85:AFE6` not decoded) and the parasol's canopy (object 51, `$89:A144`/`$A165`), so Kirby shows without them; his frame index `$D95E`/`$0B7E` (the parasol's 6/7, the UFO's set-up), the clips' own frames standing in; objects 34 and 42-45 (tile `$04`'s dust), 44, 60 (Spark's volcano), the parasol's end puff 52, never seen in the demos;
  - the power stage's glow on Kirby (an object of bank $84, `$84:CBBE`: colours 2-6 darken, colour 7 blinks `$0018`).
- The guide's dots march in four steps of 5 frames toward the next point; the game's order of the march is not traced.
- The game's random state (`$80:87DD`) starts at its power-on value in the engine and only the bubbles advance it; the game's carries the menus, the attract and the holes' openings. In play the bubbles' positions and waits are the game's kind, not its draws; the tests seed the state from the recording.
- Kirby's colours other than dry and wet are his dry frames repainted in the browser (`kirby-recolour.ts`): a pixel takes a palette colour by its exact RGB, so a colour of another palette with the same RGB would change too (none in the atlas's Kirby frames). The HUD's outline and icon phases start at 0 on the course's first hole; the game's run from its panel set-up.
- The snap panels' stars have no OAM queue: they draw just behind Kirby. Their queue is Kirby's, +1 when the heading is < 3 or ≥ 11 (`$85:CFB9`). That put them behind him in the stepper's snapshots of web_snap (2502-2508), but other sprites' order around them is not checked. A star's frames 0-2 take Kirby's current priority, where the game's `$DA74` is read when the star is drawn; the two are the same here.
- The outline pulse starts at the hole's first frame; its phase in the game is not known.
- The palette cycles (the ripple, the boost and warp/snap panels', the glow) start at their set 0 on the hole's first frame, and so do the switches' objects 117, 118 and 127. The objects start them at the load, so the phase is not known, and the game's lag frames, which stretch a step (10 frames once in a recording), are not modelled. From a switch's flip on, 117's and 118's sets follow the game's exactly (test/switches.test.ts). The ripple runs on object 113's own clock, held while the water is off (`Switches.rippleTicks`). Its other variants are not ported: the iced water's colours (`$69DA`, Freeze) and the `$6A2E`/`$ED5B` tables ([courses.md](courses.md)).
- Not ported at all: object 116's colours (the `$58` switch, 2P holes only); the scenery's own cycles (`$84:CF31` on courses 2 and 5, `$84:D072` on course 8: BG3 colours); the alternate palette tables `$6A2E` selects (with `$59` and no `$58`).
- The styled terrain's boost panels and warps do not cycle.
- The shadow has one picture. The game's frame is the surface code (`$D996` = `$DA04`, `$81:A23E`), so its shape follows the slope.
- The procedural terrain is a picture of the data the physics runs on (quadrant planes, slope shading, tile groups by colour, walls and outline as lines), not the game's art.

## Deferred

- The test holes and the random holes place no ability enemies (the ROM holes do: all ten abilities are ported).
- Two players: the second player entity and the turn change (the handle, `IsActivePlayer` for `$1803`, is in place), pad 2, the tomato queue's per-player entries, the follow's catch-up states, stolen stars (`$82:8B0F`), ball-to-ball hits, the 2P HUD, the asleep turn-skip.
- King Dedede; the shell's other screens (port_v2 phase 7, pieces 4 and 5: the course's clear and result, the medal award, the course ranking, the map, the course intro, GAME OVER's own screen, the logo, the title and its menu, the members list); player names (NAME ENTRY is skipped by the user's choice). The pause menu's COURSE SELECT SCREEN and QUIT end the course and go back to the dev menu until the map and the title exist.
- The extra game (holes 64-127): the same loading with `ENGINE_HOLES` (its songs and ripples are courses 1-8's), but not offered.

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
| 8 | the hole songs per course | settled and ported: `$80:C99D`'s lists, emulated on the whole game for courses 1-8 ([audio.md](audio.md)) |
| 9 | enemy kinds beyond hole 1 | settled for the shapes: every species' idle clip recorded (`trace_enemies.py`); open: `$48`'s colours on course 3, `$40`'s pictures on hole 36, the ability species' pose and pulse as two cycles |
| 10 | the night palette | settled: the alternate tables, every hole (port_v2 phase 7) |
| 11 | the cutscene is one recording | open: c1n kept |

Frames measured on one run only:
- objects 63 and 64's pictures frame by frame (web_warp), and the cup's rim mask's life (web_hole's sink, c1n's hole-outs);
- the hole-in-one's 1UP at C + 386 and its bonus tomato at C + 445 (c1n);
- the tomato's blink start;
- the fly guide's lag beyond web_ui and web_fly.

Read from code but not seen in a run:
- `$6A8C`, the reveal's hold on objects 76 and 77;
- the −y step clamp ([physics.md](physics.md) "Cell edges, walls and steps");
- state 40's arm on a volcano (`$D78C` = 3);
- the water's ability branches beyond the demos and web_ab_freeze_pond / web_ab_stone_pond: the UFO riding the level (`sim/water.ts`);
- the splashes' and bubbles' depth one OAM queue back (behind Kirby), and in his queue (in front) beyond the one snapshot of web_water_shot 2763.
