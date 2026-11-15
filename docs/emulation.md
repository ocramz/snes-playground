# Emulation: the snesstep stepper

Static analysis recovers what the ROM holds; some questions are only
answered by what the game *does*: what each screen has in VRAM, CGRAM and
OAM, which tiles a hole uploads into its sprite slots, which song a screen
asks for. `tools/snesstep/` runs the game's own code headless and snapshots
PPU memory. It draws no pixels; `tools/ppu_render.py` renders the snapshots.

It is a measuring instrument for this repository, not a general emulator:
one ROM (the SHA-1 in CLAUDE.md is checked on start), NTSC, LoROM, no
coprocessor, no interlace. Everything it writes goes under `build/`.

```bash
# build (std-only Rust, offline)
CARGO_TARGET_DIR=build/snesstep cargo build --release --offline \
    --manifest-path tools/snesstep/Cargo.toml
S=build/snesstep/release/snesstep

$S --frames 600 --snap-at 299 --out build/emu/title     # the title screen
python3 tools/ppu_render.py build/emu/title/f000299 -o build/emu/title.png

python3 tools/snesstep/screens.py      # every input script, one snapshot per screen
python3 tools/snesstep/oracles.py all  # acceptance: static facts vs executed code
```

## What is emulated

| part | model | source |
|---|---|---|
| 65C816 | all 256 opcodes, native and emulation mode, M/X widths, decimal ADC/SBC, MVN/MVP (one byte per step, interruptible), WAI, STP, BRK/COP/NMI/IRQ with native and emulation vectors | `src/cpu.rs` |
| cycle timing | every bus access charged by address: 6 (I/O, FastROM with `$420D` bit 0), 8 (WRAM, SlowROM, SRAM, banks `$40-$7F`), 12 (`$4000-$41FF`); internal operations 6. Instruction length in cycles *follows from the access sequence* (C, P, D, N, S of the fullsnes "CPU Clock Cycles" chart, with the +n DL!=0, +y index/page, +x emulation-branch rules), so there is no cycle table to get wrong | fullsnes "SNES Memory Speed", "CPU Clock Cycles" |
| memory map | LoROM per CLAUDE.md; WRAM 128 KB at `$7E-$7F`, low 8 KB mirrored in `$00-$3F`/`$80-$BF`; SRAM 8 KB at `$70-$7D:0000-7FFF` (zero at power-on, or `--sram`); `$2180-$2183` WRAM port; open bus = last value on the data bus | `src/bus.rs` |
| CPU I/O | `$4200` (NMI/IRQ enable, auto-joypad), `$4201` (counter latch on bit 7 falling), `$4202-$4206` multiply/divide (results immediate), `$4207-$420A` H/V timers, `$420B` DMA, `$420C` HDMA, `$420D` FastROM, `$4210` RDNMI, `$4211` TIMEUP, `$4212` HVBJOY, `$4218-$421F`, `$4016/$4017` serial reads | fullsnes "SNES PPU Interrupts", "Controllers" |
| frame | 262 lines of 1364 master cycles; vblank, NMI flag, auto-joypad and OAM-address reload at the start of line 225; DRAM refresh steals 40 cycles at cycle 538 of every line; H-IRQ at `HTIME*4+14`, V-IRQ at cycle 10 of line `VTIME` | fullsnes "SNES Timing H/V Events" |
| DMA | all 8 transfer modes, both directions, A-bus increment/decrement/fixed, 8 cycles per byte + 8 per channel + 18 overhead; the A bus cannot see `$2100-$21FF`, `$4300-$437F` | fullsnes "DMA and HDMA Channel Registers" |
| HDMA | direct and indirect, repeat and continuous, reloaded at the start of line 0, one step at cycle 1104 of lines 0-224; channel logic follows bsnes' `hdmaSetup/Reload/Transfer/Advance` | |
| PPU | VRAM 64 KB with VMAIN step and the three address translations, prefetch on `$2116/7` writes and before the increment on `$2139/A` reads; CGRAM with the word latch; OAM with the even/odd latch rule and the `$200+` high table mirror; BGnHOFS/VOFS and M7 write-twice registers composed with the fullsnes formulas; COLDATA accumulated per channel; `$2134-$2136` M7 multiply; `$2137`/`$213C/D` latches; `$213E/F` status | fullsnes "Memory OAM/VRAM/CGRAM Access", "PPU BG Control" |
| APU | the SPC700 core, timers, IPL ROM and S-DSP of `tools/spcrender` (copied into `src/spc/`, see the header of `apu.rs` for the three changes). It boots from the IPL ROM and talks to the S-CPU over `$2140-$2143`; it is run up to the S-CPU's time (1.024 MHz against 21.47727 MHz) before every port access and at every vblank, so every exchange is seen in the right order | |

