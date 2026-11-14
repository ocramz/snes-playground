# Engine phase 7: the Phaser bridge

Date: 2026-11-14 (session 6). Plan: `plans/port_v1_koota_phaser4.md` item 7,
"The Phaser bridge: the atlas->texture/animation conversion in PreloadScene,
the views, the cutscene replay, the HUD and the panel, the audio feature".
The session plan is in `~/.claude/plans/let-s-do-phase-7-recursive-sundae.md`.

## Result

The engine plays in the browser: `cd engine && npm run dev`, then
http://127.0.0.1:5174/. It runs ROM course 1 (holes 1-8, with their bitmaps)
and the eight authored test holes (drawn by the procedural renderer). The
playable loop covers:
- the star's fly-in;
- aiming with the guide;
- the shot panel;
- the roll;
- the takes and the cup's reveal;
- the hole-out with the star's fly-out (HOLE IN ONE with its night palette);
- the score panel, the music and the effects;
- pause, the course card, GAME OVER and CONTINUE.

Core is unchanged.

Checks:
- **`python3 tools/check_web_ui.py --target engine`**: the engine's shot panel
  is pixel-identical to the game's OAM sprites on all 20 web_ui frames.
- **`npm run e2e`** (`test/e2e/smoke.mjs`): course 1 boots and a shot rolls,
  with no page error, console error or failed request. The ball's view
  moves, and the tee and the cup draw under Kirby.
- **Seven new vitest files**, 372 tests in all, all passing:

  | test | what it checks |
  |---|---|
  | `frame-clock` | the 60.0988 Hz accumulator |
  | `determinism` | host frames of 1, 2, 3 and mixed core frames give the same world and the same event list (web_hole on ROM hole 1; a pad policy on t1) |
  | `cutscene` | the replay against the recording, every sprite on every lit frame of the three windows; the engine's tee and cup anchors against the recorded ones |
  | `director` | the intro's hold, then the hole-out on web_hole: core's songs, its HoleOver and the replay's own cues land on the recording's indices |
  | `panel-state` | on web_ui: the curl's lead, the ages, the closing frames, the tomato's blink, the meter's lags |
  | `view-catalog` | every name the views draw with exists in the atlases |
  | `event-table` | every sound id has a file; the test courses and 12 stepper scripts emit nothing outside the table |
- **`no-phaser-in-core`** now also checks the pure bridge modules.

## What was built

