# Graphics: tiles, tilemaps, palettes, sprites

Most bulk graphics are HAL-compressed; see [compression.md](compression.md).
**Most sprite tiles are not**: 346 uncompressed chunks (87,188 bytes, banks
`$8A`-`$94`) are copied straight from ROM to VRAM by the transfer queue, and
a compression scan never sees them. See "Tiles that are uploaded" below.

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
| 4 | bit 7 = last record in the frame, **bit 0** = sprite size bit; nothing else is ever set |

Bytes 1 and 2 are fetched as a single 16-bit load and stored straight into
OAM bytes 2-3. The X 9th bit and the size bit are accumulated two at a time
in `$31` and flushed to the OAM high table every four sprites, which is why
`$31` is initialised to `$80`.

The size bit is **bit 0**: `$80:8E08` is `LDA $0004,Y / ROR A / ROR $31`,
and the `ROR A` moves bit 0 into carry. This page used to say bit 6, and
`tools/sprites.py` read it there, which drew every 16x16 part as one 8x8
tile; that single error is why rendered frames came out as scraps. Across
every trusted table byte 4 only ever takes the values `$00 $01 $80 $81`.

Two more things a renderer has to get right, both from the hardware rather
than the game:

* A 16x16 sprite's other three tiles are found by stepping the low nibble of
  the tile number for the column and the next nibble for the row, **without
  carry** (fullsnes, "16x16 (and bigger) Tiles": "For OBJ tiles, the are no
  carry-outs from x+1 to y, nor from y+1 to Y"). Tile `$1FF` large is
  `$1FF $1F0 $10F $100`.
* The builder fills OAM upward (`INX` x4 at `$80:8E1A`) and a lower OAM
  index is drawn in front, so the **first** record of a list is on top.

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

That is where `sprites.py`'s `OBJ_SIZE = (8, 16)` comes from.

The course screen makes exactly one OBJ load up front: `$8D:CA0A` (13,312
bytes, tiles `$000-$19F`, loaded by `$80:CE92`). Of those 416 tiles, 155 are
one repeated filler tile parked in slots that are filled later (`$010-$05F`
and most of `$0A0-$0FD`), and `$1A0-$1FF` is left blank. `$8E:DD91` to tiles
`$100-$1FF` (`$80:D2E7`) was once composed on top as a second witness for the
name base; it is tileset entry 24, whose only caller is `$83:96E0` in scene
5, and it overwrote 160 course tiles with another screen's.

Sprite palettes are CGRAM `$80-$FF`, so **OBJ palette n is sub-palette n+8**
of a 512-byte CGRAM image. The course image is `$98:C000`, 512 bytes, moved
by `$80:D369`; `tools/vram.py cgram` extracts it and eight others. Four of
those nine live in bank `$94` (`$94:A729`, `$AD29`, `$AF29`, `$B129`), so
bank `$98` is the palette bank only for the partial loads that go through
`sub_cgram_partial $80:90C8`.

### Tiles that are uploaded

A frame list is tile numbers. What is in those tiles when the frame is drawn
is decided at run time, by `sub_vram_queue $80:8696`: 890 call sites, of
which 792 pass an immediate block, 54 index a table of blocks, 16 pass a
block built in WRAM and 28 compute the address some other way.

* **The block's bank comes from the caller.** `$80:86AB` tests the block
  address and takes the caller's program bank (`$07,S`, the `JSL` return
  address) for a block at `$8000` or above, the caller's data bank (`$01,S`)
  otherwise. `LDA #$C388 / JSL $80:8696` in bank `$86` names `$86:C388`.
  Reading every block in bank `$80` is right only for the loaders in bank
  `$80`.
* **Byte 0 of a record is a mode, not a DMA channel**: an offset into
  `tbl_dma_modes $80:FF0A`, three bytes each (`DMAP`, B-bus address,
  `VMAIN`). `$00` is a plain word copy, `$03` a fill from one fixed word,
  `$1B` a copy stepping 32 words -- a tilemap column.