VRAM writes while the display is active (not forced blank, lines 0-224) are
**dropped, as on hardware**, and counted; the end-of-run summary prints the
count. It has been 0 in every run so far, which is itself a check that the
timing keeps the game's uploads inside vblank or forced blank. CGRAM and
OAM writes outside blanking are kept and counted (also 0).

## What is not

- **No pixels.** `tools/ppu_render.py` does that from snapshots.
- No interlace, PAL, hi-res timing, OBJ range/time overflow flags (`$213E`
  reports none), mosaic counters, or mid-line PPU effects.
- Events (line changes, HDMA, IRQ, vblank) are processed between
  instructions, so they land up to one instruction (typically 12-50 master
  cycles) late. DMA and HDMA overheads are fixed approximations.
- The auto-joypad result is available at the start of line 225; hardware
  finishes the read about 4224 cycles later. The busy flag in `$4212` is
  modelled for that window.
- `$2137`'s H counter is `cycle / 4`, without the two long dots.
- WRAM and SRAM start zero-filled; hardware WRAM powers up with noise.
- Emulation mode: the stack-page wrap of the 65C816's new instructions
  (PEA, PEI, PER, PHD, JSL, ...) is not reproduced exactly, and RMW does an
  internal cycle instead of the dummy write. The game leaves emulation mode
  with its second instruction (`CLC / XCE` at `$00:FF00`).
- Save states keep the S-DSP's 128 registers but not its voice state
  (envelopes, BRR position), and clear KON on load: a note sounding at the
  save point is silent after loading. Everything the game can observe is
  exact: a run from frame 0 to 3400 and a run saved at 2800 and resumed give
  byte-identical VRAM, CGRAM, OAM and WRAM at frame 3399.

## Validation

1. **Boot and main loop.** 8000 frames with no input: 7986 NMIs (NMI is
   enabled at frame 14), the attract cycle title → hole demo → title →
   demo, and 0 dropped VRAM writes.
2. **The SPC handshake.** `--log-apu` shows `sub_spc_ipl_upload $80:AA30`
   reading `$AA/$BB`, writing destination `$0800` and `$CC`, then 2,571
   byte/counter pairs from `$80:AA58` (the `$0A0B`-byte driver of
   [audio.md](audio.md)), done by frame 12. `sub_spc_upload_set $80:B651`
   follows at frames 17 and 108, and `sub_spc_play_song $80:B4AC` at frame
   276 with `A = $0082` (song 4, the title music). `--wav` of the same run
   is real N-SPC output.
