# The web demo: one hole in Phaser 4

`web/` plays course 1, hole 1 (hole index 0, `MAP00`) in a browser, using the
assets and the physics documented in this repo. It is a Vite + TypeScript +
Phaser 4 app. Nothing derived from the ROM is committed: every picture, sound
and table is generated from your own ROM into `build/web/` (gitignored), and
`vite build` copies that folder into `web/dist/` (also ignored; do not
publish it).

```bash
# once: the stepper, the replay of course 1 the sprites are cut from, the rendered audio
CARGO_TARGET_DIR=build/snesstep cargo build --release --offline --manifest-path tools/snesstep/Cargo.toml
python3 tools/snesstep/autoplay.py --course 0        # about 5 minutes
python3 tools/render_audio.py
python3 tools/snesstep/screens.py                    # build/screens (the HUD panel)

python3 tools/export_web.py --golden     # ROM -> build/web/ (needs KDC_ROM, ffmpeg, the stepper)
cd web && npm install
npm run dev                              # http://127.0.0.1:5173
npm run traces                           # record the shots, the UI timeline, the intro and hole-out (stepper)
npm test                                 # 40 tests; the ROM-derived ones skip without build/web
npm run build                            # tsc + vite build -> web/dist
python3 tools/check_web_ui.py            # the shot panel against the real sprites (needs npm run dev)
```

`web/test/e2e/*.mjs` drive the dev server in headless Chromium (the build
Playwright already cached; no download) and save screenshots: `play.mjs` takes a
shot, `full.mjs` plays the hole through the `?debug` hook, `cup.mjs` holes out
and follows the star exit to the result card, `intro.mjs` steps the intro (or,
with `--outro [--hio]`, a hole-out) frame by frame and saves the frames that the
c1n snapshots have, for a side-by-side look with `tools/ppu_render.py`,
`first.mjs` renders the first frame at 1:1 for comparison with
`build/emu/holes/screens/hole000.png`, `viewport.mjs` checks that the canvas fits
the window at 14 sizes and after resizing, `depth.mjs` that the cup stays under
Kirby, `facing.mjs` saves Kirby at eight aims and `panel.mjs` the shot panel at
given states. Start `npm run dev` first. Every script but `intro.mjs` opens the
page with `?nointro`, which skips the warp-star intro.

Keys: arrows aim (Left/Right), Up = fly shot, Down = grounder; **Z / Space /
Enter = A** (confirm), **X / Esc = B** (back), **S / C = Y** (brake). During
the roll A hops and Y brakes, as in the game. R restarts, M mutes. A gamepad
works too.

## The loop

The hole opens with the game's intro: the screen fades in, Kirby flies in on the
warp star and jumps onto the tee pad, which dithers in (168 frames; nothing
answers meanwhile). Then: aim (Left/Right, Up/Down) → **A** → Kirby curls up while the camera moves to the
shot view and the panel opens (about 70 frames; nothing answers meanwhile) → spin
(Left/Right = side spin; in a fly shot the top/back selector runs by itself) →
**A** → power (the meter runs up and down; **A** latches it, or it shoots by itself
when the meter is back at 0) → 23 frames → the ball rolls. Hit enemies (they leave
a star; Kirby gets a tomato back); when one enemy is left it becomes the cup. Sink
the ball in the cup to finish: a ball rises out of the cup, turns into a star, Kirby
jumps onto it and it flies up while the camera follows it into the sky, then the
screen fades to the result card (in one stroke, the HOLE IN ONE banner, fireworks and
1UP come first, over the course in its night palette). Every shot costs a tomato, so does going out of
bounds; at zero tomatoes the hole is lost. After a shot the ball stays a ball until
the next aim starts, 35 frames after it stopped (with one or two tomatoes left Kirby
pants meanwhile).

## Where things are

