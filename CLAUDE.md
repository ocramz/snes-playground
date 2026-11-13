# snes-playground

Reverse-engineering notes and analysis scripts for SNES ROMs, currently
*Kirby's Dream Course (USA)*.

**This repo is:** prose findings (memory maps, routine write-ups, data-format
docs) plus small scripts that dump and decode ROM data.

Use the stepper to check a claim, or to answer what the code cannot be read for; record which facts came from it ("emulated") the same way you record "verified with xxd".

## The ROM

currently at absolute path:

```
/Users/marco/Downloads/Kirby's Dream Course (USA)/Kirby's Dream Course (USA).sfc
```

Override with the `KDC_ROM` environment variable.

| | |
|---|---|
| Size | 1,048,576 bytes (1 MiB / 8 Mbit) |
| SHA-1 | `e1f29ad02981ec84156b68d4fb95b2182dc8cd82` |
| MD5 | `3f2ee922cd23c9c211777be1d26ea2a8` |

**Verify before trusting any analysis** — `python3 tools/romcheck.py`. A
different dump, a copier header, or a modified ROM invalidates every offset
recorded here. If the hash does not match, stop and report it. Do not "adjust"
offsets to compensate.

Treat the file as **read-only**. Never write to it, never copy it into the
repo, never pass it as an output path.

## LoROM address mapping

Read this before converting any address. Getting it wrong produces
plausible-looking garbage, which is worse than an error.

**Preconditions** (both verified true for this ROM):

1. No 512-byte copier header — file offset == ROM offset, **no `+0x200` skew**.
   Detection: a headerless image is an exact multiple of 32768; a size of
   `n*32768 + 512` has a copier header and shifts every formula below.
2. LoROM. The header at `0x7FC0` is valid and the HiROM slot at `0xFFC0` is
   all `0xFF`. Definitive.

**Layout.** Each bank exposes ROM only in its upper half. `$XX:8000-$XX:FFFF`
is a 32 KB window; `$XX:0000-$XX:7FFF` is **not ROM** (WRAM mirror, I/O, or
SRAM depending on bank). Banks `$80-$FF` mirror `$00-$7F` byte for byte; the
`$80+` view is the FastROM (3.57 MHz) one, and this game executes from it.

**SNES → file offset**

```
require 0x8000 <= addr <= 0xFFFF        # else: not ROM, reject
file = ((bank & 0x7F) * 0x8000) + (addr - 0x8000)
```

**file offset → SNES**

```
bank = (file / 0x8000) | 0x80           # canonical FastROM form
addr = (file % 0x8000) + 0x8000
```

The low-bank alias is the same byte: `bank & 0x7F`.

**Worked examples** (all real, all asserted by `tools/lorom.py --selftest`):

| SNES | file | what |
|---|---|---|
| `$80:8000` / `$00:8000` | `0x000000` | init code, `9C 00 42` = `STZ $4200` |
| `$00:FFC0` | `0x007FC0` | cart header, `"Kirby's Dream Co..."` |
| `$00:FF00` | `0x007F00` | emulation RESET target |
| `$95:8000` | `0x0A8000` | start of the dense data banks |
| `$9B:FFFF` | `0x0DFFFF` | end of them |

Round-trip check on the first: `(0x80 & 0x7F) * 0x8000 + (0x8000 - 0x8000) = 0`;
back, `bank = (0 / 0x8000) | 0x80 = 0x80`, `addr = 0 + 0x8000 = 0x8000`.

**`$85:1234` is not a valid ROM address.** If a computation hands you a bank
address below `$8000`, that is a bug — do not mask it away.

Use `tools/lorom.py` rather than redoing this by hand.

## Known ROM facts

Cartridge header at `0x7FC0`, extended header at `0x7FB0`:

| Field | Offset | Value | Meaning |
|---|---|---|---|
| Maker code | `0x7FB0` | `"01"` | Nintendo |
| Game code | `0x7FB2` | `"CG  "` | |
| Title | `0x7FC0` | `"Kirby's Dream Course "` | 21 bytes, space-padded |
| Map mode | `0x7FD5` | `0x30` | LoROM + FastROM |
| Cart type | `0x7FD6` | `0x02` | ROM + RAM + battery |
| ROM size | `0x7FD7` | `0x0A` | 1024 KB (matches file) |
| SRAM size | `0x7FD8` | `0x03` | 8 KB |
| Destination | `0x7FD9` | `0x01` | North America |
| Version | `0x7FDB` | `0x00` | 1.0 |
| Complement | `0x7FDC` | `0x1151` | |
| Checksum | `0x7FDE` | `0xEEAE` | XOR == `0xFFFF`, valid |

