
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