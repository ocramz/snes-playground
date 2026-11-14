# Plan: the original's playable mechanics on the Koota × Phaser 4 architecture

## Context

`docs/` describes the original's mechanics: physics, terrain, tiles, enemies and the cup, the shot flow and scoring. Each fact was measured against the ROM and the headless stepper. The existing `web/` demo ports one hole as a conventional Phaser game: state lives on scenes and the logic in `HoleScene.update`.

The goal is a fresh implementation in which every mechanic and every event of the playable 1-player loop follows `reference/koota_phaser4.md`:
- Koota owns state and rules.
- Phaser is the platform.
- A thin bridge is the only code that touches both.

`web/` is left untouched and not used as a source. Everything is ported from `docs/` and checked against the emulator traces.

Decisions taken with the user:
- Both layers, Koota core plus Phaser 4 bridge and view, in a new `engine/` directory.
- Scope: the 1-player course loop, matching the traces exactly. Copy abilities, 2P and Dedede are mapped in the doc and marked deferred.
- In the playable levels: Kirby flies in on a star, the level is played, kirby flies out on a star once the player hits the hole.
- Stretch goal : Level map
- Out of scope : scoreboard, player name, final boss


Load the ROM's sprites, course bitmaps, fonts, text and audio. Ship the original hole layouts; it plays test courses written in the engine's own JSON format. 

Refer to this ROM-exported data:
- the physics constants (`tables.json`);
- the headless trace tests (the hole-1 `course.json`, `build/web-test/*`).

## Layout (`engine/`, one package following reference §4)

```
engine/
  package.json        koota 0.6.6 (npm; fallback file: from the local copy), phaser 4.2.1,
                      vite 8, vitest 5, typescript 5.9  (versions as in web/)
  vite.config.ts      publicDir = ../build/engine (rules/tables.json + assets/); courses/ imported
  index.html
  courses/            test courses (*.course.json), authored for the engine
  src/core/           imports koota only
    fixed.ts          wrap16, asr, hi16, mulQ15s (sign-magnitude, toward 0), mulFloor ($81:97A9),
                      mul16x8 ($80:A342), atan2Deg ($80:A4C1)
    rules.ts          RomRules: tables.json → typed arrays + consts, with accessors
    course-data.ts    CourseData {w,h,shape[],elev[],walls[],tile[],tee,originY} + validation;
                      fromRomCourse(course.json) — shared by PreloadScene (shipped holes) and tests
    terrain.ts        surfaceZ, quadrant, edge level, stepHeight (terrain.md); pure
    projection.ts     px = 32(x+y); py = originY + 16(x−y) − 16·Z/$5A82
    sim/              kernels: pure functions over a mutable BallWork struct, one per original
                      routine (reflect, friction, slope, curve, edges, landing, step, launch,
                      tile handlers, cup, enemy hit, spin, power)
    traits/ systems/ actions/ events.ts schedule.ts world.ts (createGameWorld(), no global)
  src/game/           Phaser layer: scenes/, bridge/, assets/keys.ts, features/ (see below)
  test/               fixtures.ts, input-script.ts, headless.ts, align.ts, *.test.ts
```

Root changes:
- `Makefile`:
  - `build/engine/rules/tables.json` comes from `tools/export_web.py --only tables --out build/engine/rules`, which needs the ROM only.
  - The test hole and golden terrain come from `--only course,golden` into `build/engine/rom-test`.
  - `build/engine/assets/` from the same exporters the web demo uses, with `--out` pointed there (see "Assets" below); same dependency set as `build/web` (`AUDIO`, `HUD`, `CLIPS`, `REPLAY`, `CUTSCENE`).
  - New targets `engine-assets`, `engine` (npm ci plus vite build) and `engine-test`.
- `CLAUDE.md`: add `engine/` to the layout.
- New `docs/engine.md`: the mapping, described below.

## The event model, one rule for the whole codebase