**Vectors.** Only two are populated; everything else is `$FFFF` (unused).
Emulation RESET `$FF00`, native NMI `$FF06`. Note the vector table is
surrounded by `0xFF` padding — read it at correct 2-byte alignment or you will
manufacture vectors that do not exist (`BRK` appears to read `$5FFF`, which is
just misaligned padding).

**Entry path.** RESET lands at `$00:FF00` (file `0x7F00`), which holds
`18 FB 5C 00 80 80` = `CLC / XCE / JMP $80:8000` — straight into native mode
and the FastROM mirror. Real init begins at file `0x000000`:
`STZ $4200`, `STZ $06`, `LDX #$06`, `LDY #$07`, `REP #$30`, `LDA #$1FF8`,
`MVN $00,$00`, `TXS`, ...

**Audio.** The ASCII strings `nintenhalken` and `*Ver S1.20*` near ROM start
identify the N-SPC (Nintendo/HAL) SPC700 sound driver, so music and SFX data
follow N-SPC conventions.

**Bank contents.** The original density heuristic (banks `$95-$9B` only 4-12%
padding, `$80-$8F` 16-41% and code-like) turned out to be right, and those
banks are now identified:

| banks | contents | how established |
|---|---|---|
| `$80-$83` | engine code: init, OAM/sprite pipeline, decompressor, APU upload, course loaders, screen setup, text, the thread-object scheduler and `tbl_thread_types $80:ED3A` | disassembled |
| `$84-$87` | thread object code: 206 of the 234 object types start here (22 more in `$83`, 6 in `$80`-`$81`), as native-code coroutines. `$84`-`$86` are 85-94% reached by following them; `$87` also holds the script-driven objects | `objanim.py` |
| `$88` | eleven course pointer tables at `$88:A770`+`0x300*n`; also tutorial text | disassembled loaders |
| `$89` | metasprite frame lists and their pointer tables: 125 tables, 1,163 frames, 99.8% of `$89:8000`-`$F36D` explained | `frametabs.py` |
| `$8A-$94` | screen graphics, compressed and uncompressed, reached from the four loader jump tables; also 346 uncompressed sprite tile chunks (87 KB) copied to VRAM by the transfer queue; four CGRAM images in `$94` | `scenes.py loaders`, `vram.py queue` |
| `$95` | BRR samples, instrument table, volume curve | APU upload tables |
| `$96-$98` | song sequences (33) plus the song/SFX table | `tbl_spc_songs` |
| `$98` | **the palette bank** for partial loads, and five of the nine full CGRAM images (the other four are in `$94`) | `sub_cgram_partial $80:90C8` hardwires it |
| `$99-$9D` | course background tilemaps | course tables 8 and 9 |
| `$9D-$9F` | course grids, small tables, and the uncompressed headers | course tables 0-7, 10 |

Banks `$8A-$94` used to be "compressed graphics no pointer table reaches".
The four loader jump tables now reach 70 of their 75 entries, so most of
that bank range is attributed — see [docs/scenes.md](docs/scenes.md).
Note that **not all graphics are compressed**: a VRAM record block can name
a ROM bank directly. Nine tileset entries do, and so do most sprite tiles --
`sub_vram_queue $80:8696` has 890 call sites, and 1,567 of the 2,101 records
they can pass read ROM directly. A compression scan will never find those
assets; `tools/vram.py direct` writes them out.

`python3 tools/coverage.py` reports which ROM bytes the extractors account
for, including every instruction the stepper executed. Currently 75.1%;
the rest is mostly engine code no script reaches in banks `$81`-`$83` and
`$87`, and 10% more sits in compressed streams nothing references.

## Layout

```
docs/           long-form findings: memory maps, data formats, subsystems
notes/          working scratch, per-session, unpolished, may be wrong
tools/          analysis scripts
symbols.tsv     machine-readable symbol/label table
build/          all derived output — GITIGNORED
```