3. **Static facts reproduce** (`python3 tools/snesstep/oracles.py all`):

   | check | snapshot | result |
   |---|---|---|
   | `$90:FBBC` font at VRAM `$4000` (the 3,072 bytes the record block uploads) | attract demo, frame 1554 | 3072/3072 |
   | `$8D:CA0A` tileset 0 at VRAM `$6000` | frame 1554 | 13312/13312 |
   | `$98:C000` palette image in the CGRAM staging buffer `$7E:0400` | frame 1554 | 256/256 |
   | CGRAM equals that buffer after the NMI's 512-byte DMA from `$80:8281` | frame 1561 | 256/256 |
   | `$8B:8000` title BG tiles at VRAM `$0000` | title, frame 298 | 16384/16384 |

   Later frames differ from the bundle in exactly the places later transfers
   wrote, and the oracle's `--xfer` mode attributes every mismatching word:
   per-hole sprite slots are refilled throughout `$6100-$77FF` (from `$91`, `$93`,
   `$94`, `$8F` directly, and from `$7E:39DA`), and colours 54 and 118 come
   from partial palettes `$98:DF74`/`$98:DFB0` via `$80:90C8` in the same
   frame as the full image.

   One documented fact did **not** reproduce. docs/compression.md lists
   `$8E:EC7F`, `$8D:9400` and `$8F:E6A4` as "title screen tiles". The title
   screen decompresses `$92:C1F2`, `$8B:8000` (to `$7F:0C00`, then VRAM
   `$0000`) and `$92:8550`, and none of the three. They are loaded together
   by `$87:EB44`, which also selects palette set 27 and is reached only
   through a jump table at `$87:8B85` (a script-opcode table, unconfirmed).
4. **Coverage self-check.** In `--coverage` output, 99.8% of non-branching
   instruction starts are followed by another start at `addr + len`, which
   checks the M/X tracking and the length table together.

## Screens reached

`tools/snesstep/screens.py` runs every script in `tools/snesstep/inputs/`
with `--snap-scenes` and writes `build/emu/screens/index.tsv`. Scene numbers
are the `A` passed to `sub_scene_screen_setup $80:CABC`; the caller is the
JSL return address.

| scene | screen | requested by | script |
|---|---|---|---|
| 16 | Nintendo logo | `$83:B4E3` | all |
| 1 | title, with the 1P/2P/DEMO menu drawn over it | `$83:B562` | `title_menu` |
| 2 | MEMBERS LIST, then NAME ENTRY (same scene) | `$81:FC06` | `play_hole1` |
| 5 | course map ("COURSE 1") | `$83:9690` | `play_hole1`, `pause_menu` |
| 11 | course intro | `$86:FD0B` | `play_hole1`, `two_player` |
| 0 | a hole in play (requested twice: `$80:C179`, then `$80:C30E`) | | `attract`, `play_hole1`, `demo_play`, `two_player` |
| 13 | DEMOPLAY SELECT | `$82:F5C9` | `demo_play` |
| 6 | 2P COURSE SELECT | `$83:D540` | `two_player` |
| 12 | 2P HANDICAP / dice order | `$83:DB4C` | `two_player` |
| 8 | course result: BEST SCORE / YOUR SCORE | | autoplay |
| 4 | course ranking table | | autoplay |
| 9 | GAME OVER, then CONTINUE / GAME END | | autoplay |
| 3 | a ranking entry's per-hole RESULT card | `$81:F98C` | `ranking` (with a course-1 save) |
| 17 | MAP SELECT | `$82:F90A` | `map_select` (medal-flag pokes) |
| 8 | DANCE SELECT's Kirby dance, on the course-result stage | `$83:BF66` | `dance` (medal-flag pokes) |
| 15 | medal award ("a gold medal for all courses") | `$83:F9FB` | autoplay, whole game, after course 8 |
| 18 | the ending, Dedede over the clouds | `$87:F02F` | autoplay, whole game, King Dedede beaten |
| 19 | the credits, drawn in stars, then END | `$84:FB31` | the same |
| 8 | 2-player result: stars per player, WIN / LOSE (after a per-hole star scorecard drawn over the hole scene) | `$83:BF66` | autoplay `--two-player` |
| 5, 11, 0, 8, 15, 18, 19 | the extra game: "EXTRA n" map, EXTRA COURSE intro, holes, results, EXTRA medal award, ending | | autoplay `--extra` |

Each is rendered with tools/ppu_render.py and copied, named, to
`build/screens/<name>.png`, with its whole BG tilemaps, sprite layer and
OBJ tile page in `<name>_layers/`.

