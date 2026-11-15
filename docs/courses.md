# Course data

Course (hole) data lives in eleven parallel pointer tables in bank `$88`,
starting at `$88:A770 (0x042770)`, each 0x300 bytes apart, each holding 256
three-byte long pointers.

Verified by disassembling the two loaders at `$82:B14B (0x01314B)` and
`$82:B20C (0x01320C)`, which index every table with the same value.

## Indexing

The hole index times three sits at `$7E:ABB6`. Both loaders do:

```
LDX $ABB6
LDA $88:<table>,X      ; low 16 bits of the long pointer
TAY
LDA $88:<table>+2,X    ; high byte (bank), in the low byte of A
TYX
LDY #<destination>
JSL $80:9F18           ; sub_hal_decompress
```

Table 0 is the exception: it is **not compressed**, and is copied 32 bytes
at a time by `$82:B1DC`.

232 slots in 0-243 are populated; the rest all point at one shared filler
entry per table. The hole index is computed as `course * 8 + hole` by
`$82:B0A4`, from the course number at `$7E:6A5A` and the hole at `$7E:6A5E`.

Each course appears **twice**, at `i` and `i+64`, under the same name —
indices 0-63 and 64-127 are both `MAP00`-`MAP77`, and 128-179 and 192-243 are
both `MAP80`-`MAPE3`. Between a pair, **layers 1, 3 and 4 are byte-identical
and only layer 2 differs**: the same terrain with a different set of hazards
and enemies. So there are 116 distinct *geometries* but 232 distinct *holes*,
and which count applies depends on the layer you are measuring.

## The tables

| # | address | dest | size | contents |
|---|---|---|---|---|
| 0 | `$88:A770` | `$7E:8B90` | 28 raw | header: 8 words then a 12-byte name |
| 1 | `$88:AA70` | `$7E:6B90` | w*h | grid layer: terrain shape |
| 2 | `$88:AD70` | `$7E:8390` | w*h | grid layer: object ids |
| 3 | `$88:B070` | `$7E:7390` | w*h | grid layer: elevation |
| 4 | `$88:B370` | `$7E:7B90` | w*h | grid layer: edge wall flags |
| 5 | `$88:B670` | `$7E:93B0` | 2 * word5 | row directory: first column of each map row |
| 6 | `$88:B970` | `$7E:9BB0` | 2 * word5 | row directory: last column of each map row |
| 7 | `$88:BC70` | `$7E:8BB0` | 2 * word5 | row directory: word offset of each row in tables 8/9 |
| 8 | `$88:BF70` | `$7F:3000` | 704-16,880 | BG1 tilemap, row-packed |
| 9 | `$88:C270` | `$7F:9800` | 704-16,880 | BG2 tilemap, row-packed |
| 10 | `$88:C570` | `$7E:A3B2` | 39-343 | Kirby's occlusion table: which cell hides him over a gap (below) |

Tables 1-4 are four parallel grid layers, one byte per cell. **Courses are
not all 12x12**: header words 1 and 2 give the dimensions, and word 0 is
their product. Checked against all 232 holes, table 1's decompressed size
equals header word 0 exactly, every time. Sizes run from 12x12 (44 holes)
through 12x28, 16x16 and 28x28.

### What each layer is

Layers 1 and 3 are the playfield geometry: **layer 1 is a terrain shape id
and layer 3 is elevation**. Both are read by `sub_terrain_probe` at
`$81:9479 (0x009479)`, so this is disassembly, not inference — see
[the terrain model](terrain.md) for the full write-up, the shape table and
the surface equation.

In brief:

- **Layer 1** is an enum `$00-$1B`: 28 shapes, of which `$03` is unused by
  any course. `$00` means **no cell here** — a gap; `$01` is flat; `$02` is
  a mound. The remaining 24 are sloped, in six families of four 90°
  rotations, so `shape = (family << 2) | rotation`.
- **Layer 3** is elevation in whole cells, `$00-$0F`. One step is `$5A82` in
  the engine's 16.16 world Z. A flat cell of height `h` has its walkable top
  at `(h+1)` steps.
- **Layer 4**'s low nibble is four per-edge wall flags, read at
  `$81:92B0` and masked with `$80:8815` (`01 02 04 08 ...`) for direction
  0-3 = N/E/S/W. The high nibble is never read in banks `$80-$87`; meaning
  unknown.