| | |
|---|---|
| `tools/export_web.py --only objects` | `objects.png/json`: the emulated sheets of objects 76, 77, 81-83 (`export_web_sprites.build_objects`) |
| `tools/export_web.py` `hud` | also writes `hud.json` (the score panel's slots) |
| `tools/export_web_sprites.py` | the clips `fall_asleep`, `dizzy`, `hit_burn_*` |
| `tools/web_audio_map.json` | the 19 effects and 2 songs core emits that were not rendered |
| `tools/check_web_ui.py --target engine` | the panel's pixel check against `engine/` |
| `Makefile` | `engine-assets` runs `objects`; `make engine-e2e` |
| `src/game/bridge/` | `tick-time` (FrameClock), `frame-loop` (`runHostFrame`), `history`, `capture-input`, `bind-views`, the `sync-*` systems, `play-feedback`, the presentation schedule, the view registry and `Ref` |
| `src/game/features/` | the view catalog; the Kirby, enemy, cup, tee, pillar and hazard views; the layers (bitmaps, outline pulse, night) and the procedural terrain; the guide; the shot panel; the HUD state; the font; the audio player and the event table; the cutscene replay and director |
| `src/game/scenes/` | Boot, Preload, Menu, Hole (the only simulation host), Hud (parallel), Result |
| `src/game/host.ts`, `main.ts` | the world and the platform context, passed in scene data |
| `src/game/debug.ts` | `?debug`'s actions: the ball onto the next enemy or the cup |

The pure modules import only core and each other, so the node tests run
them:
- `bridge/{tick-time,frame-loop,history,placement}`;
- `features/{catalog-data,kirby/pose-clips,audio/event-table,cutscene/replay,cutscene/director,shot-panel/panel-layout,shot-panel/panel-state,guide/guide-dots,hud/hud-state,text/encoding}`;
- `assets/schema`, `config`.

## Facts settled (docs candidates)

- **A snapshot is a frame late.** The stepper's snapshot f holds the WRAM at
  the end of frame f - 1 and shows the picture built in it (web_ui: snapshot
  3250 meter 1, 3251 meter 0; the flow trace has 1 at 3249). So the host's
  picture after core frame n is the game's snapshot n + 1. ui.json's ages and
  the tomato's blink were measured on snapshots. The meter's lags (gauge 1,
  face 2) and the closing frames are in core frames.
- **The panel's timing is counted from the curl.** On web_ui the curl
  (state 6) comes 26 frames after the aim's A (2800 -> 2826). Snapshot ages
  from the A are the curl's age + 26. The engine's Spin starts on that same
  frame.
- **The panel closes in three steps** (a stepper run with snapshots
  3240-3281, 2026-11-14). R is the core frame the meter latched: web_ui 3250,
  the auto-fire at 0.
  - the gauge goes at R + 1: the meter reads 0, and gauge 0 is empty;
  - the face, the ruler, the marker and the tomatoes go at R + 22, the roll's
    first frame;
  - the "1" goes at R + 25.
- **The tomato about to be spent blinks** through the power stage, 8 frames off
  and 8 on, in phase with the curl: off in snapshots 3242-3249 and
  3258-3265. When it starts is not measured; the engine starts it with the
  power stage.
- **The panel's OAM order**, front to back (web_ui f003180): the "1", the
  tomatoes, the gauge, the dot, the bar, the ruler, the gauge frame, the
  face.
- **The hole-out's index 2 is the sink's end.**
  - c1n's window starts at `$DA4A` = 1 (3121), with $21 at 3123: its ball was
    put on the cup's centre and sank in 2 frames.
  - On web_hole the ball rolls in: holed 1 at 3894, then holed 2, $21 and
    state 1 all at 3908.
  - So the replay's index 2 is the frame core's ball has sunk (BallHoled 2,
    the 'holed' event).
- **C is HoleFlow.since + HoleFlow.length.** `length` holds the arrival's t
  in the HoleOut phase, not a frame number, and HoleOver resets it.
- **Core's HoleOut is the recording's.** With index 29 at C, core's songs
  land on the cues (25 at 60, 24 at 176; HIO: 0 at 60, 26 at 87, 24 at 527).
  HoleOver comes right after the last index (C + 410 / + 760).
- **The anchors.**
  - The tee pad (type 108) is Kirby's projected point on the tee's centre,
    1 pixel up: (320, 263) on hole 1.
  - The cup's ring (type 74) is at its cell's corner, as the enemies are:
    (352, 232) for the cup at (6, 5).
- **Object 76's four frame tables are its directions.** In
  `build/sprites/emu/obj_076.png`, tables 1 and 3 are the mirror images of
  0 and 2. On hole 5 the mover heading north (dir 0) draws table 0. The
  order N E S W = tables 0-3 is inferred.
- **State 40's clip.** It switches on `$D78C` = the hit code - 12
  (clips.json). The volcano's code `$0F` gives 3, Spark's arm: inferred.

## Deviations (for docs/engine.md)

- **The cutscenes are a bridge-only replay** (the user's choice, 2026-11-14).
  The plan had one entity per recorded object, but the recording has no
  object identity, only up to 27 OAM slots a frame. So `replay.ts` plus a
  sprite pool draw it, and the cues join the drained events before
  play-feedback.
  - The hole-outs' songs and $21 are core's, so those cues are dropped.
  - The replay plays its own: the intro's song and effects, $1D, $67, $3E
    and the 1UP's $2D (core's `gainLife` emits none).
- **The intro holds the core** (core unchanged: "the hole starts at
  ShotSetup"). `startHole` spawns the hole, the host runs no core frame for
  164 ticks, then both run until the window's 168th frame. User pause is
  still the `pause` action and freezes the intro too.
- **The hole's song is the intro's cue.** `startHole` emits none. With
  `?nointro`, the host plays it.
- **The panel and the score panel are derived in the view**, from HoleFlow,
  Shot and a per-core-frame history, not from core flags. The score panel
  hides while the shot panel is up and during cutscenes (the web demo's
  rule; the game's is not known).
- **`sync-pose` dirty-checks the clip** rather than tracking `Changed(Pose)`:
  core writes Pose several times a frame, some through `updateEach`, which
  koota does not flag.
- **A clip's `next` is ignored.** It names a state, and core sets that state
  itself. A loop tail is a second anim, chained.
- **Music plays on its own AudioBufferSourceNode** with the loop points.
  Phaser's WebAudioSound has no loop region.
- **The score panel has no slot for the enemies left**, so they are not
  drawn. The lives sit in the blanked portrait box.

## Unported, approximated, deferred

- **Presentation objects not drawn** (no exported pictures, or no trace of
  them):
  - the curl stand-in `$1A`, the full-power object `$16`, the spin streak
    `$19`/25;
  - the hop object `$78`, the outline-wall effect `$47`, the hazard flash
    `$2F`;
  - object 75 over the cup, the ring stage's 78/97/79;
  - `$BE` (asleep: the `fall_asleep` clip stands in), `$40`, 110;
  - the score-panel toggles, the portrait's face;
  - the tee changing colour while Kirby curls;
  - the fly shot's shrinking dot tiles.
- **The guide's dots march in four steps of 5 frames** toward the next point.
  The game's own ordering of the march is not traced.
- **The hover drop of a revealed cup is drawn linear** over
  `$82:8CE8[h]` + 8 frames; its curve is unmeasured.
- **Every enemy draws hole 1's sheet** (type 73, the only "match" actor).
  77's and 81-83's first frame table is used everywhere (unconfirmed per
  course).
- **The night palette exists for hole 1 only** (plans risk 10). On other
  holes HOLE IN ONE plays without it.
- **The outline pulse's phase at a hole's start is not known.** The engine
  starts the walk at the hole's first tick.
- **Audio** (docs/audio.md):
  - the effects were rendered over song 0's tempo;
  - the driver's dropped ticks are not modelled;
  - the libgme level difference is not corrected.
- **The procedural terrain is a picture of the data**, not the game's art:
  quadrant planes, slope shading, tile groups by colour, walls and outline
  tiles as lines.

## Harness notes

- **`?debug`** exposes `window.__engine`:
  - `phase()`, `frame()`, `kirby()`, `depths()`;
  - `step(pad, n)`, `freeze()`, `isolatePanel()`;
  - `hitNextEnemy()`, `putOnCup()`, `freeEnemies()`.

  `?nointro` skips the fly-in; `?hole=N` starts the chosen course at hole N.
- **`test/e2e/browser.mjs`** launches Playwright's cached Chromium, as
  `web/test/e2e` does. `smoke.mjs` is `npm run e2e` / `make engine-e2e`, and
  `panel.mjs` is the browser half of `check_web_ui.py --target engine`
  (output in build/engine/test-panel).
- **Koota keeps at most 16 worlds per process.** The new tests destroy their
  worlds in `afterEach`.

## For phase 8

- **`docs/engine.md`**:
  - the mapping;
  - the event table (`features/audio/event-table.ts` is its source);
  - the asset table (`objects`, `hud.json`, the audio map's new rows);
  - the deviations above;
  - the unconfirmed list.
- **`CLAUDE.md`**: `engine/` in the layout, and the engine's run and test
  commands.
- **Move the traits out of `systems/`.** `Reveal` (systems/reveal.ts),
  `Hazards` (systems/actors.ts) and `Stall` (systems/stall.ts) are traits
  declared in system files. The views read `Reveal` and `Hazards` from
  there, along with the constants `HOVER_DROP` and `HOLE_SONG`; they call
  no system. Reference §3 would have them in `core/traits/`.