Scenes 4, 8, 9, 15, 18 and 19 are reached by tools/snesstep/autoplay.py,
which plays courses with real hole-outs ([physics.md](physics.md)). Played
from a new game, it finishes the whole game:
* all eight courses;
* the medal award;
* King Dedede;
* the ending and the credits.

tools/snesstep/ending.py snapshots those screens from the recorded run.
Scenes 3 and 17, and the title menu's hidden items, come from the
`ranking` and `map_select` scripts.

**Scenes 7, 10 and 14 are requested by nothing**, in code or in any run
([scenes.md](scenes.md)). Every scene that has a request site has now
been reached.

Songs requested on the way (`sub_spc_play_song`, id = `$7E + n`): title
`$82`, members list `$94`, course map `$95`, course intro `$93`, course 1
hole `$89`, the tutorial demo `$99`, 2P select `$92`, 2P hole `$85`, and the
attract-mode hole asks for `$7E`, song 0, the silent carrier.

## Input scripts

`--input FILE`, one entry per line: `FRAME BUTTONS [HOLD]`, buttons
`B Y SELECT START UP DOWN LEFT RIGHT A X L R` joined with `+`, `HOLD`
frames (default 1), `#` comments. The pad state for frame F is latched at
F's vblank. Buttons are pad 1's; prefix them with `2:` for pad 2
(`2:A+B`). Pad 2 is not stored in save states: it is recomputed from the
script at the next vblank.

| script | reaches |
|---|---|
| `attract.txt` | no input: logo, title, attract demo of a hole (Kirby, enemies, Whispy Woods) from frame ~1589, title again at 2807 |
| `title_menu.txt` | title menu cursor on each item |
| `play_hole1.txt` | blank SRAM → new member → name entry → course map → course 1 → hole 1 → two shots; Kirby rolling with the camera following, frames 3050-3400 |
| `demo_play.txt` | DEMOPLAY SELECT → first tutorial demo with its help text |
| `two_player.txt` | 2P course select → handicap/dice → 2-player hole in play |
| `pause_menu.txt` | hole 1 → pause menu → back to the course map |
| `map_select.txt` | title menu with the hidden items → MAP SELECT → NORMAL COURSE → the MAP SELECT screen (scene 17); needs the medal-flag pokes |
| `sound_room.txt` | title menu → SOUND ROOM (drawn over the title); needs the medal-flag pokes |
| `dance.txt` | title menu → DANCE SELECT → 1PLAY DANCE → DANCE01: Kirby's dance on the scene-8 stage, then the title; needs the medal-flag pokes |
| `play_extra.txt` | from a finished-game save: 1PLAY GAME → PLAY EXTRA COURSE → member 1 → extra course 1 (hole at 2279) |
| `ranking.txt` | members list → RANKING (scene 2) → A on entry 01 → its RESULT card (scene 3); needs a save with a cleared course |

Facts the scripts depend on, found with the stepper:

- The joypad is read at `$80:82D3` with **D = 0**, so the held, newly
  pressed and auto-repeat words are at `$00:004F`, `$00:005F`, `$00:0057`
  (pad 1; pad 2 at +2), although most game code runs with D = `$1E00`.
- The title ignores input until about frame 380.
- NAME ENTRY is a drawing pad. The pencil moves 2 units on a press and every
  second frame after an 8-frame delay (`$81:DFD9`). Its area includes the
  CLR and OK buttons: `$81:E0C7` is a zone table of `(x0, y0, x1, y1)`
  words, canvas `(4,4)-($3B,$2B)`, CLR `(4,$38)-($15,$45)`, OK
  `($28,$38)-($3B,$45)`. An empty drawing is not accepted.

## CLI