- **Layer 2 is the special-tile layer** — hazards, friction changes, boost
  panels, enemies — and is **never** non-zero where layer 1 is `$00`. The
  byte is a jump-table index: `$81:811B` dispatches it through 256 long
  pointers at `$81:8136`. See [special tiles](tiles.md).

Note when counting: because layers 1, 3 and 4 are duplicated between `i` and
`i+64` but layer 2 is not, **terrain statistics should be taken over the 116
geometries** (29,949 cells) and **tile statistics over the 232 holes** — 212
of which have a full-size layer 2, for 7,947 non-zero cells. Every histogram
bucket for layers 1, 3 and 4 being an even number is that duplication, not a
coincidence.

Reproduce all of the above with:

```bash
python3 tools/terrain.py --tables            # the engine's shape tables
python3 tools/terrain.py --stats             # cross-check tables vs data
python3 tools/terrain.py --index 0 --legend  # one hole, decoded
python3 tools/courses.py                     # extract, then
python3 tools/course_stats.py                # the older per-layer statistics
```

### The 20 short-layer-2 holes

Exactly 20 holes — `MAPC0`-`MAPC7`, `MAPD0`-`MAPD7`, `MAPE0`-`MAPE3` — have
a **16-byte** table 2 instead of one byte per cell, while their other three
layers are full size. The contiguous naming says this is a deliberate
course category rather than corruption, but what the 16 bytes are is answered in
[special tiles](tiles.md): the stub is a single `$0C`, the marked cell every
hole has, and nothing else. So that variant of those courses carries no
hazards and no enemies at all. Whether the game ever selects it is not
established. `tools/course_stats.py` skips these 20, so its statistics cover
212 holes and 55,664 cells.

### The background layers and the row directory

Tables 8 and 9 are the two background layers of the isometric course view:
table 8 is BG1, table 9 is BG2. They are **not** rectangular tilemaps. The
empty space around the diamond is not stored, so tables 5, 6 and 7 are the
row directory that makes them rectangular again. Each holds exactly
`header word 5` 16-bit entries, one per map row:

| table | per row |
|---|---|
| 5 | first column of the row; `$FFFF` when the row is empty |
| 6 | last column of the row |
| 7 | word offset of the row inside tables 8 and 9 |

so for row `r` and column `c`,

```
tile(r, c) = table8[ table7[r] + c - table5[r] ]    if table5[r] <= c <= table6[r]
```

and nothing is stored otherwise. Table 7 is therefore the running total of
`table6[r] - table5[r] + 1`, and that total equals the entry count of both
table 8 and table 9.

Read off the column-strip copy at `$80:BE17 (0x003E17)`, which uploads one
column at a time as the course scrolls:

```
LDA $93B0,X / CMP $9BB0,X / BEQ skip     ; t5[r], t6[r]; equal = row not drawn
...                                      ; reject c outside [t5, t6]
SEC / SBC $0A / CLC / ADC $8BB0,X        ; (c - t5[r]) + t7[r]
ASL A / TAX
LDA $7F:3000,X / STA $0000,Y             ; table 8 -> BG1 row buffer
LDA $7F:9800,X / STA $0040,Y             ; table 9 -> BG2 row buffer
```

`$7E:93B0`, `$9BB0` and `$8BB0` are where `sub_course_load_bg` puts tables
5, 6 and 7. The two buffers go to VRAM `$5000` and `$5800` (`$80:BE65`,
`$80:BE9A`), which screen block 0 at `$80:CB91` assigns to BG1 and BG2 —
hence the layer assignment above.

Verified both ways: the formula is asserted over all 232 holes by
`tools/coursemap.py --check` (directory lengths equal word 5, table 7 is the
running total, the total equals both tilemap sizes, no row reaches past
word 4), and every hole renders as recognisable isometric terrain.

```bash
python3 tools/coursemap.py --check      # the assertions, no output
python3 tools/coursemap.py --index 0    # one hole -> render.png, bg1/bg2, map.json
python3 tools/coursemap.py              # all 232
```

The tile page and palette are the course scene's own, not a guess.
`$80:CC9D` stages `$8B:DAB1` at `$7F:2000` and `$90:9E9E` at `$7F:0000`,
then uploads 27,136 bytes to VRAM word `$0000` through the record at
`$80:CCB7` — so tiles `$000-$0FF` come from `$90:9E9E` and `$100-$34F` from
`$8B:DAB1`, 848 in all, and the highest index any hole uses is `$349` (MAP67,
index 119; 134 of the 232 holes go past `$2DC`: `max_tile` in
`build/courses/*/map.json`, measured 2026-11-15). The
palette is the 512-byte CGRAM image at `$98:C000`, moved by `$80:D369`.