| Kind | Original | Koota form | Lifetime | Read by |
|---|---|---|---|---|
| State | WRAM: player block `$D87A-$D96E`, `$D7F0`, `$D82A`, owner `$539C`, … | SoA/AoS traits, tags, relations | persistent | core systems, views |
| Fact | per-frame flags `$DA4E/50/52`, probe `$D9FC-$DA0A`, edges `$D9E4/E6`, `$DA4C`, branch/outcome | fields of the AoS `BallWork` trait (the work copy `$D9C6-$DA6E`), reset in `begin-ball-step` | one ball step, survives a stall | later systems in the same step |
| Event | every sound or song request (`JSL $80:B542`) and every presentation spawn | event entity: `Event {kind, frame, seq, romSfx}` + payload + `EventOf(subject)` | until the host frame ends | bridge (feedback, HUD, camera kicks), tests |

Rules:
- Core systems never read events; they read state and facts.
- Only systems emit, through `emit()`. Kernels never emit, so the shot guide can reuse them silently.
- `drainEvents()` returns events in `seq` order and destroys them. The bridge calls it once per host frame; the headless harness once per core frame.
- Anything that persists on screen, such as the cup ring, a taken enemy's star or the tee, is a state entity with `Visual`, not an event.
- Facts are fields, not tags. The originals are RAM words with partial resets, they toggle mid-step and appear in traces, and tags would move archetypes every frame.

## Core: traits

**World singletons**

| Trait | Fields | Original |
|---|---|---|
| `Time` | frame | frame counter |
| `Pad` | held, pressed, prev, stallLatch (SNES bit layout) | `$1E67/$1E6B`, `$6A7C` |
| `Rules` (AoS) | tables and consts | ROM tables |
| `Course` (AoS) | w, h, shape, layer2 (mutable: cup tile), elev, walls, actorAt, originY, tee | `$6B90`, `$8390`, `$7390`, layer 4, `$ABB8` |
| `Stall` | kind (hitStop, stepStop, cupReveal), framesLeft, resumeAt | `$81:8C79`, `$81:8C48`, `$82:8B5C` |
| `HoleFlow` | phase, timer, course, hole | `$6A5A/$6A5E`, the `$80:F321` loop |
| `Shot` | aim, elev, hold, sleep, side, topBack, tbTimer, meter, dir, power, launchIn | `$D9B4/B6`, `$6B50/52/5E`, `$6B3A`, `$6ADC` |
| `Camera` | x, y, lag, mode, target | `$38AC/AE`, `$38C2-C8`, `$6AAA/AC` |
| `Guide` (AoS) | path points, end | `$81:A9B8` |
| `Career` | lives, card[8] strokes | `$D7F4` |

The camera is core state, a deliberate deviation documented in `docs/engine.md`, for two reasons:
- its arrival gates the curl and the cup reveal;
- it is checked against the `camx`/`camy` flow traces.

**Player/ball entity** (`IsPlayer`, `IsBall`, `Visual{kind:'ball'}`, `InHole(hole)`)
- Block-backed, SoA:
  - `BallPos {xc, xf, yc, yf, z}`
  - `BallVel {vx, vy, vz}`
  - `BallAir`
  - `BallSpin {sx, sy, pending}`
  - `BallHoled`
  - `BallMode` (always 0 for now)
- Persistent, SoA:
  - `Modifier` (`$DA76/78/7A`)
  - `StillCount` (`$D9BE/C0`)
  - `EnemyLatch` (`$6A68`)
  - `Tomatoes` (`$D7F0`)
  - `Strokes` (`$D82A`)
  - `Stars` (`$6A10`)
  - `Pose {state, facing, angle}`: the player character's state machine `$D7D4`, `$D7C4`, `$D7CC`; semantic state only, never clip keys.
- `BallWork` (AoS): the work copy. It holds:
  - probe and previous probe;
  - heading `$D9DA-$D9E2`;
  - coefficients `$DA30-$DA46`, `$6A72`;
  - counters `$DA48`, `$6A7A`, `$6A6C`, `$6A70`;
  - flag `$D9D2`;
  - the facts.