`docs/` is for things believed true. `notes/` is for things being worked out;
mark uncertain claims "unconfirmed" and promote them to `docs/` once verified.

## Conventions

**Addresses.** Always write SNES addresses as `$BB:AAAA` with the colon
(`$9A:8000`), and file offsets as `0x`-prefixed hex (`0x0D0000`). Never write a
bare number. When a finding is location-specific, give both:
`$95:8000 (0x0A8000)`.

**Labels.** `snake_case` with a kind prefix: `sub_` routine, `loc_` jump target
within a routine, `dat_` data blob, `tbl_` table, `ptr_` pointer table, `gfx_`
graphics, `pal_` palette, `mus_` music, `ram_` a WRAM location. Prefer
meaning to address —
`sub_decompress_tiles`, not `sub_9A8000`. Use the address form only as a
placeholder until the purpose is known.

**`symbols.tsv`** — tab-separated, one symbol per line, header row, sorted by
`snes_addr`. Tabs rather than commas because comments contain commas
constantly. Columns:

```
snes_addr	file_offset	type	name	size	comment
```

`type` is one of `code`, `data`, `gfx`, `music`, `ptr`, `ram`, `reg`, `tbl`. `size` is
decimal bytes or `-` when unknown. `file_offset` is redundant with `snes_addr`
but present so the file is greppable by either address form — keep the two
consistent.

## Tooling

Available: `python3` (**3.9.10** — no `match`, no `X | Y` type unions), `node`,
the Rust toolchain, `binwalk`, `make`, `cmake`, `clang`, `java`, `xxd`, `jq`,
`grep`.

**Not installed:** no third-party emulator (no Mesen/bsnes/snes9x/RetroArch),
no assembler (no asar/bass/ca65/wla-65816), no Ghidra. The in-repo stepper
(`tools/snesstep`) has no display and no debugger UI, only snapshots, logs and traces.

- `tools/spcrender/` models the sound chip alone (SPC700 + S-DSP) to turn
  the extracted `.spc` files into WAV.
- `tools/snesstep/` is a headless stepper: 65C816, memory map, DMA/HDMA,
  timers and the real APU, with **no pixel output**. It runs the game and
  snapshots VRAM, CGRAM, OAM and WRAM; `tools/ppu_render.py` draws a
  snapshot. It exists because some facts are only knowable at run time
  (what a screen loads, which tiles an object really shows). See
  [docs/emulation.md](docs/emulation.md).


Audio is the one thing that is rendered: `tools/render_audio.py` builds
`tools/spcrender` with `cargo` (offline, into `build/spcrender`) and plays
the `.spc` files through it. VLC.app happens to be installed and bundles an
SPC decoder; `tools/audio_check.py vlc` uses it as an independent
comparison and nothing else depends on it. `rg`
is not on `PATH` for shell commands; use `grep`. If a task genuinely needs one
of the missing tools, say so and ask before installing.

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
python3 tools/snesstep/autoplay.py --course 0   # play course 1 to the end, real hole-outs
python3 tools/emusheets.py SNAPDIRS...       # sprite sheets from live object state

# Which ROM bytes all of the above account for
python3 tools/coverage.py --runs 20               # -> build/coverage.tsv

