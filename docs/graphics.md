# Graphics: tiles, tilemaps, palettes, sprites

All bulk graphics are HAL-compressed; see [compression.md](compression.md).

## Tile format

Standard SNES planar. `tools/tiles.py` decodes 2, 4 and 8 bpp. A 4bpp tile
is 32 bytes: 16 bytes of planes 0/1 interleaved per row, then 16 bytes of
planes 2/3. Bit 7 of a plane byte is the leftmost pixel.

```bash
python3 tools/tiles.py build/gfx/bin/076C7F_8EEC7F.bin --bpp 4 -o out.png
python3 tools/tiles.py build/gfx/bin/x.bin --bpp 4 --palette PAL.bin:3 -o out.png
```

## Tilemaps

One 16-bit little-endian word per 8x8 cell:

| bits | field |
|---|---|
| 0-9 | tile index |
| 10-12 | palette |
| 13 | priority |
| 14 | horizontal flip |
| 15 | vertical flip |

`tools/tilemap.py` renders a map over a tile sheet. The map's width is not
stored with the data, so pass `--width`; `--guess` lists the factorisations
that give a screen-shaped result.

The course backgrounds (bank `$88` tables 8 and 9) are the largest tilemaps,
704 to 16,880 bytes each.

## Palettes

CGRAM entries are 15-bit `0BBBBBGGGGGRRRRR` little-endian words. The game
stages a full 512-byte CGRAM image at `$7E:0400-$05FF` and DMAs it to
`$2122` in `sub_dma_cgram` at `$80:8250 (0x000250)`; the DMA parameter table
is at `$80:8288`. Palettes reach that buffer from ROM via `MVN`, so they are
stored raw and can be scanned for.

```bash
python3 tools/palettes.py scan '$98:8000' '$98:FFFF'
python3 tools/palettes.py render '$98:C000' 0x200 -o build/pal/x.png
```

The scan is a heuristic (16 aligned words, bit 15 clear, at least 6 distinct
colours). Look at the swatch before trusting a hit.

## Sprites

`tools/sprites.py`. Objects are drawn as metasprites: a list of 5-byte
part records walked by the OAM builder at `$80:8D89 (0x000D89)`.

| byte | meaning |
|---|---|
| 0 | Y offset, signed; added to the object Y at `$38`. `$7E` and `$80` are control codes |
| 1 | tile number, low 8 bits |
| 2 | OAM attribute `vhoopppN`: bit 0 is tile bit 8, bits 1-3 palette, 4-5 priority, 6 hflip, 7 vflip |
| 3 | X offset, signed; added to the object X at `$36` |
| 4 | bit 7 = last record in the frame, bit 6 = sprite size bit |

Bytes 1 and 2 are fetched as a single 16-bit load and stored straight into
OAM bytes 2-3. The X 9th bit and the size bit are accumulated two at a time
in `$31` and flushed to the OAM high table every four sprites, which is why
`$31` is initialised to `$80`.

### Control records

A control record is **3 bytes**, not 5: byte 0 is the marker and bytes 1-2 a
pointer. The two are not symmetric, and getting `$7E` wrong silently discards
whole frames.

`$7E <ptr16>` is a **priority override**, not a continuation.
`loc_oam_frame_priority` at `$80:8D90 (0x000D90)` reads the byte at
`$7E:<ptr>`, keeps bits 0-1, shifts them to bits 12-13 and stores that in
`$3F`; the walk then continues **inline at +3** in `sub_oam_emit_frame_alt`,
which ORs `$3F` into every subsequent attribute word (`$80:8E67 ORA $3F`).
Bits 12-13 of the attribute are the OAM priority, so this makes an object's
draw priority a runtime value. The override value is not statically known;
the parts after it are entirely ordinary.

`$80 <ptr16>` **is** a continuation: `$80:8DAC` does `LDA $0001,Y / TAY`, an
absolute jump to another list in the same bank.

Most lists in the `$89:9295`, `$92F3`, `$9351`, `$9365` and `$CCDB` tables
*open* with a `$7E` record, so a walker that stops there sees a frame with no
parts at all. `$89:9533` looks empty under that reading and is really a 3x3
block of tiles `$1C0-$1C8` — Kirby.

Frame lists live in bank `$89` and are always read with `DBR=$89`, set by the
`PEA $7E89 / PLB` at `$80:8C1A (0x000C1A)` — so a frame list is always a
bank-`$89` address even when the table that points at it is not.

`$89:8000 (0x048000)` is **one such pointer table, not the index**: 105 word
entries, 6 of them `$FFFF` — indices 0 and 10-14. (An earlier note said 8;
counted directly off the ROM it is 6, and there are no `$0000` holes.)

An object does **not** store its current frame list. It stores, per object,
the address and bank of a frame *pointer table* (`$7E:0B9E,X` and
`$7E:0BBE,X`, written only by `$80:9B98 (0x001B98)`) plus an *index* into it
(`$7E:0B7E,X`, negative = invisible). Advancing an animation means changing
that index — which is what the animation bytecode does; see
[animation.md](animation.md).

### The OBJ page and its palettes

Tile numbers in a frame list are relative to the **OBSEL name base**, and
OBSEL is pinned rather than inferred. The course screen-setup block at
`$80:CB91 (0x004B91)` — 16 bytes, reached from `tbl_scene_screen_blocks
$80:CAC7` through `sub_scene_screen_setup $80:CABC` — opens `09 03 ...`:
BGMODE `$09`, **OBSEL `$03`**.

