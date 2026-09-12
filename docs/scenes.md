# Scenes: PPU setup and what each screen loads

A tile sheet is not a picture and a frame list is not a sprite. Both only
mean something against the VRAM layout and the CGRAM image that a particular
screen set up. In this game all of that is static, so it can be recovered
without running anything.

Reproduce everything here with:

```bash
python3 tools/scenes.py blocks      # the 20 screen setups
python3 tools/scenes.py loaders     # what each jump-table entry loads
python3 tools/scenes.py callers     # who selects which scene
python3 tools/scenes.py bundles     # scene -> graphics + palette, together
python3 tools/scenes.py all         # all four, to build/scenes/
```

## The screen setup block

`sub_scene_screen_setup` at `$80:CABC (0x004ABC)` is four instructions:

```
ASL A / TAX / LDA $80:CAC7,X / JSL $80:903A
```

so `tbl_scene_screen_blocks` at `$80:CAC7 (0x004AC7)` is **20 word pointers**
into bank `$80`. `sub_apply_screen_params` at `$80:9040 (0x001040)` applies
the block they name. It is 18 bytes:

| offset | goes to |
|---|---|
| 0 | `$2105` BGMODE, also kept at `$83` |
| 1 | `$2101` OBSEL, also kept at `$82` |
| 2-3, 4-5 | Y and X for `$80:8542`, BG1 |
| 6-7, 8-9 | Y and X for `$80:8598`, BG2 |
| 10-11, 12-13 | Y and X for `$80:85EC`, BG3 |
| 14-15, 16-17 | Y and X for `$80:8642`, BG4 |

Each BG setter reads **Y as the tilemap word address**, the **low two bits of
X as the tilemap size** (0 = 32x32, 1 = 64x32, 2 = 32x64, 3 = 64x64) and
**`X >> 12` as the character base** in 4K-word units. Read off `$80:8542`,
which does `AND #$03` for the size and `XBA / LSR x4 / ORA $0084` for the
base.

So the course block at `$80:CB91 (0x004B91)`

```
09 03 | 0050 0100 | 0058 0100 | 003C 0040 | 0000 0000
```

is mode 1 with BG3 priority; OBSEL `$03`; BG1 map `$5000` and BG2 map
`$5800`, both 64x32 with character base `$0000`; BG3 map `$3C00` with
character base `$4000`. The two BG map addresses are exactly where the
course tilemap uploader writes (`$80:BE65`, `$80:BE9A`), which is what
assigns course table 8 to BG1 and table 9 to BG2 — see
[courses.md](courses.md).

**OBSEL `$03` pins the sprite layout.** Bits 0-2 are the OBJ name base in
8K-word units, so base = `3 << 13` = VRAM word `$6000`; bits 3-4 select the
second page, here `$7000`; bits 5-7 = 0 means sprite sizes **8x8 and
16x16**. That matches the two OBJ loads landing exactly on `$6000`
(`$8D:CA0A`) and `$7000` (`$8E:DD91`). This was previously inferred from
where the loads landed; it is now read from the register value.

All 20 blocks use BGMODE `$09` (mode 1, BG3 priority). Eighteen use OBSEL
`$03`; scenes 1, 16 and 19 use OBSEL `$00`, i.e. an OBJ name base of
`$0000`.

## The loader jump tables

Graphics arrive through four jump tables, each entered as
`CMP #n / BCS / ASL A / TAX / JMP (table,X)`:

| table | address | entries | what |
|---|---|---|---|
| graphics set A | `$80:CC81` | 8 | large background tile pages |
| graphics set B | `$80:CD89` | 6 | fonts and window furniture |
| tilesets | `$80:CE45` | 28 | sprite pages and small overlays |
| palette sets | `$80:D2FE` | 33 | CGRAM images, whole or partial |

An unused slot points at a `BRA` to itself; three exist (graphics set A 7,
set B 5, tileset 27).

Loader routines reach the PPU five ways. `tools/scenes.py loaders` decodes
each routine instruction by instruction and reports which:

| kind | idiom | meaning |
|---|---|---|
| `stage` | `JSL $80:CA9F` | decompress to `$7F:xxxx`, no upload yet |
| `vram` | `JSL/JML $80:CAA9` | decompress to `$7F:0000`, then queue a record block |
| `queue` | `JSL $80:8696` | queue a record block directly |
| `cgram` | `MVN` to `$0400`, or `JSL $80:90C8` | move a palette into the staging buffer |
| `wram` | `JSL $80:9F18` | decompress straight to WRAM; a data table, not graphics |