```bash
python3 tools/vram.py queue      # -> build/vram/queue.tsv, one row per record
python3 tools/vram.py direct     # -> build/gfx/direct/{bin,png}, index.tsv
```

2,101 records in all: 1,567 read ROM directly, 363 the decompression buffer
at `$7F`, 150 WRAM, 21 are fills. The ROM sources come to 346 distinct
chunks, 87,188 bytes, 294 of them OBJ tiles. A typical one is 160 bytes: a
row of five tiles, sent to `$7E00` or `$7F00` so that a pose arrives as a top
row and a bottom row.

### Finding the tables

`tools/frametabs.py` scans the whole ROM and writes
`build/sprites/tables.tsv`, `lists.tsv` and `accounting.txt`.

What makes it reliable is a strict frame check: a list is accepted only when
it terminates on a last-record flag, **every record's flag byte uses only
the size and last bits**, and it ends inside the data region. The lenient
parse it replaced accepted `FF FF FF FF FF` as a one-part frame, which let
the `$FF` padding and tables of other things in: 21 "confirmed" tables were
really tables of VRAM transfer blocks (`LDA $84:xxxx,X / JSL $80:8696`), six
more were signed velocity tables.

The finders:

| finder | idiom | confidence |
|---|---|---|
| `obj2` | `LDA #imm / STA $5E1C,Y`: a thread object's table (86 of 96 values) or frame list (8) | confirmed |
| `obj2x` | `LDA $bb:aaaa,X / STA $5E1C,Y`: a list of such values | confirmed |
| `longidx`, `longabs` | `LDA long[,X] / STA $C0`, the word `sub_oam_enqueue` pushes | confirmed |
| `immc0`, `imm5d9c` | `LDA #imm / STA $C0` or `STA $5D9C,Y`: one frame list | confirmed |
| `dbr` | `LDA abs,X` near `JSL $80:8B02` | confirmed |
| `anim1c` | `1C lo hi bank`, the operand of animation opcode `$1C` | inferred |
| `longraw` | a long load with any other consumer | inferred |
| `struct` | three or more words in a row that name known frame starts, in banks `$80`-`$87` and `$89` | inferred |
| `tile` | a run nothing claimed that parses as back-to-back frames | (lists only) |

`anim1c` is inferred on its own because `$1C` is also `TRB abs` in native
code: `$84:AEB7` "names" a table that way. The four real script operands
(`$89:9295`, `$92F3`, `$9351`, `$9365`) are all confirmed by `obj2` stores.

Current result over `0x048000..0x04F36D` (29,550 bytes):

| | |
|---|---|
| tables | 125, 108 of them confirmed |
| frame lists no table names | 241 (33 from code, 208 by tiling) |
| distinct frames | 1,163, covering 27,566 bytes (93.3%) |
| pointer tables | 1,934 bytes (6.5%) |
| misaligned overlaps | none (was 135) |
| unclaimed | 50 bytes, `$89:C833` |

`$89:C833` is itself a table, of pointers below `$8000`: with `DBR = $89`
those address WRAM, i.e. part lists the game builds at run time.

```bash
python3 tools/frametabs.py                     # -> build/sprites/tables.tsv
python3 tools/frametabs.py --check '$89:9295'  # explain one candidate
```

### Rendering

A layout is not a picture, so rendering is done per object rather than per
table. `tools/objanim.py` traces what each of the 234 thread object types
does -- see [animation.md](animation.md) -- and `tools/objsheets.py` replays
it against a tile page:

```bash
python3 tools/objanim.py      # -> build/sprites/objects.tsv, objects/NNN.json
python3 tools/objsheets.py    # -> build/sprites/{objects,tables,blocks,anim}/
```

| output | what |
|---|---|
| `objects/obj_NNN.png` + `.json` | every distinct (layout, tiles, palette) the object shows, on a uniform grid; the JSON is an atlas with the cell size, the origin and per-frame durations |
| `anim/obj_NNN.gif` | the same frames in order, with their durations |
| `tables/BB_AAAA.png` + `.json` | every entry of one frame table, each with the tiles some object showed it with |
| `tables/lists.png` | the 241 frame lists no table names |
| `blocks/BB_AAAA.png` | every upload block that copies ROM into the OBJ page, as the grid it occupies in VRAM |

