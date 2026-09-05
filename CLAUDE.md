# snes-playground

Reverse-engineering notes and analysis scripts for SNES ROMs, currently
*Kirby's Dream Course (USA)*.

**This repo is:** prose findings (memory maps, routine write-ups, data-format
docs) plus small scripts that dump and decode ROM data.
**This repo is not:** a byte-matching reassemblable disassembly, a romhack, or
an emulator. There is no build system and no target binary. Nothing here
reproduces the ROM.

## The ROM

Never stored in this repo. Referenced by absolute path only:

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
| `$80-$83` | engine code: init, OAM/sprite pipeline, decompressor, APU upload, course loaders | disassembled |
| `$88` | eleven course pointer tables at `$88:A770`+`0x300*n` | disassembled loaders |
| `$89` | metasprite frame lists, indexed from `$89:8000` | disassembled |
| `$8D-$8F` | title screen graphics | decompressor call sites |
| `$95` | BRR samples, instrument table, volume curve | APU upload tables |
| `$96-$98` | song sequences (33) plus the song/SFX table | `tbl_spc_songs` |
| `$99-$9D` | course background tilemaps | course tables 8 and 9 |
| `$9D-$9F` | course grids, small tables, and the uncompressed headers | course tables 0-7, 10 |

Banks `$84-$94` hold further compressed graphics that no confirmed pointer
table reaches yet; `tools/extract_gfx.py` finds streams there, but which
screen each belongs to is unconfirmed.

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
graphics, `mus_` music. Prefer meaning to address —
`sub_decompress_tiles`, not `sub_9A8000`. Use the address form only as a
placeholder until the purpose is known.

**`symbols.tsv`** — tab-separated, one symbol per line, header row, sorted by
`snes_addr`. Tabs rather than commas because comments contain commas
constantly. Columns:

```
snes_addr	file_offset	type	name	size	comment
```

`type` is one of `code`, `data`, `gfx`, `music`, `ptr`, `ram`, `reg`. `size` is
decimal bytes or `-` when unknown. `file_offset` is redundant with `snes_addr`
but present so the file is greppable by either address form — keep the two
consistent.

## Tooling

Available: `python3` (**3.9.10** — no `match`, no `X | Y` type unions), `node`,
the Rust toolchain, `binwalk`, `make`, `cmake`, `clang`, `java`, `xxd`, `jq`,
`grep`.

**Not installed:** no emulator (no Mesen/bsnes/snes9x/RetroArch), no assembler
(no asar/bass/ca65/wla-65816), no Ghidra. **Do not assume an emulator exists**
or write instructions that depend on one — this is static analysis only. `rg`
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

# Bulk asset extraction
python3 tools/extract_gfx.py       # every stream -> build/gfx/{bin,png}, index.tsv
python3 tools/spc_extract.py       # driver, samples (WAV), songs (SPC) -> build/spc
python3 tools/courses.py           # 232 holes -> build/courses

# Playfield geometry: terrain shape, elevation, gaps
python3 tools/terrain.py --tables         # the engine's 28 terrain shapes
python3 tools/terrain.py --stats          # cross-check those tables vs data
python3 tools/terrain.py --index 0 --legend
python3 tools/terrain.py --probe 0 5 0    # surface height over one cell
python3 tools/terrain.py --tiles          # layer-2 special-tile dispatch map

# Render
python3 tools/tiles.py FILE.bin --bpp 4 -o build/x.png
python3 tools/tilemap.py MAP.bin TILES.bin --width 32 -o build/x.png
python3 tools/tilemap.py MAP.bin --guess          # candidate widths
python3 tools/palettes.py render '$98:C000' 0x200 -o build/pal.png
python3 tools/sprites.py --table                  # metasprite frame index
python3 tools/sprites.py --list '$89:8550'

# SPC700 side
python3 tools/dis_spc700.py build/spc/driver_0800.bin --base 0x0800
python3 tools/brr.py build/spc/ram_base.bin --dir 0x0400 -o build/wav/

# Text in the game's font encoding (not ASCII)
python3 tools/text.py --min 6
```

Every script imports `load_rom()` from `tools/romcheck.py`, so the integrity
check runs implicitly on each invocation.

## Formats

Written up in `docs/`, each derived from disassembly rather than pattern
matching:

- [docs/compression.md](docs/compression.md) — the HAL LZ format that every
  compressed asset uses, and the two decompressor entry points.
- [docs/audio.md](docs/audio.md) — N-SPC driver upload, BRR samples,
  33 songs, and how the standalone `.spc` files are built.
- [docs/graphics.md](docs/graphics.md) — tiles, tilemaps, palettes, and the
  metasprite/OAM pipeline.
- [docs/courses.md](docs/courses.md) — the eleven bank `$88` course tables.
- [docs/terrain.md](docs/terrain.md) — the playfield: elevation, the 28
  terrain shapes, the surface equation, and how gaps work.
- [docs/tiles.md](docs/tiles.md) — the special-tile layer: the dispatch
  tables, friction overrides, boost panels, kickers and hazards.

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

For register maps (`$2100-$21FF`, `$4200-$43FF`) and opcode tables, use
standard references (fullsnes, the 65816 manual) rather than half-remembered
tables.