70 of the 75 entries resolve to concrete sources. The remaining five pick
their record block from a table at run time (`LDA $80:tbl,X / JSL $80:8696`);
their tables are at `$80:CF06`, `$80:CFF8`, `$80:D030`, `$80:D10C` and
`$80:D252`, and which entry is chosen depends on game state.

Two findings worth recording:

- **Some graphics are stored uncompressed.** A record block whose source is
  a ROM bank rather than `$7E`/`$7F` is a direct ROM-to-VRAM DMA, so that
  asset is not a HAL stream at all and a compression scan will never find
  it. Tileset entries 1, 2, 4, 8, 9, 10, 17, 21 and 26 are like this, with
  sources in banks `$91`-`$94` and `$8D`.
- **The partial-palette helper is hardwired to bank `$98`.** `$80:90C8`
  takes A = number of colours, X = source address and Y = the first CGRAM
  colour index, and its `MVN $00,$98` fixes the source bank. So every
  partial palette load reads from bank `$98`, which makes `$98` the palette
  bank.

## Scene bundles

A screen is set up by a straight run of `LDA #n / JSL <jump table>` pairs, so
walking forward from a `JSL $80:CABC` call to the end of the routine
collects the whole bundle. `sub_course_enter $80:C307 (0x004307)` is the
model:

```
LDA #$0000 / JSL $80:CABC      screen block 0
LDA #$0000 / JSL $80:CC81      graphics set A 0   $8B:DAB1 + $90:9E9E
LDA #$0000 / JSL $80:CE45      tileset 0          $8D:CA0A
LDA #$0000 / JSL $80:D2FE      palette 0          $98:C000
              JSL $80:D6A8     per-course backdrop
LDA #$0000 / JSL $80:CD89      graphics set B 0   $92:9505
LDA #$0001 / JSL $80:CD89      graphics set B 1   $90:FBBC
```

`tools/scenes.py bundles` does this for every scene-entry site and writes
`build/scenes/bundles.tsv`. The course bundle above is an independent
confirmation of the tile page and palette that `tools/coursemap.py` uses.

Seventeen of the 20 scenes have a call site with an immediate scene number;
scenes 7, 10 and 14 are selected some other way and are not yet attributed.

## The BG3 layer, and the per-course scenery

BG3 is worth a section because three separate things share it.

Its **character page** is assembled from three loads, all in the course
bundle: the font at tiles 0-191 (`$90:FBBC`, graphics set B entry 1), window
furniture at 208-303 (`$92:9505`, entry 0) and the per-course scenery at
320-511. Tile indices count 2bpp tiles from the character base `$4000`, so a
load at VRAM word `W` starts at tile `(W - $4000) / 8`.

Its **tilemap** at VRAM `$3C00` is likewise shared. The stored per-course
map is scenery, but text is written into the same buffer at run time:
`$83:B406` walks a string and ORs `$3C00` into each glyph index — palette 7
with the priority bit — writing into the staging buffer at `$7E:DADC`, which
`$80:D7AC` then DMAs to `$3C00`. That is why the stored scenery map already
references tiles below 320.

The **scenery itself** is per-course, not per-hole. `sub_load_course_backdrop
$80:D6A8` masks the course number at `$7E:6A5A` with 7 and indexes two
8-entry tables of `(bank16, addr16)`: `$80:D748` for tiles, which always
decompress to exactly 3,072 bytes, and `$80:D768` for a 32x32 tilemap,
always 2,048 bytes.

**And it has its own palette.** `$80:D4F7` indexes `$80:D517` with the same
`course & 7` and hands 40 colours to `sub_cgram_partial`, which writes CGRAM
colours 0-39. A second table at `$80:D527` is used instead when `$7E:6A2E`
is set. This matters: the course CGRAM image at `$98:C000` leaves BG3
sub-palettes 1-7 completely black, so drawing the scenery against the scene
palette alone yields recognisable shapes full of holes. With the per-course
palette the layer resolves into clouds, hills and landmarks, and each of the
eight courses has a distinct theme.

`tools/coursemap.py` draws all of this by default; `--no-backdrop` leaves
the course geometry alone. Because BG3's map is 32x32 it wraps, so rendering
a whole course at once tiles the scenery where the hardware would show only
one screen of it.

## Scene identities

Only the course scene is named with certainty so far, from its entry
routine. The rest are listed by their entry site in
`build/scenes/callers.tsv`; naming them means reading each entry routine,
which has not been done. Do not guess a screen's identity from its palette.