Each tile a frame uses carries a provenance, and the index files report the
worst one per frame instead of leaving it to the eye: `placeholder` (still
the course filler), `empty` (a dynamic slot nothing uploaded to), `swapped`
(an unseen table entry over a slot that is re-uploaded during the
animation), `context` (loaded by the hole-start object, not by this one) and
`unknown` (uploaded from WRAM with nothing seen unpacked there). A frame
with none of those is drawn entirely from tiles its own object, or its
spawner, was seen to upload, or from the fixed course tiles.

Current run:

| | |
|---|---|
| object types that show at least one frame | 107 of 234 |
| ... with every tile proven | 43 |
| ... relying on `context` tiles | 37 |
| ... with a `placeholder` or `empty` tile | 36 |
| table sheets | 126, 1,470 frames |
| ... frames with every tile proven | 684 |
| ... drawn / left off as known-wrong | 1,195 / 275 (listed under `omitted` in the atlas) |
| upload blocks drawn | 296, 254 of them applied by a traced object |

The `context` and `placeholder` cases are mostly enemies. Their tiles go
into the filler slots per hole, from a WRAM staging buffer at `$7E:39DA`
that a tileset loader unpacks (`$93:E1B6` for entry 23, `$93:E7D5` for entry
6), and which enemy lands in which slot is decided by code this trace does
not follow. A `context` frame can look convincing and still be the right
layout over another object's tiles. **Unconfirmed until that link is
traced.**

That link was read later (2026-11-15; [tiles.md](tiles.md) "Actors"): the
enemy's species is its tile − `$40` (`$591C`), and `$82:B730` gives each
species on the hole a VRAM slot in first-seen order (`$A0 $A5 $C0 $C5 $CA $E0
$E5 $EA`, at most 8), copies its part lists to a fixed WRAM block with the
slot's base added to each tile (`$82:B769`) and queues its tiles
(`$82:B8B6`). So one species' pictures have other tile numbers from hole to
hole; `tools/snesstep/trace_enemies.py` compares them by their pixels.

### From live state

The static sheets above have to prove each tile and flag what they cannot.
Running the game removes that: `tools/emusheets.py` takes snapshots from
the stepper (see [emulation.md](emulation.md)), reads every live object's
frame table and index out of WRAM, and draws that frame with the VRAM and
CGRAM the screen had. `tools/snesstep/holes.py` and `demos.py` feed it all
232 holes and the 20 demos; the result, in `build/sprites/emu/`, is one
sheet per object type (`obj_NNN.png`) or script table
(`script_89_9295.png` is Kirby in play, with every copy ability the demos
show), each with an atlas JSON. Where a type has an emulated sheet, prefer
it to the static one: it includes the enemies' per-hole tiles that the
static trace marks `context` or `placeholder`.

Current run: 83 object types and script tables seen, 1,596 distinct
pictures once colour-only variants are folded (5,023 before), from every
4th frame of 232 holes and every 3rd frame of 20 demos. Every frame is
drawn with the VRAM and CGRAM as they stood after the NMI that followed
the snapshot, which is the pairing the screen shows; drawing with the
snapshot's own VRAM put new layouts over the previous frame's tiles.

`tools/sprites.py` still renders a single list or a whole table against one
fixed page (`--render`, `--all`). That is the right tool for checking one
frame and the wrong one for a sheet, for the reason above.

### OAM priority queues

`$80:8B02 (0x000B02)` dispatches on `$7E:2880` into one of ten queues, each
a triple of parallel arrays in `$7E:2884` upward with its own count. The
builder at `$80:8C08` drains all ten in order into the OAM staging buffer at
`$7E:0600`, so the queue number is the object's draw priority. Buffer
pointers are initialised by `$80:8823 (0x000823)`: OAM low table at `$0600`,
high table at `$0800`.

### Kirby behind the course