```
snesstep [ROM] [options]       ROM: default $KDC_ROM, else the CLAUDE.md path
  --frames N             stop when the frame counter reaches N (absolute)
  --out DIR              default build/emu/run
  --input FILE           input script (above)
  --snap-at F,F,...      snapshot at the start of vblank of these frames
  --snap-every N
  --snap-on-pc ADDR      after the instruction at ADDR executes (repeatable),
  --snap-limit N         at most N times (default 16)
  --snap-scenes          one snapshot per $80:CABC call, once the display has
  --scene-settle N       been at full brightness N frames (default 8);
                         dirs <out>/sceneNN_cMMM/fFFFFFF, index scenes.tsv
  --log-pc ADDR          registers on entry to ADDR (repeatable) -> pclog.tsv
  --log-vram-dma         every DMA/HDMA/CPU write into VRAM/CGRAM/OAM -> xfer.tsv
  --log-apu              S-CPU port writes and changed reads -> apu_ports.tsv
  --coverage FILE        every executed ROM instruction start, M/X, length
  --trace N              N instructions -> trace.txt, from --trace-from F
  --save-state FILE      at the end of the run
  --load-state FILE      continue from a saved run (frame numbers stay absolute)
  --sram FILE            battery RAM at power-on
  --save-sram FILE       battery RAM when the run ends
  --pokes FILE           many --poke values, one F:ADDR=VAL per line
  --wav FILE             audio, 32 kHz stereo
  --no-dsp               skip the S-DSP (about 20% faster, no audio)
```

Addresses are `$BB:AAAA`; ROM addresses match either mirror (`$80:8696`
and `$00:8696` are the same hook), and `$00-$3F:0000-1FFF` match `$7E`.

### Outputs

**Snapshot** `<out>/fFFFFFF/` (`_2`, `_3` if one frame is snapped twice):
`vram.bin` (65,536 bytes, byte address = 2 × word address), `cgram.bin`
(512), `oam.bin` (544), `wram.bin` (131,072) and `regs.json`. A vblank
snapshot also gets `vram_post.bin`, `cgram_post.bin` and `oam_post.bin`,
written when line 0 of the next frame begins: the PPU memory after the NMI
has made the frame's uploads. The game sets a frame index during its logic
and uploads the matching tiles in the following NMI, so the frame the
screen shows next is `wram.bin` with the `_post` files; pairing `wram.bin`
with `vram.bin` draws the new layout over the previous frame's tiles.
`regs.json`:

```
{"frame", "pc", "scanline", "reason", "cpu": {a,x,y,s,d,db,p,e},
 "ppu": {inidisp, obsel, bgmode, mosaic, bg_sc[4], bg_nba[2], bg_hofs[4],
         bg_vofs[4] (10-bit), m7sel, m7 {a,b,c,d (signed 16), x,y (signed 13)},
         m7hofs, m7vofs (signed 13), w12sel, w34sel, wobjsel, wh[4], wbglog,
         wobjlog, tm, ts, tmw, tsw, cgwsel, cgadsub, coldata[r,g,b], setini,
         vmain, vram_addr, oam_addr},
 "raw": {"2100": last byte written, ... "2133"},
 "hdma": {"2126": [224 values, one per visible line], ...},
 "hdmaen", "nmitimen"}
```

A vblank snapshot is taken at the start of line 225, before the NMI runs.
`hdma` lists only registers HDMA wrote that frame; each value is the
register's composed value as the line began, so CPU writes between lines
show too. Visible line *k* (0-223) is the state after the HDMA step of
scanline *k*.

**`xfer.tsv`**: `frame line kind ch pc src src_end src_file target dest
dest_end bytes dropped mode bbad vmain`. One row per DMA channel transfer;
CPU and HDMA writes are merged while the writing instruction, target and
frame stay the same. `dest` is a VRAM word address, CGRAM colour or OAM
byte. `src_file` is the file offset when the source is ROM, which is what
tells an uncompressed ROM-to-VRAM upload from a decompressed WRAM buffer.

**`pclog.tsv`**: `frame line hpos pc a x y s d db p stack ret_long`, where
`stack` is the three bytes at S+1..S+3 and `ret_long` reads them as a JSL
return address (+1); for a JSR-entered routine only the first two bytes
mean anything.