**Hole entities.** `startHole` spawns:
- `IsHole` + `HoleInfo`.
- Enemies: `IsEnemy`, `Cell`, `Hover`, `EnemyKind`, and `TakenBy(player)` (exclusive), mirroring `$539C`.
- The cup: `IsCup` is added to the last enemy, mirroring `$B4B8` = 8.
- `IsTee`, `IsPillar` and `IsHazardActor` (types 72, 76, 77, 81-83).

All of them carry `InHole(autoDestroy:'orphan')`, so `hole.destroy()` tears the hole down.

## Core: one frame (`schedule.ts`)

The order of the ball step is defined once, in an ordered array `BALL_STEP`. The schedule runs it, and `simulateGuide` runs it too, on a cloned `BallWork` with buttons off, stalls ignored and no events (`physics.md:884`).

**Prologue, every frame:**
1. `advance-frame`
2. `latch-pad`
3. `tick-stall`. A resumable runner: a system that sets `Stall` makes the runner store `resumeAt` and return. Later frames run only the stall's own list (`pan-camera-to-cup` and `reveal-cup` for the cup reveal). When `framesLeft` reaches 0, that frame resumes at `resumeAt`. The block is not written during the stall, which reproduces the F, F+4, F+6 record pattern.

**Flow:**

4. `update-hole-flow`
5. `setup-shot` (`$80:C50B`)
6. `update-aim` (`$81:A804`, `$81:B5F9/B661`, facing `$81:BB4A`). Auto-repeat is modelled as `Shot.sleep = 2`: the aim loop runs every 3rd frame and turns 3°.
7. `update-shot-guide` (`$81:A9B8`)
8. `update-spin-stage` (`$81:BF07-BFCC`, `$81:C12E/C170`)
9. `update-power-meter` (`$6B3A`). A is read before the increment.
10. `launch-ball` (`$81:C1D5`, `$81:BA0B`, tomato −1 at `$83:AC12`)

**Ball step**, in phases Rolling and SettleWait:

11. `load-ball-work` (`$82:F030`)
12. `arm-shot-modifier` (`$82:DA51`)
13. `begin-ball-step` (`$81:801C` prologue, `$81:8751`). Latches the airborne/rolling branch once, so a settle can't also run the rolling systems in the same step.
14. `move-airborne` (`$81:8805`, drag `$81:885C`) or `move-rolling` (`$81:89C2`)
15. `probe-airborne` or `probe-rolling` (`$81:8E60`, `$81:9479`, `$6A72`/`$DA3A`)
16. `fall-below-course` (`$81:89AA`, z < −`$11_0000` → `$D9D2`)
17. `cross-edges` (`$81:9001`)
18. `select-outcome`. Writes a sum type: wall | step | drop | dispatch. Exactly one of the next four runs.
19. `bounce-off-wall` (`$81:9390`)
20. `hit-step` (`$81:93D1`, `$81:88C4`, 2-frame stall at `$81:8C48`)
21. `drop-off-edge` (`$81:8B78`)
22. `dispatch-landing` (`$81:811B`; head of `$81:8905`, reflect `$81:9444`, 4-frame stall at `$81:8C79`). Split from step 23 because the stall falls between the two halves.
23. `finish-landing` (spin impulse `$81:8CE2`, settle or damp `$81:8975`, gravity `$81:899F`)
24. `dispatch-roll-hit` (`$81:8436`: default `$81:8A56` friction/slope/curve, friction tiles, enemy test `$82:8990`, cup `$82:AD8E`/`$AFE9`, hazards → `$83:ABC5`)
25. `take-enemy` (`$82:8A98`, tomato +1 at `$83:AC01`, count `$82:8ACE`, cup reveal `$82:8B5C` → stall)
26. `emit-step-effects` (`$81:9BE5`: bounce sfx 1/2/3, step 4, wall 7)
27. `apply-shot-modifier` (`$82:DB20`)
28. `store-ball-work` (`$82:F1E3`)

Tile handlers are a 256-entry table built from the groups in `tiles.md:65-83`. Each handler returns DEFAULT or DONE, which keeps the original's chaining: friction tile → bounce, enemy → default, cup → lowered ground → holing test, outline wall → restore. Undocumented groups fall back to DEFAULT and are listed in `docs/engine.md` as unconfirmed.