| OBSEL bits | value | meaning |
|---|---|---|
| 0-2 | 3 | OBJ name base `3 << 13` = VRAM word `$6000` |
| 3-4 | 0 | name select |
| 5-7 | 0 | sprite size pair **8x8 / 16x16** |

That is where `sprites.py`'s `OBJ_SIZE = (8, 16)` comes from, and it agrees
with the two loads that fill the page: `$8D:CA0A` (13,312 bytes, OBJ tiles
`$000-$19F`, loaded by `$80:CE92`) and `$8E:DD91` (8,192 bytes to VRAM word
`$7000` = tiles `$100-$1FF`, loaded by `$80:D2E7`). Rendering therefore needs
a **composed page**, not a tile sheet:

```bash
python3 tools/vram.py objpage --scene course -o build/vram/obj/course.bin
```

Sprite palettes are CGRAM `$80-$FF`, so **OBJ palette n is sub-palette n+8**
of a 512-byte CGRAM image. The course image is `$98:C000`, 512 bytes, moved
by `$80:D369`; `tools/vram.py cgram` extracts it and eight others.

### Finding the tables

`tools/frametabs.py` scans the whole ROM with five finders and writes
`build/sprites/tables.tsv` plus `build/sprites/accounting.txt`. The strongest
is anchored on the animation bytecode: opcode `$1C` is
`sub_obj_set_frame_ptr $80:9B98`, the only `STA $0B9E,X` in the ROM, and its
three operand bytes are literally `addr16 bank8` of a table — so `1C lo hi
bank` inside a script names one outright. That is what recovers `$89:9295`,
`$92F3`, `$9351` and `$9365` as the operands of the four object-type scripts
at `$87:99FE`. `$89:CCDB` is reached differently, by an un-indexed
`LDA $89:CCDB / STA $C0` at `$84:E241` and `$86:8476`.

51 tables currently pass, 44 of them code-confirmed, and the frames they name
cover 70.8% of the frame-data region `0x0480D2..0x04F36D`. A byte-pattern hit
that only occurs in a data bank is demoted to `inferred` rather than trusted —
`1C xx xx 89` turns up by chance in the course tilemap banks.

```bash
python3 tools/frametabs.py                     # -> build/sprites/tables.tsv
python3 tools/frametabs.py --check '$89:9295'  # explain one candidate
```

### Rendering

```bash
python3 tools/sprites.py --table
python3 tools/sprites.py --list '$89:8550'
python3 tools/sprites.py --render '$89:9533' \
    --objpage build/vram/obj/course.bin \
    --palette build/vram/cgram/98C000.bin -o build/sprites/kirby.png
```

`--render` needs the composed page and the CGRAM image; passing a bare tile
sheet renders nothing recognisable. `$89:9533` (entry 0 of table `$89:9295`)
is a 3x3 block of tiles `$1C0-$1C8` on palette 0 — Kirby — and is the quickest
way to check a page composition is right.

`--all` does the whole corpus at once:

```bash
python3 tools/sprites.py --all \
    --objpage build/vram/obj/course.bin \
    --palette build/vram/cgram/98C000.bin --scale 2
```

For every table in `tables.tsv` it renders every live entry to
`build/sprites/frames/<bank>_<addr>/<NNN>.png`, writes one contact sheet per
table to `build/sprites/sheets/`, and indexes everything in
`build/sprites/frames.tsv` (table, index, list address, part count, bbox,
tiles used, palettes used, missing tiles, scene). Frames of one table share a
**union bounding box**, which is what keeps an animation from jittering as
each frame crops to its own content.

A table whose tiles run past the 512-tile page belongs to a different scene;
those are flagged `scene=other` in `frames.tsv` and **not** rendered, because
drawing them against the course page produces confident-looking garbage. As
of the current run: 51 tables, 861 live entries, 739 frames rendered, 15
tables flagged, zero missing tiles among the rendered ones.

### OAM priority queues

`$80:8B02 (0x000B02)` dispatches on `$7E:2880` into one of ten queues, each
a triple of parallel arrays in `$7E:2884` upward with its own count. The
builder at `$80:8C08` drains all ten in order into the OAM staging buffer at
`$7E:0600`, so the queue number is the object's draw priority. Buffer
pointers are initialised by `$80:8823 (0x000823)`: OAM low table at `$0600`,
high table at `$0800`.

## Batch extraction

```bash
python3 tools/extract_gfx.py
```

Scans the ROM for streams (cached in `build/gfx/streams.tsv`), decompresses
each to `build/gfx/bin/`, renders PNGs to `build/gfx/png/`, and writes
`build/gfx/index.tsv` classifying each one.

Current counts over 2,227 streams:

| kind | count |
|---|---|
| data | 1,276 |
| tilemap | 671 |
| tiles2 | 165 |
| tiles4 | 110 |
| palette | 5 |

The classifier is a heuristic and it is wrong sometimes. Tilemaps are
detected by the concentration of their high 6 bits (palette/priority/flip
take only a handful of values); 4bpp is separated from 2bpp by how much the
upper bit planes overlap the lower ones. Small blobs like the 144-byte
course grids fall into `tiles2` because there is not enough data to judge.
Always open the PNG.
