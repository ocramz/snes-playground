
## Tooling

Available: `python3` (**3.9.10** — no `match`, no `X | Y` type unions), `node`,
the Rust toolchain, `binwalk`, `make`, `cmake`, `clang`, `java`, `xxd`, `jq`,
`grep`.

**Not installed:** no third-party emulator (no Mesen/bsnes/snes9x/RetroArch),
no assembler (no asar/bass/ca65/wla-65816), no Ghidra. The in-repo stepper
(`tools/snesstep`) has no display and no debugger UI, only snapshots, logs and traces.

Purpose-built tools:
- `tools/spcrender/` models the sound chip alone (SPC700 + S-DSP) to turn
  the extracted `.spc` files into WAV.
- `tools/snesstep/` is a headless stepper: 65C816, memory map, DMA/HDMA,
  timers and the real APU, with **no pixel output**. It runs the game and
  snapshots VRAM, CGRAM, OAM and WRAM; `tools/ppu_render.py` draws a
  snapshot. It exists because some facts are only knowable at run time
  (what a screen loads, which tiles an object really shows). See
  [docs/emulation.md](emulation.md).

Use the stepper to check a claim, or to answer what the code cannot be read for; record which facts came from it ("emulated") the same way you record "verified with xxd".

Audio is rendered: `tools/render_audio.py` builds
`tools/spcrender` with `cargo` (offline, into `build/spcrender`) and plays
the `.spc` files through it. VLC.app happens to be installed and bundles an
SPC decoder; `tools/audio_check.py vlc` uses it as an independent
comparison and nothing else depends on it. `rg`
is not on `PATH` for shell commands; use `grep`. If a task genuinely needs one
of the missing tools, say so and ask before installing.

## Make

`make help` lists the targets. `make` (= `make build`) builds the web demo end to
end: the two Rust tools, then everything `tools/export_web.py` reads from other
tools (the rendered audio, `build/screens`, Kirby's clips, the course-1 replay, the
cutscene trace), then the export, `npm ci` and `vite build`. Each step is a file rule
on the file its tool writes, so a finished step is skipped; delete an output to redo
it. A rebuilt stepper does not re-run finished emulator runs. `make extract` runs
`tools/extract_all.py`, which is not part of `build`. Pass the ROM with
`make KDC_ROM=...`.

The engine ([docs/engine.md](engine.md)) has its own targets, none of them part of `build`:

| target | does |
|---|---|
| `make engine-assets` | `build/engine/assets` from the same exporters, with the `objects` step added |
| `make engine-test` | the vitest suite (it needs only the rules and `build/engine/rom-test`; ROM-derived tests skip without them) |
| `make engine-traces` | re-records the trace, flow, sound and actor fixtures into `build/engine/rom-test` (stepper runs) |
| `make engine` | `npm ci` and `vite build` into `engine/dist` |
| `make engine-e2e` | the browser smoke test; it needs `cd engine && npm run dev` running |

Cleanup comes in three tiers:
- `make clean`: `web/dist`, `engine/dist`, `build/web`, `build/engine` and
  `__pycache__`, seconds to redo.
- `make clean-rust`: `build/snesstep` and `build/spcrender`.
- `make distclean`: also `web/node_modules`, `engine/node_modules` and all of
  `build/` except `build/emu/autoplay/c1n`, which no current tool can record
  again (docs/web-demo.md).

## Commands