**After the step:**

29. `count-still-frames` (`$81:A5CD`)
30. `detect-ball-out` (holed `$DA4A`, lost `$D9D2` or hazard)
31. `update-camera` (`$81:BA8A` pans, `$80:B961` follow with lag)
32. `update-pose`

## Core: hole flow and course loop (`HoleFlow.phase`)

| Phase | Rule (frames) | Next |
|---|---|---|
| ShotSetup | 2 (elevation −1, then 0); `$D82A`+1; selectors to 6 | Aim |
| Aim | 1°/press; held 17 → 3° every 3; Up = fly (60°), Down = grounder (0); snap to 45° target on later shots (`$80:C902`) | A → PanToShot |
| PanToShot | 5-frame delay, pan until arrived, curl; input from +70 | Spin |
| Spin | side 1 step/8 frames; top/back runs by itself in a fly shot (3 frames per step, pauses at 0/6/12) | A → Power |
| Power | +5, then 0→63→0, 1 step per frame; A latches; auto-fire at 0 | LaunchDelay |
| LaunchDelay | 23 from the last A; tomato −1 | Rolling |
| Rolling | contains the cup-reveal stall | 30 still → SettleWait; holed → HoleDone; lost → BallLost |
| SettleWait | 35 | tomatoes 0 → HoleLost; else ShotSetup |
| BallLost | 174 (`web_fly` 3403→3577), back to the shot origin | ShotSetup |
| HoleDone | short neutral pause, no cutscene; hole in one (`$D82A`==2) → lives +1 | next hole / course result |

The hole starts at ShotSetup (no 168-frame intro).

Actions:
- `startCourse(courseData[])`
- `startHole(i)`
- `nextHole`
- `continueGame`
- `pause` / `resume` (`IsPaused` on the world)
- `placeBall` (the poke equivalent, for tests and debug)

A course is 8 holes; strokes per hole = `$D82A` − 1. Lives reach 0 → GameOver. The rules for HoleLost and GameOver follow the documented facts. Undocumented values (starting lives, the cap on tomatoes, the lost-ball placement) are named constants flagged unconfirmed in `docs/engine.md`.

## Assets: porting the ROM's sprites, bitmaps, fonts and sounds

Investigated 2026-11-14 against the tools and the current `build/` output; the source of each fact is cited per row. The central finding: **the web demo's export chain already turns every asset class the engine needs into browser-ready files**, and `export_web.py` takes `--out`, so the engine regenerates them into `build/engine/assets/` without touching `web/` or `build/web`.

### What the toolchain already produces

| Asset | ROM source | Tool | Output | Verified by |
|---|---|---|---|---|
| Kirby animation clips | the `$87` script engine (state `$7E:D7D4`, table `$87:9ADE`), plus live captures for clips the static replay cannot draw | `tools/kirbyanim.py --clips` | `build/sprites/kirby/clips/` (GIF + `clips.json`: switch values, durations, loop, origin) | the web demo's pose tests against `$D7D4` traces |
| Enemy, cup, tee pad, star sheets | live VRAM/CGRAM of an emulated course-1 replay (c1n, else course1) | `tools/export_web_sprites.py` + `tools/emusheets.py` | atlas clips `enemy_idle`, `star`, `cup_open`; `tree`, `guide_dot`, guide cone cropped from a `ppu_render.py` snapshot | pictures drawn by the game itself |
| Every seen object type's pictures | snapshots of all 232 holes and 20 demos | `tools/snesstep/holes.py`, `demos.py`, `emusheets.py` | `build/sprites/emu/obj_NNN.png` + `.json`, 83 types, 1,596 pictures, same origin convention | drawn with the screen's own VRAM/CGRAM; docs/graphics.md "From live state" says prefer these over the static sheets |
| Intro / hole-out objects | an every-frame trace of the c1n run (warp star, sparkles, star burst, cup ring, ball→star, HOLE IN ONE letters, fireworks) | `tools/snesstep/trace_cutscene.py`, `export_web_sprites.build_cutscenes` | `cutscenes.json` (~300 KB) + atlas frames `cs_*` | compared frame by frame with `ppu_render.py` (docs/web-demo.md) |
| Course bitmaps | bank `$88` course tables + per-course BG3 scenery (`$80:D748`/`$D768`/`$D517`) | `export_web.py --only layers` | `layer_back/front/bg3.png`, `layer_outline_*.png` masks, `*_night.png`, `layers.json` (plus `course.json`) | `--hole N` works for all 232 holes (docs/web-demo.md) |
| Shot-panel sprites | the game's live OAM while the panel is up | `tools/export_web_ui.py` | `ui.png` + `ui.json` (94 frames, plus measured offsets/timing fields) | pixel-identical browser check `tools/check_web_ui.py` |
| HUD | stepper screen snapshots | `export_web.py` `build_hud` | `hud_panel.png`, `hud_tomato.png` | cropped from the game |
| Font | `gfx_course_font $90:FBBC` (192 2bpp tiles, glyph index = tile index) | `export_web.py` `build_font` | `font.png` glyph sheet | encoding read off the sheet (docs/text.md) |
| Music and effects | N-SPC sequences + 25 BRR samples | `tools/render_audio.py` → `build/spc/wav/`, ffmpeg encode | `audio.json` + ogg/mp3 per song/effect | renderer validated against libgme (docs/audio.md "Rendering") |