| | |
|---|---|
| `tools/export_web.py` | ROM → `build/web/*`: `course.json`, `tables.json`, `layer_*.png`, `font.png`, `hud_*.png`, `audio.json` + ogg/mp3, `sprites.*` |
| `tools/export_web_sprites.py` | the atlas; replays hole 1 in the stepper (`build/emu/web_hole0`) and cuts sheets with `tools/emusheets.py` |
| `tools/web_audio_map.json` | which song and which effects, and why (the only committed audio data) |
| `tools/snesstep/trace_ball.py`, `inputs/web_*.txt` | per-frame ball traces from the real game |
| `tools/export_web_ui.py`, `tools/check_web_ui.py` | the shot panel sprites read from the real game's OAM, and the pixel check of the browser's panel against them |
| `tools/snesstep/trace_flow.py`, `inputs/web_flow.txt`, `web_ui.txt` | frame-level timeline of Kirby's state, the aim, the camera and the meter on the real game |
| `tools/snesstep/trace_cutscene.py` | the intro and the two hole-outs, every frame of the c1n run: objects, pictures, scroll, brightness, palette, sound requests (`build/web-test/cutscene_hole0.json`); `export_web_sprites.build_cutscenes` turns it into `cutscenes.json` and the atlas frames `cs_*`, `export_web.build_layers` into the night layers |
| `web/src/render/cutscene.ts` | replays a recorded window relative to its anchors (the tee pad, the cup ring); `HoleScene` draws it, owns the camera meanwhile and plays its cues |
| `web/src/sim/` | the physics: `fixed.ts` (65816 integer maths), `trig.ts`, `terrain.ts`, `ball.ts`, `shot.ts`, `hole.ts` (shot flow, enemies, cup, score), `camera.ts`, `guide.ts`, `pose.ts` (Kirby's animation state). No Phaser import |
| `web/src/render/`, `scenes/`, `audio/` | Phaser: layers, sprites, clips, HUD, the shot panel (`shotpanel.ts`), WebAudio with loop points |
| `web/src/sim/__tests__/` | terrain parity, documented numbers, 11 frame-exact traces, facing, Kirby's states, camera and guide against the recorded game, a headless player |

## What is ported, and from where

* **Terrain** is `tools/terrain.py` `Tables.surface_z` (`$81:9479`) over the
  tables the exporter dumps. Matches Python on every cell × 361 sample points.
* **The ball** is `sub_ball_physics_step $81:801C` and what it calls:
  airborne/rolling branches, drag, gravity, bounce (Householder reflection,
  0.98 / 0.65, the 16-frame settle), friction with its 12/13 rounding, slope
  acceleration, edge crossing with step and wall events (`$81:9001`), launch off
  a step (`$81:8B78`), the grounder's curve, the fly shot's spin impulse, the
  A hop and Y brake, hit-stop, `sub_atan2_deg` (table-driven, `$80:A4C1`).
  Integer semantics follow the 65816: floor and sign-magnitude Q15 multiplies,
  16-bit wrap, `(prod × 2) >> 16` in the friction.
* **The shot**: power `$1300 × tbl[meter] >> 14`, launch with *chained* Q15
  products (`h = P cos ε`, `vx = h cos φ`; that is what gives vx 2217 for
  P = `$1156`), spin per `$81:C1D5` (the selectors' high bytes, including the
  negated cosine for the side term: that is why Left gives 707, not 702).
* **Enemies**: the cell-box hit rule (`$82:8990`) with its once-per-pass latch;
  the last enemy becomes the cup (tile `$08`, `$82:8B5C`).
* **The cup**: `sub_cup_depth $82:AFE9` (a 32×32 dish; `$5000` is the flat
  centre) lowers the ground under the ball; the ball is holed when it sinks
  `$1000` below the original surface at the centre (`$82:AD8E`).
* **Kirby's pose** is the game's animation state `$7E:D7D4` (`sim/pose.ts`): 4/5
  aim (switch on the facing `$D7C4`), 6 curl, 14/15/16 roll (by the spin), 13 hop,
  12 squash, 11 tired (one or two tomatoes left). The facing comes from the aim by
  the game's table (see below), not from a formula.
* **The camera** is `$81:BA8A` (pan) and `$80:B961` (follow) over `$38AC/$38AE`
  (`sim/camera.ts`); **the guide** is the full-power prediction the aim camera
  looks at (`sim/guide.ts`). Both below.
* **The shot panel** is read from the game's own sprites (`tools/export_web_ui.py`):
  the face (the ball fills with red as the meter rises), the ruler and marker, the
  gauge, the "1", the tomatoes.
* **Layers**: BG2.0 + BG1.0 flattened behind the sprites; BG2.1 + BG1.1 in
  front (priority bit); BG3 is the screen-fixed scenery. Projection
  `px = 32 (x+y)`, `py = word7 + 16 (x−y) − 16 Z/$5A82` (header word 7).

## Verified against the real game

`tools/snesstep/trace_ball.py` runs the Rust stepper on a scripted shot and
rebuilds the player-1 ball block for every physics step; the TypeScript port
replays the shot from its launch and must match **integer-exact** (position,
height, velocity, airborne flag) to the end of the flight. Eleven shots pass:
grounders at 0° (two, one with the curve spin), 16° (with the Y brake), 61°,
85°, 136° and 226° and 314° (rolling friction, the slope of the ramps, the outline
wall on every side, the A hop), and fly shots at 0° (one with side spin, so the
spin impulse) and 76° (with an A press in the air) out over the edge: drag,
gravity, the fall that loses the ball.

Other checks against the recorded game (`npm run traces`, build/web-test/flow_*.json):

* **Facing**: every aim value of a 340 frame sweep gives the `$D7C4/$D7CC` the
  table gives (`facing.test.ts`).
* **Kirby's states**: the sequence of `$D7D4` over a shot and the 35 frame wait
  before the next aim (`pose.test.ts`).
* **Camera**: the aim-stage approach, the shot-view pan (every real position is one
  of mine, in order) and the whole follow (x within 1-2 px, y within 1-8 px over 400
  frames); **guide**: its end within 1 px of the aim camera's target for 105 of 110
  aim angles (`camera.test.ts`).
* **Shot panel**: 20 frames spanning the opening, the selector sweep and a whole
  meter cycle are pixel-identical to the real sprites above the tomato row
  (`tools/check_web_ui.py`).

Two things about the traces, because they cost an afternoon:

* The game copies the work ball back to the player block in a burst of stores
  that sometimes straddles a frame boundary, so a snapshot per frame is
  torn. The tracer cuts on bursts (a store from a lower pc, or to a byte the
  burst already wrote) instead.
* The game occasionally runs two physics steps inside one video frame (it lags,
  then catches up). The test accepts a mismatch that two steps explain; a
  handful of such frames per shot is normal.

## Measured with the stepper (not in the older docs)

| | |
|---|---|
| Aim | a press turns 1°; held for 17 frames it turns 3° every 3 frames (the game's loop runs every third frame while it simulates the guide); Left raises the angle. `$D9B4` |
| Spin stage | top/back `$6B52` one step per 3 frames (`$6B5E` = 3), 6 → 0 → 12, pausing 6 frames at 0, 6 and 12. (The side selector's one step per 8 frames is from docs/physics.md.) |
| Power meter | `$6B3A` counts 0 → 63 → 0 at one step per frame (`$6B3C` = 63) |
| Launch delay | 23 frames from the last A to the first physics step (Kirby curls up) |
| Object positions | enemies and trees at the corner of their cell, `(32 (x+y), word7 + 16 (x−y) − 16 Z/$5A82)`; the tee pad at the cell centre; sprite top-left = position − origin |
| Outline colour | BG2 palette 7 colour 15 is animated by an object (`$84:81A3`): 30 colours, 3 frames each, read from `$98:D3E6` |
| Enemy | 8 pictures, ~8 frames each (63-frame cycle), then a star: 8 pictures of one frame each |
| Facing | `$81:BB4A`: `$6ABE = (472 - phi) mod 360`; `$81:BCA0`: `v = $81:8E98[$6ABE]`, `$D7CC = v >> 1`, `$D7C4 = v >> 2`. phi 0 → 2 and 5. Screen direction of a facing `45 - 45 v` degrees (3 faces the camera) |
| State timeline (hole 1) | aim 4, 5 while Left/Right is held; the first A → camera pan 19-26 frames (5 frames before it starts) → state 6 (curl, 35 frame clip) held through spin and power; the power A + 23 → 14 (15/16 with strong/medium spin); a hop is 13 for 17 frames, a hit-stop 12 for 4; 30 frames still → `$D9BE` → 35 more → state 4. No unroll (7) and no wait pose (9) in a 1P shot |
| Panel timing | from the A that confirms the aim: the "1" at +46, the panel at +66 (the gauge frame slides in over 4 frames), the selectors answer from +70 (the first top/back step at +70, then every 3 frames); the meter starts 5 frames after the A that leaves the spin stage and the shot goes by itself when it is back at 0. A second A during the opening does nothing (the four-A script of docs/physics.md had one press too many) |
| Panel sprites | all anchored to Kirby's ball point on the screen (same offsets with two different cameras): "1" at (-4, bob - 0 .. 8), face 3 x 3 tiles of 16 at (-24, 5), gauge frame at x 23..39, tomatoes at (-24 + 16 k, 53); the ruler and the marker at x = -4 + 2 (side - 6), the marker dot at y = 24 + 2 (topBack - 6); the face picture is the meter two frames ago, the gauge the meter one frame ago |
| Camera | `$38AC/$38AE` (scroll x = `$38AC`, y = 456 - `$38AE`). Aim stage: pan every frame toward the **end of the shot guide**; first A: pan toward Kirby + `($81:C0F0, $81:C0F8)[quarter of the aim]` = (80, 0), (0, 40), (-80, 0), (0, -56) until it has arrived, then curl; at the shot (`$82:BFBC`) `$38C6/$38C8` = that offset and the follow starts locked on; during the roll `$38AC = Kirby x - 128 + $38C6`, `$38AE = Kirby y + 112 + $38C8` with the lag `$38C6 → -floor(24 dx)` (cut at $70) and `$38C8 → -floor(24 dy)` (at $60) eased by (\|e\| >> 5) + 1. Pan steps: x `min(10, (\|d\| >> 3) + 1)`, y `min(5, ...)`; follow steps `min(4, ...)` |
| Guide | the ball launched at **full power** (meter 63) from Kirby, 40 steps if it rolls, until its first landing if it flies, projected: the aim camera's focus (`$6AAA/$6AAC`). The dots are 0.86 cells apart along it and move outward one spacing in 20 frames; the dot's 8 x 8 centre sits at the path + (-3, 0), the cone's top-left at the end + (-6, -15). While the aim turns the game runs a loop every third frame (it simulates the guide), which is why it turns 3 degrees per 3 frames |
| Effects | `$81:9BE5`: bounce sound 1/2/3 by the speed it leaves with, 4 for a step; from the call sites of `$80:B542`: enemy `$4F` (`$82:8A92`), cup `$1C` (`$82:8D49`), hop `$26`, lost `$10`, launch `$18`. The songs and effects of the intro and the hole-out are below; the old guess of song 17 as the hole-out jingle was wrong (it is never requested in a hole-out) |

## The intro and the hole-out (measured with the stepper)

`tools/snesstep/trace_cutscene.py` replays `build/emu/autoplay/c1n` with a
snapshot at every frame (48 at a time, so it stays small on disk) and reads the
64 thread-object slots (`$4E1C` type, `$5F1C/$5F9C` position, `$5E1C/$5D9C`
frame, `$519C` draw routine). Frame numbers below are the c1n run's.

| | |
|---|---|
| Objects | intro: 105 warp star, 104 Kirby (riding, then the jump off, table `$89:9295` index 6), 106 trail sparkles, 107 star burst at the landing, 108 the tee pad (dithers in from 2294). Hole-out: 74 the cup ring (its colours cycle after the hole-out), 128 the ball that rises from the cup and becomes the star, 129 Kirby, 132 trail sparkles, 108 the tee pad (colour cycling); HOLE IN ONE adds 99 (the letters), 100 (fireworks) and 103 |
| Coordinates | 74 and 108 keep **world** (course bitmap) coordinates; every other type above keeps **screen** coordinates (105 lands at (128, 112), the tee's screen position under the scroll (192, 152); 106's OAM entries are its position minus its origin, checked at f002230). Lower slots are drawn on top (Kirby over the star in the intro, the star over Kirby in the hole-out). A slot whose draw routine `$519C` is 0 shows nothing (109 in the intro; 17/130/131 after the 1UP) |
| Intro | the hole's song (`$89`, song 11) at 2169 under a blank screen; scroll (192, 152) = Kirby in the middle, the same as the demo's restart snap; fade in 2183-2197 (INIDISP 1-15); effects `$64` (2200, the star comes in, `$84:B8F9`), `$62` (2239, the jump off, `$84:B90D`), `$2F` (2294, landing, `$84:B7F0`); Kirby's script object is not drawn until 2335; state 4 (aim) at 2337, and from there the camera's aim pan is the demo's, step for step (`cutscene.test.ts`) |
| Hole-out | holed at 3121 (`$DA4A`); effect `$21` at 3123; Kirby's sprite gone at 3124 (state 1); the camera pans to the cup centred at (128, 128) on the screen (3121-3150). `$80:F60C` calls `$83:D2AB`, which tests the shot counter `$7E:D82A` (1 at the hole start, `$80:C1DC`; +1 at each shot set-up, `$80:C50B`; so 2 after one shot). Not 2: song 25 (`$97`, `$83:D2B6`) at 3181. 2: song 0 (silence) at 3181, the night palette at 3213, song 26 (`$98`, `$83:D2DD`) at 3208, HOLE IN ONE and fireworks (`$3E` ×3, `$84:BCF0`), 1UP (`$2D`, `$84:C2DD`). Then, either way: song 24 (`$96`, `$83:C748`), the ball rises (`$1D`, `$84:AAC1`), Kirby jumps onto the star, it flies up (`$67`, `$84:A917`) and the camera rises with it (scroll y 104 → -465 over 65 frames), fade out, blank at 3560 (or 3910 after a hole in one). The ordinary path was recorded by poking `$7E:D82A` = 3 at frame 3150 of the same run |
| Night palette | a CGRAM swap of 68 BG colours (not a uniform darkening: `$7ED2` → `$4968`); OBJ colours are untouched and BG3 is not scrolled during the rise. The night layers are the course's ROM colours with every entry that differs between the recorded day and night CGRAM replaced; where the game loads the night set from was not traced |

The demo replays the recording relative to anchors: the tee pad and the cup ring,
where c1n had them ((320, 263) and (352, 232), the cup being the enemy at (6, 5)).
So the hole-out plays at whichever enemy becomes the cup. It starts with the demo's
own follow camera and pans onto the recorded track with `$81:BA8A`'s steps. The
result card comes when the recording ends.

## Newly established (and not yet in physics.md / tiles.md)

* **Tiles `$28-$2D` are the play-area outline**, a wall: each is a line through
  its cell (`$28` x = ½, `$29` y = ½, `$2A` x+y = ½, `$2B` y−x = ½, `$2C`
  x+y = 3⁄2, `$2D` y−x = −½). A ball that crosses it is reflected without loss
  (`$28`/`$29` negate one component, the diagonals swap them) and put back where
  it was, **including its height** (`$82:ECD7`). On the ground nothing else
  happens that frame; in the air gravity still applies (`$82:9015`). It acts on a
  ball less than half a step above the ground.
* The A hop / Y brake bonus (`$82:DB20`) was **not** applied to an outline-wall
  hit in the trace (`web_a135`: a hop two frames before the wall left the speed
  unchanged). docs/physics.md lists walls among its triggers; the port applies it
  to bounces and step hits only.
* `$81:980B` (a surface-code change inside a cell throws the ball) is ported for
  the case where no cell edge was crossed, flagged per shape by `$81:9B45`
  (the mound and the diagonal halves). The cross-cell cases are not ported.

## Not faithful, on purpose or for now

| | |
|---|---|
| Pillars (tile `$02`, the trees) | a simplified solid: reflect and damp by `$4A3C` / `$4F5B`; the real handler `$82:94D3` / `$82:957C` is not ported. The guide runs into the same approximation (aim 256 ends 20 px off) |
| Ball lost | −1 tomato, sound `$10`, back to where the shot was taken. The game queues the event (`$83:ABC5`); where it puts the ball is not traced |
| Cup rim | the pull to the centre (`$82:AF51`) and the rim bounce (`$82:AF09`) are ported from the disassembly but only the centre is validated (the hole-out test). The camera pans to the cup (`$82:8B5C`) with the same pan as the aim stage; the game's timing and the way back are not measured |
| Start of each aim | the game sets the aim toward its target, snapped to a multiple of 45° (`$80:C902`, from `$82:AFB0`, target `$6B6C/$6B70`; after the first shot of web_flow it jumped to 180). The demo keeps the last aim |
| Intro and hole-out | replayed from one recorded run (hole 1, the c1n replay), not computed: the sparkles' paths are that run's. The game shows only the Kirby portrait of the score panel during the intro; the demo hides the whole panel. The `$44` effect after the fade-out and the game's screens after it (the next hole's card, the score card) are not played: the demo's own result card follows |
| Camera while aiming | frame-exact until the aim turns; then the game runs a loop every third frame (it simulates the guide on each change), the demo pans every frame |
| Shot guide | physics, path, end and dots as measured, but the dots of a fly shot use the rolling shot's picture (the game draws them in other tiles that shrink with height), and the marching of the dots is a smooth 20 frame cycle instead of four steps |
| Shot panel | pictures, offsets, timing and the meter's lags as recorded; not the portrait's face (the HUD box stays empty), not the tee pad changing colour while Kirby is curled, not the tomato about to be spent blinking, a lost tomato is dimmed instead of drawn with the game's picture |
| Score panel | cropped from the game; the numbers are redrawn. The game shows it in the aim stage after some idle time and hides it during the shot (f002795 shows it, f002350 and f003300 do not; the rule is unknown), the demo shows it whenever the shot panel is not up |
| Scoring | strokes and tomatoes only; no par table is known |
| Frame rate | 60.0988 Hz fixed steps, rendered at the display rate without interpolation |
| Not in the demo | copy abilities and the other ball modes (`$D9C8` ≠ 0), layer-4 walls (hole 1 has none), the title, menus and other holes |

Run `python3 tools/export_web.py --hole N` and the layers, tables and course
data for another hole come out the same way, but the sprite capture, the
pillar and the enemy kinds are specific to hole 1.