```bash
# Verify ROM integrity and decode the header — run before any analysis session
python3 tools/romcheck.py

# Address conversion, either direction
python3 tools/lorom.py '$95:8000'      # -> 0x0A8000
python3 tools/lorom.py 0x0A8000        # -> $95:8000 (alias $15:8000)
python3 tools/lorom.py --selftest      # asserts the worked examples above

# Dump a region (hexdump annotated with both address forms)
python3 tools/dump.py '$80:8000' 16
python3 tools/dump.py '$9A:8000' 0x1000 -o build/bank9a.bin

# Disassemble 65816, tracking M/X widths (see the gotchas section below)
python3 tools/dis65816.py '$80:9F18' --m8 --x16
python3 tools/dis65816.py 0x002A30 --length 0x70 --m16 --x16 --follow

# HAL LZ compression: decompress one stream, or scan a range for streams
python3 tools/halcomp.py '$8E:EC7F' -o build/gfx/title.bin
python3 tools/halcomp.py --scan '$95:8000' '$9B:FFFF'

# Everything, in dependency order, plus a cross-reference manifest
python3 tools/extract_all.py             # -> build/, build/manifest.tsv
python3 tools/extract_all.py --only courses,scenes
python3 tools/extract_all.py --manifest-only

# Bulk asset extraction
python3 tools/extract_gfx.py       # every stream -> build/gfx/{bin,png}, index.tsv
python3 tools/spc_extract.py       # driver, samples (WAV), songs (SPC) -> build/spc
python3 tools/nspc.py --all --midi --spc   # sequences, MIDI, one SPC per effect
python3 tools/render_audio.py      # 33 songs + 125 effects -> build/spc/wav/*.wav
python3 tools/courses.py           # 232 holes, raw tables -> build/courses

# Courses: unpack the row-packed tilemaps and render each hole
python3 tools/coursemap.py --check        # assert the row directory, 232/232
python3 tools/coursemap.py --index 0      # -> render.png, bg1/bg2, map.json
python3 tools/coursemap.py                # all 232
python3 tools/coursemap.py --no-backdrop  # course geometry without the scenery

# Playfield geometry: terrain shape, elevation, gaps
python3 tools/terrain.py --tables         # the engine's 28 terrain shapes
python3 tools/terrain.py --stats          # cross-check those tables vs data
python3 tools/terrain.py --index 0 --legend
python3 tools/terrain.py --probe 0 5 0    # surface height over one cell
python3 tools/terrain.py --tiles          # layer-2 special-tile dispatch map
python3 tools/terrain.py --export         # geometry.json + heightmap.png per hole
python3 tools/course_stats.py             # per-layer statistics over build/courses

# The web demo (docs/web-demo.md): assets for web/, and per-frame ball traces
python3 tools/export_web.py --golden      # ROM -> build/web/ (+ build/web-test/ fixtures)
python3 tools/snesstep/trace_ball.py all  # recorded shots -> build/web-test/trace_*.json
python3 tools/snesstep/trace_flow.py web_flow --frames 4700   # Kirby's state, aim, camera, meter per frame
python3 tools/snesstep/trace_actors.py web_haz98 --frames 3000  # hazard actors' thread slots per frame -> actors_*.json
#   (all three read tools/snesstep/inputs/<name>.pokes when it exists; the
#   engine's fixtures: `make engine-traces`, into build/engine/rom-test/)
python3 tools/snesstep/trace_cutscene.py   # hole 1's intro and hole-outs, every frame -> build/web-test/cutscene_hole0.json
python3 tools/export_web_ui.py            # the shot panel's sprites from OAM -> build/web/ui.*
python3 tools/check_web_ui.py             # ... and a pixel check of the browser's panel (npm run dev first)
python3 tools/check_web_ui.py --target engine   # the same against engine/'s panel (its npm run dev, port 5174)

# The engine (engine/, plans/port_v1_koota_phaser4.md): `make engine-assets` runs
# export_web.py into build/engine/assets with the web demo's steps plus `objects`
# (the hazard actors' pictures from build/sprites/emu: objects.png/json); the `hud`
# step also writes the score panel's slots as data (hud.json)
python3 tools/export_web.py --only objects --out build/engine/assets
#   then: cd engine && npm run dev   (http://127.0.0.1:5174/; ?nointro, ?debug, ?hole=N)
#   make engine-e2e                  # the browser smoke test (needs the dev server)
#   cd engine && npm test            # = make engine-test; npm run traces = make engine-traces
#   (the keys, the debug hook and what each test checks: docs/engine.md)

# Screens: PPU setup, what each loads, and the scene bundles
python3 tools/scenes.py blocks            # the 20 screen setup blocks
python3 tools/scenes.py loaders           # the four loader jump tables
python3 tools/scenes.py bundles           # scene -> graphics + palette
python3 tools/scenes.py all               # all of it -> build/scenes

# Render
python3 tools/tiles.py FILE.bin --bpp 4 -o build/x.png
python3 tools/tilemap.py MAP.bin TILES.bin --width 32 -o build/x.png
python3 tools/tilemap.py MAP.bin --guess          # candidate widths
python3 tools/palettes.py render '$98:C000' 0x200 -o build/pal.png

# VRAM: what is loaded where
python3 tools/vram.py loaders                     # VRAM loader records
python3 tools/vram.py queue                       # every sub_vram_queue record
python3 tools/vram.py direct                      # uncompressed chunks -> build/gfx/direct
python3 tools/vram.py cgram                       # CGRAM palette images
python3 tools/vram.py objpage --scene course -o build/vram/obj/course.bin

# Sprites: frame tables, object traces, then sheets
python3 tools/frametabs.py                        # tables.tsv, lists.tsv, accounting.txt
python3 tools/objanim.py                          # trace the 234 thread object types
python3 tools/objanim.py --type 197               # one object's draw/upload/wait events
python3 tools/objsheets.py                        # -> build/sprites/{objects,tables,blocks,anim}
python3 tools/sprites.py --table                  # one metasprite frame index
python3 tools/sprites.py --list '$89:8550'

# SPC700 side
python3 tools/dis_spc700.py build/spc/driver_0800.bin --base 0x0800
python3 tools/brr.py build/spc/ram_base.bin --dir 0x0400 -o build/spc/samples/

# Audio: render to WAV (builds tools/spcrender on first use; needs cargo)
python3 tools/render_audio.py                     # everything, + build/spc/wav/index.tsv
python3 tools/render_audio.py --song 6 --sfx 0x0B
python3 tools/audio_check.py brr                  # renderer vs brr.py, sample for sample
python3 tools/audio_check.py kon                  # key-ons vs the nspc.py timeline
python3 tools/audio_check.py vlc                  # vs VLC's libgme, if VLC.app is there
build/spcrender/release/spcrender --selftest
build/spcrender/release/spcrender build/spc/songs/song_06_id84.spc \
    -o build/x.wav --stems --log-kon build/x.tsv

# Text in the game's font encoding (not ASCII)
python3 tools/text.py --strings                   # -> build/text/strings.tsv
python3 tools/text.py --font-sheet -o build/text/font.png
python3 tools/text.py --render '$88:DA2F' -o build/text/x.png

# Run the game (headless; build once, then drive with input scripts)
CARGO_TARGET_DIR=build/snesstep cargo build --release --offline --manifest-path tools/snesstep/Cargo.toml
S=build/snesstep/release/snesstep
$S --frames 3400 --input tools/snesstep/inputs/play_hole1.txt --snap-at 3100 --out build/emu/x
$S --frames 3400 --input tools/snesstep/inputs/play_hole1.txt --log-pc '$80:9F18'   # -> pclog.tsv
$S ... --poke '2050:$7E:6A5A=0002' --poke-at-pc '$80:F37A,$7E:D956=0001'          # steer it
$S ... --pokes build/emu/autoplay/game/pokes.txt --save-sram build/x/sram.bin    # replay a run, keep its save
python3 tools/ppu_render.py build/emu/x/f003100 -o x.png --layers x_layers
python3 tools/snesstep/oracles.py all        # emulator vs the static facts
python3 tools/snesstep/screens.py            # every reachable screen -> build/screens/
python3 tools/snesstep/holes.py              # play all 232 holes (~25 min)
python3 tools/snesstep/demos.py              # the 20 DEMOPLAY SELECT demos
python3 tools/emusheets.py --cache build/emu/holes/emusheets.pickle \
    --merge build/emu/demos/emusheets.pickle --out build/sprites/emu
python3 tools/actorids.py                    # actor id == object type, checked
python3 tools/kirbyanim.py --state 6         # Kirby's animation script for one state
python3 tools/kirbyanim.py --make-base && python3 tools/kirbyanim.py   # all 51, rendered
python3 tools/kirbyanim.py --live            # the same from play, by state and angle
python3 tools/kirbyanim.py --clips           # one GIF/strip/JSON clip per state x arm -> build/sprites/kirby/clips
python3 tools/snesstep/autoplay.py --course 0   # play course 1 to the end, real hole-outs
python3 tools/snesstep/autoplay.py --frames 135000 --out build/emu/autoplay/game  # the whole game (~5 min)
python3 tools/snesstep/ending.py build/emu/autoplay/game   # medal award, Dedede, ending, credits
python3 tools/snesstep/autoplay.py --extra --frames 150000   # the extra game, from that save
python3 tools/snesstep/autoplay.py --two-player --frames 14000   # a 2-player course (pad 2 = "2:A")
python3 tools/snesstep/capture.py build/emu/autoplay/two_player two_player_result=13100   # named frames
python3 tools/snesstep/screens.py ranking map_select       # screens that need a save or medal flags
python3 tools/emusheets.py SNAPDIRS...       # sprite sheets from live object state

# Which ROM bytes all of the above account for
python3 tools/coverage.py --runs 20               # -> build/coverage.tsv

# Keep symbols.tsv honest (sorted, addresses and offsets consistent)
python3 tools/symcheck.py
```

Every script imports `load_rom()` from `tools/romcheck.py`, so the integrity
check runs implicitly on each invocation.