Two committed, hand-maintained inputs: `tools/web_audio_map.json` (which songs/effects and why — the event table's `romSfx` ids come from here; the plan reuses it, renamed or extended, rather than duplicating it) and the clip-name list in `export_web_sprites.py`.

### Atlas format the engine consumes

`sprites.json` / `ui.json` (measured from `build/web`):

```
{image, size, frames: {name: {x, y, w, h, ox, oy}},
 clips: {name: {frames: [{f, d}], loop, loopStart, next}}}
```

- `ox,oy` is the object's position inside the frame; a sprite is drawn with its top-left at `object_position − (ox,oy)` (the convention of `build/sprites/emu/obj_*.json` and the Kirby clips).
- `d` is a duration in 60 Hz frames; `next` chains clips (curl → `ball_roll`); `loop`/`loopStart` mark the looping tail.
- Kirby's clip names key on the semantic state, which is exactly the core `Pose{state, facing, angle}` trait: `aim_facing{0-7}`, `aim_turn_facing{0-7}`, `wait_turn_facing{0-7}`, `curl_into_ball_angle{00-15}`, `unroll_angle{00-15}`, `ball_roll` / `ball_roll_spin_{medium,strong}` / `ball_roll_fast`, `hop_{ground,air}`, `ball_squash_squash{00-10}`, `ball_sink`, `tired_health{0-2}`.

This is not a Phaser atlas format, and it carries data Phaser's formats lack (ox/oy, 60 Hz durations, `next`). The bridge converts at load time in `PreloadScene`: one `texture.add()` per frame, one global Animation per clip with `frameRate = 60`, `repeat` from `loop`/`loopStart`, and the `next` chain followed on `animationcomplete`. Asset keys are constants in `src/game/assets/keys.ts` (reference §4). Core never names a key: `sync-pose` maps `Changed(Pose)` → clip through the view catalog (reference §12).

### Per-class notes and gaps

**Sprites.** Hole 1's sheets are complete. Other holes of course 1 may show enemy kinds the c1n capture window (frames 2110–3960, hole 1 only) never drew; the fallback is `build/sprites/emu/obj_NNN.*`, which covers every type seen in all 232 holes. A new exporter step packs, per shipped hole, the sheets of the object types that hole's actors map to — with two caveats: `build/sprites/emu/actors.tsv` rates only enemy `$49` → type 73 a "match" (the other actor ids are "weak"), and the static sheets (`objsheets.py`) mark enemy tiles `context`/`placeholder`, so emulated sheets are the only trusted source (docs/graphics.md). If a shipped hole needs a kind no sheet has, capture it with `emusheets.py` from that hole's replay.

**Cutscenes (the star fly-in and fly-out).** The intro and hole-out are replays of one recorded run, positioned relative to anchors (the tee pad and the cup ring), with the camera track and sound cues included (docs/web-demo.md). The engine implements the same replay as a `cutscene` feature: one entity per recorded object with `Visual{kind:'cs_*'}`, positions driven by the recorded timeline, the cue list folded into the event stream so `play-feedback` handles it uniformly. This is the in-scope "Kirby flies in on a star / flies out once the player hits the hole", with the original pictures. The night palette used by HOLE IN ONE is a recorded 68-colour BG swap whose ROM source was never traced — valid only for course 1's CGRAM, unconfirmed elsewhere.

**Course bitmaps.** `--hole N --only course,layers` exports any of the 232 holes. v1 ships course 1 (holes 0–7) under `assets/holes/NN/` via a Makefile loop; authored test courses carry no bitmaps and keep the procedural renderer (below). The play-area outline is not baked into the bitmaps: the exporter writes white masks (`layer_outline_*.png`) which the runtime tints with the 15-colour ping-pong walk at `$98:D3E6` (30 steps, 3 frames each, `OUTLINE_WALK` in export_web.py; measured with a stepper watch). Add that colour table to the `tables.json` export so the engine animates the pulse from data, not from a copy of the Python constant.

**Font and text.** `font.png` is the glyph sheet; the encoding is docs/text.md (glyph index = tile index; digits `$10-$19`, space `$1F`). The engine needs glyphs for the HUD counters and the result card only; full string extraction (`tools/text.py --strings`) stays deferred with the scoreboard — no string→screen pointer table exists anyway (docs/text.md).

**Audio.** `audio.json` is `{music: {file, loopStart, loopEnd}, songs: {n: ...}, sfx: {n: file}}`; loop points are measured in `build/spc/wav/index.tsv`. The bridge plays music through the SoundManager with WebAudio loop markers and maps `event.romSfx` → `sfx_NN`. One real gap: **the hole song per course**. Only course 1 → song 11 is measured (docs/emulation.md); hole songs are requested by script opcode (`loc_script_play_song $87:8579`) and 12 songs have no fixed caller. Action before shipping more than course 1: trace `sub_spc_play_song` during each course's hole intro with the stepper and extend the audio map — unconfirmed until then; test courses use song 11. Approximations to record in docs/engine.md: effects are rendered over song 0's tempo but clocked by the running song in play (12 of 33 songs differ); the driver drops ticks under load; libgme plays 1.30× louder for an unexplained reason (docs/audio.md).

### Phaser integration (reference §4, §12)

`PreloadScene` queues everything under `build/engine/assets/` (served by vite's `publicDir`): the atlas PNG + JSON, `ui`/`hud`/`font` PNGs + JSON, per-hole layers + `course.json`, the audio files + `audio.json`, `cutscenes.json`. It converts the atlases into textures and global animations, then dispatches `loadRules` and `startCourse` as before. Texture, cache and sound managers are global in Phaser; the bridge owns `assets/keys.ts`. Because shipped ROM holes need the same `course.json → CourseData` conversion the tests use, `rom-course.ts` moves out of `test/` into `src/core/course-data.ts` (`fromRomCourse`), shared by `PreloadScene` and the fixtures.

## Phaser: scenes, bridge, features

**Scenes:**
- `BootScene`
- `PreloadScene`: the asset pipeline's output (atlases, layers, ui/hud/font, audio, cutscenes) → textures and global animations; `tables.json` and the courses → actions `loadRules` and `startCourse`
- `MenuScene`: a neutral "start course" action
- `HoleScene`: the only simulation host
- `HudScene`: parallel
- `ResultScene`: the course card

`HoleScene.update(time, delta)` runs:
1. `tick-time`: accumulates ms at 60.0988 Hz and runs N ≤ 4 core frames.
2. Per core frame: `capture-input` (keyboard → `Pad`: arrows, Z = A, X = Y, Enter = Start), then `runStep`.
3. Once per host frame, the presentation:
   - `bind-views`: `Visual`, `Not(Ref)` → `{Domain}View` via `view-catalog`; `Removed(Visual)` → release.
   - `sync-transforms` (`BallPos` → projection)
   - `sync-depth` (iso sort key)
   - `sync-camera` (`Camera` → camera scroll)
   - `sync-guide`
   - `sync-pose` (`Changed(Pose)` → the clip the view catalog names for `{state, facing, angle}`)
   - `play-feedback` (`drainEvents` → sfx by `romSfx`, flashes, rings, shake, panel blinks)
4. `SHUTDOWN`: disposables, `views.releaseAll()`, `hole.destroy()`.

**Features**, asset-backed (pictures and sounds from the pipeline above; key constants in `assets/keys.ts`):
- `layers`: the exported course bitmaps (back / front / BG3) for shipped ROM holes; the outline masks tinted with the `$98:D3E6` walk; the night set during HOLE IN ONE. Authored test courses have no bitmaps and fall back to the procedural renderer (per-cell iso polygons from the edge levels, shaded by surface code, walls and special tiles as glyph overlays) — kept also as the debug view.
- `ball` and `kirby`: atlas clips driven by `Pose` (`sync-pose` on `Changed(Pose)`): aim/curl/unroll/wait/roll/hop/squash/sink/tired, facing tick from the aim clips; the shadow stays procedural.
- `enemies`, `cup`, `pillars`, `hazards`: atlas clips keyed by `EnemyKind` / object type (`enemy_idle` cycle, then the `star` clip once taken); kinds with no sheet fall back to markers.
- `cutscene`: the intro and hole-out replayed from `cutscenes.json` relative to the tee and cup anchors, including the camera track and the night swap.
- `guide`: the recorded dot and cone frames on the measured path.
- `shot-panel`: the `ui.png` sprites (face, ruler, marker, gauge, "1", tomatoes) with the measured timing (panel +66, ready +70, meter start +5) and offsets.
- `hud`: `hud_panel.png` / `hud_tomato.png` plus font glyphs for the counters: strokes, tomatoes, lives, enemies left.
- `audio`: the hole's song with its loop points, the hole-out songs 24/25/26, and `event.romSfx` → `sfx_NN` in `play-feedback`.

**Test courses** (`engine/courses/`), 8 small holes that together exercise every terrain shape, steps, gaps, walls, outline walls, friction, boost, kicker, hazards, pillars, enemies and the cup. A schema check runs in a test.

## `docs/engine.md`

The mapping itself. For every original subsystem it gives the routine or RAM it comes from and the engine artefact it becomes (trait, system, action, event, scene), in the order of the schedule. It also contains:
- the event table: event → original site → sfx/song id → what the view does;
- the asset table: asset class → ROM source → exporter → format → engine consumer, including the audio approximations (effect tempo, dropped ticks, the 1.30× level difference) and the asset caveats (night palette, weak actor mapping, cutscene recording);
- the deviations (the camera in core; facts as `BallWork` fields; events as entities; cutscenes replayed from a recording rather than computed);
- the deferred rows: abilities (modes 1-21, `$D9C8`), 2P (`$1803` block, stars stolen, ball-to-ball), Dedede, copy-ability swallowing, cutscenes, menus, SRAM;
- an "unconfirmed" list for the risks below.

## Risks to check first (from the design review; implementer verifies before coding each)

1. Settle skips gravity: the trace shows vz = 0 after a settle (`web_flya` 3335), despite the order given in `physics.md:221-229`.
2. Trace records are write-back bursts, not frames: two steps can merge into one record, and the stamps lag by 1-2 frames. The harness aligns them; it does not assume one record per frame.
3. The cup reveal stalls about 99 frames mid-step (`web_curve` 3233→3333); its length probably depends on the pan distance.
4. A/Y bonus on walls: `physics.md:494` lists walls, but `web-demo.md:223` saw no bonus on an outline-wall hit.
5. The rolling enemy-hit handler, the `$81:980B` crest launch, the pillars (`$02`) and the boost gates are not fully documented. Exclude them from the exact tests and flag them.
6. The spin pause is given as "twice as long" in `physics.md:386` and as 6 frames in `web-demo.md:160`. The flow trace decides.
7. Koota: a SoA `get()` returns a copy, so write back with `set()` or `updateEach`. Call `changed()` after mutating AoS `Course.layer2`. Mask every write to 16 bits.
8. Per-course hole songs are untraced: only course 1 → song 11 is measured (docs/emulation.md); hole songs come from script opcode `$87:8579` and 12 songs have no fixed caller. Trace before shipping past course 1.
9. Enemy kinds beyond hole 1: the actor→object-type mapping is "weak" for all actor ids except `$49`→73 (`build/sprites/emu/actors.tsv`), and per-hole tile slots are statically untraced. Use the emulated sheets; if a shipped hole needs an unseen kind, capture it with `emusheets.py` from that hole's replay.
10. The night palette is a recording specific to course 1's CGRAM; where the game loads the night set from was never traced (docs/web-demo.md).
11. The cutscene replay is one run's recording; a trace of `course1` instead of c1n draws different enemy pictures in the hole-out (docs/web-demo.md), and `make distclean` keeps c1n for this reason.

## Implementation order

1. Scaffold `engine/`, the Makefile rules for `build/engine/*`, and the fixture loaders.
2. Asset pipeline: `make engine-assets` → `build/engine/assets/` (atlas, ui, hud, font, audio, `cutscenes.json`, holes 0–7 course/layers; the `$98:D3E6` walk into `tables.json`). Reuse the web exporters with `--out`; the per-hole enemy-sheet packing waits until a shipped hole needs a kind hole 1 lacks.
3. `fixed.ts`, `rules.ts`, `terrain.ts`, with tests against `terrain_golden.json` and the emulated numbers in `physics.md`.
4. Ball kernels plus `BALL_STEP` plus the stall runner, against the 11 `trace_web_*` shots seeded at launch.
5. The flow systems (aim, spin, meter, launch, still count, camera, pose), against `flow_web_*.json` and the end-to-end input scripts.
6. Enemies, cup, holing, hazards, tomatoes, strokes and lives; the hole and course loop on the test courses.
7. The Phaser bridge: the atlas→texture/animation conversion in `PreloadScene`, the views, the cutscene replay, the HUD and the panel, the audio feature.
8. `docs/engine.md`, plus updates to `CLAUDE.md` and `docs/tooling.md`.

## Verification

- `make engine-test` (vitest, node, headless):
  - fixed-point and trig maths;
  - terrain against `terrain_golden.json`;
  - `trace-shots`: all 11 traces seeded from the record before the first move, with presses mapped by a calibrated constant pinned on `web_grounder`/`web_gy` and validated on `web_flya`;
  - `trace-script`: end to end from `tools/snesstep/inputs/web_*.txt`, with the frame offset at aim start;
  - `flow`: the value sequences of state, aim, elev, side, tb, over and facing within ±2 frames; camera within ±2 px in x and ±8 px in y;
  - `stalls`: 4+2 at `web_fly` 3105, about 100 at `web_curve` 3233;
  - `hole-flow` and `events` (event timeline) on the test courses;
  - `determinism`: splitting host frames into 1, 2 or 3 core frames gives the same state and events;
  - `assets`: every clip's frames exist in the atlas; every `Visual.kind` in the view catalog resolves to a texture and clip; every event kind's `romSfx` resolves to a file listed in `audio.json`; `cutscenes.json` schema and anchors; the outline walk equals the `$98:D3E6` table (export-time assert);
  - `cutscene`: a replayed object's screen position equals the recorded one at sampled frames (the equivalent of the web demo's `cutscene.test.ts`);
  - a static check that nothing under `src/core` imports `phaser`.

- `cd engine && npx tsc --noEmit && npx vite build`.
- The shot panel pixel-checked against the real sprites, re-running the `tools/check_web_ui.py` comparison against the engine's dev server.
- Run it: `npm run dev`, then play the 8 test holes by keyboard. Check aim/spin/meter timing, rolling and bouncing, steps, gaps → ball lost, enemies → cup → holed, the tomato and stroke counts, the course card and game over. A Playwright smoke script (`playwright-core`, as in `web/test/e2e`) boots the hole, sends a shot and asserts there are no console errors and the ball view moved.