### Per-hole surface graphics: the water

That page and palette are the course scene's. A hole with water changes
both at its load, so drawing a water hole from them alone shows tiles
`$180-$1AB` as noise in the boost panels' red and black.

`sub_hole_surface_gfx $82:BCD7` (dis.) reads `$7E:B3B8`, the count of
cells per layer-2 value (on course 1 hole 7 its `$60-$6F` entries equal the
grid's, snapshot `build/emu/prog/f012000`):
- any boost panel `$30-$3B`: `$B6FA` = 1, spawn object 112. Nothing else;
- otherwise any `$60-$6F` (the water, [tiles.md](tiles.md)): `$B6FA` = 2,
  spawn object 113, then graphics set A entry 2 (`$80:CCDF`). Its record
  `$80:CCEF` copies 1408 bytes, uncompressed, from `$91:ED29` to VRAM word
  `$1800`: tiles `$180-$1AB`. While `$7E:69CA` is set it queues `$80:CCF8`
  instead, a zero fill. Entry 1 (`$80:CCC0`) reloads them when `$B6FA` = 2.

So a hole with both would get no water graphics, but no hole has both: 45
hole slots have water and 20 boost panels (`tools/coursemap.py`'s
`surface_kind`).

The colours are animated by the two objects, through `sub_cgram_partial`
into palette 4:
- **Object 112** (`$84:876C`), the boost panels: colours 1-4 from `$98:C200`,
  `$C208`, `$C210`, `$C218` in turn, 3 frames each. `$98:C000` holds the
  first, which is why the static image draws the panels right.
- **Object 113** (`$84:8293`), the water. Its per-frame hook `$84:8533`
  steps a phase (phase + 1) & 3 every `$84:8576`[phase] = 8 frames and
  writes colours 1-7 (CGRAM `$41`) from base + `$84:857E`[phase] = +0,
  +`$0E`, +0, +`$1C`: three sets, in the order A B A C. The base is
  `$84:84AF`[`$7E:6A5C`], and `$6A5C` is 2 × course in every recorded
  snapshot of courses 0-15. Course 1's base is `$98:E030`.
  - Not modelled by the exporter: `$84:84F1`, the table taken while
    `$7E:6A2E` is set; `$7E:ED5B`'s `$98:EA50`/`$EA7A`; the hook's freeze
    while `$69CA` is set; and the splash it plays instead while the ball
    sinks (`$69DA`: `$98:C22E`-`$C282`, then the same back).

*Emulated* on course 1 hole 7 (`play_hole1` with `$6A5A` = 0 and `$6A5E` = 6
poked at 2050, a snapshot every frame 2280-2344, read 2026-11-15):
- the whole VRAM page equals `hole_page` on every frame;
- CGRAM 65-71 is always one of the three sets, in runs of 8 frames: B
  2287-2294, A 2295-2302, C 2303-2310, A 2311-2318, B 2319-2326, then A
  2327-2336 (10), C 2337-2344. One step lasted 10 frames. That fits the scheduler dropping
  ticks on lag frames ([emulation.md](emulation.md)), but its cause was not traced;
- hole 7's front layer composed from each snapshot's own VRAM and palette 4
  is pixel-identical to the exported `layer_front.png` (set A) and to it
  with `layer_front_ripple1/2.png` over it (sets B and C).

`tools/coursemap.py`'s `hole_page`, `hole_palette` and `water_ripple` apply
all of this; `tools/export_web.py` bakes set A into the layers and writes
the B and C overlays.

### Table 10: Kirby's occlusion table

Table 10 tells the roll loop when Kirby, over a gap, is behind the course.
`$82:F4FD` reads it every roll-loop frame and stores his OAM priority in
`$D96A` ([graphics.md](graphics.md) "Kirby behind the course"). Read with
`tools/dis65816.py` at `$82:F4FD`-`$82:F5B9`, 2026-11-15:

- **The directory.** It is w + h words, one per screen column
  d = xc + yc + carry(xf + yf). The projection draws Kirby at 32 (x + y), so
  a column is 32 px wide. Each word is an offset into the table, or `$FFFF`
  when the column has no records.
- **The records.** At each offset there is a count byte, then that many
  5-byte records: `[xmin s8, xmax u8, priority u8, cell u16]`. A record
  covers xmin ≤ xc < xmax on its column. `$82:F593` makes the test on xc's
  low byte, as `CMP / BMI` against xmin and `CMP / BCC` against xmax.
- **The cell.** `cell` is a row-major grid index. Kirby is behind it while
  z ≤ its top, `(elevation + 1)` steps from `$88:80C8`/`$88:8000`. The
  priority is 1 (under both background layers) or 2 (under the front layer
  only).

**Across all 232 holes** (2026-11-15):
- The layout is always the same: the directory, then the record lists
  packed in order, then 3 bytes that nothing reads.
- The priority bytes are only 1 and 2.
- The live `$7E:A3B2` at web_fly 3240 equals hole 1's decompressed table
  byte for byte.

**How the table was probably made.** One rule reproduces it: a gap position
is behind the nearest cell in front of it on its screen column. Those cells
cover the column (cx + cy is d − 1 or d) and have a larger cx − cy, so they
sit lower on the screen. Over every gap position of the 232 holes, both
carries included, the rule picks the table's cell, or no record, for
70,950 of 71,124 positions (99.76 %). The engine builds tables for its
authored holes this way (`engine/src/core/occlusion.ts`).

## Header format

28 bytes: eight little-endian words, then a 12-byte space-padded ASCII name.

Hole 0, at `0x0FF829`:

```
0090 000C 000C 1560 0060 0039 0000 00E8  "MAP00       "
```

| word | hole 0 | meaning | confidence |
|---|---|---|---|
| 0 | `$0090` = 144 | cell count, `= word1 * word2` | **exact, 232/232 holes**, and equals the size of grid layers 1-4 |
| 1 | `$000C` = 12 | grid width | exact |
| 2 | `$000C` = 12 | grid height | exact |
| 3 | `$1560` = 5472 | tilemap area in tiles, `= word4 * word5` | **exact, 232/232** |
| 4 | `$0060` = 96 | tilemap width in tiles, `= 4 * (width + height)` | **exact, 232/232** |
| 5 | `$0039` = 57 | tilemap height in tiles | see below |
| 6 | `$0000` | always zero in every hole | |
| 7 | `$00E8` = 232 | unknown; multiples of 8, few distinct values | |

Words 3, 4 and 5 are in **8-pixel tiles, not pixels**. Word 5 is exactly the
length of each row-directory table (5, 6 and 7), and word 3 is the count of
cells in the full rectangular tilemap — both asserted over all 232 holes by
`tools/coursemap.py --check`. In pixels the bounding box is eight times
larger: hole 0 is 96 x 57 tiles, i.e. 768 x 456 pixels.

Word 4 being exactly `4 * (width + height)` is the signature of an
**isometric projection**: a diamond laid out from a `w x h` grid is
`(w + h)` cells wide and a cell is 8 tiles wide, of which each half-diamond
occupies 4.

Word 5 is the matching height. It is always `2 * (width + height)` plus an
odd number from 9 upward that grows with terrain elevation (verified:
`word5 - 2*(w+h)` is positive and within `4*maxheight + 16` for all 232
holes). A closed form eluded me — `2*(w+h) + 2*maxheight + 9` fits only 50
of 232 — because the projected top depends on *where* the tall cells are,
not just how tall the tallest is. It does not need a closed form: the value
is read from the header, and the row directory gives the extent of every
row directly.

Names run `MAP00`, `MAP01`, ... and also `MAPE2`, `MAPF0`, `MAP46`, so the
naming is not a dense sequence — the table is ordered by index, not by name.

## Extracting

```bash
python3 tools/courses.py                    # all 232 holes -> build/courses/
python3 tools/courses.py --index 0 --dump   # one hole, to stdout
```

Each hole gets a directory `NNN_NAME/` with one file per table. To view a
course background you need its tile source, which is loaded separately by
the screen setup code and is not in these tables:

```bash
python3 tools/tilemap.py build/courses/000_MAP00/t08_9C85D0.bin --guess
python3 tools/tilemap.py build/courses/000_MAP00/t08_9C85D0.bin TILES.bin \
    --width 46 -o build/courses/000_MAP00/bg.png
```