# Keep symbols.tsv honest (sorted, addresses and offsets consistent)
python3 tools/symcheck.py
```

Every script imports `load_rom()` from `tools/romcheck.py`, so the integrity
check runs implicitly on each invocation.

## Formats

Written up in `docs/`, each derived from disassembly rather than pattern
matching:

- [docs/compression.md](docs/compression.md) — the HAL LZ format that every
  compressed asset uses, and the two decompressor entry points.
- [docs/audio.md](docs/audio.md) — N-SPC driver upload, BRR samples,
  33 songs and 125 effects, how the standalone `.spc` files are built, the
  sequencer's timing, and how the WAV renderer was validated.
- [docs/graphics.md](docs/graphics.md) — tiles, tilemaps, palettes, the
  metasprite/OAM pipeline, the VRAM transfer queue, and how sprite sheets
  are rendered.
- [docs/animation.md](docs/animation.md) — the animation bytecode of the
  script-driven objects, and the thread objects: 234 coroutine object types,
  their slot fields, and the inline-operand helpers they call.
- [docs/courses.md](docs/courses.md) — the eleven bank `$88` course tables,
  including the row directory that unpacks the two background tilemaps.
- [docs/terrain.md](docs/terrain.md) — the playfield: elevation, the 28
  terrain shapes, the surface equation, and how gaps work.
- [docs/tiles.md](docs/tiles.md) — the special-tile layer: the dispatch
  tables, friction overrides, boost panels, kickers and hazards.
- [docs/scenes.md](docs/scenes.md) — the 20 screen setup blocks, the four
  loader jump tables, and which graphics and palette each screen loads.
- [docs/text.md](docs/text.md) — the font-tile encoding, the control codes,
  and where the strings are.
- [docs/physics.md](docs/physics.md) — the ball's state and one physics
  frame, enemies and the cup (a run-time object), the holing rule, the
  screen projection, and the course-playing driver.
- [docs/emulation.md](docs/emulation.md) — the headless stepper: what is
  emulated, how it was validated against the static facts, input scripts,
  pokes, and which screens they reach.

## Workflow

- Read-only by default. The ROM is never an output path.
- Every derived artifact — dumps, decompressed blobs, rendered graphics,
  disassembly listings — goes in `build/`, which is gitignored. Never write
  them elsewhere.
- Record where a fact came from. "Verified with `xxd` at `0x7FD5`" beats an
  unattributed assertion; a later session cannot otherwise tell measurements
  from guesses.
- When a tool's output contradicts a note in `docs/`, re-measure before
  believing either. The vector table above was recorded wrongly on first pass
  precisely because it was read at the wrong alignment.

## Legal and hygiene

Never commit ROM bytes: not the ROM, not a slice of it, not a bulk hexdump, not
decompressed graphics, not save states. `.gitignore` blocks `*.sfc`, `*.smc`,
`*.srm`, save states and `build/`, but that is a backstop, not permission to be
careless — extracted assets stay in `build/`.

Short illustrative hexdumps in notes (a header, a routine prologue, tens of
bytes) are fine and are what documentation looks like. Bulk asset data is not.

## 65816 gotchas

These produce *silently wrong* results rather than errors, worst first.

- **M/X flag widths change instruction length.** `LDA #$12` is two bytes with
  `M=1`; `LDA #$1234` is three with `M=0`. You must track the flags through
  `REP`/`SEP` to decode at all — `REP #$30` sets A and X/Y to 16-bit, `SEP #$30`
  to 8-bit. The init code at `0x000000` does `REP #$30` early, so most of it is
  16-bit.
- **Flag state is not local to a routine.** A subroutine may be called with
  either width and may rely on its caller's. If the entry width is unknown, say
  so rather than guessing.
- **`JSL`/`RTL` vs `JSR`/`RTS`.** Long calls push a 3-byte return address, short
  calls 2. Mismatching them corrupts the stack. Record which convention a
  routine uses in its notes.
- **Bank crossing.** `JMP`/`JSR` stay in the current bank; only `JML`/`JSL`
  change it. Data addressing goes through the DBR and is bank-relative, and
  16-bit indexing wraps within a bank rather than carrying into the next.
- **Direct page moves.** `D` is not always `$0000`, so an operand that looks
  like `$12` may be `$0012` or `$2112`. Check for `TCD`/`PHD`.
- **Code and data are interleaved.** Linear disassembly *will* desync when it
  walks into a table. Follow control flow from known entry points, stop at
  unconditional `JMP`/`BRA`/`RTS`/`RTL`, and treat unreached bytes as unknown
  rather than assuming they are code.
- **Some calls take their operands inline.** Twelve helpers are copied to
  WRAM `$1018`-`$120D` at boot and called with a near `JSR` from any bank;
  each reads 0 to 9 bytes placed after the call and fixes up its own return
  address (`JSR $1030 / idx / frames` alone has 924 call sites). A `JSR` to
  an address below `$2000` in banks `$83`-`$87` is one of these, and the
  bytes after it are data. The table is `RAM_HELPERS` in `tools/objanim.py`.
- **A callee can read its caller's bank.** `sub_vram_queue $80:8696` takes
  the bank of its block from the `JSL` return address on the stack, so the
  same 16-bit argument means a different address from each bank.

For register maps (`$2100-$21FF`, `$4200-$43FF`) and opcode tables, use
standard references (fullsnes, the 65816 manual) rather than half-remembered
tables.