Every sprite of play is drawn at OAM priority 3, over both course layers,
except Kirby. His frame lists open with the record `$7E $D96A`, so the
per-player word `$D96A` sets the priority of all his parts. The roll loop
recomputes it every frame in `$82:F4FD`. Player 1 calls it at `$82:C06E`,
after the presentation `$81:A121` and the shadow `$81:A23E`, and player 2
at `$82:C0F7`. Read with `tools/dis65816.py`, 2026-11-15:

| where the ball is | `$D96A` | behind |
|---|---|---|
| z < 0 (the high word's sign) | 1 | yes |
| on a cell (shape ≠ 0) | 3 | |
| over a gap, xc < 0 | 1 | yes |
| over a gap, yc < 0 | 3 | |
| over a gap, yc ≥ h (`$8B94`) | 1 | yes |
| over a gap, otherwise | table 10's priority while z ≤ the top of the record's cell, else 3 ([courses.md](courses.md) "Table 10") | with the record |

- **Behind** also sets `$DA6C` = 9, which puts Kirby in the last OAM queue,
  after every other sprite. It also counts `$ECDD`. On the next frame
  `$81:A1E6` sees that count and does not sort him back
  (`$81:A237` copies `$DA6C` to `$0B1E`).
- **Resets.** The set-up (`$80:C532`) and the lost ball's reset
  (`$80:F59A` → `$80:F5BD`) write 3.
- **In mode 1 with BG3 priority**, priority 1 is under BG1 and BG2 at both
  of their priorities and over BG3.0. Priority 2 is under the priority-bit
  half only.

**The shadow** has its own routine, `$81:A23E`, which sets its frame
`$D996`. The frame is `$FFFF` (no shadow) in these cases:
- `$D9D2` bit 0 (the ball is below z 0);
- holed (`$DA4A`);
- `$6B7E` non-zero (the cup handler's depth scratch);
- a ground of 0 (`$DA08:$DA06`: a gap, [terrain.md](terrain.md) "Gaps").

Otherwise the frame is the surface code `$DA04` (or `$69D6` in one case).
The shadow's picture therefore changes with the slope.

*Emulated* on web_fly (`snesstep --snap-every 4`, read 2026-11-15). Kirby
flies off the near side at xc = 12, yc = 3:
- **3196**: the probe first reads a gap. From this frame there is no shadow
  sprite.
- **Through 3252**: `$D96A` stays 3. Column 15 has no record for xc = 12.
- **3256**: z is below 0 and `$D96A` = 1.
- **3260**: Kirby's nine 8 x 8 sprites have moved to the end of OAM, at
  priority 1.

The store lands at 3256, not 3252, because the fall's song request blocks
the loop in the APU handshake first ([flow.md](flow.md) "The fall").

## Batch extraction

```bash
python3 tools/extract_gfx.py
```

Decodes every stream the ROM points at first, at the pointer's own offset --
immediate decompressor calls, the bank `$88` course tables, the course
backdrop tables -- and only then brute-forces the gaps between them (cached
in `build/gfx/streams.tsv`). Each stream goes to `build/gfx/bin/`, PNGs to
`build/gfx/png/`, and `build/gfx/index.tsv` classifies each one and records
what referenced it.

The order matters. A blind scan is greedy and non-overlapping, so a chance
decode that starts a few bytes early swallows the real stream behind it:
157 referenced streams used to sit inside 110 such hits, the font
`$90:FBBC` and the sprite tiles `$8E:DD91` among them, and their output
files began at the wrong offset.

Current counts over 2,438 streams, 1,345 of them referenced:

| kind | count |
|---|---|
| data | 1,409 |
| tilemap | 683 |
| tiles2 | 211 |
| tiles4 | 130 |
| palette | 5 |

The classifier is a heuristic and it is wrong sometimes. Tilemaps are
detected by the concentration of their high 6 bits (palette/priority/flip
take only a handful of values); 4bpp is separated from 2bpp by how much the
upper bit planes overlap the lower ones. Small blobs like the 144-byte
course grids fall into `tiles2` because there is not enough data to judge.
Always open the PNG.