**`coverage.tsv`**: `snes_addr file_offset m x len`, one row per
instruction start and M/X combination seen.

### Frames, iterations and snapshots

The stepper counts video frames. The game counts main-loop iterations, and the two do not line up. These rules were found while porting the engine; its tests, which compare every recorded store and sound request, depend on them.

* **A stamp early in a frame belongs to the iteration before it.** The roll loop routinely runs past the vblank, so a store or a sound request in the first lines of frame F was made by the iteration of F − 1. The recorders therefore carry the scanline:
  * `ln` in `trace_ball.py`'s records;
  * the line column of `trace_flow.py`'s sound log (`sounds_<name>.json`, every `$80:B542` / `$80:B4AC` call).

  The tests convert a stamp below line 112 to the previous iteration, and with that every event of the recordings lines up on one convention. Example: web_flow's launch pushes a tomato −1 at 2982 that lands at 3002. A take's +1 pushed at 3067 lands at 3087, though the store is stamped 3088 because it happens in the first lines of that frame. Counted this way, the phase-5 "32 frames to the set-up" was 33 iterations.
* **A snapshot shows the iteration before it.** A vblank snapshot `fFFFFFF` holds the WRAM as iteration f − 1 left it, and the picture built from it. web_ui: the flow trace writes the meter's 1 at 3249, snapshot 3250 has 1 and snapshot 3251 has 0. Ages measured on snapshots (the shot panel's, [flow.md](flow.md)) are therefore one more than the same moments in iterations.
* **Trace records are write-back bursts, not frames.** The game copies the work ball back in a burst of stores that can straddle a frame. When it lags and catches up, two physics steps can fall in one frame ([web-demo.md](web-demo.md) "Verified against the real game"). The engine's harness aligns states, so it never assumes one record per frame.
* **Lag frames.** An iteration that outlasts its frame delays the next one:
  * the shot guide's simulation (flow.md "The aim loop");
  * the APU handshake of a song request (audio.md);
  * a busy hole.

  The thread scheduler then drops ticks, which shifts the hazard actors' phase ([tiles.md](tiles.md) "Hazards"). Course 1 hole 4's cup reveal shows one such frame, and the volcano holes show 4-7 over an eruption.

Input scripts can carry a `<name>.pokes` file beside them (`tools/snesstep/inputs/`), which `trace_ball.py`, `trace_flow.py` and `trace_actors.py` pass to the stepper: the hazard scenarios pick their hole and place the ball this way.

## Speed

Apple M1, release build: about 2,700 frames/s with the S-DSP
(45× real time), 3,300 without; logging the transfers costs about 3%. The
whole attract cycle (8000 frames) runs in 3 seconds and `screens.py` in
about 12.

## Steering the game

Two options change WRAM so a script can reach states its inputs cannot:

- `--poke F:ADDR=VAL` writes a 16-bit value at the start of vblank of frame
  F. `tools/snesstep/holes.py` uses it to play any hole: course 1's intro is
  reached through `play_hole1.txt`, and at frame 2050 the course number
  `$7E:6A5A` and the hole `$7E:6A5E` are overwritten, so the hole loader
  (`sub_set_hole_index $82:B0A4`) builds the requested one. All 232 hole
  indices load this way; `ram_hole_index3 $7E:ABB6` reads back 3x the
  requested index in every case.
- `--poke-at-pc PC,ADDR=VAL` writes each time the instruction at PC is about
  to run, which forces a branch. `--poke-at-pc '$80:F37A,$7E:D956=0001'`
  takes the holed path of the main flow (`$80:F37A`: `LDA $D956 / BNE`) and
  the game plays its HOLE IN ONE sequence. Two frames later it deadlocks,
  and the deadlock is the poke's fault, not the stepper's: the forced path
  queues more VRAM transfers in one frame than the budget at `$7E:0026`
  allows (`$1400` bytes), and `sub_vram_enqueue_one $80:86E6` then waits
  for the NMI to drain the ring, which the NMI skips while the main loop is
  mid-frame (`$4B` set, `$80:81B8`). The course-end screens are reached
  instead by real hole-outs (tools/snesstep/autoplay.py, physics.md).

## Progress and the ending

`$7E:D7BE` (courses cleared, 0-8) is recomputed on the course map by
`$81:FB9C`-`$81:FBCD` from the save slot: `$70:0010,X` is the count, and
bit `$04` of `$70:001A,X` is required for it to reach 8 (X is the slot
offset, 0 for the first member). After the map, `$80:F20E` sends a 1-player
game with 8 cleared to `sub_final_stage $87:E767`, King Dedede
([physics.md](physics.md)). Beating him leads to scene 18 (`$87:F028`)
and scene 19 (`$84:FB26`).

*Emulated*, the whole game played with autoplay.py in one run from boot:
* scene 15 at frame 111,945;
* the final stage from 112,771;
* Dedede beaten at about 119,400;
* scene 18 at 119,979 and scene 19 at 120,415;
* END about 7,000 frames later. It stays up while nothing is pressed.

The save then has `$70:0010` = 8, `$70:001A` = 5, and medal value 3 on all
eight courses.

An earlier attempt forged a save with 8 courses cleared. It put the map on
the DEDEDE stage, which then ignored the buttons. Why is **unconfirmed**,
and the played route makes it moot.

## The game's top-level flow

Found by running the game and reading the return addresses of the scene
requests: every scene up to a hole in play is requested from one straight
line of code at `$80:F0E2`-`$80:F48C`, the game's main flow. It is plain
native code, not a thread object. A hole is played in the loop at
`$80:F321`-`$80:F33E`: set up a shot (`$81:A619`), wait frames until the
shot thread's `$531C,Y` (Y = `$7E:6B48`) is non-zero, negative meaning
"take the shot again"; then `$80:F342` records the shot, and `$80:F37A`
branches to `$80:F48C` when the ball was holed (`$7E:D956`).

## Sprites from live state

`tools/emusheets.py` reads, from each snapshot's WRAM, every live object's
frame table and index (`$5E1C`/`$5D9C` for thread objects, `$0B9E`/`$0B7E`
for script objects) and draws that frame with the snapshot's own VRAM and
CGRAM. Nothing about pairing frames with tiles is inferred: a picture is in
a sheet because the game showed it. `tools/snesstep/holes.py` feeds it
snapshots of every hole in play (every 4 frames from frame 2150 to 3400,
two shots each) through a cache; `tools/snesstep/demos.py` does the same for
the 20 DEMOPLAY SELECT demos, which show the copy abilities (Stone, Parasol,
Fireball, Needle, Tornado, Wheel, Spark, Hi-Jump, Freeze, UFO) and the
tutorial topics. The merged sheets go to `build/sprites/emu/`:

```bash
python3 tools/snesstep/holes.py        # ~25 min, all 232 holes
python3 tools/snesstep/demos.py        # ~2 min
python3 tools/emusheets.py --cache build/emu/holes/emusheets.pickle \
    --merge build/emu/demos/emusheets.pickle --out build/sprites/emu
python3 tools/actorids.py              # actor id -> object type check
```

Pictures that differ only in colour (fades, hit flashes, cycling palettes)
are kept once, in their most-seen colouring; the atlas records how many
colour variants and sightings each has. A frame pointer below `$2000` is a
part list built in low WRAM (`tbl_frames_in_wram $89:C833`, used by the
course enemy type 73) and is read from the snapshot.

The hole batch also confirmed what an actor id is: the five actors that
spawn a visible object (`$0049`, `$004C`, `$004D`, `$0051`-`$0053`) are
alive in exactly the holes that place them (overlap 1.000), each as the
object type with the same number. `$0048` (type 72) draws nothing in a
hole and so cannot be paired by sight; the code (`$82:B3AF`) settles it.
